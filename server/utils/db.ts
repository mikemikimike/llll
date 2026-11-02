/// <reference types="@cloudflare/workers-types" />
import { drizzle } from 'drizzle-orm/d1'
import baselineSql from '../../drizzle/server-migrations/0000_server_baseline.sql?raw'
import mailDraftsSql from '../../drizzle/server-migrations/0001_mail_drafts.sql?raw'
import agentWebhooksSql from '../../drizzle/server-migrations/0002_agent_webhooks.sql?raw'
import telegramNotificationsSql from '../../drizzle/server-migrations/0003_telegram_notifications.sql?raw'
import grantsSql from '../../drizzle/server-migrations/0004_grants.sql?raw'
import grantsResourcesSql from '../../drizzle/server-migrations/0005_grants_resources.sql?raw'
import taskPullLinksSql from '../../drizzle/server-migrations/0006_task_pull_links.sql?raw'
import dataFieldsRelationsSql from '../../drizzle/server-migrations/0007_data_fields_relations.sql?raw'
import { schema } from '../../drizzle/schema'
import { isUuidV4 } from '../../shared/server-settings'

export function getDb(d1: D1Database) {
  return drizzle(d1, { schema })
}

/** Convert Drizzle's migration markers into the format accepted by D1 exec. */
export function d1ExecSql(sql: string): string {
  return sql
    .split('--> statement-breakpoint')
    .map(statement => statement
      .split('\n')
      .filter(line => !line.trimStart().startsWith('--'))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean)
    .map(statement => statement.endsWith(';') ? statement : `${statement};`)
    .join('\n')
}

export const INIT_SQL = d1ExecSql([
  baselineSql,
  mailDraftsSql,
  agentWebhooksSql,
  telegramNotificationsSql,
  grantsSql,
  grantsResourcesSql,
  taskPullLinksSql,
  dataFieldsRelationsSql,
].join('\n--> statement-breakpoint\n'))

/** Bootstrap is only for an empty database. Deployed changes use D1 migrations. */
// An isolate serves one Server, so a schema that was present once stays
// present for the isolate's lifetime. Skipping the probes saves three D1 round
// trips on every public request.
const migratedDatabases = new WeakSet<D1Database>()

function celldRuntime(env?: { LLLL_RUNTIME?: string }): boolean {
  return env?.LLLL_RUNTIME?.trim().toLowerCase() === 'celld'
}

export async function ensureMigrated(db: D1Database, env?: { LLLL_RUNTIME?: string, SERVER_ID?: string }): Promise<boolean> {
  if (migratedDatabases.has(db)) return true
  const marker = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='server_schema'").first()
  if (!marker) {
    const existing = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations', '_cf_KV') LIMIT 1").first()
    if (existing || celldRuntime(env)) throw new Error('This Server requires a fresh server-v2 database')
    await db.exec(INIT_SQL)
  }
  const schemaVersion = await db.prepare('SELECT version FROM server_schema WHERE id = 1').first<{ version: string }>()
  if (schemaVersion?.version !== 'server-v2') throw new Error('Unsupported Server schema')
  if (isUuidV4(env?.SERVER_ID)) {
    await db.prepare('INSERT INTO server_identity(singleton,id) VALUES (1,?) ON CONFLICT(singleton) DO NOTHING')
      .bind(env!.SERVER_ID!.toLowerCase()).run()
  }
  await Promise.all([
    db.prepare('SELECT kind FROM users LIMIT 1').first(),
    db.prepare('SELECT user_id FROM agents LIMIT 1').first(),
  ])
  migratedDatabases.add(db)
  return true
}

/** Read-only: the database carries the supported `server-v2` schema marker. */
export async function schemaCurrent(db: D1Database): Promise<boolean> {
  if (migratedDatabases.has(db)) return true
  try {
    const row = await db.prepare('SELECT version FROM server_schema WHERE id = 1').first<{ version: string }>()
    return row?.version === 'server-v2'
  }
  catch {
    return false
  }
}

export async function userCount(db: D1Database): Promise<number> {
  try {
    const row = await db.prepare("SELECT COUNT(*) as c FROM users WHERE status = 'active'").first<{ c: number }>()
    return row?.c ?? 0
  }
  catch {
    return 0
  }
}

export async function serverReady(db: D1Database): Promise<boolean> {
  try {
    return Boolean(await db.prepare("SELECT id FROM server LIMIT 1").first())
  }
  catch {
    return false
  }
}
