<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { canvasPath } from '~~/shared/paths'
import { Permission } from '~~/shared/permissions'
import type { CanvasDTO, CanvasEdgeDTO, CanvasNodeColor, CanvasNodeDTO, DataResourcesDTO } from '~~/shared/types'
import { createCanvasNodeEditor, type CanvasNodePatch } from '~/utils/canvas-node-editor'

definePageMeta({ layout: 'server', middleware: ['auth', 'manage-databases'] })

const { serverId } = useServer()
const { api } = useApi()
const route = useRoute()
const nav = useNavActions()
const { can } = useRoleGrants()
const qc = useQueryClient()
const toast = useToast()
const viewport = useTemplateRef<HTMLDivElement>('viewport')
const resourcesQ = useQuery({
  queryKey: computed(() => ['data-resources', serverId.value]),
  queryFn: () => api<DataResourcesDTO>(`/api/servers/${serverId.value}/data-resources`),
  enabled: computed(() => Boolean(serverId.value)),
  refetchInterval: 10_000,
})
const canvases = computed(() => resourcesQ.data.value?.canvases ?? [])
const selectedId = computed(() => String(route.query.canvas || '') || canvases.value[0]?.id || '')
const canvasQ = useQuery({
  queryKey: computed(() => ['canvas', selectedId.value]),
  queryFn: () => api<{ canvas: CanvasDTO }>(`/api/canvases/${selectedId.value}`),
  enabled: computed(() => Boolean(selectedId.value && canvases.value.some(canvas => canvas.id === selectedId.value))),
})
const activeCanvas = computed(() => canvasQ.data.value?.canvas.id === selectedId.value ? canvasQ.data.value.canvas : null)
const nodes = ref<CanvasNodeDTO[]>([])
const edges = ref<CanvasEdgeDTO[]>([])
const canvasTitle = ref('')
const canvasVersion = ref(1)
const saving = ref(false)
const showDelete = ref(false)
const connecting = ref(false)
const connectFrom = ref<string | null>(null)
const drag = shallowRef<{ id: string; clientX: number; clientY: number; x: number; y: number } | null>(null)
const nodeEditors = new Map<string, ReturnType<typeof createCanvasNodeEditor>>()
const drafts = new Map<string, CanvasNodeDTO[]>()
const failedNodes = computed(() => nodes.value.filter(node => nodeEditors.get(node.id)?.state.error))

function editorFor(node: CanvasNodeDTO) {
  let editor = nodeEditors.get(node.id)
  if (!editor) {
    editor = createCanvasNodeEditor(node, async (patch, version) => {
      try {
        const result = await api<{ node: CanvasNodeDTO }>(`/api/canvas-nodes/${node.id}`, { method: 'PATCH', body: { ...patch, version } })
        return result.node
      }
      catch (error) { throw new Error(errorMessage(error), { cause: error }) }
    })
    nodeEditors.set(node.id, editor)
  }
  return editor
}

watch(activeCanvas, (canvas, previous) => {
  if (canvas?.id !== previous?.id) {
    endDrag()
    for (const node of nodes.value) void editorFor(node).save()
    connecting.value = false
    connectFrom.value = null
  }
  if (canvas) {
    const list = canvas.nodes.map(node => {
      const editor = editorFor(node)
      editor.receive(node)
      return editor.state.node
    })
    for (const node of drafts.get(canvas.id) ?? []) {
      const editor = editorFor(node)
      if (!list.some(item => item.id === node.id) && (editor.isDirty() || editor.state.saving)) {
        editor.state.error = 'This item is no longer available. Your edits are kept here.'
        list.push(editor.state.node)
      }
    }
    drafts.set(canvas.id, list)
    nodes.value = list
  }
  else nodes.value = []
  edges.value = canvas?.edges.map(edge => ({ ...edge })) ?? []
  if (canvas?.id !== previous?.id || canvasTitle.value === previous?.title) canvasTitle.value = canvas?.title ?? ''
  canvasVersion.value = canvas?.version ?? 1
}, { immediate: true })

watch([canvases, selectedId], ([list, id]) => {
  if (!list.length || !id || list.some(canvas => canvas.id === id)) return
  void navigateTo(canvasPath(list[0]?.id), { replace: true })
})

const colorClasses: Record<CanvasNodeColor, string> = {
  neutral: 'border-default bg-elevated',
  orange: 'border-primary/50 bg-primary/10',
  blue: 'border-info/50 bg-info/10',
  green: 'border-success/50 bg-success/10',
  red: 'border-error/50 bg-error/10',
}

function nodeById(id: string) {
  return nodes.value.find(node => node.id === id)
}

function edgeLine(edge: CanvasEdgeDTO) {
  const from = nodeById(edge.fromNodeId)
  const to = nodeById(edge.toNodeId)
  if (!from || !to) return null
  return { x1: from.x + from.width / 2, y1: from.y + from.height / 2, x2: to.x + to.width / 2, y2: to.y + to.height / 2 }
}

async function refresh(canvasId = selectedId.value) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['data-resources'] }),
    qc.invalidateQueries({ queryKey: ['canvas', canvasId] }),
  ])
}

async function addNode(kind: 'note' | 'text' = 'note') {
  const canvas = activeCanvas.value
  if (!canvas || saving.value) return
  const el = viewport.value
  const offsets = [[0, 0], [272, 0], [-272, 0], [0, 176], [272, 176], [-272, 176]] as const
  const [offsetX, offsetY] = offsets[nodes.value.length % offsets.length]!
  const x = Math.max(40, Math.min(2160, (el?.scrollLeft ?? 0) + (el?.clientWidth ?? 800) / 2 - 120 + offsetX))
  const y = Math.max(40, Math.min(1456, (el?.scrollTop ?? 0) + (el?.clientHeight ?? 600) / 2 - 72 + offsetY))
  saving.value = true
  try {
    const result = await api<{ node: CanvasNodeDTO }>(`/api/canvases/${canvas.id}/nodes`, {
      method: 'POST', body: { kind, content: '', x, y, color: kind === 'note' ? 'orange' : 'neutral' },
    })
    if (selectedId.value === canvas.id) nodes.value.push(editorFor(result.node).state.node)
    await refresh(canvas.id)
    // A new note is for writing: put the cursor in it.
    await nextTick()
    document.querySelector<HTMLTextAreaElement>(`[data-canvas-node="${result.node.id}"] textarea`)?.focus()
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { saving.value = false }
}

async function patchNode(node: CanvasNodeDTO, patch: CanvasNodePatch) {
  const editor = editorFor(node)
  Object.assign(editor.state.node, patch)
  await editor.save()
  try { await refresh(node.canvasId) }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
}

async function retryNode(node: CanvasNodeDTO) {
  try {
    const result = await api<{ canvas: CanvasDTO }>(`/api/canvases/${node.canvasId}`)
    const latest = result.canvas.nodes.find(item => item.id === node.id)
    if (!latest) return
    const editor = editorFor(node)
    editor.receive(latest)
    await editor.save(true)
    await refresh(node.canvasId)
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
}

async function discardNodeChanges(node: CanvasNodeDTO) {
  function forgetDraft() {
    nodeEditors.delete(node.id)
    drafts.set(node.canvasId, (drafts.get(node.canvasId) ?? []).filter(item => item.id !== node.id))
    if (selectedId.value === node.canvasId) nodes.value = nodes.value.filter(item => item.id !== node.id)
  }
  try {
    const result = await api<{ canvas: CanvasDTO }>(`/api/canvases/${node.canvasId}`)
    const latest = result.canvas.nodes.find(item => item.id === node.id)
    if (latest) editorFor(node).discard(latest)
    else forgetDraft()
    await refresh(node.canvasId)
  }
  catch (error) {
    if (typeof error === 'object' && error && 'statusCode' in error && error.statusCode === 404) forgetDraft()
    else toast.add({ title: errorMessage(error), color: 'error' })
  }
}

function startDrag(event: PointerEvent, node: CanvasNodeDTO) {
  const target = event.target as HTMLElement
  if (connecting.value || event.button !== 0 || target.closest('textarea,button,input')) return
  event.preventDefault()
  drag.value = { id: node.id, clientX: event.clientX, clientY: event.clientY, x: node.x, y: node.y }
  window.addEventListener('pointermove', moveDrag)
  window.addEventListener('pointerup', endDrag, { once: true })
  window.addEventListener('pointercancel', endDrag, { once: true })
}

function moveDrag(event: PointerEvent) {
  if (!drag.value) return
  const node = nodeById(drag.value.id)
  if (!node) return
  node.x = Math.max(0, Math.min(2400 - node.width, drag.value.x + event.clientX - drag.value.clientX))
  node.y = Math.max(0, Math.min(1600 - node.height, drag.value.y + event.clientY - drag.value.clientY))
}

function endDrag() {
  if (!import.meta.client) return
  window.removeEventListener('pointermove', moveDrag)
  window.removeEventListener('pointerup', endDrag)
  window.removeEventListener('pointercancel', endDrag)
  const current = drag.value
  drag.value = null
  if (!current) return
  const node = nodeById(current.id)
  if (node && (node.x !== current.x || node.y !== current.y)) void patchNode(node, { x: node.x, y: node.y })
}

async function handleNodeClick(node: CanvasNodeDTO) {
  if (!connecting.value) return
  if (!connectFrom.value) { connectFrom.value = node.id; return }
  if (connectFrom.value === node.id) { connectFrom.value = null; return }
  const canvas = activeCanvas.value
  if (!canvas) return
  try {
    const result = await api<{ edge: CanvasEdgeDTO }>(`/api/canvases/${canvas.id}/edges`, {
      method: 'POST', body: { fromNodeId: connectFrom.value, toNodeId: node.id },
    })
    if (selectedId.value === canvas.id) {
      edges.value.push(result.edge)
      connectFrom.value = null
      connecting.value = false
    }
    await refresh(canvas.id)
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
}

function toggleConnecting() {
  connecting.value = !connecting.value
  connectFrom.value = null
}

async function removeNode(node: CanvasNodeDTO) {
  try {
    await editorFor(node).save()
    await api(`/api/canvas-nodes/${node.id}`, { method: 'DELETE' })
    nodeEditors.delete(node.id)
    drafts.set(node.canvasId, (drafts.get(node.canvasId) ?? []).filter(item => item.id !== node.id))
    if (selectedId.value === node.canvasId) {
      nodes.value = nodes.value.filter(item => item.id !== node.id)
      edges.value = edges.value.filter(edge => edge.fromNodeId !== node.id && edge.toNodeId !== node.id)
    }
    await refresh(node.canvasId)
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
}

function colorMenu(node: CanvasNodeDTO) {
  const colors: Array<{ label: string; value: CanvasNodeColor }> = [
    { label: 'Neutral', value: 'neutral' }, { label: 'Orange', value: 'orange' },
    { label: 'Blue', value: 'blue' }, { label: 'Green', value: 'green' }, { label: 'Red', value: 'red' },
  ]
  return [colors.map(color => ({ label: color.label, onSelect: () => void patchNode(node, { color: color.value }) }))]
}

async function renameCanvas() {
  const canvas = activeCanvas.value
  const title = canvasTitle.value.trim()
  if (!canvas || saving.value || !title || title === canvas.title) return
  saving.value = true
  try {
    const result = await api<{ canvas: Omit<CanvasDTO, 'nodes' | 'edges'> }>(`/api/canvases/${canvas.id}`, { method: 'PATCH', body: { title, version: canvasVersion.value } })
    if (selectedId.value === canvas.id) canvasVersion.value = result.canvas.version
    await refresh(canvas.id)
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }); await refresh(canvas.id) }
  finally { saving.value = false }
}

async function removeCanvas() {
  const canvas = activeCanvas.value
  if (!canvas) return
  saving.value = true
  try {
    await Promise.all([...nodeEditors.values()].filter(editor => editor.state.node.canvasId === canvas.id).map(editor => editor.save()))
    await api(`/api/canvases/${canvas.id}`, { method: 'DELETE' })
    for (const [id, editor] of nodeEditors) if (editor.state.node.canvasId === canvas.id) nodeEditors.delete(id)
    drafts.delete(canvas.id)
    showDelete.value = false
    qc.removeQueries({ queryKey: ['canvas', canvas.id] })
    await qc.invalidateQueries({ queryKey: ['data-resources'] })
    const next = canvases.value.find(item => item.id !== canvas.id)
    await navigateTo(canvasPath(next?.id), { replace: true })
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { saving.value = false }
}

onBeforeUnmount(() => {
  endDrag()
  window.removeEventListener('beforeunload', warnUnsavedChanges)
  for (const editor of nodeEditors.values()) void editor.save()
})

function warnUnsavedChanges(event: BeforeUnloadEvent) {
  if (![...nodeEditors.values()].some(editor => editor.isDirty() || editor.state.saving)) return
  event.preventDefault()
  event.returnValue = ''
}

onMounted(() => window.addEventListener('beforeunload', warnUnsavedChanges))

onBeforeRouteLeave(async () => {
  endDrag()
  await Promise.all([...nodeEditors.values()].map(editor => editor.save()))
  const unsaved = [...nodeEditors.values()].find(editor => editor.isDirty())
  if (unsaved) {
    toast.add({ title: 'Save your canvas changes before leaving.', color: 'error' })
    if (selectedId.value !== unsaved.state.node.canvasId) return canvasPath(unsaved.state.node.canvasId)
    return false
  }
})

function retryLoad() {
  return Promise.all([resourcesQ.refetch(), canvasQ.refetch()])
}
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-col">
    <header class="flex min-h-12 shrink-0 flex-wrap items-center gap-2 px-3 py-2 shadow-[0_1px_0_var(--ui-border)]">
      <LayoutMobileMenuButton />
      <UIcon name="i-ph-selection-background" class="size-5 text-muted" />
      <UInput v-if="activeCanvas" v-model="canvasTitle" variant="none" aria-label="Canvas title" class="min-w-0 flex-1 sm:flex-none" :disabled="saving" :ui="{ base: 'px-1 font-semibold' }" @change="renameCanvas" />
      <span v-else class="font-semibold">Canvases</span>
      <div class="ml-auto flex max-w-full flex-wrap items-center gap-1">
        <DataBookmarkButton v-if="activeCanvas" :server-id="serverId" target-type="canvas" :target-id="activeCanvas.id" />
        <UButton color="neutral" variant="soft" icon="i-ph-note" label="Note" :disabled="!activeCanvas" @click="addNode('note')" />
        <UButton color="neutral" variant="soft" icon="i-ph-text-t" label="Text" :disabled="!activeCanvas" @click="addNode('text')" />
        <UButton :color="connecting ? 'primary' : 'neutral'" :variant="connecting ? 'soft' : 'ghost'" icon="i-ph-path" label="Connect" :disabled="!activeCanvas || nodes.length < 2" @click="toggleConnecting" />
        <UButton color="neutral" variant="ghost" icon="i-ph-trash" aria-label="Delete canvas" :disabled="!activeCanvas" @click="showDelete = true" />
        <UButton icon="i-ph-plus" label="Canvas" @click="nav.createCanvasOpen.value = true" />
      </div>
    </header>

    <div v-if="failedNodes.length" class="shrink-0 space-y-2 border-b border-default p-3">
      <UAlert v-for="node in failedNodes" :key="node.id" color="error" title="Canvas item not saved" :description="nodeEditors.get(node.id)?.state.error">
        <template #actions>
          <UButton color="neutral" variant="soft" label="Save my changes" @click="retryNode(node)" />
          <UButton color="neutral" variant="ghost" label="Discard my changes" @click="discardNodeChanges(node)" />
        </template>
      </UAlert>
    </div>

    <div v-if="connecting" class="shrink-0 border-b border-default bg-primary/10 px-4 py-2 text-sm text-default">
      {{ connectFrom ? 'Choose the second item.' : 'Choose the first item to connect.' }}
    </div>
    <div v-if="resourcesQ.isPending.value || (selectedId && canvases.some(canvas => canvas.id === selectedId) && canvasQ.isPending.value)" class="p-6"><LayoutSkeleton variant="cards" /></div>
    <LayoutLoadError v-else-if="resourcesQ.error.value || canvasQ.error.value" message="Canvases did not load." :retry="retryLoad" />
    <LayoutEmptyState v-else-if="!activeCanvas" icon="i-ph-selection-background" title="No canvases yet" description="A free surface for notes and the connections between them: lay ideas out, then link what belongs together.">
      <UButton v-if="can(Permission.manageDatabases)" icon="i-ph-plus" label="Create first canvas" @click="nav.createCanvasOpen.value = true" />
    </LayoutEmptyState>
    <div v-else ref="viewport" class="min-h-0 flex-1 overflow-auto bg-muted/30">
      <div
        class="relative h-[1600px] w-[2400px]"
        style="background-image: radial-gradient(circle, var(--ui-border) 1px, transparent 1px); background-size: 24px 24px;"
      >
        <svg class="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden="true">
          <template v-for="edge in edges" :key="edge.id">
            <line
              v-if="edgeLine(edge)"
              v-bind="edgeLine(edge)!"
              stroke="var(--ui-border-accented)"
              stroke-width="2"
            />
          </template>
        </svg>

        <article
          v-for="node in nodes"
          :key="node.id"
          :data-canvas-node="node.id"
          class="absolute flex select-none flex-col rounded-lg border shadow-sm transition-shadow"
          :class="[colorClasses[node.color], connectFrom === node.id ? 'ring-2 ring-primary' : '', connecting ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing']"
          :style="{ left: `${node.x}px`, top: `${node.y}px`, width: `${node.width}px`, height: `${node.height}px` }"
          @pointerdown="startDrag($event, node)"
          @click.stop="handleNodeClick(node)"
        >
          <button
            v-if="connecting"
            type="button"
            class="absolute inset-0 z-10 cursor-crosshair rounded-lg"
            :aria-label="connectFrom ? 'Connect to item' : 'Choose item'"
            @click.stop="handleNodeClick(node)"
          />
          <div class="flex h-8 shrink-0 touch-none items-center gap-1 border-b border-default/70 px-2">
            <UIcon :name="node.kind === 'note' ? 'i-ph-note' : 'i-ph-text-t'" class="size-4 text-dimmed" />
            <span class="flex-1 text-xs font-medium text-dimmed">{{ node.kind === 'note' ? 'Note' : 'Text' }}</span>
            <UIcon v-if="nodeEditors.get(node.id)?.state.saving" name="i-ph-spinner-gap" class="size-3 animate-spin text-dimmed" />
            <UDropdownMenu :items="colorMenu(node)"><UButton color="neutral" variant="ghost" size="xs" icon="i-ph-palette" aria-label="Change color" /></UDropdownMenu>
            <UButton color="error" variant="ghost" size="xs" icon="i-ph-x" aria-label="Delete item" @click.stop="removeNode(node)" />
          </div>
          <textarea
            v-model="node.content"
            :aria-label="node.kind === 'note' ? 'Note content' : 'Text content'"
            class="min-h-0 flex-1 resize-none bg-transparent p-3 text-sm text-default outline-none placeholder:text-dimmed"
            :placeholder="node.kind === 'note' ? 'Write a note…' : 'Add text…'"
            @pointerdown.stop
            @blur="patchNode(node, { content: node.content })"
          />
        </article>

        <div v-if="!nodes.length" class="absolute left-[calc(50%-12rem)] top-48 w-96 text-center text-sm text-muted">
          Add a note or text card, then drag it anywhere.
        </div>
      </div>
    </div>

    <UModal v-model:open="showDelete" title="Delete canvas?">
      <template #body><p class="text-sm text-muted">All items and connections on it will be deleted.</p></template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="showDelete = false" />
        <UButton color="error" label="Delete" :loading="saving" @click="removeCanvas" />
      </template>
    </UModal>
  </div>
</template>
