import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { d1 } from '../helpers/sqlite-d1'
import { INIT_SQL } from '../../server/utils/db'
import { createRecord, updateRecord } from '../../server/utils/record-service'
import { loadDatabasePage, normalizeDatabaseViewConfig } from '../../server/utils/database-views'
import { allocateDatabaseSlot, databaseFieldsFor, loadDatabaseItem } from '../../server/utils/database-data'
import { createTable } from '../../server/utils/table-service'
import { defaultDatabaseViewConfig } from '../../shared/database'
import { ALL_PERMISSIONS } from '../../shared/permissions'
import type { AuthorizationContext } from '../../shared/authorization'
import type { L4Env } from '../../workers/env'

let db: DatabaseSync, env: L4Env
const auth: AuthorizationContext = { serverId: '00000000-0000-4000-8000-000000000001', principal: { id: 'owner', kind: 'human', roleId: 'owner-role', roleName: 'Owner', permissions: ALL_PERMISSIONS, isOwner: true, resourceAccess: {} }, credential: { kind: 'session' } }

beforeEach(() => {
  vi.stubGlobal('createError', createError)
  db = new DatabaseSync(':memory:'); db.exec(INIT_SQL)
  db.exec(`INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('owner-role','owner','Owner',${ALL_PERMISSIONS});
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('owner','human','Owner','active','owner-role','2026-10-24'),('ann','human','Ann','active','owner-role','2026-10-24');
    INSERT INTO server_identity(singleton,id) VALUES(1,'${auth.serverId}'); INSERT INTO server(id,name,owner_id) VALUES('${auth.serverId}','Fixture','owner');
    INSERT INTO database_definitions(id,name,created_by) VALUES('projects','Projects','owner'),('tasks','Tasks','owner');
    INSERT INTO database_fields(id,database_id,name,type,slot,config_json,created_by) VALUES
      ('project','tasks','Project','relation','links_1','{"options":[],"relation":{"databaseId":"projects"}}','owner'),
      ('tags','tasks','Tags','multi_select','select_1','{"options":["Bug","Idea"]}','owner'),
      ('owner','tasks','Owner','person','text_1','{"options":[]}','owner'),
      ('site','tasks','Site','url','text_2','{"options":[]}','owner');
    INSERT INTO database_items(id,database_id,title,created_by) VALUES('p1','projects','Website','owner'),('p2','projects','App','owner');`)
  env = { DB: d1(db) } as L4Env
})
afterEach(() => { db.close(); vi.unstubAllGlobals() })

describe('relation, list and address fields', () => {
  it('stores links, options, people and addresses and returns them with the linked titles', async () => {
    const item = await createRecord(env, auth, 'tasks', { title: 'Launch', values: { project: ['p1'], tags: ['Idea', 'Bug'], owner: ['ann'], site: 'example.com/path' } })
    expect(item.values).toEqual({ project: ['p1'], tags: ['Idea', 'Bug'], owner: ['ann'], site: 'https://example.com/path' })
    const page = await loadDatabasePage(env, 'tasks', { page: 1, pageSize: 50 })
    expect(page.items[0]?.values.project).toEqual(['p1'])
    expect(page.linked).toEqual({ p1: { id: 'p1', databaseId: 'projects', title: 'Website' } })
  })

  it('replaces a relation in the given order and answers with exactly what it committed', async () => {
    const item = await createRecord(env, auth, 'tasks', { title: 'Launch', values: { project: ['p1'] } })
    const updated = await updateRecord(env, auth, item.id, { values: { project: ['p2', 'p1'], tags: [] }, version: 1 })
    expect(updated.version).toBe(2)
    expect(updated.values.project).toEqual(['p2', 'p1'])
    expect(updated.values.tags).toEqual([])
    expect((await loadDatabaseItem(env, item.id))?.values.project).toEqual(['p2', 'p1'])
    const cleared = await updateRecord(env, auth, item.id, { values: { project: null }, version: 2 })
    expect(cleared.values.project).toEqual([])
    expect(db.prepare('SELECT COUNT(*) as total FROM database_item_links').get()).toEqual({ total: 0 })
  })

  it('refuses records of another database, strangers and unknown options', async () => {
    const stray = await createRecord(env, auth, 'tasks', { title: 'Stray' })
    await expect(createRecord(env, auth, 'tasks', { title: 'Bad link', values: { project: [stray.id] } })).rejects.toMatchObject({ statusCode: 400 })
    await expect(createRecord(env, auth, 'tasks', { title: 'Bad person', values: { owner: ['nobody'] } })).rejects.toMatchObject({ statusCode: 400 })
    await expect(createRecord(env, auth, 'tasks', { title: 'Bad tag', values: { tags: ['Nope'] } })).rejects.toMatchObject({ statusCode: 400 })
    await expect(createRecord(env, auth, 'tasks', { title: 'Bad site', values: { site: 'not a url' } })).rejects.toMatchObject({ statusCode: 400 })
    expect(db.prepare('SELECT COUNT(*) as total FROM database_items WHERE database_id = ?').get('tasks')).toEqual({ total: 1 })
  })

  it('filters by linked, option and person values', async () => {
    await createRecord(env, auth, 'tasks', { title: 'Linked', values: { project: ['p1'], tags: ['Bug'], owner: ['ann'] } })
    await createRecord(env, auth, 'tasks', { title: 'Loose', values: { tags: ['Idea'] } })
    const fields = await databaseFieldsFor(env, 'tasks')
    const view = (filters: unknown[]) => {
      const config = normalizeDatabaseViewConfig({ ...defaultDatabaseViewConfig(), filters }, fields, 'table', true)
      db.prepare(`INSERT OR REPLACE INTO database_views(id,database_id,name,layout,config_json,created_by) VALUES('v','tasks','Filtered','table',?,'owner')`).run(JSON.stringify(config))
      return loadDatabasePage(env, 'tasks', { viewId: 'v', page: 1, pageSize: 50 })
    }
    expect((await view([{ fieldId: 'project', operator: 'is_not_empty' }])).items.map(item => item.title)).toEqual(['Linked'])
    expect((await view([{ fieldId: 'project', operator: 'is_empty' }])).items.map(item => item.title)).toEqual(['Loose'])
    expect((await view([{ fieldId: 'tags', operator: 'contains', value: 'Idea' }])).items.map(item => item.title)).toEqual(['Loose'])
    expect((await view([{ fieldId: 'owner', operator: 'contains', value: 'ann' }])).items.map(item => item.title)).toEqual(['Linked'])
    expect(() => normalizeDatabaseViewConfig({ ...defaultDatabaseViewConfig(), filters: [{ fieldId: 'project', operator: 'equals', value: 'p1' }] }, fields, 'table', true)).toThrow()
  })

  it('drops a link with the record it points at and accepts a gallery view', async () => {
    const item = await createRecord(env, auth, 'tasks', { title: 'Launch', values: { project: ['p1', 'p2'] } })
    db.prepare('DELETE FROM database_items WHERE id = ?').run('p1')
    expect((await loadDatabaseItem(env, item.id))?.values.project).toEqual(['p2'])
    db.prepare(`INSERT INTO database_views(id,database_id,name,layout,created_by) VALUES('g','tasks','Cards','gallery','owner')`).run()
    expect((await loadDatabasePage(env, 'tasks', { viewId: 'g', page: 1, pageSize: 10 })).view.layout).toBe('gallery')
  })

  it('keeps the titles of a database the reader may not open to itself, and refuses links into it', async () => {
    const item = await createRecord(env, auth, 'tasks', { title: 'Launch', values: { project: ['p1'] } })
    const limited: AuthorizationContext = { ...auth, principal: { ...auth.principal, isOwner: false, resourceAccess: { databases: ['tasks'] } } }
    const page = await loadDatabasePage(env, 'tasks', { page: 1, pageSize: 50, authorization: limited })
    expect(page.items[0]?.values.project).toEqual(['p1'])
    expect(page.linked).toEqual({})
    expect((await loadDatabasePage(env, 'tasks', { page: 1, pageSize: 50, authorization: auth })).linked.p1?.title).toBe('Website')
    await expect(updateRecord(env, limited, item.id, { values: { project: ['p2'] }, version: 1 })).rejects.toThrow(/not granted/u)
    // Clearing a relation needs no access to where it pointed.
    expect((await updateRecord(env, limited, item.id, { values: { project: [] }, version: 1 })).values.project).toEqual([])
  })

  it('shares one column pool between the types stored in it', async () => {
    // text_1 and text_2 hold Owner and Site, so the next text-like field takes text_3.
    expect(await allocateDatabaseSlot(env, 'tasks', 'email')).toBe('text_3')
    expect(await allocateDatabaseSlot(env, 'tasks', 'text')).toBe('text_3')
    expect(await allocateDatabaseSlot(env, 'tasks', 'select')).toBe('select_2')
    expect(await allocateDatabaseSlot(env, 'tasks', 'relation')).toBe('links_2')
  })

  it('creates a table whose relation points at itself', async () => {
    const table = await createTable(env, auth, { name: 'Pages', fields: [
      { name: 'Parent', type: 'relation', relation: { databaseId: 'self' } },
      { name: 'Site', type: 'url' },
      { name: 'Notes', type: 'text' },
      { name: 'Labels', type: 'multi_select', options: ['A', 'B'] },
    ] })
    expect(table.fields.map(field => [field.name, field.type, field.relation?.databaseId ?? null])).toEqual([
      ['Parent', 'relation', table.id], ['Site', 'url', null], ['Notes', 'text', null], ['Labels', 'multi_select', null],
    ])
    expect(db.prepare('SELECT slot FROM database_fields WHERE database_id = ? ORDER BY position').all(table.id)).toEqual([{ slot: 'links_1' }, { slot: 'text_1' }, { slot: 'text_2' }, { slot: 'select_1' }])
    await expect(createTable(env, auth, { name: 'Broken', fields: [{ name: 'Parent', type: 'relation', relation: { databaseId: 'missing' } }] })).rejects.toMatchObject({ statusCode: 404 })
  })
})
