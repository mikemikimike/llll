<script setup lang="ts">
import { navigateTo, errorMessage } from '#imports'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { Permission } from '~~/shared/permissions'
import { refDebounced } from '@vueuse/core'
import { DatabaseColumnWidth, DatabaseSlotCounts, databaseSlotPool, defaultDatabaseViewConfig, hasFieldOptions, type DatabaseFieldType, type DatabaseValue, type DatabaseViewConfig, type DatabaseViewFilter, type DatabaseViewLayout, type DatabaseViewSort } from '~~/shared/database'
import { databasePath } from '~~/shared/paths'
import type { DataResourcesDTO, DatabaseDTO, DatabaseFieldDTO, DatabaseItemDTO, DatabasePageDTO, DatabaseViewDTO, LinkedRecordDTO, MemberDTO, PublicUser } from '~~/shared/types'
import { fieldIcon, fieldTypeChoices, fieldTypeLabel, filterComplete, filterNeedsValue, filterValueFor, viewIcon, viewLayoutChoices, type EditableViewFilter } from '~/utils/database-fields'

definePageMeta({ layout: 'server', middleware: ['auth', 'manage-databases'] })

const { serverId } = useServer()
const { can } = useRoleGrants()
const isMobile = useIsMobile()
const { api } = useApi()
const route = useRoute()
const nav = useNavActions()
const qc = useQueryClient()
const toast = useToast()

const showArchived = computed({
  get: () => route.query.archived === '1',
  set: value => void navigateTo(databasePath(null, value)),
})
const selectedDatabaseId = computed({
  get: () => String(route.query.database || '') || null,
  set: value => void navigateTo(databasePath(value, showArchived.value)),
})
const selectedViewId = computed({
  get: () => String(route.query.view || '') || null,
  set: value => void navigateTo(databasePath(selectedDatabaseId.value, showArchived.value, value)),
})
/** A record opened as a page keeps its id in the URL, so a link to it opens it. */
const selectedRecordId = computed({
  get: () => String(route.query.record || '') || null,
  set: value => void navigateTo(databasePath(selectedDatabaseId.value, showArchived.value, selectedViewId.value, value), { replace: Boolean(value) === Boolean(selectedRecordId.value) }),
})
const resourcesQ = useQuery({
  queryKey: computed(() => ['data-resources', serverId.value]),
  queryFn: () => api<DataResourcesDTO>(`/api/servers/${serverId.value}/data-resources`),
  enabled: computed(() => Boolean(serverId.value)),
  refetchInterval: 10_000,
})
const allDatabases = computed(() => resourcesQ.data.value?.databases ?? [])
const databases = computed(() => allDatabases.value.filter(database => Boolean(database.archivedAt) === showArchived.value))
const activeDatabaseSummary = computed(() => databases.value.find(database => database.id === selectedDatabaseId.value) ?? databases.value[0] ?? null)

const search = ref('')
const debouncedSearch = refDebounced(search, 250)
const page = ref(1)
const pageSize = 100
const calendarCursor = ref(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
function localDateKey(date: Date) {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
const calendarRange = computed(() => {
  const from = new Date(calendarCursor.value.getFullYear(), calendarCursor.value.getMonth(), 1)
  from.setDate(from.getDate() - from.getDay())
  const to = new Date(from)
  to.setDate(from.getDate() + 41)
  return { from: localDateKey(from), to: localDateKey(to) }
})
const databaseKey = computed(() => ['database', activeDatabaseSummary.value?.id, selectedViewId.value, debouncedSearch.value, page.value, calendarRange.value.from, calendarRange.value.to] as const)
const databaseQ = useQuery({
  queryKey: databaseKey,
  queryFn: () => api<DatabasePageDTO>(`/api/databases/${activeDatabaseSummary.value!.id}`, {
    query: {
      view: selectedViewId.value || undefined,
      search: debouncedSearch.value,
      page: page.value,
      pageSize,
      dateFrom: calendarRange.value.from,
      dateTo: calendarRange.value.to,
    },
  }),
  enabled: computed(() => Boolean(activeDatabaseSummary.value?.id)),
  refetchInterval: 10_000,
  // Opening a database without a view in the URL loads its first view, and the
  // page then adds that view to the URL. Keep the table on screen through it.
  placeholderData: previous => previous?.database.id === activeDatabaseSummary.value?.id && previous?.view.id === selectedViewId.value ? previous : undefined,
})
const activeDatabase = computed<DatabaseDTO | null>(() => databaseQ.data.value
  ? { ...databaseQ.data.value.database, items: databaseQ.data.value.items }
  : null)
const views = computed(() => databaseQ.data.value?.views ?? [])
const activeView = computed(() => databaseQ.data.value?.view ?? null)
const membersQ = useQuery({
  queryKey: computed(() => ['members', serverId.value]),
  queryFn: () => api<{ members: MemberDTO[] }>(`/api/servers/${serverId.value}/members`),
  enabled: computed(() => Boolean(serverId.value)),
})
const members = computed(() => membersQ.data.value?.members ?? [])
const membersById = computed<Record<string, PublicUser>>(() => Object.fromEntries(members.value.map(member => [member.user.id, member.user])))
/** Titles of linked records: the page's, plus records picked here before the next load. */
const linkedCache = ref<Record<string, LinkedRecordDTO>>({})
const linked = computed<Record<string, LinkedRecordDTO>>(() => ({ ...databaseQ.data.value?.linked, ...linkedCache.value }))
function rememberLinked(records: LinkedRecordDTO[]) {
  if (records.length) linkedCache.value = { ...linkedCache.value, ...Object.fromEntries(records.map(record => [record.id, record])) }
}
const visibleFields = computed(() => {
  const fields = activeDatabase.value?.fields ?? []
  const visible = activeView.value?.config.visibleFieldIds
  return visible === null || visible === undefined ? fields : fields.filter(field => visible.includes(field.id))
})
/**
 * Column widths belong to the view, like Notion. Dragging updates them locally;
 * the view saves once the drag settles, and polls do not undo a width mid-drag.
 */
const columnWidths = ref<Record<string, number>>({})
let widthsDirty = false
let widthTimer: ReturnType<typeof setTimeout> | undefined
watch(() => activeView.value?.config.columnWidths, (widths) => {
  if (!widthsDirty) columnWidths.value = { ...widths }
}, { immediate: true })
watch(() => activeView.value?.id, () => {
  clearTimeout(widthTimer)
  widthsDirty = false
  columnWidths.value = { ...activeView.value?.config.columnWidths }
})
function columnWidth(key: string) {
  return columnWidths.value[key] ?? (key === 'title' ? DatabaseColumnWidth.title : DatabaseColumnWidth.field)
}
function setColumnWidth(key: string, width: number) {
  widthsDirty = true
  columnWidths.value = { ...columnWidths.value, [key]: Math.round(width) }
}
const tableWidth = computed(() => 48 + 40 + columnWidth('title') + visibleFields.value.reduce((sum, field) => sum + columnWidth(field.id), 0))

function saveColumnWidths() {
  clearTimeout(widthTimer)
  widthTimer = setTimeout(() => void persistColumnWidths(), 400)
}

async function persistColumnWidths(retry = true) {
  const view = activeView.value
  if (!view) return
  try {
    const { view: saved } = await api<{ view: DatabaseViewDTO }>(`/api/database-views/${view.id}`, {
      method: 'PATCH',
      body: { config: { ...view.config, columnWidths: { ...columnWidths.value } }, version: view.version },
    })
    qc.setQueryData<DatabasePageDTO>(databaseKey.value, old => old
      ? { ...old, view: old.view.id === saved.id ? saved : old.view, views: old.views.map(candidate => candidate.id === saved.id ? saved : candidate) }
      : old)
    widthsDirty = false
  }
  catch (error) {
    // The view changed elsewhere, for example a filter; widths apply on top of it.
    if (retry && isConflict(error)) {
      await databaseQ.refetch()
      return persistColumnWidths(false)
    }
    widthsDirty = false
    toast.add({ title: errorMessage(error), color: 'error' })
  }
}

const saving = ref(false)
/**
 * Records created in this view stay in it until you leave, even when they do not
 * match its filters, like Notion. Otherwise a new record would vanish on the next poll.
 */
const createdHere = ref(new Map<string, DatabaseItemDTO>())
// Separate sources compare by value; one getter returning an array would fire on every poll.
watch([() => activeDatabaseSummary.value?.id, selectedViewId, showArchived], () => {
  createdHere.value = new Map()
})

/** Replaces one record in the loaded page without reloading the database. */
function putItem(item: DatabaseItemDTO) {
  if (createdHere.value.has(item.id)) createdHere.value = new Map(createdHere.value).set(item.id, item)
  qc.setQueryData<DatabasePageDTO>(databaseKey.value, old => old
    ? { ...old, items: old.items.map(candidate => candidate.id === item.id ? item : candidate) }
    : old)
}

function isConflict(error: unknown) {
  return (error as { statusCode?: number, status?: number })?.statusCode === 409
    || (error as { status?: number })?.status === 409
}

const rowEdits = useDatabaseEdits(
  async (id, patch) => {
    const send = (version: number) => api<{ item: DatabaseItemDTO }>(`/api/database-items/${id}`, { method: 'PATCH', body: { ...patch, version } })
    try {
      return (await send(patch.version)).item
    }
    catch (error) {
      // Someone else saved this record first. Edits are per field, so apply this
      // change on top of the latest version once instead of stranding it.
      if (!isConflict(error)) throw error
      const latest = (await databaseQ.refetch()).data?.items.find(candidate => candidate.id === id)
      if (!latest) throw error
      return (await send(latest.version)).item
    }
  },
  // The saved record comes back with the response; the 10-second poll covers other changes.
  item => putItem(item),
)
onBeforeRouteUpdate(() => rowEdits.flush())
onBeforeRouteLeave(() => rowEdits.flush())
function beforeUnload(event: BeforeUnloadEvent) {
  if (!rowEdits.isDirty()) return
  event.preventDefault()
  event.returnValue = ''
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))

async function retryItem(item: DatabaseItemDTO) {
  const result = await databaseQ.refetch()
  const latest = result.data?.items.find(candidate => candidate.id === item.id)
  if (result.error || !latest) {
    toast.add({ title: result.error ? errorMessage(result.error) : 'This record is no longer available.', color: 'error' })
    return
  }
  await rowEdits.retry(latest)
}

const showDatabaseForm = ref(false)
const databaseName = ref('')
const editingDatabaseId = ref<string | null>(null)
const showFieldForm = ref(false)
const fieldName = ref('')
const fieldType = ref<DatabaseFieldType>('text')
const fieldOptions = ref('')
const fieldRelationDatabaseId = ref('')
const editingFieldId = ref<string | null>(null)
/** Databases a relation may point at, this one included. */
const relationTargets = computed(() => allDatabases.value.filter(database => !database.archivedAt).map(database => ({ label: database.name, value: database.id })))
const showViewForm = ref(false)
const editingViewId = ref<string | null>(null)
const viewName = ref('')
const viewLayout = ref<DatabaseViewLayout>('table')
const viewVisibleFieldIds = ref<string[]>([])
const viewSorts = ref<DatabaseViewSort[]>([])
const viewFilters = ref<EditableViewFilter[]>([])
const viewGroupFieldId = ref('')
const viewDateFieldId = ref('')
const showConfirm = ref(false)
const confirmTitle = ref('')
const confirmAction = shallowRef<null | (() => Promise<void>)>(null)

const fields = computed(() => activeDatabase.value?.fields ?? [])
const loadedItemIds = computed(() => new Set(activeDatabase.value?.items.map(item => item.id) ?? []))
/** Records created here that the view's filters leave out; they show until you leave. */
const outsideView = computed(() => [...createdHere.value.values()].filter(item => !loadedItemIds.value.has(item.id)))
const visibleItems = computed(() => [...activeDatabase.value?.items ?? [], ...outsideView.value].map(rowEdits.display))
/** Marked only in filtered views; elsewhere a record missing from the page is on another page. */
const outsideViewIds = computed(() => new Set(activeView.value?.config.filters.length ? outsideView.value.map(item => item.id) : []))
const selectFields = computed(() => activeDatabase.value?.fields.filter(field => field.type === 'select') ?? [])
const dateFields = computed(() => activeDatabase.value?.fields.filter(field => field.type === 'date') ?? [])
const boardField = computed(() => activeDatabase.value?.fields.find(field => field.id === activeView.value?.config.groupFieldId) ?? null)
const boardGroups = computed(() => {
  const field = boardField.value
  if (!field) return []
  const counts = databaseQ.data.value?.groupCounts ?? {}
  return [...field.options.map(option => ({ key: option, label: option, total: counts[option] ?? 0, items: visibleItems.value.filter(item => item.values[field.id] === option) })), {
    key: '', label: 'No value', total: counts[''] ?? 0, items: visibleItems.value.filter(item => !item.values[field.id]),
  }]
})
const calendarDays = computed(() => {
  const start = new Date(`${calendarRange.value.from}T00:00:00`)
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    const key = localDateKey(date)
    const fieldId = activeView.value?.config.dateFieldId
    return { date, key, current: date.getMonth() === calendarCursor.value.getMonth(), items: fieldId ? visibleItems.value.filter(item => item.values[fieldId] === key) : [] }
  })
})
const calendarTitle = computed(() => calendarCursor.value.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))
const canSaveView = computed(() => Boolean(
  viewName.value.trim()
  && viewFilters.value.every(filter => filterComplete(fields.value, filter))
  && viewSorts.value.every(sort => sort.fieldId)
  && (viewLayout.value !== 'board' || viewGroupFieldId.value)
  && (viewLayout.value !== 'calendar' || viewDateFieldId.value),
))

/**
 * Changes made from the toolbar save on their own, like Notion: a filter, a sort
 * or a hidden property applies as soon as it is complete. A concurrent change to
 * the view is reloaded once and this change applied on top of it.
 */
async function patchViewConfig(partial: Partial<DatabaseViewConfig>, retry = true): Promise<boolean> {
  const view = activeView.value
  if (!view) return false
  try {
    const { view: saved } = await api<{ view: DatabaseViewDTO }>(`/api/database-views/${view.id}`, {
      method: 'PATCH',
      body: { config: { ...view.config, columnWidths: { ...columnWidths.value }, ...partial }, version: view.version },
    })
    qc.setQueryData<DatabasePageDTO>(databaseKey.value, old => old
      ? { ...old, view: old.view.id === saved.id ? saved : old.view, views: old.views.map(candidate => candidate.id === saved.id ? saved : candidate) }
      : old)
    void qc.invalidateQueries({ queryKey: ['database', activeDatabaseSummary.value?.id] })
    return true
  }
  catch (error) {
    if (retry && isConflict(error)) {
      await databaseQ.refetch()
      return patchViewConfig(partial, false)
    }
    toast.add({ title: errorMessage(error), color: 'error' })
    return false
  }
}
const quickFilters = ref<EditableViewFilter[]>([])
const quickSorts = ref<DatabaseViewSort[]>([])
const quickFiltersOpen = ref(false)
const quickSortsOpen = ref(false)
const propertiesOpen = ref(false)
watch(quickFiltersOpen, (open) => {
  if (open) quickFilters.value = editableFilters(activeView.value?.config.filters ?? [])
})
watch(quickSortsOpen, (open) => {
  if (open) quickSorts.value = (activeView.value?.config.sorts ?? []).map(sort => ({ ...sort }))
})
let quickTimer: ReturnType<typeof setTimeout> | undefined
function scheduleQuickSave(partial: () => Partial<DatabaseViewConfig>) {
  clearTimeout(quickTimer)
  quickTimer = setTimeout(() => void patchViewConfig(partial()), 500)
}
watch(quickFilters, () => {
  if (!quickFiltersOpen.value) return
  // An unfinished row waits; the others apply right away.
  const complete = quickFilters.value.filter(filter => filterComplete(fields.value, filter))
  const next = complete.map(toViewFilter)
  if (JSON.stringify(next) === JSON.stringify(activeView.value?.config.filters ?? [])) return
  scheduleQuickSave(() => ({ filters: next }))
}, { deep: true })
watch(quickSorts, () => {
  if (!quickSortsOpen.value) return
  const next = quickSorts.value.map(sort => ({ ...sort }))
  if (JSON.stringify(next) === JSON.stringify(activeView.value?.config.sorts ?? [])) return
  scheduleQuickSave(() => ({ sorts: next }))
}, { deep: true })
function editableFilters(filters: DatabaseViewFilter[]): EditableViewFilter[] {
  return filters.map(filter => ({ fieldId: filter.fieldId, operator: filter.operator, value: filter.value === undefined || filter.value === null ? '' : String(filter.value) }))
}
function toViewFilter(filter: EditableViewFilter): DatabaseViewFilter {
  return { fieldId: filter.fieldId, operator: filter.operator, ...(filterNeedsValue(filter) ? { value: filterValueFor(fields.value, filter) } : {}) }
}
function setFieldVisible(fieldId: string, visible: boolean) {
  const current = activeView.value?.config.visibleFieldIds ?? fields.value.map(field => field.id)
  const next = visible ? [...new Set([...current, fieldId])] : current.filter(id => id !== fieldId)
  void patchViewConfig({ visibleFieldIds: next.length === fields.value.length ? null : next })
}

/** The record open as a page: from the loaded page when it is there, otherwise on its own. */
const recordQ = useQuery({
  queryKey: computed(() => ['database-item', selectedRecordId.value] as const),
  queryFn: () => api<{ item: DatabaseItemDTO; linked: Record<string, LinkedRecordDTO> }>(`/api/database-items/${selectedRecordId.value}`),
  enabled: computed(() => Boolean(selectedRecordId.value) && !visibleItems.value.some(item => item.id === selectedRecordId.value)),
})
watch(() => recordQ.data.value?.linked, records => { if (records) rememberLinked(Object.values(records)) })
const panelItem = computed(() => {
  const id = selectedRecordId.value
  if (!id) return null
  return visibleItems.value.find(item => item.id === id) ?? (recordQ.data.value?.item.id === id ? rowEdits.display(recordQ.data.value.item) : null)
})
const panelOpen = computed({
  get: () => Boolean(selectedRecordId.value),
  set: (open) => { if (!open) selectedRecordId.value = null },
})
function openRecord(item: DatabaseItemDTO) {
  selectedRecordId.value = item.id
}
function updateRecord(item: DatabaseItemDTO, patch: { title?: string; values?: Record<string, DatabaseValue> }) {
  rowEdits.update(item, patch)
}
const draggedItemId = ref<string | null>(null)

watch([databases, selectedDatabaseId], ([list, id]) => {
  if (!id || !list.length || list.some(database => database.id === id)) return
  selectedDatabaseId.value = list[0]?.id ?? null
}, { immediate: true })

watch([activeDatabaseSummary, selectedViewId], ([database, viewId]) => {
  const first = database?.views[0]
  if (database && first && (!viewId || !database.views.some(view => view.id === viewId))) {
    // A link to one record arrives without a view; keep the record while the first view is added.
    void navigateTo(databasePath(database.id, showArchived.value, first.id, selectedRecordId.value), { replace: true })
  }
}, { immediate: true })
watch([selectedDatabaseId, selectedViewId, debouncedSearch], () => { page.value = 1 })

watch(() => nav.createDatabaseOpen.value, (open) => {
  if (!open) return
  nav.createDatabaseOpen.value = false
  openCreateDatabase()
})

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement).value
}

async function refresh() {
  await Promise.all([qc.invalidateQueries({ queryKey: ['database'] }), qc.invalidateQueries({ queryKey: ['data-resources'] })])
}

/** Runs a change and refreshes in the background, so its dialog can close as soon as it is saved. */
async function mutate(action: () => Promise<unknown>, success?: string) {
  if (saving.value) return false
  saving.value = true
  try {
    await action()
    if (success) toast.add({ title: success, color: 'success' })
    void refresh()
    return true
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
    return false
  }
  finally {
    saving.value = false
  }
}

function openCreateDatabase() {
  editingDatabaseId.value = null
  databaseName.value = ''
  showDatabaseForm.value = true
}

function openRenameDatabase() {
  const database = activeDatabase.value
  if (!database) return
  editingDatabaseId.value = database.id
  databaseName.value = database.name
  showDatabaseForm.value = true
}

async function saveDatabase() {
  const name = databaseName.value.trim()
  if (!name || !serverId.value) return
  const editing = editingDatabaseId.value
  let createdId: string | null = null
  const ok = await mutate(async () => {
    if (editing) await api(`/api/databases/${editing}`, { method: 'PATCH', body: { name } })
    else {
      const result = await api<{ database: DatabaseDTO }>(`/api/servers/${serverId.value}/databases`, { method: 'POST', body: { name } })
      createdId = result.database.id
    }
  }, editing ? 'Database renamed' : 'Database created')
  if (!ok) return
  showDatabaseForm.value = false
  // Open the new database once the list knows it; an unknown id falls back to the first database.
  if (createdId) {
    await refresh()
    await navigateTo(databasePath(createdId))
  }
}

async function archiveDatabase() {
  const database = activeDatabase.value
  if (!database) return
  await mutate(() => api(`/api/databases/${database.id}`, { method: 'PATCH', body: { archived: !database.archivedAt } }), database.archivedAt ? 'Database restored' : 'Database archived')
}

function deleteDatabase() {
  const database = activeDatabase.value
  if (!database) return
  askConfirm(`Delete ${database.name}?`, async () => {
    await mutate(() => api(`/api/databases/${database.id}`, { method: 'DELETE' }), 'Database deleted')
  })
}

function openCreateField() {
  if (!activeDatabase.value) return
  editingFieldId.value = null
  fieldName.value = ''
  fieldType.value = 'text'
  fieldOptions.value = ''
  fieldRelationDatabaseId.value = activeDatabase.value.id
  showFieldForm.value = true
}

function openEditField(field: DatabaseFieldDTO) {
  editingFieldId.value = field.id
  fieldName.value = field.name
  fieldType.value = field.type
  fieldOptions.value = field.options.join(', ')
  fieldRelationDatabaseId.value = field.relation?.databaseId ?? ''
  showFieldForm.value = true
}

/** What a new field sends: its options for a select, its target for a relation. */
function fieldBody(name: string) {
  const options = fieldOptions.value.split(',').map(option => option.trim()).filter(Boolean)
  return {
    name,
    type: fieldType.value,
    options: hasFieldOptions(fieldType.value) ? options : [],
    ...(fieldType.value === 'relation' ? { relation: { databaseId: fieldRelationDatabaseId.value } } : {}),
  }
}
const fieldFormComplete = computed(() => Boolean(fieldName.value.trim()) && (fieldType.value !== 'relation' || Boolean(fieldRelationDatabaseId.value)))

async function saveField() {
  const database = activeDatabase.value
  const name = fieldName.value.trim()
  if (!database || !name) return
  const editing = editingFieldId.value
  const body = editing
    ? { name, ...(hasFieldOptions(fieldType.value) ? { options: fieldBody(name).options } : {}) }
    : fieldBody(name)
  const ok = await mutate(
    () => editing
      ? api(`/api/database-fields/${editing}`, { method: 'PATCH', body })
      : api(`/api/databases/${database.id}/fields`, { method: 'POST', body }),
    editing ? 'Field updated' : 'Field created',
  )
  if (ok) showFieldForm.value = false
}

function deleteField(field: DatabaseFieldDTO) {
  askConfirm(`Delete ${field.name}?`, async () => {
    await mutate(() => api(`/api/database-fields/${field.id}`, { method: 'DELETE' }), 'Field deleted')
  })
}

async function moveField(field: DatabaseFieldDTO, direction: -1 | 1) {
  const fields = activeDatabase.value?.fields ?? []
  const index = fields.findIndex(candidate => candidate.id === field.id)
  const other = fields[index + direction]
  if (!other) return
  await mutate(() => Promise.all([
    api(`/api/database-fields/${field.id}`, { method: 'PATCH', body: { position: other.position } }),
    api(`/api/database-fields/${other.id}`, { method: 'PATCH', body: { position: field.position } }),
  ]))
}

function openCreateView() {
  const fields = activeDatabase.value?.fields ?? []
  editingViewId.value = null
  viewName.value = ''
  viewLayout.value = 'table'
  viewVisibleFieldIds.value = fields.map(field => field.id)
  viewSorts.value = [{ fieldId: 'title', direction: 'asc' }]
  viewFilters.value = []
  viewGroupFieldId.value = selectFields.value[0]?.id ?? ''
  viewDateFieldId.value = dateFields.value[0]?.id ?? ''
  showViewForm.value = true
}

function openEditView(view: DatabaseViewDTO) {
  const fields = activeDatabase.value?.fields ?? []
  editingViewId.value = view.id
  viewName.value = view.name
  viewLayout.value = view.layout
  viewVisibleFieldIds.value = view.config.visibleFieldIds === null ? fields.map(field => field.id) : [...view.config.visibleFieldIds]
  viewSorts.value = view.config.sorts.map(sort => ({ ...sort }))
  viewFilters.value = editableFilters(view.config.filters)
  viewGroupFieldId.value = view.config.groupFieldId ?? ''
  viewDateFieldId.value = view.config.dateFieldId ?? ''
  showViewForm.value = true
}

async function saveView() {
  const database = activeDatabase.value
  const name = viewName.value.trim()
  if (!database || !name) return
  const current = editingViewId.value ? views.value.find(view => view.id === editingViewId.value) : null
  const allFieldIds = database.fields.map(field => field.id)
  const config = defaultDatabaseViewConfig()
  config.visibleFieldIds = viewVisibleFieldIds.value.length === allFieldIds.length ? null : [...viewVisibleFieldIds.value]
  config.sorts = viewSorts.value.map(sort => ({ ...sort }))
  config.filters = viewFilters.value.map(toViewFilter)
  config.groupFieldId = viewLayout.value === 'board' ? viewGroupFieldId.value || null : null
  config.dateFieldId = viewLayout.value === 'calendar' ? viewDateFieldId.value || null : null
  config.columnWidths = { ...current?.config.columnWidths }
  let createdId: string | null = null
  const ok = await mutate(async () => {
    if (current) {
      await api(`/api/database-views/${current.id}`, { method: 'PATCH', body: { name, layout: viewLayout.value, config, version: current.version } })
    }
    else {
      const result = await api<{ view: DatabaseViewDTO }>(`/api/databases/${database.id}/views`, { method: 'POST', body: { name, layout: viewLayout.value, config } })
      createdId = result.view.id
    }
  }, current ? 'View updated' : 'View created')
  if (!ok) return
  showViewForm.value = false
  if (createdId) await navigateTo(databasePath(database.id, false, createdId))
}

function deleteView(view: DatabaseViewDTO) {
  askConfirm(`Delete ${view.name}?`, async () => {
    const removed = await mutate(() => api(`/api/database-views/${view.id}`, { method: 'DELETE' }), 'View deleted')
    if (removed) {
      const next = views.value.find(candidate => candidate.id !== view.id)
      await navigateTo(databasePath(view.databaseId, false, next?.id), { replace: true })
    }
  })
}

function toggleVisibleField(fieldId: string, visible: boolean) {
  viewVisibleFieldIds.value = visible
    ? [...new Set([...viewVisibleFieldIds.value, fieldId])]
    : viewVisibleFieldIds.value.filter(id => id !== fieldId)
}

function changeCalendarMonth(direction: -1 | 1) {
  calendarCursor.value = new Date(calendarCursor.value.getFullYear(), calendarCursor.value.getMonth() + direction, 1)
  page.value = 1
}

function dropBoard(group: string) {
  if (!can(Permission.writeData)) return
  const item = visibleItems.value.find(candidate => candidate.id === draggedItemId.value)
  const field = boardField.value
  draggedItemId.value = null
  if (item && field) void updateFieldValue(item, field, group || null)
}

/**
 * The table ends in a "New record" row, like Notion: type a title and press
 * Enter to create the record with it. The row shows immediately while it saves,
 * and the field stays focused for the next one.
 */
const newRecordTitle = ref('')

function focusNewRecord() {
  void nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('[data-new-record] input')
    input?.scrollIntoView({ block: 'nearest' })
    input?.focus()
  })
}

/**
 * Values that make a new record match the view's filters where one value clearly
 * does, like Notion: "Status is Done" starts the record as Done. Title filters and
 * ranges are left alone; those records still stay visible until you leave the view.
 */
function filterDefaults(): Record<string, DatabaseValue> {
  const values: Record<string, DatabaseValue> = {}
  const fields = new Map(activeDatabase.value?.fields.map(field => [field.id, field]) ?? [])
  for (const filter of activeView.value?.config.filters ?? []) {
    const field = fields.get(filter.fieldId)
    if (!field || filter.value === undefined || filter.value === null || filter.fieldId in values) continue
    if (filter.operator === 'equals' || (filter.operator === 'contains' && field.type === 'text')) values[field.id] = filter.value
  }
  return values
}

const newRecords = useNewRecords(
  async (databaseId, title, values) => (await api<{ item: DatabaseItemDTO }>(`/api/databases/${databaseId}/items`, { method: 'POST', body: { title, values } })).item,
  {
    onCreated(databaseId, item) {
      void qc.invalidateQueries({ queryKey: ['data-resources'] })
      const key = databaseKey.value
      if (key[1] !== databaseId) return
      createdHere.value = new Map(createdHere.value).set(item.id, item)
      const page = qc.getQueryData<DatabasePageDTO>(key)
      // The view changed or is loading while the record saved; that load may predate it.
      if (!page || databaseQ.isFetching.value) {
        void qc.invalidateQueries({ queryKey: ['database', databaseId] })
        return
      }
      if (!page.items.some(existing => existing.id === item.id)) qc.setQueryData<DatabasePageDTO>(key, { ...page, items: [...page.items, item], total: page.total + 1 })
    },
    onFailed(title, error) {
      toast.add({ title: errorMessage(error), color: 'error' })
      if (!newRecordTitle.value) newRecordTitle.value = title
    },
    // Once a burst of typed records has saved, reload the view so the ones its
    // filters leave out are marked; they stay on screen through createdHere.
    onIdle() {
      if (activeView.value?.config.filters.length) void databaseQ.refetch()
    },
  },
)
const pendingRecords = computed(() => newRecords.pending.value.filter(record => record.databaseId === activeDatabase.value?.id))

function submitNewRecord() {
  const title = newRecordTitle.value.trim()
  const database = activeDatabase.value
  if (!title || !database) return
  newRecordTitle.value = ''
  void newRecords.submit(database.id, title, filterDefaults())
}

/** + Record: in a table, go to the New record row; elsewhere add an "Untitled" record. */
async function addItem() {
  if (activeView.value?.layout === 'table') {
    focusNewRecord()
    return
  }
  const database = activeDatabase.value
  if (database) await newRecords.submit(database.id, 'Untitled', filterDefaults())
}

async function updateTitle(item: DatabaseItemDTO, event: Event) {
  const title = inputValue(event).trim()
  if (!title || title === item.title) return
  rowEdits.update(item, { title })
}

async function updateFieldValue(item: DatabaseItemDTO, field: DatabaseFieldDTO, value: DatabaseValue) {
  if (JSON.stringify(item.values[field.id] ?? null) === JSON.stringify(value ?? null)) return
  rowEdits.update(item, { values: { [field.id]: value } })
}

function deleteItem(item: DatabaseItemDTO) {
  askConfirm(`Delete ${item.title}?`, async () => {
    const removed = await mutate(() => api(`/api/database-items/${item.id}`, { method: 'DELETE' }))
    if (!removed) return
    if (selectedRecordId.value === item.id) selectedRecordId.value = null
    rowEdits.discard(item)
    if (createdHere.value.has(item.id)) {
      const next = new Map(createdHere.value)
      next.delete(item.id)
      createdHere.value = next
    }
    qc.setQueryData<DatabasePageDTO>(databaseKey.value, old => old
      ? { ...old, items: old.items.filter(candidate => candidate.id !== item.id), total: Math.max(0, old.total - 1) }
      : old)
  })
}

function askConfirm(title: string, action: () => Promise<void>) {
  confirmTitle.value = title
  confirmAction.value = action
  showConfirm.value = true
}

async function confirmMutation() {
  if (!confirmAction.value) return
  await confirmAction.value()
  showConfirm.value = false
  confirmAction.value = null
}

/** + in the table header: name, pick a type, and it is there. */
const newFieldOpen = ref(false)
watch(newFieldOpen, (open) => {
  if (!open) return
  editingFieldId.value = null
  fieldName.value = ''
  fieldType.value = 'text'
  fieldOptions.value = ''
  fieldRelationDatabaseId.value = activeDatabase.value?.id ?? ''
})
async function createFieldQuick() {
  const database = activeDatabase.value
  const name = fieldName.value.trim()
  if (!database || !name || !fieldFormComplete.value) return
  const ok = await mutate(() => api(`/api/databases/${database.id}/fields`, { method: 'POST', body: fieldBody(name) }), 'Field added')
  if (ok) newFieldOpen.value = false
}

function rowMenu(item: DatabaseItemDTO) {
  return [[
    { label: 'Delete', icon: 'i-ph-trash', color: 'error' as const, onSelect: () => deleteItem(item) },
  ]]
}

function fieldMenu(field: DatabaseFieldDTO) {
  const fields = activeDatabase.value?.fields ?? []
  const index = fields.findIndex(candidate => candidate.id === field.id)
  return [[
    { label: 'Edit', icon: 'i-ph-pencil-simple', onSelect: () => openEditField(field) },
    { label: 'Move left', icon: 'i-ph-arrow-left', disabled: index <= 0, onSelect: () => moveField(field, -1) },
    { label: 'Move right', icon: 'i-ph-arrow-right', disabled: index < 0 || index >= fields.length - 1, onSelect: () => moveField(field, 1) },
  ], [
    { label: 'Delete', icon: 'i-ph-trash', color: 'error' as const, onSelect: () => deleteField(field) },
  ]]
}

const databaseMenu = computed(() => [[
  { label: 'Rename', icon: 'i-ph-pencil-simple', onSelect: openRenameDatabase },
], [
  { label: activeDatabase.value?.archivedAt ? 'Restore' : 'Archive', icon: 'i-ph-archive', onSelect: archiveDatabase },
  { label: 'Delete', icon: 'i-ph-trash', color: 'error' as const, onSelect: deleteDatabase },
]])
const viewMenu = computed(() => activeView.value ? [[
  { label: 'View settings', icon: 'i-ph-sliders-horizontal', onSelect: () => openEditView(activeView.value!) },
  { label: 'Add field', icon: 'i-ph-plus', onSelect: openCreateField },
], [
  { label: 'Delete view', icon: 'i-ph-trash', color: 'error' as const, disabled: views.value.length <= 1, onSelect: () => deleteView(activeView.value!) },
]] : [])

function retryLoad() {
  return Promise.all([resourcesQ.refetch(), databaseQ.refetch()])
}
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-col">
    <main class="flex min-h-0 min-w-0 flex-1 flex-col">
      <LayoutPageHeader
        :icon="activeView ? viewIcon(activeView.layout) : 'i-ph-table'"
        :title="activeDatabase?.name || 'Data'"
        :loading="resourcesQ.isPending.value || (Boolean(activeDatabaseSummary) && databaseQ.isPending.value)"
      >
        <template #meta>
          <UBadge v-if="showArchived" label="Archived" color="neutral" variant="subtle" size="sm" />
        </template>
        <template #actions>
          <DataBookmarkButton v-if="activeView" :server-id="serverId" target-type="database_view" :target-id="activeView.id" />
          <UDropdownMenu v-if="activeDatabase && can(Permission.manageDatabases)" :items="databaseMenu">
            <UButton color="neutral" variant="ghost" icon="i-ph-dots-three" aria-label="Database actions" />
          </UDropdownMenu>
          <UButton v-if="!showArchived && activeDatabase && can(Permission.writeData)" icon="i-ph-plus" :label="isMobile ? undefined : 'Record'" aria-label="New record" @click="addItem" />
        </template>
      </LayoutPageHeader>

      <div v-if="resourcesQ.isPending.value || (activeDatabaseSummary && databaseQ.isPending.value)"><LayoutSkeleton variant="table" /></div>
      <LayoutLoadError v-else-if="resourcesQ.error.value || databaseQ.error.value" message="Data did not load." :retry="retryLoad" />
      <LayoutEmptyState v-else-if="!activeDatabase && showArchived" icon="i-ph-archive" title="Nothing archived" description="Databases you archive show up here." />
      <LayoutEmptyState v-else-if="!activeDatabase" icon="i-ph-table" title="No databases yet" description="A database holds structured records you can view as a table, board, calendar, or list.">
        <UButton v-if="can(Permission.manageDatabases)" icon="i-ph-plus" label="Create first database" @click="openCreateDatabase" />
      </LayoutEmptyState>
      <template v-else-if="activeView">
        <!-- One toolbar, like Notion: views on the left, tools on the right, all the same height. -->
        <div class="flex shrink-0 flex-wrap items-center gap-1 border-b border-default px-3 py-1.5">
          <div class="flex min-w-0 items-center gap-0.5 overflow-x-auto">
            <UButton
              v-for="view in views"
              :key="view.id"
              :label="view.name"
              :icon="viewIcon(view.layout)"
              color="neutral"
              :variant="view.id === activeView.id ? 'soft' : 'ghost'"
              size="sm"
              :class="view.id === activeView.id ? 'text-highlighted' : 'text-muted'"
              @click="navigateTo(databasePath(activeDatabase.id, showArchived, view.id))"
            />
            <UButton v-if="!showArchived" color="neutral" variant="ghost" size="sm" icon="i-ph-plus" :disabled="!can(Permission.manageDatabases)" aria-label="Create view" @click="openCreateView" />
          </div>
          <div class="ms-auto flex items-center gap-1">
            <!-- Filter, Sort and Properties open in place and apply as you change them, like Notion. -->
            <UPopover v-if="can(Permission.manageDatabases) && !showArchived" v-model:open="quickFiltersOpen" :content="{ align: 'end' }">
              <UButton :color="activeView.config.filters.length ? 'primary' : 'neutral'" variant="ghost" size="sm" icon="i-ph-funnel-simple" :label="isMobile ? undefined : activeView.config.filters.length ? `${activeView.config.filters.length} ${activeView.config.filters.length === 1 ? 'filter' : 'filters'}` : 'Filter'" aria-label="Filters" />
              <template #content><div class="w-[min(92vw,30rem)] p-3"><DataViewRules v-model:filters="quickFilters" :fields="fields" :members="members" show="filters" /></div></template>
            </UPopover>
            <UPopover v-if="can(Permission.manageDatabases) && !showArchived" v-model:open="quickSortsOpen" :content="{ align: 'end' }">
              <UButton :color="activeView.config.sorts.length ? 'primary' : 'neutral'" variant="ghost" size="sm" icon="i-ph-arrows-down-up" :label="isMobile ? undefined : activeView.config.sorts.length ? `${activeView.config.sorts.length} ${activeView.config.sorts.length === 1 ? 'sort' : 'sorts'}` : 'Sort'" aria-label="Sorts" />
              <template #content><div class="w-[min(92vw,28rem)] p-3"><DataViewRules v-model:sorts="quickSorts" :fields="fields" show="sorts" /></div></template>
            </UPopover>
            <UPopover v-if="can(Permission.manageDatabases) && !showArchived" v-model:open="propertiesOpen" :content="{ align: 'end' }">
              <UButton color="neutral" variant="ghost" size="sm" icon="i-ph-sliders-horizontal" :label="isMobile ? undefined : 'Properties'" aria-label="Properties" />
              <template #content>
                <div class="w-64 p-2">
                  <p class="px-2 pb-1 text-xs font-medium text-muted">Shown in this view</p>
                  <ul v-if="fields.length">
                    <li v-for="field in fields" :key="field.id" class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-elevated">
                      <UIcon :name="fieldIcon(field.type)" class="size-4 shrink-0 text-dimmed" />
                      <span class="min-w-0 flex-1 truncate text-sm">{{ field.name }}</span>
                      <USwitch size="xs" :model-value="visibleFields.some(candidate => candidate.id === field.id)" :aria-label="`Show ${field.name}`" @update:model-value="setFieldVisible(field.id, Boolean($event))" />
                    </li>
                  </ul>
                  <p v-else class="px-2 py-2 text-xs text-muted">No fields yet.</p>
                  <UButton label="Add field" icon="i-ph-plus" color="neutral" variant="ghost" size="xs" class="mt-1" @click="propertiesOpen = false; openCreateField()" />
                </div>
              </template>
            </UPopover>
            <UInput v-model="search" size="sm" icon="i-ph-magnifying-glass" placeholder="Search" aria-label="Search this view" class="w-28 sm:w-44" />
            <UDropdownMenu v-if="!showArchived && can(Permission.manageDatabases)" :items="viewMenu">
              <UButton color="neutral" variant="ghost" size="sm" icon="i-ph-sliders-horizontal" aria-label="View options" />
            </UDropdownMenu>
          </div>
        </div>

        <UAlert v-for="item in [...rowEdits.edits.values()].filter(edit => edit.item.databaseId === activeDatabase?.id && edit.error).map(edit => edit.item)" :key="item.id" color="error" :title="`${item.title}: changes not saved`" :description="errorMessage(rowEdits.edits.get(item.id)?.error)" class="mx-3 my-2">
          <template #actions>
            <UButton label="Save my changes" color="error" variant="soft" @click="retryItem(item)" />
            <UButton label="Discard my changes" color="neutral" variant="outline" @click="rowEdits.discard(item)" />
          </template>
        </UAlert>

        <div v-if="!visibleItems.length && activeView.layout !== 'calendar' && activeView.layout !== 'table'" class="grid min-h-0 flex-1 place-items-center p-6 text-sm text-muted">{{ search ? 'No matching records' : 'No records in this view' }}</div>
        <div v-else-if="activeView.layout === 'table'" class="min-h-0 flex-1 overflow-auto">
          <!-- Notion-like grid: borderless cells, row actions on hover, a New record row, and + to add a field. -->
          <table class="table-fixed border-separate border-spacing-0 text-sm" :style="{ width: `${tableWidth}px` }">
            <thead class="sticky top-0 z-10 bg-default">
              <tr>
                <th class="sticky start-0 z-20 w-12 border-b border-e border-default bg-default px-3 py-2 text-start text-xs font-medium text-dimmed">#</th>
                <th class="sticky start-12 z-20 border-b border-e border-default bg-default px-3 py-2 text-start" :style="{ width: `${columnWidth('title')}px` }">
                  <span class="flex items-center gap-1.5 text-xs font-medium text-muted"><UIcon name="i-ph-text-t" class="size-4" />Title</span>
                  <LayoutResizeHandle v-if="can(Permission.manageDatabases)" :model-value="columnWidth('title')" :min="DatabaseColumnWidth.min" :max="DatabaseColumnWidth.max" label="Resize Title column" @update:model-value="setColumnWidth('title', $event)" @end="saveColumnWidths" />
                </th>
                <th v-for="field in visibleFields" :key="field.id" class="relative border-b border-e border-default bg-default p-0 text-start" :style="{ width: `${columnWidth(field.id)}px` }">
                  <UDropdownMenu v-if="!showArchived && can(Permission.manageDatabases)" :items="fieldMenu(field)">
                    <button type="button" class="flex h-9 w-full items-center gap-1.5 px-3 text-xs font-medium text-muted hover:bg-elevated/60 hover:text-default">
                      <UIcon :name="fieldIcon(field.type)" class="size-4 shrink-0 text-dimmed" />
                      <span class="min-w-0 flex-1 truncate text-start">{{ field.name }}</span>
                    </button>
                  </UDropdownMenu>
                  <span v-else class="flex h-9 items-center gap-1.5 px-3 text-xs font-medium text-muted"><UIcon :name="fieldIcon(field.type)" class="size-4 shrink-0 text-dimmed" /><span class="truncate">{{ field.name }}</span></span>
                  <LayoutResizeHandle v-if="can(Permission.manageDatabases)" :model-value="columnWidth(field.id)" :min="DatabaseColumnWidth.min" :max="DatabaseColumnWidth.max" :label="`Resize ${field.name} column`" @update:model-value="setColumnWidth(field.id, $event)" @end="saveColumnWidths" />
                </th>
                <th class="w-10 border-b border-default bg-default px-1 text-start">
                  <UPopover v-if="!showArchived && can(Permission.manageDatabases)" v-model:open="newFieldOpen" :content="{ align: 'end' }">
                    <UButton color="neutral" variant="ghost" size="xs" icon="i-ph-plus" aria-label="Add field" />
                    <template #content>
                      <form class="w-64 space-y-2 p-2" @submit.prevent="createFieldQuick">
                        <UInput v-model="fieldName" size="sm" placeholder="Field name" aria-label="Field name" autofocus class="w-full" />
                        <div class="grid max-h-72 gap-0.5 overflow-y-auto" role="radiogroup" aria-label="Field type">
                          <button
                            v-for="choice in fieldTypeChoices"
                            :key="choice.value"
                            type="button"
                            role="radio"
                            :aria-checked="fieldType === choice.value"
                            class="flex items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm"
                            :class="fieldType === choice.value ? 'bg-accented text-highlighted' : 'text-default hover:bg-elevated'"
                            @click="fieldType = choice.value"
                          >
                            <UIcon :name="choice.icon" class="size-4 text-muted" />
                            <span class="min-w-0 flex-1 truncate">{{ choice.label }}</span>
                            <span class="truncate text-xs text-dimmed">{{ choice.hint }}</span>
                          </button>
                        </div>
                        <UInput v-if="hasFieldOptions(fieldType)" v-model="fieldOptions" size="sm" placeholder="Options, separated by commas" aria-label="Options" class="w-full" />
                        <USelect v-if="fieldType === 'relation'" v-model="fieldRelationDatabaseId" size="sm" :items="relationTargets" placeholder="Related database" aria-label="Related database" class="w-full" />
                        <UButton type="submit" block size="sm" label="Add field" :loading="saving" :disabled="!fieldFormComplete" />
                      </form>
                    </template>
                  </UPopover>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!visibleItems.length && search">
                <td :colspan="visibleFields.length + 3" class="border-b border-default px-4 py-6 text-center text-sm text-muted">No matching records</td>
              </tr>
              <tr v-for="(item, index) in visibleItems" :key="item.id" class="group">
                <td class="sticky start-0 z-[2] w-12 border-b border-e border-default bg-default px-1 text-center text-xs text-dimmed group-hover:bg-elevated/40">
                  <!-- The row number doubles as the row handle, like Notion; a dot means a change is saving. -->
                  <span class="flex h-9 items-center justify-center">
                    <span v-if="rowEdits.edits.get(item.id)?.saving" class="size-1.5 animate-pulse rounded-full bg-primary" aria-label="Saving" />
                    <template v-else>
                      <!-- Touch screens cannot hover, so they always get the row menu. -->
                      <span :class="showArchived ? '' : 'group-hover:hidden pointer-coarse:hidden'">{{ (page - 1) * pageSize + index + 1 }}</span>
                      <UDropdownMenu v-if="!showArchived && can(Permission.manageDatabases)" :items="rowMenu(item)">
                        <UButton class="hidden group-hover:inline-flex pointer-coarse:inline-flex" color="neutral" variant="ghost" size="xs" icon="i-ph-dots-three" :aria-label="`${item.title} actions`" />
                      </UDropdownMenu>
                    </template>
                  </span>
                </td>
                <td class="df-cell sticky start-12 z-[2] border-b border-e border-default bg-default group-hover:bg-elevated/40">
                  <div :data-record-title="item.id">
                    <UInput :model-value="item.title" variant="none" aria-label="Record title" :disabled="showArchived || !can(Permission.writeData)" class="w-full" :ui="{ base: 'h-9 px-3 pe-16 font-medium text-highlighted', trailing: 'pe-1.5' }" @change="updateTitle(item, $event)">
                      <template #trailing>
                        <UTooltip v-if="outsideViewIds.has(item.id)" text="Doesn't match this view's filters. It hides when you leave the view.">
                          <UIcon name="i-ph-eye-slash" class="size-4 text-dimmed" aria-label="Outside this view's filters" />
                        </UTooltip>
                        <!-- Open the record as a page, like Notion's OPEN on hover. -->
                        <UButton label="Open" icon="i-ph-arrows-out-simple" size="xs" color="neutral" variant="soft" class="hidden group-hover:inline-flex pointer-coarse:inline-flex" :aria-label="`Open ${item.title}`" @click="openRecord(item)" />
                      </template>
                    </UInput>
                  </div>
                </td>
                <td v-for="field in visibleFields" :key="field.id" class="df-cell border-b border-e border-default group-hover:bg-elevated/40">
                  <div class="flex min-h-9 items-center">
                    <DataFieldEditor :field="field" :value="item.values[field.id]" :members="members" :linked="linked" :disabled="showArchived || !can(Permission.writeData)" cell @update="updateFieldValue(item, field, $event)" @linked="rememberLinked" />
                  </div>
                </td>
                <td class="border-b border-default" />
              </tr>
              <tr v-for="record in pendingRecords" :key="`pending-${record.key}`" class="opacity-60">
                <td class="sticky start-0 z-[2] border-b border-e border-default bg-default"><span class="flex h-9 items-center justify-center"><span class="size-1.5 animate-pulse rounded-full bg-primary" /></span></td>
                <td class="sticky start-12 z-[2] truncate border-b border-e border-default bg-default px-3 font-medium">{{ record.title }}</td>
                <td :colspan="visibleFields.length + 1" class="border-b border-default" />
              </tr>
              <tr v-if="!showArchived && !search && can(Permission.writeData)">
                <td class="sticky start-0 z-[2] border-b border-e border-default bg-default text-dimmed"><span class="flex h-9 items-center justify-center"><UIcon name="i-ph-plus" class="size-3.5" /></span></td>
                <td class="df-cell sticky start-12 z-[2] border-b border-e border-default bg-default" data-new-record>
                  <UInput
                    v-model="newRecordTitle"
                    variant="none"
                    :placeholder="visibleItems.length ? 'New record' : 'Type a title to add the first record'"
                    aria-label="New record title"
                    class="w-full"
                    :ui="{ base: 'h-9 px-3' }"
                    @keydown.enter.prevent="submitNewRecord"
                    @blur="submitNewRecord"
                  />
                </td>
                <td :colspan="visibleFields.length + 1" class="border-b border-default" />
              </tr>
            </tbody>
          </table>
        </div>

        <div v-else-if="activeView.layout === 'list'" class="min-h-0 flex-1 overflow-y-auto p-3">
          <div class="divide-y divide-default rounded-lg border border-default">
            <div v-for="item in visibleItems" :key="item.id" class="group flex cursor-pointer items-center gap-4 px-4 py-3 hover:bg-elevated" @click="openRecord(item)">
              <UInput :model-value="item.title" :data-record-title="item.id" variant="none" aria-label="Record title" :disabled="showArchived || !can(Permission.writeData)" class="min-w-48 flex-1" :ui="{ base: 'px-0 font-medium' }" @click.stop @change="updateTitle(item, $event)" />
              <span v-for="field in visibleFields.slice(0, 3)" :key="field.id" class="hidden max-w-48 min-w-0 sm:block"><DataFieldValue :field="field" :value="item.values[field.id]" :members="membersById" :linked="linked" placeholder /></span>
              <UIcon name="i-ph-caret-right" class="size-4 shrink-0 text-dimmed" />
            </div>
          </div>
        </div>

        <div v-else-if="activeView.layout === 'board'" class="min-h-0 flex-1 overflow-auto p-3">
          <div class="flex min-h-full min-w-max gap-3">
            <section v-for="group in boardGroups" :key="group.key" class="w-72 shrink-0 rounded-lg bg-muted/60 p-2" @dragover.prevent @drop="dropBoard(group.key)">
              <header class="mb-2 flex items-center gap-2 px-1 text-sm font-medium"><span>{{ group.label }}</span><span class="text-xs text-dimmed">{{ group.total }}</span></header>
              <div class="space-y-2">
                <article v-for="item in group.items" :key="item.id" :draggable="!showArchived && can(Permission.writeData)" class="cursor-pointer rounded-md border border-default bg-default p-3 shadow-sm hover:bg-elevated/60" @dragstart="draggedItemId = item.id" @click="openRecord(item)">
                  <p class="font-medium">{{ item.title }}</p>
                  <dl class="mt-2 space-y-1 text-xs text-muted"><div v-for="field in visibleFields.filter(field => field.id !== boardField?.id).slice(0, 3)" :key="field.id" class="flex items-start gap-2"><dt class="shrink-0">{{ field.name }}</dt><dd class="ml-auto min-w-0 max-w-40 text-default"><DataFieldValue :field="field" :value="item.values[field.id]" :members="membersById" :linked="linked" placeholder /></dd></div></dl>
                </article>
              </div>
            </section>
          </div>
        </div>

        <div v-else-if="activeView.layout === 'gallery'" class="min-h-0 flex-1 overflow-y-auto p-3">
          <!-- Cards, like Notion's gallery: the title, then the visible fields with their names. -->
          <ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <li v-for="item in visibleItems" :key="item.id">
              <article class="flex h-full cursor-pointer flex-col gap-2 rounded-lg border border-default bg-default p-4 hover:bg-elevated/60" @click="openRecord(item)">
                <p class="truncate font-medium text-highlighted">{{ item.title }}</p>
                <dl class="space-y-1.5 text-xs">
                  <div v-for="field in visibleFields.slice(0, 5)" :key="field.id" class="flex items-start gap-2">
                    <dt class="flex w-24 shrink-0 items-center gap-1 truncate text-muted"><UIcon :name="fieldIcon(field.type)" class="size-3.5 shrink-0 text-dimmed" />{{ field.name }}</dt>
                    <dd class="min-w-0 flex-1"><DataFieldValue :field="field" :value="item.values[field.id]" :members="membersById" :linked="linked" placeholder /></dd>
                  </div>
                </dl>
              </article>
            </li>
          </ul>
        </div>

        <div v-else class="min-h-0 flex-1 overflow-auto p-3">
          <div class="mb-3 flex items-center gap-2"><UButton color="neutral" variant="ghost" icon="i-ph-caret-left" aria-label="Previous month" @click="changeCalendarMonth(-1)" /><span class="min-w-40 text-center font-medium">{{ calendarTitle }}</span><UButton color="neutral" variant="ghost" icon="i-ph-caret-right" aria-label="Next month" @click="changeCalendarMonth(1)" /></div>
          <div class="grid min-w-[700px] grid-cols-7 border-s border-t border-default text-xs">
            <div v-for="day in ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']" :key="day" class="border-b border-e border-default bg-muted px-2 py-1.5 font-medium text-muted">{{ day }}</div>
            <div v-for="day in calendarDays" :key="day.key" class="min-h-28 border-b border-e border-default p-1.5" :class="day.current ? 'bg-default' : 'bg-muted/30 text-dimmed'">
              <span>{{ day.date.getDate() }}</span>
              <div class="mt-1 space-y-1"><button v-for="item in day.items" :key="item.id" type="button" class="block w-full truncate rounded bg-primary/10 px-1.5 py-1 text-start text-default hover:bg-primary/20" @click="openRecord(item)">{{ item.title }}</button></div>
            </div>
          </div>
          <p class="mt-2 text-xs text-muted">Records without a date remain available from a table or list view.</p>
        </div>

        <div v-if="databaseQ.data.value && databaseQ.data.value.total > pageSize" class="flex shrink-0 justify-end border-t border-default px-4 py-2"><UPagination v-model:page="page" :total="databaseQ.data.value.total" :items-per-page="pageSize" /></div>
      </template>
    </main>

    <UModal v-model:open="showDatabaseForm" :title="editingDatabaseId ? 'Rename database' : 'Create database'">
      <template #body>
        <UFormField label="Name"><UInput v-model="databaseName" autofocus class="w-full" @keyup.enter="saveDatabase" /></UFormField>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="showDatabaseForm = false" />
        <UButton label="Save" :loading="saving" :disabled="!databaseName.trim()" @click="saveDatabase" />
      </template>
    </UModal>

    <UModal v-model:open="showViewForm" :title="editingViewId ? 'View settings' : 'Create view'">
      <template #body>
        <div class="space-y-5">
          <UFormField label="Name"><UInput v-model="viewName" autofocus class="w-full" /></UFormField>
          <UFormField label="Layout"><USelect v-model="viewLayout" :items="viewLayoutChoices" class="w-full" /></UFormField>
          <UFormField v-if="viewLayout === 'board'" label="Group cards by">
            <USelect v-model="viewGroupFieldId" :items="selectFields.map(field => ({ label: field.name, value: field.id }))" placeholder="Choose a Select field" class="w-full" />
            <p v-if="!selectFields.length" class="mt-1 text-xs text-warning">Create a Select field before using a board.</p>
          </UFormField>
          <UFormField v-if="viewLayout === 'calendar'" label="Date field">
            <USelect v-model="viewDateFieldId" :items="dateFields.map(field => ({ label: field.name, value: field.id }))" placeholder="Choose a Date field" class="w-full" />
            <p v-if="!dateFields.length" class="mt-1 text-xs text-warning">Create a Date field before using a calendar.</p>
          </UFormField>

          <fieldset>
            <legend class="mb-2 text-sm font-medium">Visible fields</legend>
            <div v-if="activeDatabase?.fields.length" class="grid grid-cols-2 gap-2">
              <UCheckbox
                v-for="field in activeDatabase.fields"
                :key="field.id"
                :label="field.name"
                :model-value="viewVisibleFieldIds.includes(field.id)"
                @update:model-value="toggleVisibleField(field.id, Boolean($event))"
              />
            </div>
            <p v-else class="text-xs text-muted">This database has no custom fields.</p>
          </fieldset>

          <DataViewRules v-model:filters="viewFilters" v-model:sorts="viewSorts" :fields="fields" :members="members" />
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="showViewForm = false" />
        <UButton
          label="Save"
          :loading="saving"
          :disabled="!canSaveView"
          @click="saveView"
        />
      </template>
    </UModal>

    <UModal v-model:open="showFieldForm" :title="editingFieldId ? 'Edit field' : 'Create field'">
      <template #body>
        <div class="space-y-4">
          <UFormField label="Name"><UInput v-model="fieldName" autofocus class="w-full" /></UFormField>
          <UFormField label="Type" :hint="`${DatabaseSlotCounts[databaseSlotPool(fieldType)]} ${fieldTypeLabel(fieldType).toLowerCase()} fields share a pool per database`">
            <USelect v-model="fieldType" :items="fieldTypeChoices" :disabled="Boolean(editingFieldId)" class="w-full" />
          </UFormField>
          <UFormField v-if="hasFieldOptions(fieldType)" label="Options" description="Separate options with commas.">
            <UInput v-model="fieldOptions" placeholder="New, In progress, Done" class="w-full" @keyup.enter="saveField" />
          </UFormField>
          <UFormField v-if="fieldType === 'relation'" label="Related database" description="Records of this database can be linked from each record.">
            <USelect v-model="fieldRelationDatabaseId" :items="relationTargets" :disabled="Boolean(editingFieldId)" placeholder="Choose a database" class="w-full" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="showFieldForm = false" />
        <UButton label="Save" :loading="saving" :disabled="!fieldFormComplete" @click="saveField" />
      </template>
    </UModal>

    <DataRecordPanel
      v-model:open="panelOpen"
      :item="panelItem"
      :fields="fields"
      :database-name="activeDatabase?.name ?? ''"
      :members="members"
      :linked="linked"
      :can-write="!showArchived && can(Permission.writeData)"
      :can-delete="!showArchived && can(Permission.manageDatabases)"
      :saving="Boolean(panelItem && rowEdits.edits.get(panelItem.id)?.saving)"
      :loading="Boolean(selectedRecordId) && !panelItem && recordQ.isPending.value"
      @update="panelItem && updateRecord(panelItem, $event)"
      @linked="rememberLinked"
      @delete="panelItem && deleteItem(panelItem)"
    />

    <UModal v-model:open="showConfirm" :title="confirmTitle">
      <template #body><p class="text-sm text-muted">This cannot be undone.</p></template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="showConfirm = false" />
        <UButton color="error" label="Delete" :loading="saving" @click="confirmMutation" />
      </template>
    </UModal>
  </div>
</template>

<style scoped>
/* Borderless cells show where you are editing with an outline, like Notion. */
.df-cell:focus-within {
  background: var(--ui-bg-elevated);
  box-shadow: inset 0 0 0 2px color-mix(in oklab, var(--ui-primary) 65%, transparent);
}
</style>
