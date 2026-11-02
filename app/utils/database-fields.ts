import { DatabaseFieldTypes, DatabaseViewLayouts, filterOperatorsFor, isTextLikeFieldType, type DatabaseFieldType, type DatabaseScalarValue, type DatabaseValue, type DatabaseViewFilterOperator, type DatabaseViewLayout } from '~~/shared/database'
import type { DatabaseFieldDTO } from '~~/shared/types'

/** How a field type shows in menus and column headers. */
export function fieldTypeLabel(type: DatabaseFieldType): string {
  switch (type) {
    case 'boolean': return 'Checkbox'
    case 'multi_select': return 'Multi-select'
    case 'url': return 'URL'
    case 'email': return 'Email'
    case 'phone': return 'Phone'
    case 'person': return 'Person'
    case 'relation': return 'Relation'
    default: return type.charAt(0).toUpperCase() + type.slice(1)
  }
}

export function fieldIcon(type: DatabaseFieldType): string {
  switch (type) {
    case 'number': return 'i-ph-hash'
    case 'boolean': return 'i-ph-check-square'
    case 'date': return 'i-ph-calendar-blank'
    case 'select': return 'i-ph-caret-circle-down'
    case 'multi_select': return 'i-ph-list-checks'
    case 'url': return 'i-ph-link-simple'
    case 'email': return 'i-ph-at'
    case 'phone': return 'i-ph-phone'
    case 'person': return 'i-ph-user'
    case 'relation': return 'i-ph-arrows-left-right'
    default: return 'i-ph-text-t'
  }
}

/** A short line for the type picker. */
export function fieldTypeHint(type: DatabaseFieldType): string {
  switch (type) {
    case 'text': return 'A line or a paragraph'
    case 'number': return 'Amounts, counts, scores'
    case 'boolean': return 'Done or not'
    case 'date': return 'One day'
    case 'select': return 'One option from a list'
    case 'multi_select': return 'Any number of options'
    case 'url': return 'A web address'
    case 'email': return 'An email address'
    case 'phone': return 'A phone number'
    case 'person': return 'Members of this Server'
    case 'relation': return 'Records of a database'
  }
}

export const fieldTypeChoices = DatabaseFieldTypes.map(type => ({ value: type, label: fieldTypeLabel(type), icon: fieldIcon(type), hint: fieldTypeHint(type) }))

export function viewLabel(layout: DatabaseViewLayout): string {
  return layout.charAt(0).toUpperCase() + layout.slice(1)
}

export function viewIcon(layout: DatabaseViewLayout): string {
  switch (layout) {
    case 'board': return 'i-ph-kanban'
    case 'calendar': return 'i-ph-calendar-blank'
    case 'list': return 'i-ph-list-bullets'
    case 'gallery': return 'i-ph-squares-four'
    default: return 'i-ph-table'
  }
}

export const viewLayoutChoices = DatabaseViewLayouts.map(layout => ({ value: layout, label: viewLabel(layout), icon: viewIcon(layout) }))

/** The HTML input type that edits a scalar field inline. */
export function fieldInputType(type: DatabaseFieldType): string {
  if (type === 'number') return 'number'
  if (type === 'date') return 'date'
  if (type === 'url') return 'url'
  if (type === 'email') return 'email'
  if (type === 'phone') return 'tel'
  return 'text'
}

/** A plain-text rendering with no lookups: list values show their raw entries. */
export function displayValue(value: DatabaseValue | undefined): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

/** A web address without its scheme, for a chip. */
export function shortUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`.replace(/^www\./u, '')
  }
  catch {
    return value
  }
}

export type EditableViewFilter = { fieldId: string; operator: DatabaseViewFilterOperator; value: string }

export function filterFieldFor(fields: DatabaseFieldDTO[], filter: Pick<EditableViewFilter, 'fieldId'>): DatabaseFieldDTO | null {
  return fields.find(field => field.id === filter.fieldId) ?? null
}

export function filterOperatorOptionsFor(fields: DatabaseFieldDTO[], filter: EditableViewFilter) {
  const type = filter.fieldId === 'title' ? 'text' : filterFieldFor(fields, filter)?.type ?? null
  return filterOperatorsFor(type).map(operator => ({ label: operator.replaceAll('_', ' '), value: operator }))
}

export function filterNeedsValue(filter: Pick<EditableViewFilter, 'operator'>): boolean {
  return filter.operator !== 'is_empty' && filter.operator !== 'is_not_empty'
}

/** Whether the value is picked from the field's options rather than typed. */
export function filterUsesChoice(fields: DatabaseFieldDTO[], filter: EditableViewFilter): boolean {
  const type = filterFieldFor(fields, filter)?.type
  return filterNeedsValue(filter) && (type === 'multi_select' || (type === 'select' && filter.operator !== 'contains'))
}

export function filterUsesPerson(fields: DatabaseFieldDTO[], filter: EditableViewFilter): boolean {
  return filterNeedsValue(filter) && filterFieldFor(fields, filter)?.type === 'person'
}

/** Keeps a filter row consistent after its field or condition changes. */
export function normalizeEditableFilter(fields: DatabaseFieldDTO[], filter: EditableViewFilter): void {
  const allowed = filterOperatorOptionsFor(fields, filter)
  if (!allowed.some(option => option.value === filter.operator)) filter.operator = allowed[0]?.value ?? 'is_not_empty'
  const field = filterFieldFor(fields, filter)
  if (field?.type === 'boolean' && !['true', 'false'].includes(filter.value)) filter.value = ''
  if (filterUsesChoice(fields, filter) && !field?.options.includes(filter.value)) filter.value = ''
  if (!filterNeedsValue(filter)) filter.value = ''
}

export function filterValueFor(fields: DatabaseFieldDTO[], filter: EditableViewFilter): DatabaseScalarValue {
  const field = filterFieldFor(fields, filter)
  if (field?.type === 'number') return Number(filter.value)
  if (field?.type === 'boolean') return filter.value === 'true'
  return filter.value
}

export function filterComplete(fields: DatabaseFieldDTO[], filter: EditableViewFilter): boolean {
  return Boolean(filter.fieldId) && (!filterNeedsValue(filter) || filter.value !== '')
}

export { isTextLikeFieldType }
