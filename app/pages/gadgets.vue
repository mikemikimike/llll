<script setup lang="ts">
import { navigateTo, errorMessage } from '#imports'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { FormSubmitEvent } from '@nuxt/ui'
import * as z from 'zod'
import { emptyGadgetSpec, GadgetPresentationKinds, type GadgetBinding, type GadgetDetailDTO, type GadgetListDTO, type GadgetRuntimeDatasetDTO, type GadgetRuntimeDTO, type GadgetSpec } from '~~/shared/gadgets'
import type { DatabaseValue } from '~~/shared/database'
import { hasPermission, Permission } from '~~/shared/permissions'
import { gadgetPath } from '~~/shared/paths'
import type { DataResourcesDTO, DatabaseFieldDTO, DatabaseItemDTO, DatabasePageDTO, RoleDTO } from '~~/shared/types'

definePageMeta({ layout: 'server', middleware: ['auth', 'use-gadgets'] })

const { serverId } = useServer()
const { api } = useApi()
const route = useRoute()
const nav = useNavActions()
const qc = useQueryClient()
const toast = useToast()
const functionsQ = useQuery({
  queryKey: computed(() => ['ai-functions', serverId.value]),
  queryFn: () => api<{ functions: Array<{ id: string; available: boolean }> }>(`/api/servers/${serverId.value}/ai-functions`),
  enabled: computed(() => Boolean(serverId.value)),
})
const canGenerate = computed(() => Boolean(functionsQ.data.value?.functions.find(item => item.id === 'apps.assist')?.available))

const gadgetsQ = useQuery({
  queryKey: computed(() => ['gadgets', serverId.value]),
  queryFn: () => api<GadgetListDTO>(`/api/servers/${serverId.value}/gadgets`),
  enabled: computed(() => Boolean(serverId.value)),
})
const gadgets = computed(() => gadgetsQ.data.value?.gadgets ?? [])
const canManage = computed(() => Boolean(gadgetsQ.data.value?.canManage))
const selectedId = computed(() => String(route.query.gadget || '') || gadgets.value[0]?.id || '')
const activeSummary = computed(() => gadgets.value.find(gadget => gadget.id === selectedId.value) ?? null)
const editing = computed(() => canManage.value && (route.query.edit === '1' || Boolean(activeSummary.value && !activeSummary.value.publishedVersion)))

watch([gadgets, selectedId], ([list, id]) => {
  if (!list.length || list.some(gadget => gadget.id === id)) return
  void navigateTo(gadgetPath(list[0]!.id), { replace: true })
}, { immediate: true })

const detailQ = useQuery({
  queryKey: computed(() => ['gadget-detail', selectedId.value]),
  queryFn: () => api<{ gadget: GadgetDetailDTO }>(`/api/gadgets/${selectedId.value}`),
  enabled: computed(() => Boolean(selectedId.value && editing.value)),
})
const runtimeQ = useQuery({
  queryKey: computed(() => ['gadget-runtime', selectedId.value, activeSummary.value?.publishedVersion]),
  queryFn: () => api<GadgetRuntimeDTO>(`/api/gadgets/${selectedId.value}/runtime`),
  enabled: computed(() => Boolean(selectedId.value && activeSummary.value?.publishedVersion && !editing.value)),
  refetchInterval: 10_000,
})
const resourcesQ = useQuery({
  queryKey: computed(() => ['data-resources', serverId.value]),
  queryFn: () => api<DataResourcesDTO>(`/api/servers/${serverId.value}/data-resources`),
  enabled: computed(() => Boolean(serverId.value && editing.value)),
})
const rolesQ = useQuery({
  queryKey: computed(() => ['roles', serverId.value]),
  queryFn: () => api<{ roles: RoleDTO[] }>(`/api/servers/${serverId.value}/roles`),
  enabled: computed(() => Boolean(serverId.value && editing.value)),
})

const createSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  description: z.string().trim().max(500),
  prompt: z.string().trim().max(2000),
})
type CreateSchema = z.output<typeof createSchema>
const createState = reactive<CreateSchema>({ name: '', description: '', prompt: '' })
const creating = ref(false)

async function createGadget(event: FormSubmitEvent<CreateSchema>) {
  creating.value = true
  try {
    const result = await api<{ gadget: GadgetDetailDTO }>(`/api/servers/${serverId.value}/gadgets`, {
      method: 'POST',
      body: {
        name: event.data.name,
        description: event.data.description,
        prompt: event.data.prompt || undefined,
      },
    })
    nav.createGadgetOpen.value = false
    createState.name = ''
    createState.description = ''
    createState.prompt = ''
    await qc.invalidateQueries({ queryKey: ['gadgets', serverId.value] })
    qc.setQueryData(['gadget-detail', result.gadget.id], { gadget: result.gadget })
    await navigateTo(gadgetPath(result.gadget.id, true))
    toast.add({ title: event.data.prompt ? 'Draft generated' : 'App created', color: 'success' })
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  }
  finally {
    creating.value = false
  }
}

const draftName = ref('')
const draftDescription = ref('')
const draftSpec = ref<GadgetSpec>(emptyGadgetSpec())
const draftRoleIds = ref<string[]>([])
const draftRevision = ref(1)
const sourceDetails = shallowRef<Record<string, DatabasePageDTO>>({})
let sourceLoad = 0

function cloneGadgetSpec(spec: GadgetSpec): GadgetSpec {
  return JSON.parse(JSON.stringify(spec)) as GadgetSpec
}

async function loadSourceDetails(spec: GadgetSpec) {
  const load = ++sourceLoad
  const entries = await Promise.all(spec.bindings.map(async (binding) => {
    const page = await api<DatabasePageDTO>(`/api/databases/${binding.source.databaseId}`, {
      query: { view: binding.source.viewId, page: 1, pageSize: 1 },
    })
    return [binding.id, page] as const
  }))
  if (load === sourceLoad) sourceDetails.value = Object.fromEntries(entries)
}

watch(() => detailQ.data.value?.gadget, (gadget) => {
  if (!gadget) return
  draftName.value = gadget.name
  draftDescription.value = gadget.description
  draftSpec.value = cloneGadgetSpec(gadget.draftSpec)
  draftRoleIds.value = [...gadget.roleIds]
  draftRevision.value = gadget.draftRevision
  void loadSourceDetails(gadget.draftSpec).catch(error => toast.add({ title: errorMessage(error), color: 'error' }))
}, { immediate: true })

const viewOptions = computed(() => (resourcesQ.data.value?.databases ?? [])
  .filter(database => !database.archivedAt)
  .flatMap(database => database.views.map(view => ({
    label: `${database.name} / ${view.name}`,
    value: JSON.stringify([database.id, view.id]),
  }))))
const selectedSource = ref<string | undefined>()
const addingSource = ref(false)
const presentationOptions = GadgetPresentationKinds.map(value => ({ label: value.charAt(0).toUpperCase() + value.slice(1), value }))
const shareableRoles = computed(() => (rolesQ.data.value?.roles ?? []).filter(role => role.key !== 'owner'))

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

async function addSource() {
  if (!selectedSource.value) return
  const [databaseId, viewId] = JSON.parse(selectedSource.value) as [string, string]
  if (draftSpec.value.bindings.some(binding => binding.source.databaseId === databaseId && binding.source.viewId === viewId)) {
    toast.add({ title: 'This View is already bound', color: 'warning' })
    return
  }
  addingSource.value = true
  try {
    const page = await api<DatabasePageDTO>(`/api/databases/${databaseId}`, { query: { view: viewId, page: 1, pageSize: 1 } })
    const visible = page.view.config.visibleFieldIds === null
      ? page.database.fields
      : page.database.fields.filter(field => page.view.config.visibleFieldIds?.includes(field.id))
    const bindingId = id('binding')
    const binding: GadgetBinding = {
      id: bindingId,
      label: `${page.database.name} / ${page.view.name}`,
      source: { type: 'database_view', databaseId, viewId },
      fieldIds: visible.map(field => field.id),
      operations: ['read'],
    }
    draftSpec.value.bindings.push(binding)
    draftSpec.value.sections.push({ id: id('section'), bindingId, title: page.view.name, presentation: 'table' })
    sourceDetails.value = { ...sourceDetails.value, [bindingId]: page }
    selectedSource.value = undefined
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  }
  finally {
    addingSource.value = false
  }
}

function sectionFor(bindingId: string) {
  return draftSpec.value.sections.find(section => section.bindingId === bindingId)!
}

function removeBinding(bindingId: string) {
  draftSpec.value.bindings = draftSpec.value.bindings.filter(binding => binding.id !== bindingId)
  draftSpec.value.sections = draftSpec.value.sections.filter(section => section.bindingId !== bindingId)
  const { [bindingId]: _removed, ...remaining } = sourceDetails.value
  sourceDetails.value = remaining
}

function visibleFields(binding: GadgetBinding): DatabaseFieldDTO[] {
  const page = sourceDetails.value[binding.id]
  if (!page) return []
  const visible = page.view.config.visibleFieldIds
  return visible === null ? page.database.fields : page.database.fields.filter(field => visible.includes(field.id))
}

function toggleField(binding: GadgetBinding, fieldId: string, enabled: boolean) {
  binding.fieldIds = enabled ? [...new Set([...binding.fieldIds, fieldId])] : binding.fieldIds.filter(id => id !== fieldId)
}

function toggleOperation(binding: GadgetBinding, operation: 'create' | 'update', enabled: boolean) {
  binding.operations = enabled ? [...new Set([...binding.operations, operation])] : binding.operations.filter(value => value !== operation)
}

function toggleRole(roleId: string, enabled: boolean) {
  draftRoleIds.value = enabled ? [...new Set([...draftRoleIds.value, roleId])] : draftRoleIds.value.filter(id => id !== roleId)
}

const saving = ref(false)
async function saveDraft(): Promise<GadgetDetailDTO | null> {
  if (!selectedId.value) return null
  saving.value = true
  try {
    const result = await api<{ gadget: GadgetDetailDTO }>(`/api/gadgets/${selectedId.value}`, {
      method: 'PATCH',
      body: {
        revision: draftRevision.value,
        name: draftName.value,
        description: draftDescription.value,
        spec: draftSpec.value,
        roleIds: draftRoleIds.value,
      },
    })
    draftRevision.value = result.gadget.draftRevision
    qc.setQueryData(['gadget-detail', selectedId.value], result)
    await qc.invalidateQueries({ queryKey: ['gadgets', serverId.value] })
    toast.add({ title: 'Draft saved', color: 'success' })
    return result.gadget
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
    return null
  }
  finally {
    saving.value = false
  }
}

const publishing = ref(false)
async function publish() {
  publishing.value = true
  try {
    const saved = await saveDraft()
    if (!saved) return
    const result = await api<{ gadget: GadgetDetailDTO }>(`/api/gadgets/${saved.id}/publish`, {
      method: 'POST', body: { revision: saved.draftRevision },
    })
    qc.setQueryData(['gadget-detail', saved.id], result)
    await qc.invalidateQueries({ queryKey: ['gadgets', serverId.value] })
    await navigateTo(gadgetPath(saved.id))
    await qc.invalidateQueries({ queryKey: ['gadget-runtime', saved.id] })
    toast.add({ title: `Version ${result.gadget.publishedVersion} published`, color: 'success' })
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  }
  finally {
    publishing.value = false
  }
}

function datasetFor(bindingId: string): GadgetRuntimeDatasetDTO | null {
  return runtimeQ.data.value?.datasets.find(dataset => dataset.binding.id === bindingId) ?? null
}

function displayValue(value: DatabaseValue | undefined): string {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

function recordString(fieldId: string): string {
  const value = recordValues.value[fieldId]
  return typeof value === 'string' ? value : ''
}

function recordNumber(fieldId: string): number | undefined {
  const value = recordValues.value[fieldId]
  return typeof value === 'number' ? value : undefined
}

function setRecordString(fieldId: string, value: string | number | undefined) {
  recordValues.value[fieldId] = value === undefined ? null : String(value)
}

function setRecordNumber(fieldId: string, value: number | undefined) {
  recordValues.value[fieldId] = value ?? null
}

const recordOpen = ref(false)
const recordBindingId = ref('')
const recordItem = shallowRef<DatabaseItemDTO | null>(null)
const recordTitle = ref('')
const recordValues = ref<Record<string, DatabaseValue>>({})
const recordSaving = ref(false)
const recordDataset = computed(() => datasetFor(recordBindingId.value))

function openRecord(dataset: GadgetRuntimeDatasetDTO, item: DatabaseItemDTO | null = null) {
  recordBindingId.value = dataset.binding.id
  recordItem.value = item
  recordTitle.value = item?.title ?? ''
  recordValues.value = Object.fromEntries(dataset.fields.map(field => [field.id, item?.values[field.id] ?? null]))
  recordOpen.value = true
}

async function saveRecord() {
  const dataset = recordDataset.value
  if (!dataset || !recordTitle.value.trim()) return
  recordSaving.value = true
  try {
    await api(`/api/gadgets/${selectedId.value}/actions`, {
      method: 'POST',
      body: {
        bindingId: dataset.binding.id,
        operation: recordItem.value ? 'update' : 'create',
        recordId: recordItem.value?.id,
        version: recordItem.value?.version,
        title: recordTitle.value,
        values: recordValues.value,
      },
    })
    recordOpen.value = false
    await runtimeQ.refetch()
    toast.add({ title: recordItem.value ? 'Record updated' : 'Record created', color: 'success' })
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  }
  finally {
    recordSaving.value = false
  }
}

function roleLabel(role: RoleDTO) {
  if (role.key === 'admin') return 'Admin'
  if (role.key === 'member') return 'Member'
  return role.name
}

function roleAccessLabel(role: RoleDTO) {
  const granted = hasPermission(role.permissions, Permission.useGadgets) || hasPermission(role.permissions, Permission.manageGadgets)
  return granted ? roleLabel(role) : `${roleLabel(role)} — missing Use gadgets grant`
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <LayoutPageHeader icon="i-ph-squares-four" :title="activeSummary?.name || 'Apps'" :loading="gadgetsQ.isPending.value">
      <template #meta>
        <UBadge v-if="activeSummary?.publishedVersion" color="neutral" variant="subtle" :label="`v${activeSummary.publishedVersion}`" />
      </template>
      <template #actions>
        <UButton
          v-if="canManage && activeSummary && !editing"
          color="neutral"
          variant="ghost"
          icon="i-ph-pencil-simple"
          label="Edit"
          @click="navigateTo(gadgetPath(activeSummary.id, true))"
        />
        <template v-if="editing && activeSummary">
          <UButton v-if="activeSummary.publishedVersion" color="neutral" variant="ghost" label="Close" @click="navigateTo(gadgetPath(activeSummary.id))" />
          <UButton color="neutral" variant="outline" label="Save draft" :loading="saving && !publishing" @click="saveDraft" />
          <UButton label="Publish" icon="i-ph-paper-plane-tilt" :loading="publishing" :disabled="!draftSpec.sections.length" @click="publish" />
        </template>
      </template>
    </LayoutPageHeader>

    <LayoutSkeleton v-if="gadgetsQ.isPending.value" variant="document" />
    <LayoutEmptyState
      v-else-if="!activeSummary"
      icon="i-ph-squares-four"
      title="No apps yet"
      :description="canManage
        ? 'Apps are internal tools built on your databases and shared with the roles you choose.'
        : 'No apps are shared with your role yet.'"
    >
      <UButton v-if="canManage" icon="i-ph-plus" label="Create first app" @click="nav.createGadgetOpen.value = true" />
    </LayoutEmptyState>

    <main v-else-if="editing" class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <LayoutSkeleton v-if="detailQ.isPending.value" variant="form" class="mx-auto max-w-5xl" />
      <LayoutLoadError v-else-if="detailQ.error.value" :message="`The draft did not load. ${errorMessage(detailQ.error.value)}`" :retry="detailQ.refetch" />
      <div v-else class="mx-auto max-w-5xl space-y-8">
        <section class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Name" required><UInput v-model="draftName" class="w-full" /></UFormField>
          <UFormField label="Description"><UInput v-model="draftDescription" class="w-full" /></UFormField>
        </section>

        <section>
          <div class="mb-3 flex items-center justify-between gap-3">
            <h2 class="text-sm font-semibold text-highlighted">Sources</h2>
            <div class="flex min-w-0 items-center gap-2">
              <USelectMenu v-model="selectedSource" :items="viewOptions" value-key="value" class="w-72 max-w-full" placeholder="Database / View" />
              <UButton icon="i-ph-plus" label="Add" :loading="addingSource" :disabled="!selectedSource" @click="addSource" />
            </div>
          </div>
          <div v-if="!draftSpec.bindings.length" class="rounded-lg border border-dashed border-default p-8 text-center text-sm text-muted">
            Add at least one Database View.
          </div>
          <div v-else class="space-y-4">
            <UCard v-for="binding in draftSpec.bindings" :key="binding.id">
              <template #header>
                <div class="flex items-center gap-3">
                  <UIcon name="i-ph-database" class="size-5 text-dimmed" />
                  <span class="min-w-0 flex-1 truncate font-medium">{{ binding.label }}</span>
                  <UButton color="error" variant="ghost" icon="i-ph-trash" aria-label="Remove source" @click="removeBinding(binding.id)" />
                </div>
              </template>
              <div class="grid gap-5 lg:grid-cols-2">
                <div class="space-y-4">
                  <UFormField label="Section title"><UInput v-model="sectionFor(binding.id).title" class="w-full" /></UFormField>
                  <UFormField label="Presentation"><USelect v-model="sectionFor(binding.id).presentation" :items="presentationOptions" class="w-full" /></UFormField>
                  <div>
                    <p class="mb-2 text-xs font-medium text-muted">Actions</p>
                    <div class="flex flex-wrap gap-4">
                      <UCheckbox :model-value="true" label="Read" disabled />
                      <UCheckbox :model-value="binding.operations.includes('create')" label="Create" @update:model-value="toggleOperation(binding, 'create', Boolean($event))" />
                      <UCheckbox :model-value="binding.operations.includes('update')" label="Update" @update:model-value="toggleOperation(binding, 'update', Boolean($event))" />
                    </div>
                  </div>
                </div>
                <div>
                  <p class="mb-2 text-xs font-medium text-muted">Visible Fields</p>
                  <div class="grid gap-2 sm:grid-cols-2">
                    <UCheckbox :model-value="true" label="Title" disabled />
                    <UCheckbox
                      v-for="field in visibleFields(binding)"
                      :key="field.id"
                      :model-value="binding.fieldIds.includes(field.id)"
                      :label="field.name"
                      @update:model-value="toggleField(binding, field.id, Boolean($event))"
                    />
                  </div>
                </div>
              </div>
            </UCard>
          </div>
        </section>

        <section>
          <h2 class="text-sm font-semibold text-highlighted">Access</h2>
          <div class="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <UCheckbox
              v-for="role in shareableRoles"
              :key="role.id"
              :model-value="draftRoleIds.includes(role.id)"
              :label="roleAccessLabel(role)"
              @update:model-value="toggleRole(role.id, Boolean($event))"
            />
          </div>
        </section>
      </div>
    </main>

    <main v-else class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <LayoutSkeleton v-if="runtimeQ.isPending.value" variant="table" class="mx-auto max-w-7xl" />
      <div v-else-if="runtimeQ.error.value" class="mx-auto max-w-7xl"><UAlert color="error" title="Could not open this app" :description="errorMessage(runtimeQ.error.value)" /></div>
      <div v-else-if="runtimeQ.data.value" class="mx-auto max-w-7xl">
        <p v-if="runtimeQ.data.value.gadget.description" class="mb-6 text-sm text-muted">{{ runtimeQ.data.value.gadget.description }}</p>
        <div class="grid gap-5 xl:grid-cols-2">
          <UCard
            v-for="section in runtimeQ.data.value.spec.sections"
            :key="section.id"
            :class="section.presentation === 'table' ? 'xl:col-span-2' : ''"
          >
            <template #header>
              <div class="flex items-center gap-3">
                <div class="min-w-0 flex-1">
                  <h2 class="truncate font-semibold text-highlighted">{{ section.title }}</h2>
                  <p class="truncate text-xs text-muted">{{ datasetFor(section.bindingId)?.database.name }} / {{ datasetFor(section.bindingId)?.view.name }}</p>
                </div>
                <UButton
                  v-if="datasetFor(section.bindingId)?.binding.operations.includes('create')"
                  size="sm"
                  icon="i-ph-plus"
                  label="Record"
                  @click="openRecord(datasetFor(section.bindingId)!)"
                />
              </div>
            </template>
            <template v-if="datasetFor(section.bindingId)" #default>
              <div v-if="section.presentation === 'metric'" class="py-5">
                <p class="text-4xl font-semibold tabular-nums text-highlighted">{{ datasetFor(section.bindingId)!.total }}</p>
                <p class="mt-1 text-sm text-muted">records</p>
              </div>
              <ul v-else-if="section.presentation === 'list'" class="divide-y divide-default">
                <li v-for="item in datasetFor(section.bindingId)!.items" :key="item.id" class="flex items-center gap-3 py-3">
                  <div class="min-w-0 flex-1">
                    <p class="truncate font-medium text-highlighted">{{ item.title }}</p>
                    <p class="truncate text-xs text-muted">{{ datasetFor(section.bindingId)!.fields.map(field => displayValue(item.values[field.id])).join(' · ') }}</p>
                  </div>
                  <UButton
                    v-if="datasetFor(section.bindingId)!.binding.operations.includes('update')"
                    color="neutral"
                    variant="ghost"
                    icon="i-ph-pencil-simple"
                    aria-label="Edit Record"
                    @click="openRecord(datasetFor(section.bindingId)!, item)"
                  />
                </li>
              </ul>
              <div v-else class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead><tr class="border-b border-default text-left text-xs text-muted"><th class="px-3 py-2 font-medium">Title</th><th v-for="field in datasetFor(section.bindingId)!.fields" :key="field.id" class="px-3 py-2 font-medium">{{ field.name }}</th><th class="w-10" /></tr></thead>
                  <tbody>
                    <tr v-for="item in datasetFor(section.bindingId)!.items" :key="item.id" class="border-b border-muted last:border-0">
                      <td class="px-3 py-2 font-medium text-highlighted">{{ item.title }}</td>
                      <td v-for="field in datasetFor(section.bindingId)!.fields" :key="field.id" class="px-3 py-2 text-muted">{{ displayValue(item.values[field.id]) }}</td>
                      <td class="px-1 py-1">
                        <UButton
                          v-if="datasetFor(section.bindingId)!.binding.operations.includes('update')"
                          color="neutral"
                          variant="ghost"
                          icon="i-ph-pencil-simple"
                          aria-label="Edit Record"
                          @click="openRecord(datasetFor(section.bindingId)!, item)"
                        />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p
                v-if="section.presentation !== 'metric' && datasetFor(section.bindingId)!.total > datasetFor(section.bindingId)!.items.length"
                class="border-t border-default pt-3 text-xs text-muted"
              >
                Showing {{ datasetFor(section.bindingId)!.items.length }} of {{ datasetFor(section.bindingId)!.total }} records
              </p>
            </template>
          </UCard>
        </div>
      </div>
    </main>

    <UModal v-model:open="nav.createGadgetOpen.value" title="Create app">
      <template #body>
        <UForm id="create-gadget" :schema="createSchema" :state="createState" class="space-y-4" @submit="createGadget">
          <UFormField name="name" label="Name" required><UInput v-model="createState.name" autofocus class="w-full" /></UFormField>
          <UFormField name="description" label="Description"><UInput v-model="createState.description" class="w-full" /></UFormField>
          <UFormField
            name="prompt"
            label="Help with Apps"
            :hint="canGenerate ? 'Optional' : 'Choose a model'"
            :description="canGenerate ? 'Only available Database View names and visible Field names are sent to the selected model.' : 'Ask the Server owner to assign a model to Help with Apps in Settings → Agents → Providers, or create the App directly.'"
          >
            <UTextarea v-model="createState.prompt" :disabled="!canGenerate" class="w-full" autoresize :rows="3" placeholder="Build a sales overview from Leads and Companies" />
          </UFormField>
        </UForm>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="nav.createGadgetOpen.value = false" />
        <UButton type="submit" form="create-gadget" :label="createState.prompt.trim() ? 'Generate draft' : 'Create draft'" :loading="creating" />
      </template>
    </UModal>

    <UModal v-model:open="recordOpen" :title="recordItem ? 'Edit Record' : 'Create Record'">
      <template #body>
        <div class="space-y-4">
          <UFormField label="Title" required><UInput v-model="recordTitle" autofocus class="w-full" /></UFormField>
          <UFormField v-for="field in recordDataset?.fields ?? []" :key="field.id" :label="field.name">
            <UInput v-if="field.type === 'text'" :model-value="recordString(field.id)" class="w-full" @update:model-value="setRecordString(field.id, $event)" />
            <UInputNumber v-else-if="field.type === 'number'" :model-value="recordNumber(field.id)" class="w-full" @update:model-value="setRecordNumber(field.id, $event)" />
            <UCheckbox v-else-if="field.type === 'boolean'" :model-value="Boolean(recordValues[field.id])" @update:model-value="recordValues[field.id] = Boolean($event)" />
            <UInput v-else-if="field.type === 'date'" :model-value="recordString(field.id)" type="date" class="w-full" @update:model-value="setRecordString(field.id, $event)" />
            <USelect v-else :model-value="recordString(field.id)" :items="field.options" class="w-full" @update:model-value="setRecordString(field.id, $event)" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="recordOpen = false" />
        <UButton label="Save" :loading="recordSaving" :disabled="!recordTitle.trim()" @click="saveRecord" />
      </template>
    </UModal>
  </div>
</template>
