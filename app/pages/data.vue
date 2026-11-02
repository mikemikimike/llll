<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { DropdownMenuItem } from '@nuxt/ui'
import { Permission } from '~~/shared/permissions'
import { databasePath, documentPath, canvasPath } from '~~/shared/paths'
import { formatMessageTime } from '~~/shared/format'
import type { DataResourcesDTO } from '~~/shared/types'

definePageMeta({ layout: 'server', middleware: ['auth', 'manage-databases'] })
const { serverId } = useServer()
const { api } = useApi()
const { can } = useRoleGrants()
const nav = useNavActions()
const resources = useQuery({
  queryKey: computed(() => ['data-resources', serverId.value]),
  queryFn: () => api<DataResourcesDTO>(`/api/servers/${serverId.value}/data-resources`),
  enabled: computed(() => Boolean(serverId.value)),
})
const search = ref('')
const matches = (title: string) => title.toLowerCase().includes(search.value.trim().toLowerCase())

const count = (noun: string, n: number) => n === 1 ? `1 ${noun}` : `${n} ${noun}s`
const edited = (iso: string) => `Edited ${formatMessageTime(iso).replace(/^(Today|Yesterday)/, word => word.toLowerCase())}`

type Row = { id: string; title: string; detail: string; to: string }
type Group = { key: 'documents' | 'databases' | 'canvases'; name: string; icon: string; createLabel: string; canCreate: boolean; create: () => void; creating?: boolean; hint: string; rows: Row[] }

const creators = computed(() => ({
  documents: { label: 'Document', icon: 'i-ph-file-text', can: can(Permission.writeData), open: () => { nav.createDocumentOpen.value = true } },
  databases: { label: 'Database', icon: 'i-ph-table', can: can(Permission.manageDatabases), open: () => { nav.createDatabaseOpen.value = true } },
  canvases: { label: 'Canvas', icon: 'i-ph-selection-background', can: can(Permission.manageDatabases), open: () => { nav.createCanvasOpen.value = true } },
}))
const creatorList = computed(() => Object.values(creators.value).filter(item => item.can))
const newMenu = computed<DropdownMenuItem[]>(() => creatorList.value.map(item => ({ label: item.label, icon: item.icon, onSelect: item.open })))

const databases = computed(() => resources.data.value?.databases ?? [])
const archivedCount = computed(() => databases.value.filter(database => database.archivedAt).length)

const groups = computed<Group[]>(() => [
  {
    key: 'documents', name: 'Documents', icon: 'i-ph-file-text', createLabel: 'New document', canCreate: creators.value.documents.can, create: creators.value.documents.open, creating: nav.documentCreating.value,
    hint: 'Notes, specs and guides your team edits together.',
    rows: (resources.data.value?.documents ?? []).map(item => ({ id: item.id, title: item.title || 'Untitled', detail: edited(item.updatedAt), to: documentPath(item.id) })),
  },
  {
    key: 'databases', name: 'Databases', icon: 'i-ph-table', createLabel: 'New database', canCreate: creators.value.databases.can, create: creators.value.databases.open,
    hint: 'Structured records with table, board, calendar and list views.',
    rows: databases.value.filter(item => !item.archivedAt).map(item => ({ id: item.id, title: item.name, detail: `${item.itemCount ? count('record', item.itemCount) : 'No records yet'} · ${count('view', item.views.length)}`, to: databasePath(item.id, false, item.views[0]?.id) })),
  },
  {
    key: 'canvases', name: 'Canvases', icon: 'i-ph-selection-background', createLabel: 'New canvas', canCreate: creators.value.canvases.can, create: creators.value.canvases.open,
    hint: 'A free surface for notes and the connections between them.',
    rows: (resources.data.value?.canvases ?? []).map(item => ({ id: item.id, title: item.title, detail: `${item.nodeCount ? count('item', item.nodeCount) : 'Empty'} · ${edited(item.updatedAt)}`, to: canvasPath(item.id) })),
  },
])

const bookmarks = computed(() => (resources.data.value?.bookmarks ?? []).flatMap((bookmark) => {
  if (bookmark.targetType === 'database_view') {
    for (const database of databases.value) {
      if (database.archivedAt) continue
      const view = database.views.find(candidate => candidate.id === bookmark.targetId)
      if (view) return [{ key: `view:${view.id}`, title: `${database.name} / ${view.name}`, icon: 'i-ph-layout', to: databasePath(database.id, false, view.id) }]
    }
  }
  if (bookmark.targetType === 'document') {
    const document = resources.data.value?.documents.find(candidate => candidate.id === bookmark.targetId)
    if (document) return [{ key: `document:${document.id}`, title: document.title || 'Untitled', icon: 'i-ph-file-text', to: documentPath(document.id) }]
  }
  if (bookmark.targetType === 'canvas') {
    const canvas = resources.data.value?.canvases.find(candidate => candidate.id === bookmark.targetId)
    if (canvas) return [{ key: `canvas:${canvas.id}`, title: canvas.title, icon: 'i-ph-selection-background', to: canvasPath(canvas.id) }]
  }
  return []
}))

const searching = computed(() => Boolean(search.value.trim()))
const visibleBookmarks = computed(() => searching.value ? bookmarks.value.filter(bookmark => matches(bookmark.title)) : bookmarks.value)
// While searching, a group without matches disappears instead of showing its "nothing yet" hint.
const visibleGroups = computed(() => groups.value
  .map(group => ({ ...group, rows: searching.value ? group.rows.filter(row => matches(row.title)) : group.rows }))
  .filter(group => !searching.value || group.rows.length))
const total = computed(() => groups.value.reduce((sum, group) => sum + group.rows.length, 0))
const nothingYet = computed(() => !total.value && !bookmarks.value.length)
const noMatches = computed(() => searching.value && !visibleGroups.value.length && !visibleBookmarks.value.length)
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-col">
    <LayoutPageHeader title="Data" icon="i-ph-stack">
      <template #actions>
        <UDropdownMenu v-if="newMenu.length" :items="newMenu" :content="{ align: 'end' }">
          <UButton label="New" icon="i-ph-plus" trailing-icon="i-ph-caret-down" :loading="nav.documentCreating.value" />
        </UDropdownMenu>
      </template>
    </LayoutPageHeader>
    <main class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
        <h2 class="text-xl font-semibold text-highlighted">Your team's knowledge</h2>
        <p class="mt-1 text-sm text-muted">Documents, databases and canvases, kept together in this Server.</p>

        <LayoutSkeleton v-if="resources.isPending.value" variant="nav" :rows="6" class="mt-8" />
        <LayoutLoadError v-else-if="resources.error.value" message="Data did not load." :retry="resources.refetch" />
        <LayoutEmptyState v-else-if="nothingYet" icon="i-ph-stack" title="Nothing here yet" :description="newMenu.length ? 'Start with a document, a database for structured records, or a canvas to think on.' : 'Documents, databases and canvases shared with you appear here.'">
          <UButton v-for="item in creatorList" :key="item.label" :label="item.label" :icon="item.icon" color="neutral" variant="subtle" @click="item.open" />
        </LayoutEmptyState>
        <template v-else>
          <UInput v-if="total > 5 || bookmarks.length" v-model="search" type="search" icon="i-ph-magnifying-glass" placeholder="Find a document, database or canvas" aria-label="Find in data" autocomplete="off" class="mt-5 w-full" />
          <LayoutEmptyState v-if="noMatches" icon="i-ph-magnifying-glass" title="No matches" description="Try a different name." />
          <div v-else class="mt-8 space-y-8">
            <section v-if="visibleBookmarks.length" aria-labelledby="data-bookmarks">
              <h3 id="data-bookmarks" class="mb-2 text-xs font-medium text-muted">Bookmarks</h3>
              <ul class="divide-y divide-default">
                <li v-for="bookmark in visibleBookmarks" :key="bookmark.key">
                  <NuxtLink :to="bookmark.to" :title="bookmark.title" class="flex min-h-12 items-center gap-3 rounded-md px-2 py-2.5 hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary">
                    <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-elevated text-muted"><UIcon :name="bookmark.icon" class="size-5" /></span>
                    <span class="min-w-0 flex-1 truncate text-sm font-medium text-highlighted">{{ bookmark.title }}</span>
                    <UIcon name="i-ph-caret-right" class="size-4 shrink-0 text-muted" />
                  </NuxtLink>
                </li>
              </ul>
            </section>

            <section v-for="group in visibleGroups" :key="group.key" :aria-labelledby="`data-${group.key}`">
              <div class="mb-2 flex items-center justify-between gap-3">
                <h3 :id="`data-${group.key}`" class="text-xs font-medium text-muted">{{ group.name }}<span v-if="group.rows.length" class="ms-1.5 tabular-nums text-dimmed">{{ group.rows.length }}</span></h3>
                <UButton v-if="group.canCreate && group.rows.length" :label="group.createLabel" icon="i-ph-plus" size="xs" color="neutral" variant="ghost" :loading="group.creating" @click="group.create" />
              </div>
              <div v-if="!group.rows.length" class="flex flex-col items-start gap-3 rounded-lg border border-dashed border-default px-4 py-4 sm:flex-row sm:items-center">
                <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-elevated text-muted"><UIcon :name="group.icon" class="size-5" /></span>
                <p class="min-w-0 flex-1 text-sm text-muted">{{ group.hint }}</p>
                <UButton v-if="group.canCreate" :label="group.createLabel" icon="i-ph-plus" size="sm" color="neutral" variant="subtle" :loading="group.creating" @click="group.create" />
              </div>
              <ul v-else class="divide-y divide-default">
                <li v-for="row in group.rows" :key="row.id">
                  <NuxtLink :to="row.to" :title="row.title" class="flex min-h-14 items-center gap-3 rounded-md px-2 py-2.5 hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary">
                    <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-elevated text-muted"><UIcon :name="group.icon" class="size-5" /></span>
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-sm font-medium text-highlighted">{{ row.title }}</span>
                      <span class="mt-0.5 block truncate text-xs text-muted">{{ row.detail }}</span>
                    </span>
                    <UIcon name="i-ph-caret-right" class="size-4 shrink-0 text-muted" />
                  </NuxtLink>
                </li>
              </ul>
              <UButton v-if="group.key === 'databases' && archivedCount && !searching" :to="databasePath(null, true)" :label="count('archived database', archivedCount)" icon="i-ph-archive" trailing-icon="i-ph-caret-right" color="neutral" variant="ghost" size="sm" class="mt-2" />
            </section>
          </div>
        </template>
      </div>
    </main>
  </div>
</template>
