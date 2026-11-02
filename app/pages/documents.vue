<script setup lang="ts">
import { errorMessage } from '#imports'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { Permission } from '~~/shared/permissions'
import { documentPath } from '~~/shared/paths'
import type { DataResourcesDTO, DocumentDTO } from '~~/shared/types'

definePageMeta({ layout: 'server', middleware: ['auth', 'manage-databases'] })

const { serverId } = useServer()
const { can } = useRoleGrants()
const isMobile = useIsMobile()
const { api } = useApi()
const route = useRoute()
const nav = useNavActions()
const qc = useQueryClient()
const toast = useToast()
const resourcesQ = useQuery({
  queryKey: computed(() => ['data-resources', serverId.value]),
  queryFn: () => api<DataResourcesDTO>(`/api/servers/${serverId.value}/data-resources`),
  enabled: computed(() => Boolean(serverId.value)),
  refetchInterval: 10_000,
})
const documents = computed(() => resourcesQ.data.value?.documents ?? [])
const selectedId = computed(() => String(route.query.document || '') || documents.value[0]?.id || '')
const documentQ = useQuery({
  queryKey: computed(() => ['document', selectedId.value]),
  queryFn: () => api<{ document: DocumentDTO }>(`/api/documents/${selectedId.value}`),
  enabled: computed(() => Boolean(selectedId.value && documents.value.some(document => document.id === selectedId.value))),
})
const activeDocument = computed(() => documentQ.data.value?.document.id === selectedId.value ? documentQ.data.value.document : null)
const { title, content, dirty, saving, saveError, save, discard, cancelScheduledSave, scheduleSave } = useDocumentDraft(
  activeDocument,
  async (id, patch) => {
    const result = await api<{ document: DocumentDTO }>(`/api/documents/${id}`, { method: 'PATCH', body: patch })
    return result.document
  },
  (document) => {
    qc.setQueryData(['document', document.id], { document })
    void qc.invalidateQueries({ queryKey: ['data-resources'] })
  },
)
const deleting = ref(false)
useDocumentCreateGuard(save)
const showDelete = ref(false)
const showReload = ref(false)

async function reloadDocument() {
  const result = await documentQ.refetch()
  if (result.error) { toast.add({ title: errorMessage(result.error), color: 'error' }); return }
  discard()
  showReload.value = false
}

watch([documents, selectedId], ([list, id]) => {
  if (!list.length || !id || list.some(document => document.id === id)) return
  void navigateTo(documentPath(list[0]?.id), { replace: true })
})

// Query-only document switches reuse this page, so both guards must flush.
onBeforeRouteUpdate(() => save())
onBeforeRouteLeave(() => save())

function beforeUnload(event: BeforeUnloadEvent) {
  if (!dirty.value && !saving.value) return
  event.preventDefault()
  event.returnValue = ''
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))

async function removeDocument() {
  const document = activeDocument.value
  if (!document || deleting.value || saving.value) return
  cancelScheduledSave()
  deleting.value = true
  try {
    await api(`/api/documents/${document.id}`, { method: 'DELETE' })
    discard()
    showDelete.value = false
    qc.removeQueries({ queryKey: ['document', document.id] })
    await qc.invalidateQueries({ queryKey: ['data-resources'] })
    const next = documents.value.find(item => item.id !== document.id)
    await navigateTo(documentPath(next?.id), { replace: true })
    toast.add({ title: 'Document deleted', color: 'success' })
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { deleting.value = false }
}


function retryLoad() {
  return Promise.all([resourcesQ.refetch(), documentQ.refetch()])
}
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-col">
    <LayoutPageHeader icon="i-ph-file-text" :title="activeDocument ? (title || activeDocument.title) : 'Documents'">
      <template #actions>
        <span v-if="activeDocument" class="text-xs text-dimmed">{{ saving ? 'Saving…' : saveError ? 'Not saved' : dirty ? 'Unsaved' : 'Saved' }}</span>
        <DataBookmarkButton v-if="activeDocument" :server-id="serverId" target-type="document" :target-id="activeDocument.id" />
        <UButton v-if="activeDocument && can(Permission.manageDatabases)" color="neutral" variant="ghost" icon="i-ph-trash" aria-label="Delete document" :disabled="saving || deleting" @click="showDelete = true" />
        <UButton v-if="can(Permission.writeData)" icon="i-ph-plus" :label="isMobile ? undefined : 'Document'" aria-label="New document" :loading="nav.documentCreating.value" @click="nav.createDocumentOpen.value = true" />
      </template>
    </LayoutPageHeader>

    <div v-if="resourcesQ.isPending.value || (selectedId && documents.some(document => document.id === selectedId) && documentQ.isPending.value)"><LayoutSkeleton variant="document" /></div>
    <LayoutLoadError v-else-if="resourcesQ.error.value || documentQ.error.value" message="Documents did not load." :retry="retryLoad" />
    <LayoutEmptyState v-else-if="!activeDocument" icon="i-ph-file-text" title="No documents yet" description="Notes, specs and guides your team edits together, with a bookmark for the ones you keep coming back to.">
      <UButton v-if="can(Permission.writeData)" icon="i-ph-plus" label="Create first document" :loading="nav.documentCreating.value" @click="nav.createDocumentOpen.value = true" />
    </LayoutEmptyState>
    <main v-else class="min-h-0 flex-1 overflow-y-auto">
      <UAlert v-if="saveError" color="error" title="Document not saved" :description="errorMessage(saveError)" class="m-4 w-auto">
        <template #actions>
          <UButton label="Retry save" color="error" variant="soft" :loading="saving" @click="save()" />
          <UButton label="Reload latest" color="neutral" variant="outline" :disabled="saving" @click="showReload = true" />
        </template>
      </UAlert>
      <div class="mx-auto w-full max-w-4xl px-5 py-8 sm:px-10">
        <UInput
          v-model="title"
          placeholder="Untitled"
          :disabled="nav.documentCreating.value"
          :readonly="!can(Permission.writeData)"
          variant="none"
          size="xl"
          aria-label="Document title"
          class="mb-5 w-full"
          :ui="{ base: 'px-0 text-3xl font-semibold' }"
          @update:model-value="scheduleSave"
        />
        <UEditor v-model="content" :editable="can(Permission.writeData) && !nav.documentCreating.value" content-type="html" placeholder="Start writing…" class="min-h-[60vh]" @update:model-value="scheduleSave">
          <template #default="{ editor }">
            <UEditorToolbar v-if="can(Permission.writeData)" :editor="editor" class="sticky top-0 z-10 mb-4 border-b border-default bg-default/95 py-2 backdrop-blur" />
          </template>
        </UEditor>
      </div>
    </main>

    <UModal v-model:open="showReload" title="Discard unsaved changes?">
      <template #body><p class="text-sm text-muted">This replaces your draft with the latest saved document. Copy any text you want to keep first.</p></template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="showReload = false" />
        <UButton color="error" label="Discard and reload" :loading="documentQ.isFetching.value" @click="reloadDocument" />
      </template>
    </UModal>
    <UModal v-model:open="showDelete" title="Delete document?">
      <template #body><p class="text-sm text-muted">This cannot be undone.</p></template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="showDelete = false" />
        <UButton color="error" label="Delete" :loading="deleting" @click="removeDocument" />
      </template>
    </UModal>
  </div>
</template>
