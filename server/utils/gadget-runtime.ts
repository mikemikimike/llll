import type { AuthorizationContext } from '../../shared/authorization'
import type { GadgetBinding, GadgetRuntimeDTO, GadgetSpec } from '../../shared/gadgets'
import { newId, nowIso } from '../../shared/ids'
import type { DatabaseValue } from '../../shared/database'
import type { DatabaseItemDTO } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { canManageGadgets, canUseGadgets, requireGadget, type GadgetRow } from './gadget-catalog'
import { fail } from './cf'
import { databaseFieldsFor, databaseItemDto, databaseSqlValue, loadDatabaseItem, requireDatabase, requireDatabaseItem } from './database-data'
import { databaseItemMatchesView, loadDatabasePage } from './database-views'
import { validateGadgetSpec } from './gadget-spec'
import type { Membership } from './guards'
import { writeAudit } from './messages'

async function requireRuntimeAccess(env: L4Env, actor: Membership, gadgetId: string): Promise<{ gadget: GadgetRow, authorization?: AuthorizationContext }> {
  if (!canUseGadgets(actor)) fail(403, 'forbidden', 'Missing permission')
  const gadget = await requireGadget(env, gadgetId)
  if (!gadget.publishedVersion) fail(404, 'not_found', 'App not found')
  const access = await env.DB.prepare(
    `SELECT 1 FROM gadget_versions versions
     JOIN grants access ON access.gadget_version_id = versions.id
     WHERE versions.gadget_id = ? AND versions.version = ? AND access.role_id = ?`,
  ).bind(gadgetId, gadget.publishedVersion, actor.roleId).first()
  if (!access && !canManageGadgets(actor)) fail(404, 'not_found', 'App not found')
  return { gadget, authorization: access ? undefined : actor.authorization }
}

type PublishedGadget = { name: string, description: string, spec: GadgetSpec }

async function loadPublishedGadget(env: L4Env, gadget: GadgetRow, authorization?: AuthorizationContext): Promise<PublishedGadget> {
  const row = await env.DB.prepare(
    'SELECT name, description, spec_json as specJson FROM gadget_versions WHERE gadget_id = ? AND version = ?',
  ).bind(gadget.id, gadget.publishedVersion).first<{ name: string, description: string, specJson: string }>()
  if (!row) fail(409, 'gadget_version_missing', 'The published App Version is missing')
  let value: unknown
  try { value = JSON.parse(row.specJson) }
  catch { fail(409, 'gadget_version_invalid', 'The published App Version is invalid') }
  return { name: row.name, description: row.description, spec: await validateGadgetSpec(env, value, { publish: true, authorization }) }
}

function projectItem(item: DatabaseItemDTO, binding: GadgetBinding): DatabaseItemDTO {
  const fields = new Set(binding.fieldIds)
  return { ...item, values: Object.fromEntries(Object.entries(item.values).filter(([fieldId]) => fields.has(fieldId))) }
}

/** Open is the only read interface the UI needs; all source resolution stays behind this seam. */
export async function openGadget(env: L4Env, actor: Membership, gadgetId: string): Promise<GadgetRuntimeDTO> {
  const { gadget, authorization } = await requireRuntimeAccess(env, actor, gadgetId)
  const published = await loadPublishedGadget(env, gadget, authorization)
  const spec = published.spec
  const datasets = await Promise.all(spec.bindings.map(async (binding) => {
    const page = await loadDatabasePage(env, binding.source.databaseId, {
      viewId: binding.source.viewId,
      page: 1,
      pageSize: 50,
      authorization,
    })
    const visible = new Set(binding.fieldIds)
    return {
      binding,
      database: { id: page.database.id, name: page.database.name },
      view: { id: page.view.id, name: page.view.name },
      fields: page.database.fields.filter(field => visible.has(field.id)),
      items: page.items.map(item => projectItem(item, binding)),
      total: page.total,
    }
  }))
  return {
    gadget: { id: gadget.id, name: published.name, description: published.description, version: gadget.publishedVersion! },
    spec,
    datasets,
  }
}

export type GadgetInvocation = {
  bindingId: string
  operation: 'create' | 'update'
  recordId?: string
  title?: string
  values?: Record<string, DatabaseValue>
  version?: number
}

async function createRecord(
  env: L4Env,
  actor: Membership,
  gadgetId: string,
  binding: GadgetBinding,
  input: GadgetInvocation,
): Promise<DatabaseItemDTO> {
  await requireDatabase(env, binding.source.databaseId, true)
  const fields = await databaseFieldsFor(env, binding.source.databaseId)
  const allowed = new Set(binding.fieldIds)
  const fieldMap = new Map(fields.filter(field => allowed.has(field.id)).map(field => [field.id, field]))
  const columns = ['id', 'database_id', 'title', 'position', 'version', 'created_by', 'created_at', 'updated_at']
  const position = await env.DB.prepare('SELECT COALESCE(MAX(position), 0) + 1024 as value FROM database_items WHERE database_id = ?')
    .bind(binding.source.databaseId).first<{ value: number }>()
  const id = newId()
  const now = nowIso()
  const title = input.title?.trim() || 'Untitled'
  const values: Array<string | number | null> = [id, binding.source.databaseId, title, position?.value ?? 1024, 1, actor.user.id, now, now]
  for (const [fieldId, value] of Object.entries(input.values ?? {})) {
    const field = fieldMap.get(fieldId)
    if (!field) fail(400, 'gadget_field_denied', 'The App cannot write one of the supplied Fields')
    if (field.type === 'relation') fail(400, 'gadget_field_denied', 'Apps cannot write relation Fields yet')
    columns.push(field.slot)
    values.push(databaseSqlValue(field, value))
  }
  await env.DB.prepare(`INSERT INTO database_items (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).bind(...values).run()
  await writeAudit(env, {
    serverId: actor.serverId,
    actorId: actor.user.id,
    action: 'gadget.record.create',
    targetType: 'database_item',
    targetId: id,
    meta: { gadgetId, bindingId: binding.id, databaseId: binding.source.databaseId },
    authorization: actor.authorization,
  })
  return projectItem((await loadDatabaseItem(env, id))!, binding)
}

async function updateRecord(
  env: L4Env,
  actor: Membership,
  gadgetId: string,
  binding: GadgetBinding,
  input: GadgetInvocation,
): Promise<DatabaseItemDTO> {
  if (!input.recordId || !input.version) fail(400, 'bad_request', 'Updating a Record requires its id and version')
  const current = await requireDatabaseItem(env, input.recordId)
  if (current.databaseId !== binding.source.databaseId) fail(400, 'gadget_source_denied', 'The Record does not belong to this App Binding')
  if (!await databaseItemMatchesView(env, current.databaseId, binding.source.viewId, input.recordId)) {
    fail(400, 'gadget_source_denied', 'The Record does not belong to this App Binding')
  }
  await requireDatabase(env, current.databaseId, true)
  if (current.version !== input.version) fail(409, 'stale_record', 'This Record changed elsewhere. Reload and try again.')
  const fields = await databaseFieldsFor(env, current.databaseId)
  const allowed = new Set(binding.fieldIds)
  const fieldMap = new Map(fields.filter(field => allowed.has(field.id)).map(field => [field.id, field]))
  const assignments = ['updated_at = ?', 'version = version + 1']
  const values: Array<string | number | null> = [nowIso()]
  if (input.title !== undefined) {
    const title = input.title.trim()
    if (!title) fail(400, 'bad_request', 'Record title is required')
    assignments.push('title = ?')
    values.push(title)
  }
  for (const [fieldId, value] of Object.entries(input.values ?? {})) {
    const field = fieldMap.get(fieldId)
    if (!field) fail(400, 'gadget_field_denied', 'The App cannot write one of the supplied Fields')
    if (field.type === 'relation') fail(400, 'gadget_field_denied', 'Apps cannot write relation Fields yet')
    assignments.push(`${field.slot} = ?`)
    values.push(databaseSqlValue(field, value))
  }
  if (assignments.length === 2) fail(400, 'bad_request', 'No Record changes were supplied')
  const updated = await env.DB.prepare(
    `UPDATE database_items SET ${assignments.join(', ')} WHERE id = ? AND version = ?
     RETURNING *, database_id as databaseId, created_by as createdBy, created_at as createdAt, updated_at as updatedAt`,
  ).bind(...values, input.recordId, input.version).first<Parameters<typeof databaseItemDto>[0]>()
  if (!updated) fail(409, 'stale_record', 'This Record changed elsewhere. Reload and try again.')
  await writeAudit(env, {
    serverId: actor.serverId,
    actorId: actor.user.id,
    action: 'gadget.record.update',
    targetType: 'database_item',
    targetId: input.recordId,
    meta: { gadgetId, bindingId: binding.id, databaseId: binding.source.databaseId, fields: [...Object.keys(input.values ?? {}), ...(input.title !== undefined ? ['title'] : [])] },
    authorization: actor.authorization,
  })
  return projectItem(databaseItemDto(updated, fields), binding)
}

/** Invoke enforces published capabilities before dispatching a domain mutation. */
export async function invokeGadget(env: L4Env, actor: Membership, gadgetId: string, input: GadgetInvocation): Promise<DatabaseItemDTO> {
  const { gadget, authorization } = await requireRuntimeAccess(env, actor, gadgetId)
  const { spec } = await loadPublishedGadget(env, gadget, authorization)
  const binding = spec.bindings.find(candidate => candidate.id === input.bindingId)
  if (!binding || !binding.operations.includes(input.operation)) fail(403, 'gadget_operation_denied', 'This App does not allow that operation')
  if (input.operation === 'create') return createRecord(env, actor, gadgetId, binding, input)
  return updateRecord(env, actor, gadgetId, binding, input)
}
