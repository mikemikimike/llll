<script setup lang="ts">
/**
 * Picks records of the related database, like Notion's relation cell: the chosen
 * ones show as chips, a search lists the rest, a click toggles a record.
 */
import { useQuery } from '@tanstack/vue-query'
import { refDebounced } from '@vueuse/core'
import type { DatabaseFieldDTO, DatabasePageDTO, LinkedRecordDTO } from '~~/shared/types'

const props = withDefaults(defineProps<{
  field: DatabaseFieldDTO
  modelValue: string[]
  linked?: Record<string, LinkedRecordDTO>
  disabled?: boolean
  /** Borderless, for a table cell. */
  cell?: boolean
}>(), { linked: () => ({}), disabled: false, cell: false })
const emit = defineEmits<{ 'update:modelValue': [ids: string[]]; 'linked': [records: LinkedRecordDTO[]] }>()

const { api } = useApi()
const open = ref(false)
const search = ref('')
const debounced = refDebounced(search, 200)
const databaseId = computed(() => props.field.relation?.databaseId ?? '')
const resultsQ = useQuery({
  queryKey: computed(() => ['relation-records', databaseId.value, debounced.value] as const),
  queryFn: () => api<DatabasePageDTO>(`/api/databases/${databaseId.value}`, { query: { search: debounced.value, pageSize: 25 } }),
  enabled: computed(() => open.value && Boolean(databaseId.value)),
  staleTime: 10_000,
})
/** Titles seen in this picker, so a record chosen here shows its name before the page reloads. */
const seen = ref<Record<string, LinkedRecordDTO>>({})
watch(() => resultsQ.data.value?.items, (items) => {
  if (!items) return
  const next = { ...seen.value }
  for (const item of items) next[item.id] = { id: item.id, databaseId: item.databaseId, title: item.title }
  seen.value = next
})
const titleOf = (id: string) => props.linked[id]?.title ?? seen.value[id]?.title ?? 'No access'
const selected = computed(() => new Set(props.modelValue))

function toggle(id: string) {
  const next = selected.value.has(id) ? props.modelValue.filter(value => value !== id) : [...props.modelValue, id]
  emit('linked', next.flatMap(value => props.linked[value] ?? seen.value[value] ?? []))
  emit('update:modelValue', next)
}
</script>

<template>
  <UPopover v-model:open="open" :content="{ align: 'start' }">
    <button
      type="button"
      class="flex min-h-9 w-full min-w-0 flex-wrap items-center gap-1 text-start focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed"
      :class="cell ? 'px-3 py-1.5' : 'rounded-md px-2.5 py-1.5 ring ring-inset ring-accented hover:bg-elevated/60'"
      :disabled="disabled"
      :aria-label="field.name"
    >
      <span v-for="id in modelValue" :key="id" class="max-w-full truncate rounded-md bg-elevated px-1.5 py-0.5 text-xs text-highlighted">{{ titleOf(id) }}</span>
      <span v-if="!modelValue.length" class="text-sm text-dimmed">{{ disabled ? '' : 'Link a record' }}</span>
    </button>
    <template #content>
      <div class="w-72 p-2">
        <UInput v-model="search" size="sm" icon="i-ph-magnifying-glass" placeholder="Search records" aria-label="Search records" autofocus class="w-full" />
        <LayoutSkeleton v-if="resultsQ.isPending.value" variant="nav" :rows="3" class="mt-2" />
        <LayoutLoadError v-else-if="resultsQ.error.value" inline message="Records did not load." :retry="resultsQ.refetch" class="mt-2" />
        <p v-else-if="!resultsQ.data.value?.items.length" class="px-2 py-3 text-sm text-muted">{{ search ? 'No matching records' : 'No records yet' }}</p>
        <ul v-else class="mt-1 max-h-64 overflow-y-auto" role="listbox" :aria-label="`Records of ${resultsQ.data.value.database.name}`">
          <li v-for="item in resultsQ.data.value.items" :key="item.id">
            <button type="button" role="option" :aria-selected="selected.has(item.id)" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-elevated" @click="toggle(item.id)">
              <UIcon :name="selected.has(item.id) ? 'i-ph-check-square' : 'i-ph-square'" class="size-4 shrink-0" :class="selected.has(item.id) ? 'text-highlighted' : 'text-dimmed'" />
              <span class="min-w-0 flex-1 truncate">{{ item.title }}</span>
            </button>
          </li>
        </ul>
      </div>
    </template>
  </UPopover>
</template>
