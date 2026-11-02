import { databaseSlotPeers, databaseSlots, decodeListValue, encodeListValue, isDatabaseSlot, normalizeDatabaseOptions, type DatabaseFieldType, type DatabaseValue } from '../../shared/database'
import { newId } from '../../shared/ids'
import type { DatabaseDTO, DatabaseFieldDTO, DatabaseItemDTO, LinkedRecordDTO } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'

type DefinitionRow = Omit<DatabaseDTO, 'fields' | 'items'>
export type StoredDatabaseField = DatabaseFieldDTO & { slot: string }
type FieldRow = Omit<StoredDatabaseField, 'options' | 'relation'> & { configJson: string }
type ItemRow = Omit<DatabaseItemDTO, 'values'> & Record<string, unknown>
/** Relation values of loaded records: record id → field id → linked record ids in order. */
export type ItemLinks = Map<string, Map<string, string[]>>

/** D1 binds at most 100 parameters per statement. */
const BIND_CHUNK = 90

export function parseDatabaseField(row: FieldRow): StoredDatabaseField {
  let options: string[] = []
  let relation: StoredDatabaseField['relation'] = null
  try {
    const config = JSON.parse(row.configJson) as { options?: unknown; relation?: { databaseId?: unknown } }
    if (Array.isArray(config.options)) options = config.options.filter((value): value is string => typeof value === 'string')
    if (row.type === 'relation' && typeof config.relation?.databaseId === 'string') relation = { databaseId: config.relation.databaseId }
  }
  catch {
    options = []
  }
  const { configJson: _configJson, ...field } = row
  return { ...field, options, relation }
}

export function databaseFieldDto(field: StoredDatabaseField): DatabaseFieldDTO {
  const { slot: _slot, ...publicField } = field
  return publicField
}

export function databaseItemDto(row: ItemRow, fields: StoredDatabaseField[], links?: Map<string, string[]>): DatabaseItemDTO {
  const values: Record<string, DatabaseValue> = {}
  for (const field of fields) {
    if (field.type === 'relation') { values[field.id] = links?.get(field.id) ?? []; continue }
    const raw = row[field.slot]
    if (field.type === 'multi_select' || field.type === 'person') values[field.id] = decodeListValue(raw)
    else values[field.id] = field.type === 'boolean' && raw !== null && raw !== undefined ? Boolean(raw) : (raw as DatabaseValue ?? null)
  }
  return {
    id: row.id,
    databaseId: row.databaseId,
    title: row.title,
    position: row.position,
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    values,
  }
}

function chunks<T>(values: T[]): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += BIND_CHUNK) result.push(values.slice(index, index + BIND_CHUNK))
  return result
}

/** Relation values of these records, in the order they were linked. */
export async function loadItemLinks(env: L4Env, itemIds: string[]): Promise<ItemLinks> {
  const links: ItemLinks = new Map()
  for (const chunk of chunks([...new Set(itemIds)])) {
    const result = await env.DB.prepare(
      `SELECT field_id as fieldId, item_id as itemId, target_item_id as targetItemId FROM database_item_links
       WHERE item_id IN (${chunk.map(() => '?').join(', ')}) ORDER BY position, created_at`,
    ).bind(...chunk).all<{ fieldId: string; itemId: string; targetItemId: string }>()
    for (const row of result.results ?? []) {
      const fields = links.get(row.itemId) ?? new Map<string, string[]>()
      fields.set(row.fieldId, [...(fields.get(row.fieldId) ?? []), row.targetItemId])
      links.set(row.itemId, fields)
    }
  }
  return links
}

/**
 * Titles of the records that relation values point at, so a list can show them without
 * another load. A title belongs to its database: records of a database the reader may not
 * open are left out, and their chips show no name.
 */
export async function loadLinkedRecords(env: L4Env, links: ItemLinks, canRead: (databaseId: string) => boolean = () => true): Promise<Record<string, LinkedRecordDTO>> {
  const targetIds = new Set<string>()
  for (const fields of links.values()) for (const ids of fields.values()) for (const id of ids) targetIds.add(id)
  const linked: Record<string, LinkedRecordDTO> = {}
  for (const chunk of chunks([...targetIds])) {
    const result = await env.DB.prepare(
      `SELECT id, database_id as databaseId, title FROM database_items WHERE id IN (${chunk.map(() => '?').join(', ')})`,
    ).bind(...chunk).all<LinkedRecordDTO>()
    for (const row of result.results ?? []) if (canRead(row.databaseId)) linked[row.id] = row
  }
  return linked
}

export async function loadDatabases(env: L4Env, includeArchived = false): Promise<DatabaseDTO[]> {
  const archivedClause = includeArchived ? '' : 'WHERE archived_at IS NULL'
  const [definitionsResult, fieldsResult, itemsResult] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, position, created_by as createdBy, archived_at as archivedAt,
       created_at as createdAt, updated_at as updatedAt
       FROM database_definitions ${archivedClause} ORDER BY position, created_at`,
    ).all<DefinitionRow>(),
    env.DB.prepare(
      `SELECT id, database_id as databaseId, name, type, slot, config_json as configJson, position,
       created_at as createdAt, updated_at as updatedAt
       FROM database_fields ORDER BY position, created_at`,
    ).all<FieldRow>(),
    env.DB.prepare(
      `SELECT *, database_id as databaseId, created_by as createdBy,
       created_at as createdAt, updated_at as updatedAt
       FROM database_items ORDER BY position, created_at`,
    ).all<ItemRow>(),
  ])
  const fields = (fieldsResult.results ?? []).map(parseDatabaseField)
  const items = itemsResult.results ?? []
  const links = fields.some(field => field.type === 'relation') ? await loadItemLinks(env, items.map(item => item.id)) : new Map() as ItemLinks
  return (definitionsResult.results ?? []).map(database => {
    const databaseFields = fields.filter(field => field.databaseId === database.id)
    return {
      ...database,
      fields: databaseFields.map(databaseFieldDto),
      items: items.filter(item => item.databaseId === database.id).map(item => databaseItemDto(item, databaseFields, links.get(item.id))),
    }
  })
}

export async function loadDatabaseItem(env: L4Env, itemId: string): Promise<DatabaseItemDTO | null> {
  const row = await env.DB.prepare(
    `SELECT id, database_id as databaseId, title, position, version, created_by as createdBy,
     created_at as createdAt, updated_at as updatedAt, * FROM database_items WHERE id = ?`,
  ).bind(itemId).first<ItemRow>()
  if (!row) return null
  const fields = await databaseFieldsFor(env, row.databaseId)
  const links = fields.some(field => field.type === 'relation') ? await loadItemLinks(env, [itemId]) : null
  return databaseItemDto(row, fields, links?.get(itemId))
}

export async function requireDatabase(env: L4Env, id: string, writable = false): Promise<DefinitionRow> {
  const database = await env.DB.prepare(
    `SELECT id, name, position, created_by as createdBy, archived_at as archivedAt,
     created_at as createdAt, updated_at as updatedAt FROM database_definitions WHERE id = ?`,
  ).bind(id).first<DefinitionRow>()
  if (!database) fail(404, 'not_found', 'Database not found')
  if (writable && database.archivedAt) fail(409, 'database_archived', 'Restore the database before changing it')
  return database
}

export async function requireDatabaseField(env: L4Env, id: string): Promise<StoredDatabaseField> {
  const field = await env.DB.prepare(
    `SELECT id, database_id as databaseId, name, type, slot, config_json as configJson, position,
     created_at as createdAt, updated_at as updatedAt FROM database_fields WHERE id = ?`,
  ).bind(id).first<FieldRow>()
  if (!field) fail(404, 'not_found', 'Database field not found')
  if (!isDatabaseSlot(field.type, field.slot)) fail(500, 'invalid_field_slot', 'Database field has an invalid storage slot')
  return parseDatabaseField(field)
}

export async function requireDatabaseItem(env: L4Env, id: string): Promise<ItemRow> {
  const item = await env.DB.prepare(
    `SELECT id, database_id as databaseId, title, position, version, created_by as createdBy,
     created_at as createdAt, updated_at as updatedAt, * FROM database_items WHERE id = ?`,
  ).bind(id).first<ItemRow>()
  if (!item) fail(404, 'not_found', 'Database item not found')
  return item
}

export async function databaseFieldsFor(env: L4Env, databaseId: string): Promise<StoredDatabaseField[]> {
  const result = await env.DB.prepare(
    `SELECT id, database_id as databaseId, name, type, slot, config_json as configJson, position,
     created_at as createdAt, updated_at as updatedAt FROM database_fields
     WHERE database_id = ? ORDER BY position, created_at`,
  ).bind(databaseId).all<FieldRow>()
  return (result.results ?? []).map(parseDatabaseField)
}

/** Types sharing a column pool (text, url, email, phone, person; select and multi-select) share its slots. */
export async function allocateDatabaseSlot(env: L4Env, databaseId: string, type: DatabaseFieldType): Promise<string> {
  const peers = databaseSlotPeers(type)
  const usedResult = await env.DB.prepare(
    `SELECT slot FROM database_fields WHERE database_id = ? AND type IN (${peers.map(() => '?').join(', ')})`,
  ).bind(databaseId, ...peers).all<{ slot: string }>()
  const used = new Set((usedResult.results ?? []).map(row => row.slot))
  const slot = databaseSlots(type).find(candidate => !used.has(candidate))
  if (!slot) fail(409, 'field_limit', `This database has reached its ${type.replace('_', ' ')} field limit`)
  return slot
}

/** The stored configuration of a field: its options, and the target database of a relation. */
export function databaseFieldConfig(field: Pick<DatabaseFieldDTO, 'type' | 'options' | 'relation'>): string {
  return JSON.stringify({
    options: field.type === 'select' || field.type === 'multi_select' ? field.options : [],
    ...(field.type === 'relation' && field.relation ? { relation: { databaseId: field.relation.databaseId } } : {}),
  })
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const PHONE = /^\+?[\d\s().-]{3,40}$/u

function listValue(field: DatabaseFieldDTO, value: unknown, limit: number): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) fail(400, 'bad_request', `${field.name} must be a list`)
  const entries = normalizeDatabaseOptions(value as string[])
  if (entries.length > limit) fail(400, 'bad_request', `${field.name} can hold at most ${limit} entries`)
  return entries
}

/** The column value for a field; relation fields have no column, see prepareRecordValues. */
export function databaseSqlValue(field: DatabaseFieldDTO, value: unknown): string | number | null {
  if (field.type === 'relation') fail(400, 'bad_request', `${field.name} is a relation; send a list of record ids`)
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return null
  if (field.type === 'text') {
    if (typeof value !== 'string' || value.length > 5000) fail(400, 'bad_request', `${field.name} must be text under 5000 characters`)
    return value
  }
  if (field.type === 'url') {
    if (typeof value !== 'string' || value.length > 2000) fail(400, 'bad_request', `${field.name} must be a web address`)
    const address = /^[a-z][a-z0-9+.-]*:\/\//iu.test(value.trim()) ? value.trim() : `https://${value.trim()}`
    try { new URL(address) }
    catch { fail(400, 'bad_request', `${field.name} must be a web address`) }
    return address
  }
  if (field.type === 'email') {
    if (typeof value !== 'string' || value.length > 320 || !EMAIL.test(value.trim())) fail(400, 'bad_request', `${field.name} must be an email address`)
    return value.trim()
  }
  if (field.type === 'phone') {
    if (typeof value !== 'string' || !PHONE.test(value.trim())) fail(400, 'bad_request', `${field.name} must be a phone number`)
    return value.trim()
  }
  if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(400, 'bad_request', `${field.name} must be a number`)
    return value
  }
  if (field.type === 'boolean') {
    if (typeof value !== 'boolean') fail(400, 'bad_request', `${field.name} must be true or false`)
    return value ? 1 : 0
  }
  if (field.type === 'date') {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
      fail(400, 'bad_request', `${field.name} must be a date`)
    }
    return value
  }
  if (field.type === 'multi_select') {
    const entries = listValue(field, value, 50)
    const unknown = entries.find(entry => !field.options.includes(entry))
    if (unknown) fail(400, 'bad_request', `${field.name} has an unsupported option`)
    return encodeListValue(entries)
  }
  if (field.type === 'person') return encodeListValue(listValue(field, value, 50))
  if (typeof value !== 'string' || !field.options.includes(value)) fail(400, 'bad_request', `${field.name} has an unsupported option`)
  return value
}

export type PreparedRecordValues = {
  columns: Array<{ slot: string; value: string | number | null }>
  links: Array<{ field: StoredDatabaseField; targetIds: string[] }>
}

/**
 * Splits submitted values into column writes and relation links, checking that
 * people are members here and that linked records belong to the field's database.
 * `authorizeTarget` runs for each database that gains links, so nobody links records
 * they may not open.
 */
export async function prepareRecordValues(
  env: L4Env,
  fields: Map<string, StoredDatabaseField>,
  values: Record<string, unknown>,
  unknownField: () => never,
  authorizeTarget: (databaseId: string) => void = () => {},
): Promise<PreparedRecordValues> {
  const prepared: PreparedRecordValues = { columns: [], links: [] }
  const people = new Set<string>()
  for (const [fieldId, value] of Object.entries(values)) {
    const field = fields.get(fieldId)
    if (!field) unknownField()
    if (field.type === 'relation') {
      const targetIds = value === null || value === undefined ? [] : listValue(field, value, 100)
      prepared.links.push({ field, targetIds })
      continue
    }
    const column = databaseSqlValue(field, value)
    if (field.type === 'person') for (const id of decodeListValue(column)) people.add(id)
    prepared.columns.push({ slot: field.slot, value: column })
  }
  for (const chunk of chunks([...people])) {
    const known = await env.DB.prepare(`SELECT id FROM users WHERE id IN (${chunk.map(() => '?').join(', ')})`).bind(...chunk).all<{ id: string }>()
    if ((known.results ?? []).length !== chunk.length) fail(400, 'bad_request', 'A person value is not a member of this Server')
  }
  for (const link of prepared.links) {
    const databaseId = link.field.relation?.databaseId
    if (!databaseId) fail(500, 'invalid_relation', `${link.field.name} has no target database`)
    if (link.targetIds.length) authorizeTarget(databaseId)
    for (const chunk of chunks(link.targetIds)) {
      const known = await env.DB.prepare(
        `SELECT id FROM database_items WHERE database_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`,
      ).bind(databaseId, ...chunk).all<{ id: string }>()
      if ((known.results ?? []).length !== chunk.length) fail(400, 'bad_request', `${link.field.name} can only link records of its database`)
    }
  }
  return prepared
}

/** Replaces the links of each submitted relation field with the given records, in order. */
export function linkStatements(env: L4Env, itemId: string, links: PreparedRecordValues['links'], now: string): D1PreparedStatement[] {
  return links.flatMap(link => [
    env.DB.prepare('DELETE FROM database_item_links WHERE item_id = ? AND field_id = ?').bind(itemId, link.field.id),
    ...link.targetIds.map((targetId, index) => env.DB.prepare(
      'INSERT INTO database_item_links (id, field_id, item_id, target_item_id, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(newId(), link.field.id, itemId, targetId, (index + 1) * 1024, now)),
  ])
}
