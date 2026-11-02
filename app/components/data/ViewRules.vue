<script setup lang="ts">
/**
 * The filter and sort rules of a view, one row each like Notion:
 * field · condition · value · remove, all the same size.
 */
import type { DatabaseViewSort } from '~~/shared/database'
import type { DatabaseFieldDTO, MemberDTO } from '~~/shared/types'
import { filterFieldFor, filterNeedsValue, filterOperatorOptionsFor, filterUsesChoice, filterUsesPerson, normalizeEditableFilter, type EditableViewFilter } from '~/utils/database-fields'

const props = withDefaults(defineProps<{
  fields: DatabaseFieldDTO[]
  members?: MemberDTO[]
  /** Which rules to show. */
  show?: 'filters' | 'sorts' | 'both'
}>(), { members: () => [], show: 'both' })
const filters = defineModel<EditableViewFilter[]>('filters', { default: () => [] })
const sorts = defineModel<DatabaseViewSort[]>('sorts', { default: () => [] })

const fieldOptions = computed(() => [
  { label: 'Title', value: 'title' },
  ...props.fields.map(field => ({ label: field.name, value: field.id })),
])
const memberOptions = computed(() => props.members.map(member => ({ label: member.user.displayName, value: member.user.id })))
const inputType = (filter: EditableViewFilter) => {
  const type = filterFieldFor(props.fields, filter)?.type
  return type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'
}
function addFilter() {
  if (filters.value.length >= 8) return
  filters.value = [...filters.value, { fieldId: 'title', operator: 'contains', value: '' }]
}
function addSort() {
  if (sorts.value.length >= 3) return
  sorts.value = [...sorts.value, { fieldId: 'title', direction: 'asc' }]
}
</script>

<template>
  <div class="space-y-5">
    <section v-if="show !== 'sorts'" class="space-y-2" role="group" aria-label="Filters">
      <div class="flex items-center justify-between gap-2">
        <h3 class="text-sm font-medium">Filters</h3>
        <UButton color="neutral" variant="ghost" size="xs" icon="i-ph-plus" label="Add filter" :disabled="filters.length >= 8" @click="addFilter" />
      </div>
      <div v-for="(filter, index) in filters" :key="index" class="flex flex-wrap items-center gap-1.5 sm:flex-nowrap">
        <USelect v-model="filter.fieldId" size="sm" :items="fieldOptions" aria-label="Filter field" class="min-w-0 flex-1" @update:model-value="normalizeEditableFilter(fields, filter)" />
        <USelect v-model="filter.operator" size="sm" :items="filterOperatorOptionsFor(fields, filter)" aria-label="Condition" class="w-36 shrink-0" @update:model-value="normalizeEditableFilter(fields, filter)" />
        <USelect v-if="filterNeedsValue(filter) && filterFieldFor(fields, filter)?.type === 'boolean'" v-model="filter.value" size="sm" :items="[{ label: 'Yes', value: 'true' }, { label: 'No', value: 'false' }]" aria-label="Value" class="min-w-0 flex-1" />
        <USelect v-else-if="filterUsesChoice(fields, filter)" v-model="filter.value" size="sm" :items="filterFieldFor(fields, filter)?.options.map(option => ({ label: option, value: option })) ?? []" placeholder="Value" aria-label="Value" class="min-w-0 flex-1" />
        <USelect v-else-if="filterUsesPerson(fields, filter)" v-model="filter.value" size="sm" :items="memberOptions" placeholder="Person" aria-label="Value" class="min-w-0 flex-1" />
        <UInput v-else-if="filterNeedsValue(filter)" v-model="filter.value" size="sm" :type="inputType(filter)" placeholder="Value" aria-label="Value" class="min-w-0 flex-1" />
        <UButton color="neutral" variant="ghost" size="sm" square icon="i-ph-x" aria-label="Remove filter" @click="filters = filters.filter((_, position) => position !== index)" />
      </div>
      <p v-if="!filters.length" class="text-xs text-muted">No filters: every record shows.</p>
    </section>

    <section v-if="show !== 'filters'" class="space-y-2" role="group" aria-label="Sorts">
      <div class="flex items-center justify-between gap-2">
        <h3 class="text-sm font-medium">Sorts</h3>
        <UButton color="neutral" variant="ghost" size="xs" icon="i-ph-plus" label="Add sort" :disabled="sorts.length >= 3" @click="addSort" />
      </div>
      <div v-for="(sort, index) in sorts" :key="index" class="flex items-center gap-1.5">
        <USelect v-model="sort.fieldId" size="sm" :items="fieldOptions.filter(option => option.value === 'title' || fields.find(field => field.id === option.value)?.type !== 'relation')" aria-label="Sort field" class="min-w-0 flex-1" />
        <USelect v-model="sort.direction" size="sm" :items="[{ label: 'Ascending', value: 'asc' }, { label: 'Descending', value: 'desc' }]" aria-label="Direction" class="w-36 shrink-0" />
        <UButton color="neutral" variant="ghost" size="sm" square icon="i-ph-x" aria-label="Remove sort" @click="sorts = sorts.filter((_, position) => position !== index)" />
      </div>
      <p v-if="!sorts.length" class="text-xs text-muted">No sorting: records keep their order.</p>
    </section>
  </div>
</template>
