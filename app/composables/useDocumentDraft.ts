import { computed, onScopeDispose, reactive, watch, type Ref } from 'vue'
import type { DocumentDTO } from '~~/shared/types'

type Draft = {
  id: string
  title: string
  content: string
  savedTitle: string
  savedContent: string
  version: number
  saving: boolean
  error: unknown
}

export function useDocumentDraft(
  document: Ref<DocumentDTO | null>,
  persist: (id: string, patch: { title: string; content: string; version: number }) => Promise<DocumentDTO>,
  onSaved: (document: DocumentDTO) => void,
) {
  const drafts = reactive(new Map<string, Draft>())
  const pending = new Map<string, Promise<boolean>>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const draft = computed(() => document.value ? drafts.get(document.value.id) : undefined)
  // A new document is stored as "Untitled" (or "Untitled 2", …) so it has a name in lists; the editor
  // shows that as an empty field so the first keystroke replaces it. Leaving it empty keeps the stored name.
  const isGeneratedTitle = (title: string) => /^Untitled(?: \d+)?$/.test(title)
  const editableTitle = (title: string) => isGeneratedTitle(title) ? '' : title
  const effectiveTitle = (value: Draft) => value.title.trim() || (isGeneratedTitle(value.savedTitle) ? value.savedTitle : 'Untitled')
  const isDirty = (value: Draft) => effectiveTitle(value) !== value.savedTitle || value.content !== value.savedContent

  watch(document, (value) => {
    if (!value) return
    const existing = drafts.get(value.id)
    if (existing && (isDirty(existing) || existing.saving)) return
    const next = {
      id: value.id, title: editableTitle(value.title), content: value.content,
      savedTitle: value.title, savedContent: value.content, version: value.version,
      saving: false, error: null,
    }
    if (existing) Object.assign(existing, next)
    else drafts.set(value.id, reactive(next))
  }, { immediate: true, flush: 'sync' })

  function save(value = draft.value): Promise<boolean> {
    if (!value) return Promise.resolve(true)
    clearTimeout(timers.get(value.id))
    timers.delete(value.id)
    const inFlight = pending.get(value.id)
    if (inFlight) return inFlight
    if (!isDirty(value)) return Promise.resolve(true)
    const run = async () => {
      value.saving = true
      value.error = null
      try {
        while (isDirty(value)) {
          const title = effectiveTitle(value)
          const content = value.content
          const saved = await persist(value.id, { title, content, version: value.version })
          value.version = saved.version
          value.savedTitle = title
          value.savedContent = content
          onSaved(saved)
        }
        return true
      }
      catch (error) {
        value.error = error
        return false
      }
      finally {
        value.saving = false
        pending.delete(value.id)
      }
    }
    // Set the promise before validation can finish synchronously.
    const promise = Promise.resolve().then(run)
    pending.set(value.id, promise)
    return promise
  }

  function scheduleSave() {
    const value = draft.value
    if (!value) return
    clearTimeout(timers.get(value.id))
    // Failures require an explicit retry; never loop on a conflict or outage.
    if (value.error) return
    timers.set(value.id, setTimeout(() => void save(value), 600))
  }

  onScopeDispose(() => {
    for (const timer of timers.values()) clearTimeout(timer)
  })

  return {
    title: computed({ get: () => draft.value?.title ?? '', set: value => { if (draft.value) draft.value.title = value } }),
    content: computed({ get: () => draft.value?.content ?? '', set: value => { if (draft.value) draft.value.content = value } }),
    dirty: computed(() => Boolean(draft.value && isDirty(draft.value))),
    saving: computed(() => draft.value?.saving ?? false),
    saveError: computed(() => draft.value?.error),
    save: () => save(),
    cancelScheduledSave: () => {
      if (!draft.value) return
      clearTimeout(timers.get(draft.value.id))
      timers.delete(draft.value.id)
    },
    discard: () => {
      const value = document.value
      if (!value || draft.value?.saving) return
      clearTimeout(timers.get(value.id))
      timers.delete(value.id)
      drafts.set(value.id, {
        id: value.id, title: editableTitle(value.title), content: value.content,
        savedTitle: value.title, savedContent: value.content, version: value.version,
        saving: false, error: null,
      })
    },
    scheduleSave,
  }
}
