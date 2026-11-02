<script setup lang="ts">
/**
 * The control that edits one field's value, in a table cell or on the record page.
 * Scalars edit in place; options, people and relations pick from a list.
 */
import type { DatabaseValue } from '~~/shared/database'
import type { DatabaseFieldDTO, LinkedRecordDTO, MemberDTO } from '~~/shared/types'
import { fieldInputType } from '~/utils/database-fields'

const props = withDefaults(defineProps<{
  field: DatabaseFieldDTO
  value: DatabaseValue | undefined
  members?: MemberDTO[]
  linked?: Record<string, LinkedRecordDTO>
  disabled?: boolean
  /** Borderless and 36px tall, for a table cell. */
  cell?: boolean
}>(), { members: () => [], linked: () => ({}), disabled: false, cell: false })
const emit = defineEmits<{ update: [value: DatabaseValue]; linked: [records: LinkedRecordDTO[]] }>()

const list = computed(() => Array.isArray(props.value) ? props.value : [])
const text = computed(() => typeof props.value === 'string' || typeof props.value === 'number' ? String(props.value) : '')
const { serverUrl } = useApi()
function avatarOf(user: MemberDTO['user']) {
  const src = userAvatarSrc(user)
  return { src: src?.startsWith('/api/') ? serverUrl(src) : src ?? undefined, alt: user.displayName, text: (user.displayName || '?').slice(0, 1).toUpperCase() }
}
const memberOptions = computed(() => props.members.map(member => ({ label: member.user.displayName, value: member.user.id, avatar: avatarOf(member.user) })))
const optionItems = computed(() => props.field.options.map(option => ({ label: option, value: option })))
const variant = computed(() => props.cell ? 'none' : 'outline')
const cellUi = computed(() => props.cell ? { base: 'h-9 px-3' } : undefined)

function commitInput(event: Event) {
  const raw = (event.target as HTMLInputElement).value
  const next: DatabaseValue = props.field.type === 'number' ? (raw === '' ? null : Number(raw)) : (raw || null)
  if (props.value === next) return
  emit('update', next)
}
function commitList(value: unknown) {
  emit('update', Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])
}
</script>

<template>
  <UCheckbox v-if="field.type === 'boolean'" :model-value="Boolean(value)" :disabled="disabled" :aria-label="field.name" :class="cell ? 'px-3' : ''" @update:model-value="emit('update', Boolean($event))" />
  <USelect
    v-else-if="field.type === 'select'"
    :model-value="typeof value === 'string' ? value : undefined"
    :variant="variant"
    placeholder=" "
    :aria-label="field.name"
    :items="[{ label: 'None', value: null }, ...optionItems]"
    :disabled="disabled"
    class="w-full min-w-0"
    :ui="cell ? { base: 'h-9 px-3', trailingIcon: 'opacity-0 group-hover:opacity-100' } : undefined"
    @update:model-value="emit('update', typeof $event === 'string' ? $event : null)"
  />
  <USelectMenu
    v-else-if="field.type === 'multi_select'"
    :model-value="list"
    :items="optionItems"
    value-key="value"
    multiple
    :variant="variant"
    :placeholder="disabled ? '' : 'Choose options'"
    :aria-label="field.name"
    :disabled="disabled"
    class="w-full min-w-0"
    :ui="cell ? { base: 'min-h-9 px-3', trailingIcon: 'opacity-0 group-hover:opacity-100' } : undefined"
    @update:model-value="commitList($event)"
  />
  <USelectMenu
    v-else-if="field.type === 'person'"
    :model-value="list"
    :items="memberOptions"
    value-key="value"
    multiple
    :variant="variant"
    :placeholder="disabled ? '' : 'Choose people'"
    :aria-label="field.name"
    :disabled="disabled"
    class="w-full min-w-0"
    :ui="cell ? { base: 'min-h-9 px-3', trailingIcon: 'opacity-0 group-hover:opacity-100' } : undefined"
    @update:model-value="commitList($event)"
  />
  <DataRelationPicker v-else-if="field.type === 'relation'" :field="field" :model-value="list" :linked="linked" :disabled="disabled" :cell="cell" @update:model-value="emit('update', $event)" @linked="emit('linked', $event)" />
  <UInput
    v-else
    :model-value="text"
    :variant="variant"
    :type="fieldInputType(field.type)"
    :aria-label="field.name"
    :disabled="disabled"
    :placeholder="cell || disabled ? undefined : field.type === 'url' ? 'https://' : field.type === 'email' ? 'name@example.com' : undefined"
    class="w-full min-w-0"
    :ui="cellUi"
    @change="commitInput"
  />
</template>
