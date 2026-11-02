import { getServerId } from '../../../shared/server-id'
import { z } from 'zod'
import { decodeListValue, hasFieldOptions, normalizeDatabaseOptions } from '../../../shared/database'
import { nowIso } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { cf, fail } from '../../utils/cf'
import { databaseFieldConfig, databaseFieldDto, requireDatabase, requireDatabaseField } from '../../utils/database-data'
import { requireMember } from '../../utils/guards'
import { writeAudit } from '../../utils/messages'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  options: z.array(z.string().max(80)).max(50).optional(),
  position: z.number().int().min(0).optional(),
}).refine(body => Object.keys(body).length > 0, 'No changes')

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, (await getServerId(cf(event).env.DB)), Permission.manageDatabases)
  const id = getRouterParam(event, 'id')!
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  const field = await requireDatabaseField(env, id)
  await requireDatabase(env, field.databaseId, true)
  if (body.name !== undefined) {
    const duplicate = await env.DB.prepare(
      'SELECT id FROM database_fields WHERE database_id = ? AND id <> ? AND lower(name) = lower(?) LIMIT 1',
    ).bind(field.databaseId, id, body.name).first()
    if (duplicate) fail(409, 'duplicate_name', 'A field with this name already exists')
  }
  let options = field.options
  if (body.options !== undefined) {
    if (!hasFieldOptions(field.type)) fail(400, 'bad_request', 'Only select fields have options')
    options = normalizeDatabaseOptions(body.options)
    const values = await env.DB.prepare(
      `SELECT DISTINCT ${field.slot} as value FROM database_items
       WHERE database_id = ? AND ${field.slot} IS NOT NULL`,
    ).bind(field.databaseId).all<{ value: string }>()
    const used = (values.results ?? []).flatMap(row => field.type === 'multi_select' ? decodeListValue(row.value) : [row.value])
    if (used.some(value => !options.includes(value))) {
      fail(409, 'option_in_use', 'Remove or change existing cell values before deleting this option')
    }
  }
  const assignments: string[] = ['updated_at = ?']
  const values: Array<string | number> = [nowIso()]
  if (body.name !== undefined) { assignments.push('name = ?'); values.push(body.name) }
  if (body.position !== undefined) { assignments.push('position = ?'); values.push(body.position) }
  if (body.options !== undefined) { assignments.push('config_json = ?'); values.push(databaseFieldConfig({ ...field, options })) }
  await env.DB.prepare(`UPDATE database_fields SET ${assignments.join(', ')} WHERE id = ?`).bind(...values, id).run()
  await writeAudit(env, { serverId: (await getServerId(cf(event).env.DB)), actorId: actor.user.id, action: 'database_field.update', targetType: 'database_field', targetId: id, meta: { databaseId: field.databaseId, fields: Object.keys(body) } })
  return { field: databaseFieldDto(await requireDatabaseField(env, id)) }
})
