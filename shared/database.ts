/**
 * Field types a database offers, like Notion's property types. Each one is stored
 * in one of five physical column pools of database_items (see DatabaseFieldStorage),
 * except relation, whose values are rows of database_item_links.
 */
export const DatabaseFieldTypes = ['text', 'number', 'boolean', 'date', 'select', 'multi_select', 'url', 'email', 'phone', 'person', 'relation'] as const

export type DatabaseFieldType = (typeof DatabaseFieldTypes)[number]

/** The physical column pools of database_items. */
export const DatabaseStorageTypes = ['text', 'number', 'boolean', 'date', 'select'] as const
export type DatabaseStorageType = (typeof DatabaseStorageTypes)[number]

/** Which column pool stores each type; relation has none. */
export const DatabaseFieldStorage: Record<DatabaseFieldType, DatabaseStorageType | null> = {
  text: 'text',
  url: 'text',
  email: 'text',
  phone: 'text',
  person: 'text',
  number: 'number',
  boolean: 'boolean',
  date: 'date',
  select: 'select',
  multi_select: 'select',
  relation: null,
}

/** Types whose value is a list of ids or options. */
export const DatabaseListFieldTypes = ['multi_select', 'person', 'relation'] as const satisfies readonly DatabaseFieldType[]
export function isListFieldType(type: DatabaseFieldType): boolean {
  return (DatabaseListFieldTypes as readonly string[]).includes(type)
}

/** Types edited and filtered like free text. */
export function isTextLikeFieldType(type: DatabaseFieldType): boolean {
  return type === 'text' || type === 'url' || type === 'email' || type === 'phone'
}

/** Types that carry a list of options. */
export function hasFieldOptions(type: DatabaseFieldType): boolean {
  return type === 'select' || type === 'multi_select'
}

export type DatabaseScalarValue = string | number | boolean
export type DatabaseValue = DatabaseScalarValue | string[] | null

export const DatabaseViewLayouts = ['table', 'board', 'calendar', 'list', 'gallery'] as const
export type DatabaseViewLayout = (typeof DatabaseViewLayouts)[number]

export const DatabaseViewFilterOperators = [
  'equals',
  'not_equals',
  'contains',
  'is_empty',
  'is_not_empty',
  'greater_than',
  'less_than',
  'before',
  'after',
] as const
export type DatabaseViewFilterOperator = (typeof DatabaseViewFilterOperators)[number]
export type DatabaseViewSortDirection = 'asc' | 'desc'

export type DatabaseViewFilter = {
  fieldId: string
  operator: DatabaseViewFilterOperator
  value?: DatabaseScalarValue | null
}

/** Which conditions a field of this type accepts; `title` behaves as text. */
export function filterOperatorsFor(type: DatabaseFieldType | null): DatabaseViewFilterOperator[] {
  if (!type) return []
  if (type === 'relation') return ['is_empty', 'is_not_empty']
  if (type === 'multi_select' || type === 'person') return ['contains', 'is_empty', 'is_not_empty']
  const common: DatabaseViewFilterOperator[] = ['equals', 'not_equals', 'is_empty', 'is_not_empty']
  if (isTextLikeFieldType(type) || type === 'select') return [...common, 'contains']
  if (type === 'number') return [...common, 'greater_than', 'less_than']
  if (type === 'date') return [...common, 'before', 'after']
  return common
}

export type DatabaseViewSort = {
  fieldId: string
  direction: DatabaseViewSortDirection
}

export type DatabaseViewConfig = {
  /** null follows all current and future fields; an empty array intentionally hides every custom field. */
  visibleFieldIds: string[] | null
  filters: DatabaseViewFilter[]
  sorts: DatabaseViewSort[]
  groupFieldId: string | null
  dateFieldId: string | null
  /** Table column widths in pixels, keyed by field id or `title`; missing columns use the default width. */
  columnWidths: Record<string, number>
}

/** Bounds for a table column width set by dragging its border. */
export const DatabaseColumnWidth = { min: 80, max: 640, title: 256, field: 192 } as const

export function defaultDatabaseViewConfig(): DatabaseViewConfig {
  return {
    visibleFieldIds: null,
    filters: [],
    sorts: [{ fieldId: 'title', direction: 'asc' }],
    groupFieldId: null,
    dateFieldId: null,
    columnWidths: {},
  }
}

/** Physical columns per pool, plus virtual link slots that only keep relation fields apart. */
export const DatabaseSlotCounts: Record<DatabaseStorageType | 'relation', number> = {
  text: 16,
  number: 8,
  boolean: 8,
  date: 8,
  select: 8,
  relation: 16,
}

/** The pool a type allocates from: its storage pool, or the virtual `links` pool for relations. */
export function databaseSlotPool(type: DatabaseFieldType): DatabaseStorageType | 'relation' {
  return DatabaseFieldStorage[type] ?? 'relation'
}

/** Types that share a pool with this one, so their slots must not collide. */
export function databaseSlotPeers(type: DatabaseFieldType): DatabaseFieldType[] {
  const pool = databaseSlotPool(type)
  return DatabaseFieldTypes.filter(candidate => databaseSlotPool(candidate) === pool)
}

/** Physical columns are allocated only from this server-known list. */
export function databaseSlots(type: DatabaseFieldType): string[] {
  const pool = databaseSlotPool(type)
  const prefix = pool === 'relation' ? 'links' : pool
  return Array.from({ length: DatabaseSlotCounts[pool] }, (_, index) => `${prefix}_${index + 1}`)
}

export function isDatabaseSlot(type: DatabaseFieldType, slot: string): boolean {
  return databaseSlots(type).includes(slot)
}

export function normalizeDatabaseOptions(options: Iterable<string>): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const raw of options) {
    const option = raw.trim()
    const key = option.toLocaleLowerCase()
    if (!option || seen.has(key)) continue
    seen.add(key)
    normalized.push(option)
  }
  return normalized
}

/** A list value as stored in a text or select column: a JSON array of strings, or NULL when empty. */
export function encodeListValue(values: readonly string[]): string | null {
  return values.length ? JSON.stringify(values) : null
}

export function decodeListValue(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  }
  catch {
    return []
  }
}
