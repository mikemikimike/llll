import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { drainNotificationOutbox } from '../../workers/push'
import type { L4Env } from '../../workers/env'
import web from '../../apps/site/src/index'
import { createRelayToken, ensureTelegramWebhook, openRelayToken, webhookSecret } from '../../apps/site/src/telegram'
import type { WebEnv } from '../../apps/site/src/env'
import { verifyMiniAppData } from '../../shared/telegram'
import { webMigrationsSql } from '../helpers/web-migrations'

const SERVER = '00000000-0000-4000-8000-000000000001'
const SHELL = 'https://web.example.com'
const BOT = '123456:test-bot-token'

async function signedLaunch(userId: number, authDate: number) {
  const params = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify({ id: userId, first_name: 'Ada' }) })
  const encoder = new TextEncoder()
  const secretKey = await crypto.subtle.importKey('raw', encoder.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const secret = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(BOT))
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const data = [...params].sort(([a], [b]) => a < b ? -1 : 1).map(([name, value]) => `${name}=${value}`).join('\n')
  const hash = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)))].map(b => b.toString(16).padStart(2, '0')).join('')
  params.set('hash', hash)
  return params.toString()
}

describe('Telegram relay on the official site', () => {
  let sqlite: DatabaseSync
  let env: WebEnv
  const post = (path: string, body: object, origin: string | null = SHELL) => web.fetch(new Request(SHELL + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body),
  }), env)

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:'); sqlite.exec(webMigrationsSql())
    env = { DB: d1(sqlite), ASSETS: { fetch: async () => new Response('static') } as Fetcher, AUTH_SECRET: 'test-secret-'.repeat(5), PUBLIC_ORIGIN: SHELL, TELEGRAM_BOT_TOKEN: BOT }
  })
  afterEach(() => { vi.unstubAllGlobals(); sqlite.close() })

  it('seals the chat and Server into a stable token the Server cannot read', async () => {
    const token = await createRelayToken(env, 42, SERVER)
    expect(await createRelayToken(env, 42, SERVER)).toBe(token)
    expect(await createRelayToken(env, 43, SERVER)).not.toBe(token)
    expect(token).not.toContain('42')
    expect(await openRelayToken(env, token)).toEqual({ v: 1, c: 42, s: SERVER })
    expect(await openRelayToken({ ...env, AUTH_SECRET: 'other-secret-'.repeat(5) }, token)).toBeNull()
  })

  it('accepts launch data up to an hour old for subscribing, and only signed data', async () => {
    const now = Math.floor(Date.now() / 1000)
    const fresh = await post('/api/telegram/subscribe', { initData: await signedLaunch(42, now - 1800), serverId: SERVER })
    expect(fresh.status).toBe(200)
    const { token } = await fresh.json() as { token: string }
    expect(await openRelayToken(env, token)).toMatchObject({ c: 42, s: SERVER })
    expect((await post('/api/telegram/subscribe', { initData: await signedLaunch(42, now - 7200), serverId: SERVER })).status).toBe(401)
    const forged = (await signedLaunch(42, now)).replace('Ada', 'Eve')
    expect((await post('/api/telegram/subscribe', { initData: forged, serverId: SERVER })).status).toBe(401)
    await expect(verifyMiniAppData(await signedLaunch(42, now - 1800), BOT)).rejects.toThrow()
  })

  it('lets a Server opened as the Mini App subscribe from its own origin', async () => {
    const server = 'https://chat.example.org'
    const preflight = await web.fetch(new Request(SHELL + '/api/telegram/subscribe', { method: 'OPTIONS', headers: { Origin: server } }), env)
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*')
    const now = Math.floor(Date.now() / 1000)
    const ok = await post('/api/telegram/subscribe', { initData: await signedLaunch(42, now), serverId: SERVER }, server)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('*')
    const refused = await post('/api/telegram/subscribe', { initData: 'auth_date=1&hash=00', serverId: SERVER }, server)
    expect(refused.status).toBe(401)
    expect(refused.headers.get('Access-Control-Allow-Origin')).toBe('*')
    // Other mutations still require the Shell's own origin.
    expect((await post('/api/servers/register', { id: SERVER, origin: server }, server)).status).toBe(403)
  })

  it('sends a content-free message with an Open button, and reports gone subscriptions', async () => {
    const token = await createRelayToken(env, 42, SERVER)
    const sent: Array<{ chat_id: number; text: string; reply_markup: { inline_keyboard: Array<Array<{ web_app: { url: string } }>> } }> = []
    let status = 200
    vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
      expect(input).toBe(`https://api.telegram.org/bot${BOT}/sendMessage`)
      sent.push(JSON.parse(String(init.body)))
      return Response.json(status === 200 ? { ok: true } : { ok: false, description: 'Forbidden: bot was blocked by the user' }, { status })
    })
    const body = { token, serverId: SERVER, serverName: 'Friends', kind: 'mention', path: '/channels/abc' }
    // Servers call from their Worker, with no browser Origin.
    expect((await post('/api/telegram/notify', body, null)).status).toBe(200)
    expect(sent[0]).toMatchObject({ chat_id: 42, text: 'You were mentioned on Friends' })
    expect(sent[0]!.reply_markup.inline_keyboard[0]![0]!.web_app.url).toBe(`${SHELL}/${SERVER}/channels/abc`)
    expect((await post('/api/telegram/notify', { ...body, serverId: '00000000-0000-4000-8000-000000000002' }, null)).status).toBe(410)
    status = 403
    expect((await post('/api/telegram/notify', body, null)).status).toBe(410)
  })

  it('sends a retried delivery once, and again only if Telegram refused it', async () => {
    const token = await createRelayToken(env, 42, SERVER)
    let sent = 0
    let status = 200
    vi.stubGlobal('fetch', async () => { sent++; return Response.json({ ok: status === 200 }, { status }) })
    const body = { token, serverId: SERVER, serverName: 'Friends', kind: 'dm_message', path: '/', delivery: 'a'.repeat(64) }
    // The Server lost the first answer and retries the same delivery.
    expect((await post('/api/telegram/notify', body, null)).status).toBe(200)
    expect((await post('/api/telegram/notify', body, null)).status).toBe(200)
    expect(sent).toBe(1)
    status = 502
    const refused = { ...body, delivery: 'b'.repeat(64) }
    expect((await post('/api/telegram/notify', refused, null)).status).toBe(502)
    status = 200
    expect((await post('/api/telegram/notify', refused, null)).status).toBe(200)
    expect(sent).toBe(3)
  })
})

describe('Pairing Telegram from a browser', () => {
  let sqlite: DatabaseSync
  let env: WebEnv
  let sent: Array<{ method: string; body: Record<string, unknown> }>
  let webhookUrl = ''
  const post = (path: string, body: object, headers: Record<string, string> = {}) => web.fetch(new Request(SHELL + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }), env)
  const sha = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('')
  const start = async (text: string, chat = { id: 42, type: 'private' }) => post('/api/telegram/webhook', { update_id: 1, message: { text, chat } }, { 'X-Telegram-Bot-Api-Secret-Token': await webhookSecret(env) })

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:'); sqlite.exec(webMigrationsSql())
    env = { DB: d1(sqlite), ASSETS: { fetch: async () => new Response('static') } as Fetcher, AUTH_SECRET: 'test-secret-'.repeat(5), PUBLIC_ORIGIN: 'https://llll.example', TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_BOT_USERNAME: 'L4_agent' }
    sent = []
    webhookUrl = ''
    vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
      const method = String(input).split('/').at(-1)!
      const body = JSON.parse(String(init.body || '{}'))
      sent.push({ method, body })
      if (method === 'getWebhookInfo') return Response.json({ ok: true, result: { url: webhookUrl } })
      if (method === 'setWebhook') webhookUrl = body.url
      return Response.json({ ok: true })
    })
  })
  afterEach(() => { vi.unstubAllGlobals(); sqlite.close() })

  it('hands the chat that pressed Start to the Server that knows the secret, once', async () => {
    const code = 'c'.repeat(24)
    const secret = 'd'.repeat(64)
    // Servers call from their Worker, with no browser Origin.
    const link = await post('/api/telegram/links', { code, secretHash: await sha(secret), serverId: SERVER, serverName: 'Friends' })
    expect(link.status).toBe(200)
    expect(await link.json()).toMatchObject({ bot: 'L4_agent' })
    expect((await post('/api/telegram/links', { code, secretHash: await sha(secret), serverId: SERVER, serverName: 'Other' })).status).toBe(409)
    expect(await (await post('/api/telegram/links/claim', { code, secret })).json()).toEqual({ pending: true })

    expect((await post('/api/telegram/webhook', { message: { text: '/start ' + code, chat: { id: 7, type: 'private' } } }, { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' })).status).toBe(401)
    expect((await start('/start ' + code)).status).toBe(200)
    expect(sent.find(call => call.method === 'sendMessage')?.body).toMatchObject({ chat_id: 42, text: 'Telegram notifications are on for Friends. You can go back to L4.' })

    expect((await post('/api/telegram/links/claim', { code, secret: 'e'.repeat(64) })).status).toBe(410)
    const { token } = await (await post('/api/telegram/links/claim', { code, secret })).json() as { token: string }
    expect(await openRelayToken(env, token)).toMatchObject({ c: 42, s: SERVER })
    expect((await post('/api/telegram/links/claim', { code, secret })).status).toBe(410)
  })

  it('limits collecting a code per code, since every Server calls from the same address', async () => {
    const secret = 'd'.repeat(64)
    // Many Servers pairing at once, each collecting its own code, are not one caller.
    for (let n = 0; n < 70; n++) expect((await post('/api/telegram/links/claim', { code: n.toString(16).padStart(24, 'a'), secret })).status).toBe(410)
    const code = 'f'.repeat(24)
    for (let n = 0; n < 60; n++) expect((await post('/api/telegram/links/claim', { code, secret })).status).toBe(410)
    expect((await post('/api/telegram/links/claim', { code, secret })).status).toBe(429)
  })

  it('ignores groups and answers a plain Start with the Shell, and expired codes with a retry hint', async () => {
    expect((await start('/start ' + 'g'.repeat(24), { id: -100, type: 'group' })).status).toBe(200)
    expect(sent.filter(call => call.method === 'sendMessage')).toEqual([])
    await start('/start')
    expect(sent.at(-1)?.body).toMatchObject({ chat_id: 42, reply_markup: { inline_keyboard: [[{ web_app: { url: 'https://llll.example/servers' } }]] } })
    await start('/start ' + 'x'.repeat(24))
    expect(sent.at(-1)?.body).toMatchObject({ text: 'This link expired. Turn on Telegram notifications in L4 again.' })
  })

  it('takes the bot webhook only in production and never over someone else\'s', async () => {
    await ensureTelegramWebhook({ ...env, ENVIRONMENT: 'preview' })
    expect(sent).toEqual([])
    webhookUrl = 'https://elsewhere.example/hook'
    await ensureTelegramWebhook(env)
    expect(sent.map(call => call.method)).toEqual(['getWebhookInfo'])
    webhookUrl = ''
    await ensureTelegramWebhook(env)
    expect(sent.at(-1)).toMatchObject({ method: 'setWebhook', body: { url: 'https://llll.example/api/telegram/webhook', secret_token: await webhookSecret(env), allowed_updates: ['message'] } })
  })
})

describe('Telegram delivery from a Server', () => {
  let sqlite: DatabaseSync
  let env: L4Env

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:'); sqlite.exec(INIT_SQL)
    sqlite.exec(`
      INSERT INTO roles (id, key, name, permissions_bitmask) VALUES ('member', 'custom:member', 'Member', 0);
      INSERT INTO users (id, display_name, status, role_id, joined_at) VALUES ('owner', 'Owner', 'active', 'member', '2026-09-01');
      INSERT INTO server_identity(singleton,id) VALUES(1,'${SERVER}');
      INSERT INTO server(id,name,owner_id) VALUES('${SERVER}','Friends','owner');
      INSERT INTO channels (id, name, type, visibility) VALUES ('general', 'general', 'text', 'server');
      INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at, updated_at, transport, relay_origin, relay_token)
        VALUES ('tg', 'owner', 'telegram:abc', '', '', 't', 't', 'telegram', '${SHELL}', 'opaque-relay-token-123');
      INSERT INTO notification_outbox (event_id, subscription_id, recipient_id, kind, channel_id, payload_json, attempts, available_at, created_at)
        VALUES ('message:1', 'tg', 'owner', 'mention', 'general', '{"title":"Ada mentioned you in #general","body":"secret plans","tag":"message:1","url":"/channels/general"}', 0, '2000-01-01T00:00:00.000Z', 't');
    `)
    env = { DB: d1(sqlite), EMBED_ORIGINS: SHELL } as unknown as L4Env
  })
  afterEach(() => { vi.unstubAllGlobals(); sqlite.close() })

  it('relays only the kind, Server and path, without VAPID keys', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      calls.push({ url: url.toString(), body: JSON.parse(String(init.body)) })
      return Response.json({ delivered: true })
    })
    await drainNotificationOutbox(env)
    expect(calls).toEqual([{ url: `${SHELL}/api/telegram/notify`, body: { token: 'opaque-relay-token-123', serverId: SERVER, serverName: 'Friends', kind: 'mention', path: '/channels/general', delivery: expect.stringMatching(/^[a-f0-9]{64}$/u) } }])
    expect(JSON.stringify(calls)).not.toContain('secret plans')
    expect(sqlite.prepare('SELECT delivered_at FROM notification_outbox').get()).toMatchObject({ delivered_at: expect.any(String) })
  })

  it('drops the subscription when the relay says it is gone or is no longer trusted', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 410 }))
    await drainNotificationOutbox(env)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()).toEqual({ n: 0 })
  })

  it('never posts the token to a relay outside the embed origins', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    env = { ...env, EMBED_ORIGINS: '' } as L4Env
    sqlite.exec(`UPDATE push_subscriptions SET relay_origin = 'https://evil.example'`)
    await drainNotificationOutbox(env)
    expect(fetch).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()).toEqual({ n: 0 })
  })
})
