<script setup lang="ts">
/**
 * One field's value as it reads in a list, card or calendar: option chips, people
 * with avatars, linked records, clickable addresses. Empty shows a dash when asked.
 */
import type { DatabaseValue } from '~~/shared/database'
import { databasePath } from '~~/shared/paths'
import type { DatabaseFieldDTO, LinkedRecordDTO, PublicUser } from '~~/shared/types'
import { shortUrl } from '~/utils/database-fields'

const props = withDefaults(defineProps<{
  field: DatabaseFieldDTO
  value: DatabaseValue | undefined
  members?: Record<string, PublicUser>
  linked?: Record<string, LinkedRecordDTO>
  /** Show a dash for an empty value instead of nothing. */
  placeholder?: boolean
}>(), { members: () => ({}), linked: () => ({}), placeholder: false })

const list = computed(() => Array.isArray(props.value) ? props.value : [])
const empty = computed(() => props.value === null || props.value === undefined || props.value === '' || (Array.isArray(props.value) && !props.value.length))
const text = computed(() => typeof props.value === 'string' || typeof props.value === 'number' ? String(props.value) : '')
</script>

<template>
  <span v-if="empty" class="text-dimmed">{{ placeholder ? '—' : '' }}</span>
  <UIcon v-else-if="field.type === 'boolean'" :name="value ? 'i-ph-check-square' : 'i-ph-square'" class="size-4" :class="value ? 'text-highlighted' : 'text-dimmed'" :aria-label="value ? 'Yes' : 'No'" />
  <UBadge v-else-if="field.type === 'select'" color="neutral" variant="subtle" size="sm" :label="text" class="max-w-full truncate" />
  <span v-else-if="field.type === 'multi_select'" class="flex min-w-0 flex-wrap gap-1">
    <UBadge v-for="option in list" :key="option" color="neutral" variant="subtle" size="sm" :label="option" class="max-w-full truncate" />
  </span>
  <span v-else-if="field.type === 'person'" class="flex min-w-0 flex-wrap items-center gap-1.5">
    <span v-for="id in list" :key="id" class="flex min-w-0 items-center gap-1 text-sm">
      <UserAvatar v-if="members[id]" :user="members[id]!" size="2xs" />
      <span class="truncate">{{ members[id]?.displayName ?? 'Former member' }}</span>
    </span>
  </span>
  <span v-else-if="field.type === 'relation'" class="flex min-w-0 flex-wrap gap-1">
    <!-- A record of a database the reader may not open keeps its name to itself. -->
    <template v-for="id in list" :key="id">
      <NuxtLink
        v-if="linked[id]"
        :to="databasePath(linked[id]!.databaseId, false, null, id)"
        class="max-w-full truncate rounded-md bg-elevated px-1.5 py-0.5 text-xs text-highlighted underline decoration-dotted underline-offset-2 hover:bg-accented"
        @click.stop
      >{{ linked[id]!.title }}</NuxtLink>
      <span v-else class="max-w-full truncate rounded-md bg-elevated px-1.5 py-0.5 text-xs text-dimmed" title="A record of a database you cannot open">No access</span>
    </template>
  </span>
  <a v-else-if="field.type === 'url'" :href="text" target="_blank" rel="noopener noreferrer" class="block max-w-full truncate text-sm text-highlighted underline decoration-dotted underline-offset-2 hover:text-primary" @click.stop>{{ shortUrl(text) }}</a>
  <a v-else-if="field.type === 'email'" :href="`mailto:${text}`" class="block max-w-full truncate text-sm text-highlighted underline decoration-dotted underline-offset-2 hover:text-primary" @click.stop>{{ text }}</a>
  <a v-else-if="field.type === 'phone'" :href="`tel:${text}`" class="block max-w-full truncate text-sm text-highlighted underline decoration-dotted underline-offset-2 hover:text-primary" @click.stop>{{ text }}</a>
  <span v-else class="block max-w-full truncate text-sm">{{ text }}</span>
</template>
