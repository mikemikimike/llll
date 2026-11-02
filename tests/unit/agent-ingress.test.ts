import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signalAgentsForMessage } from '../../workers/agent-ingress'

let sqlite: DatabaseSync
let db: D1Database

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: unknown[] = []
      const statement = {
        bind(...next: unknown[]) {
          values = next
          return statement
        },
        async first<T>() {
          return (database.prepare(sql).get(...values) as T | undefined) ?? null
        },
        async all<T>() {
          return { results: database.prepare(sql).all(...values) as T[] }
        },
      }
      return statement
    },
  } as unknown as D1Database
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE roles (id TEXT PRIMARY KEY, permissions_bitmask INTEGER NOT NULL);
    CREATE TABLE server (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL);
    CREATE TABLE users (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, role_id TEXT NOT NULL);
    CREATE TABLE agents (user_id TEXT PRIMARY KEY, status TEXT NOT NULL, access TEXT NOT NULL DEFAULT 'open');
    CREATE TABLE grants (id TEXT PRIMARY KEY, member_id TEXT, role_id TEXT, agent_id TEXT, expires_at TEXT, project_id TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, archived_at TEXT);
    CREATE TABLE channels (id TEXT PRIMARY KEY, type TEXT NOT NULL, visibility TEXT NOT NULL, parent_id TEXT);
    CREATE TABLE channel_members (channel_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE attachments (id TEXT PRIMARY KEY, message_id TEXT, content_type TEXT NOT NULL);

    INSERT INTO roles VALUES ('admin-role', 8192), ('member-role', 112);
    INSERT INTO server VALUES ('main', 'owner');
    INSERT INTO users VALUES
      ('owner', 'human', 'active', 'member-role'),
      ('human', 'human', 'active', 'admin-role'),
      ('member', 'human', 'active', 'member-role'),
      ('agent', 'agent', 'active', 'member-role');
    INSERT INTO agents(user_id,status) VALUES ('agent', 'active');
    INSERT INTO channels VALUES
      ('dm', 'dm', 'private', NULL),
      ('thread', 'thread', 'private', 'dm');
    INSERT INTO channel_members VALUES
      ('dm', 'human'),
      ('dm', 'agent');
  `)
  db = d1(sqlite)
})

afterEach(() => sqlite.close())

describe('agent message ingress', () => {
  it('does not treat server administration as permission to invoke agents', async () => {
    sqlite.exec("UPDATE roles SET permissions_bitmask = 1 WHERE id = 'admin-role'")
    const receiveMessage = vi.fn()
    await signalAgentsForMessage({ DB: db, AI: {}, AGENT_DO: { getByName: () => ({ receiveMessage }) } } as never,
      { messageId: 'denied', channelId: 'dm', authorId: 'human', authorName: 'Human', content: 'run', mentionIds: ['agent'] })
    expect(receiveMessage).not.toHaveBeenCalled()
  })

  it('keeps addressing the agent inside a one-to-one DM thread', async () => {
    const receiveMessage = vi.fn(async () => 'workflow-id')
    const env = {
      DB: db,
      AI: {},
      AGENT_DO: { getByName: () => ({ receiveMessage }) },
    }

    await signalAgentsForMessage(env as never, {
      messageId: 'message-thread',
      channelId: 'thread',
      authorId: 'human',
      authorName: 'Human',
      content: 'Continue here',
      mentionIds: [],
      mode: 'steer',
    })

    expect(receiveMessage).toHaveBeenCalledWith({
      messageId: 'message-thread',
      channelId: 'thread',
      authorId: 'human',
      authorName: 'Human',
      content: 'Continue here',
      hasImages: false,
      mode: 'steer',
    })
  })

  it('starts a DM turn for an image-only message', async () => {
    sqlite.exec("INSERT INTO attachments VALUES ('image-1', 'message-image', 'image/png')")
    const receiveMessage = vi.fn(async () => 'workflow-id')
    const env = {
      DB: db,
      AI: {},
      AGENT_DO: { getByName: () => ({ receiveMessage }) },
    }

    await signalAgentsForMessage(env as never, {
      messageId: 'message-image',
      channelId: 'dm',
      authorId: 'human',
      authorName: 'Human',
      content: '',
      mentionIds: [],
    })

    expect(receiveMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'message-image',
      content: '',
      hasImages: true,
    }))
  })

  it('starts a turn through an OpenAI-compatible endpoint when Workers AI is absent', async () => {
    const receiveMessage = vi.fn(async () => 'workflow-id')
    const env = {
      DB: db,
      AI_BASE_URL: 'https://llm.example.com/v1',
      AI_API_KEY: 'secret',
      AI_MODEL: 'your-model',
      AGENT_DO: { getByName: () => ({ receiveMessage }) },
    }

    await signalAgentsForMessage(env as never, {
      messageId: 'message-compatible',
      channelId: 'dm',
      authorId: 'human',
      authorName: 'Human',
      content: 'Hello',
      mentionIds: [],
    })

    expect(receiveMessage).toHaveBeenCalled()
  })

  it('routes to the coordinator without a model provider so it can report configuration failure', async () => {
    const receiveMessage = vi.fn(async () => 'workflow-id')
    const env = {
      DB: db,
      AGENT_DO: { getByName: () => ({ receiveMessage }) },
    }

    await signalAgentsForMessage(env as never, {
      messageId: 'message-no-ai',
      channelId: 'dm',
      authorId: 'human',
      authorName: 'Human',
      content: 'Hello',
      mentionIds: [],
    })

    expect(receiveMessage).toHaveBeenCalled()
  })

  it('does not let a chat-only member start an agent turn', async () => {
    const receiveMessage = vi.fn(async () => 'workflow-id')
    const env = {
      DB: db,
      AI: {},
      AGENT_DO: { getByName: () => ({ receiveMessage }) },
    }

    await signalAgentsForMessage(env as never, {
      messageId: 'message-member',
      channelId: 'dm',
      authorId: 'member',
      authorName: 'Member',
      content: 'Run this command',
      mentionIds: ['agent'],
    })

    expect(receiveMessage).not.toHaveBeenCalled()
  })

  it('lets Agent access reach one Agent without Use agents, and keeps a granted-access Agent silent for others', async () => {
    sqlite.exec(`INSERT INTO channel_members VALUES ('dm','member');
      UPDATE agents SET access='granted' WHERE user_id='agent'`)
    const receiveMessage = vi.fn(async () => 'workflow-id')
    const env = { DB: db, AI: {}, AGENT_DO: { getByName: () => ({ receiveMessage }) } }
    const send = (authorId: string, messageId: string) => signalAgentsForMessage(env as never,
      { messageId, channelId: 'dm', authorId, authorName: authorId, content: 'Review this', mentionIds: ['agent'] })

    await send('human', 'uses-agents-without-access')
    expect(receiveMessage).not.toHaveBeenCalled()
    await send('owner', 'owner-always')
    expect(receiveMessage).toHaveBeenCalledTimes(1)

    sqlite.exec(`INSERT INTO grants(id,member_id,role_id,agent_id,expires_at) VALUES ('expired','member',NULL,'agent','2020-01-01T00:00:00.000Z')`)
    await send('member', 'expired-access')
    expect(receiveMessage).toHaveBeenCalledTimes(1)
    // Access in an archived Project grants nothing, so it wakes nothing either.
    sqlite.exec(`INSERT INTO projects VALUES ('old','2026-10-01T00:00:00.000Z');
      INSERT INTO grants(id,member_id,role_id,agent_id,expires_at,project_id) VALUES ('archived','member',NULL,'agent',NULL,'old')`)
    await send('member', 'archived-project-access')
    expect(receiveMessage).toHaveBeenCalledTimes(1)
    sqlite.exec(`INSERT INTO grants(id,member_id,role_id,agent_id,expires_at) VALUES ('current','member',NULL,'agent',NULL)`)
    await send('member', 'granted-member')
    expect(receiveMessage).toHaveBeenCalledTimes(2)
    expect(receiveMessage).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: 'granted-member', authorId: 'member' }))
  })
})
