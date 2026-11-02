<script setup lang="ts">
/**
 * A record opened as a page, like Notion: the title on top, then every field
 * with its icon and an editor, and who created it at the bottom.
 */
import type { DatabaseValue } from '~~/shared/database'
import { formatMessageTime } from '~~/shared/format'
import type { DatabaseFieldDTO, DatabaseItemDTO, LinkedRecordDTO, MemberDTO } from '~~/shared/types'
import { fieldIcon } from '~/utils/database-fields'

const props = withDefaults(defineProps<{
  item: DatabaseItemDTO | null
  fields: DatabaseFieldDTO[]
  databaseName: string
  members?: MemberDTO[]
  linked?: Record<string, LinkedRecordDTO>
  canWrite?: boolean
  canDelete?: boolean
  saving?: boolean
  loading?: boolean
}>(), { members: () => [], linked: () => ({}), canWrite: false, canDelete: false, saving: false, loading: false })
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ update: [patch: { title?: string; values?: Record<string, DatabaseValue> }]; linked: [records: LinkedRecordDTO[]]; delete: [] }>()

const creator = computed(() => props.members.find(member => member.user.id === props.item?.createdBy)?.user.displayName)
function updateTitle(event: Event) {
  const title = (event.target as HTMLInputElement).value.trim()
  if (title && title !== props.item?.title) emit('update', { title })
}
</script>

<template>
  <USlideover v-model:open="open" :title="item?.title || 'Record'" :description="databaseName" :ui="{ content: 'max-w-xl', header: 'sr-only', body: 'p-0' }">
    <template #body>
      <div v-if="loading" class="p-6"><LayoutSkeleton variant="form" /></div>
      <LayoutEmptyState v-else-if="!item" icon="i-ph-table" title="Record not found" description="It may have been deleted, or it is outside your access." />
      <div v-else class="flex h-full min-h-0 flex-col">
        <div class="flex items-center gap-1 px-4 pt-3 text-xs text-muted">
          <UIcon name="i-ph-table" class="size-4" /><span class="truncate">{{ databaseName }}</span>
          <span v-if="saving" class="ms-2 flex items-center gap-1"><span class="size-1.5 animate-pulse rounded-full bg-primary" />Saving</span>
          <UButton icon="i-ph-x" color="neutral" variant="ghost" size="sm" aria-label="Close record" class="ms-auto" @click="open = false" />
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
          <UInput :model-value="item.title" variant="none" size="xl" aria-label="Record title" placeholder="Untitled" :disabled="!canWrite" class="mt-3 w-full" :ui="{ base: 'px-0 text-2xl font-semibold text-highlighted' }" @change="updateTitle" />
          <dl class="mt-4 divide-y divide-default">
            <div v-for="field in fields" :key="field.id" class="group grid grid-cols-[9rem_1fr] items-start gap-3 py-1.5">
              <dt class="flex h-9 min-w-0 items-center gap-1.5 text-sm text-muted"><UIcon :name="fieldIcon(field.type)" class="size-4 shrink-0 text-dimmed" /><span class="truncate">{{ field.name }}</span></dt>
              <dd class="min-w-0">
                <DataFieldEditor :field="field" :value="item.values[field.id]" :members="members" :linked="linked" :disabled="!canWrite" cell @update="emit('update', { values: { [field.id]: $event } })" @linked="emit('linked', $event)" />
              </dd>
            </div>
            <p v-if="!fields.length" class="py-3 text-sm text-muted">This database has no fields yet. Add one with + in the table header.</p>
          </dl>
          <div class="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-dimmed">
            <span>Created {{ formatMessageTime(item.createdAt).replace(/^(Today|Yesterday)/, word => word.toLowerCase()) }}<template v-if="creator"> by {{ creator }}</template></span>
            <span v-if="item.updatedAt !== item.createdAt">Edited {{ formatMessageTime(item.updatedAt).replace(/^(Today|Yesterday)/, word => word.toLowerCase()) }}</span>
            <UButton v-if="canDelete" label="Delete record" icon="i-ph-trash" color="error" variant="ghost" size="xs" class="ms-auto" @click="emit('delete')" />
          </div>
        </div>
      </div>
    </template>
  </USlideover>
</template>
