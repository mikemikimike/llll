import { effectScope, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDocumentDraft } from '../../app/composables/useDocumentDraft'
import { useDatabaseEdits } from '../../app/composables/useDatabaseEdits'
import type { DatabaseItemDTO, DocumentDTO } from '../../shared/types'

function document(id: string, version = 1): DocumentDTO {
  return { id, title: id, content: 'Original', version, position: 0, createdBy: 'owner', createdAt: '', updatedAt: '' }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

afterEach(() => vi.useRealTimers())

describe('document drafts', () => {
  it('flushes a pending debounce and serializes text entered while saving', async () => {
    vi.useFakeTimers()
    const scope = effectScope()
    const source = ref<DocumentDTO | null>(document('a'))
    const first = deferred<DocumentDTO>()
    const persist = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(async (_id, patch) => ({ ...document('a', 3), ...patch, version: 3 }))
    const draft = scope.run(() => useDocumentDraft(source, persist, saved => { source.value = saved }))!
    draft.content.value = 'First edit'
    draft.scheduleSave()
    const saved = draft.save()
    await Promise.resolve()
    draft.content.value = 'Second edit'
    first.resolve({ ...document('a', 2), content: 'First edit' })
    expect(await saved).toBe(true)
    expect(persist.mock.calls[1]).toEqual(['a', { title: 'a', content: 'Second edit', version: 2 }])
    expect(draft.content.value).toBe('Second edit')
    expect(draft.dirty.value).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(persist).toHaveBeenCalledTimes(2)
    scope.stop()
  })

  it('saves an empty title as Untitled without repeatedly persisting the same draft', async () => {
    const scope = effectScope()
    const source = ref<DocumentDTO | null>(document('a'))
    const persist = vi.fn().mockImplementation(async (_id, patch) => ({ ...document('a', 2), ...patch, version: 2 }))
    const draft = scope.run(() => useDocumentDraft(source, persist, saved => { source.value = saved }))!
    draft.title.value = '  '
    draft.content.value = 'My notes'
    expect(await draft.save()).toBe(true)
    expect(persist).toHaveBeenCalledExactlyOnceWith('a', { title: 'Untitled', content: 'My notes', version: 1 })
    expect(draft.dirty.value).toBe(false)
    expect(await draft.save()).toBe(true)
    expect(persist).toHaveBeenCalledTimes(1)
    scope.stop()
  })

  it('opens a generated Untitled name as an empty field and keeps it until the member types', async () => {
    const scope = effectScope()
    const source = ref<DocumentDTO | null>({ ...document('a'), title: 'Untitled 3' })
    const persist = vi.fn().mockImplementation(async (_id, patch) => ({ ...document('a', 2), ...patch, version: 2 }))
    const draft = scope.run(() => useDocumentDraft(source, persist, saved => { source.value = saved }))!
    expect(draft.title.value).toBe('')
    expect(draft.dirty.value).toBe(false)
    draft.content.value = 'Notes'
    expect(await draft.save()).toBe(true)
    expect(persist).toHaveBeenCalledExactlyOnceWith('a', { title: 'Untitled 3', content: 'Notes', version: 1 })
    draft.title.value = 'Plan'
    expect(await draft.save()).toBe(true)
    expect(persist).toHaveBeenLastCalledWith('a', { title: 'Plan', content: 'Notes', version: 2 })
    expect(draft.title.value).toBe('Plan')
    scope.stop()
  })

  it('retains drafts and stops retries after a conflict', async () => {
    vi.useFakeTimers()
    const scope = effectScope()
    const source = ref<DocumentDTO | null>(document('a'))
    const persist = vi.fn().mockRejectedValue(new Error('Changed elsewhere'))
    const draft = scope.run(() => useDocumentDraft(source, persist, vi.fn()))!
    draft.content.value = 'Keep this'
    draft.scheduleSave()
    await vi.advanceTimersByTimeAsync(600)
    expect(draft.saveError.value).toBeInstanceOf(Error)
    expect(await draft.save()).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(persist).toHaveBeenCalledTimes(2)
    source.value = { ...document('a', 2), content: 'Remote edit' }
    expect(draft.content.value).toBe('Keep this')
    source.value = document('b')
    expect(draft.content.value).toBe('Original')
    source.value = document('a', 2)
    expect(draft.content.value).toBe('Keep this')
    draft.discard()
    expect(draft.content.value).toBe('Original')
    expect(draft.dirty.value).toBe(false)
    scope.stop()
  })

  it('keeps an old save response isolated from a newly selected document', async () => {
    const scope = effectScope()
    const source = ref<DocumentDTO | null>(document('a'))
    const pending = deferred<DocumentDTO>()
    const draft = scope.run(() => useDocumentDraft(source, () => pending.promise, vi.fn()))!
    draft.content.value = 'A edit'
    const saving = draft.save()
    await Promise.resolve()
    source.value = document('b', 7)
    draft.content.value = 'B edit'
    pending.resolve({ ...document('a', 2), content: 'A edit' })
    await saving
    expect(draft.content.value).toBe('B edit')
    expect(draft.dirty.value).toBe(true)
    scope.stop()
  })
})

describe('database editing', () => {
  const item: DatabaseItemDTO = { id: 'row', databaseId: 'db', title: 'Title', version: 1, position: 0, createdBy: 'owner', createdAt: '', updatedAt: '', values: { a: 'A', b: 'B' } }

  it('uses the returned row version for a second cell and retains newer typing', async () => {
    const first = deferred<DatabaseItemDTO>()
    const persist = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(async (_id, patch) => ({ ...item, version: 3, values: { a: 'Newer A', b: 'New B', ...patch.values } }))
    const editor = useDatabaseEdits(persist, vi.fn())
    editor.update(item, { values: { a: 'New A' } })
    await Promise.resolve()
    editor.update(item, { values: { a: 'Newer A', b: 'New B' } })
    expect(persist).toHaveBeenCalledTimes(1)
    first.resolve({ ...item, version: 2, values: { a: 'New A', b: 'B' } })
    await editor.save(item.id)
    expect(persist.mock.calls[1]).toEqual(['row', { values: { a: 'Newer A', b: 'New B' }, version: 2 }])
    expect(editor.display(item).values).toEqual({ a: 'Newer A', b: 'New B' })
  })

  it('preserves a failed cell edit and does not retry until requested', async () => {
    const persist = vi.fn().mockRejectedValue(new Error('Offline'))
    const editor = useDatabaseEdits(persist, vi.fn())
    editor.update(item, { values: { a: 'Unsaved' } })
    await editor.save(item.id)
    editor.update(item, { values: { b: 'Also unsaved' } })
    expect(persist).toHaveBeenCalledTimes(1)
    expect(editor.display(item).values).toEqual({ a: 'Unsaved', b: 'Also unsaved' })
    expect(editor.edits.get(item.id)?.error).toBeInstanceOf(Error)
  })
})
