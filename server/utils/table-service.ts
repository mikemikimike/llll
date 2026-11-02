import { z } from 'zod'
import { DatabaseFieldTypes, databaseSlotPool, databaseSlots, hasFieldOptions, normalizeDatabaseOptions } from '../../shared/database'
import { authorize, authorizeResource, ServerAction, type AuthorizationContext } from '../../shared/authorization'
import { newId, nowIso } from '../../shared/ids'
import type { DatabaseDTO, DatabaseFieldDTO } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { auditStatement } from './messages'
import { fail } from './cf'
import { databaseFieldConfig, requireDatabase } from './database-data'

export const createTableSchema = z.object({
  name: z.string().trim().min(1).max(80),
  fields: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    type: z.enum(DatabaseFieldTypes),
    options: z.array(z.string().max(80)).max(50).default([]),
    /** For a relation: the database it links to, or "self" for this new table. */
    relation: z.object({ databaseId: z.string().min(1) }).optional(),
  }).refine(field => field.type !== 'relation' || field.relation, 'A relation field needs a target database')).max(30).default([]),
})

/** Create a complete research table atomically; partial schemas are never published. */
export async function createTable(env: L4Env, authorization: AuthorizationContext, input: z.input<typeof createTableSchema>): Promise<DatabaseDTO> {
  authorize(authorization, ServerAction.manageData)
  authorizeResource(authorization, 'databases', '*')
  const body = createTableSchema.parse(input)
  const names = body.fields.map(field => field.name.toLowerCase())
  if (new Set(names).size !== names.length) fail(400, 'duplicate_field', 'Field names must be unique')
  if (await env.DB.prepare('SELECT id FROM database_definitions WHERE lower(name)=lower(?)').bind(body.name).first()) fail(409, 'duplicate_name', 'A table with this name exists')
  const position = await env.DB.prepare('SELECT COALESCE(MAX(position),0) as position FROM database_definitions WHERE archived_at IS NULL').first<{ position: number }>()
  const id = newId()
  const now = nowIso()
  const used = new Map<string, number>()
  const fields: Array<DatabaseFieldDTO & { slot: string }> = []
  for (const [index, field] of body.fields.entries()) {
    const pool = databaseSlotPool(field.type)
    const next = used.get(pool) ?? 0
    const slot = databaseSlots(field.type)[next]
    if (!slot) fail(400, 'field_limit', `Too many ${field.type.replace('_', ' ')} fields`)
    used.set(pool, next + 1)
    const relation = field.type === 'relation' && field.relation
      ? { databaseId: field.relation.databaseId === 'self' ? id : (await requireDatabase(env, field.relation.databaseId)).id }
      : null
    fields.push({ id: newId(), databaseId: id, name: field.name, type: field.type, slot, relation,
      options: hasFieldOptions(field.type) ? normalizeDatabaseOptions(field.options) : [], position: (index + 1) * 1024, createdAt: now, updatedAt: now })
  }
  const audit = await auditStatement(env, { serverId: authorization.serverId, actorId: authorization.principal.id, action: 'database.create',
    targetType: 'database', targetId: id, meta: { name: body.name, fieldCount: fields.length }, authorization })
  await env.DB.batch([
    env.DB.prepare('INSERT INTO database_definitions(id,name,position,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .bind(id, body.name, (position?.position ?? 0) + 1024, authorization.principal.id, now, now),
    ...fields.map(field => env.DB.prepare('INSERT INTO database_fields(id,database_id,name,type,slot,config_json,position,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .bind(field.id, id, field.name, field.type, field.slot, databaseFieldConfig(field), field.position, authorization.principal.id, now, now)),
    audit,
  ])
  return { id, name: body.name, position: (position?.position ?? 0) + 1024, createdBy: authorization.principal.id, archivedAt: null,
    createdAt: now, updatedAt: now, fields: fields.map(({ slot: _slot, ...field }) => field), items: [] }
}
