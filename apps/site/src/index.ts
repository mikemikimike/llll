import { enableL4Factory } from '../../../packages/deployment-core/src/factory'
import { ownerRecoverySchema, recoverOwnerSetup } from './owner-setup'
import { enableL4Files } from '../../../packages/deployment-core/src/storage'
import { z } from 'zod'
import { CLOUDFLARE_AUTH_URL, CLOUDFLARE_SCOPES, oauthGrant, pkceChallenge, randomCode, refreshCloudflareGrant } from '../../../shared/cloudflare-oauth'
import { uuidSchema } from '../../../shared/embed'
import { policyForHtml, SHELL_PERMISSIONS_POLICY, strictTransportSecurity } from '../../../shared/security-headers'
import { advanceDeployment, deploymentFailure, cloudflare, deploymentParameters, listReleases, VERSION_PATTERN } from './deploy'
import { advanceUpdate, failUpdate, prepareUpdate, publicUpdate, rememberUpdate, updateRequestSchema } from './update'
import { applyDomainChange, publicDomainRequest, rememberDomainRequest } from './domains'
import { webSession, digest, clearDeployment } from './session'
import { claimTelegramLink, createTelegramLink, ensureTelegramWebhook, relayTelegram, subscribeTelegram, telegramWebhook } from './telegram'
import type { WebEnv } from './env'
import { listL4Servers } from '../../../packages/deployment-core/src/servers'

// Landing, Docs and the Shell only run same-origin bundles, their own inline
// scripts (allowed by hash per document) and Telegram's Mini App SDK. Other
// resource types stay unrestricted: the Shell embeds and talks to
// operator-owned Server origins it cannot enumerate.
const SITE_CSP = "script-src 'self' https://telegram.org; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
export async function withSiteSecurityHeaders(request: Request, response: Response): Promise<Response> {
  const html = (response.headers.get('Content-Type') || '').toLowerCase().includes('text/html') && request.method !== 'HEAD' && response.body
    ? await response.text()
    : null
  const output = new Response(html ?? response.body, response)
  output.headers.set('Referrer-Policy', 'no-referrer'); output.headers.set('X-Content-Type-Options', 'nosniff')
  output.headers.set('Permissions-Policy', SHELL_PERMISSIONS_POLICY)
  // llll.gg and every PR Preview subdomain are HTTPS-only Cloudflare hosts.
  const hsts = strictTransportSecurity(new URL(request.url), null, true)
  if (hsts) output.headers.set('Strict-Transport-Security', hsts)
  output.headers.set('Content-Security-Policy', html === null ? SITE_CSP : await policyForHtml(SITE_CSP, html))
  return output
}
function fail(status: number, message: string): never { throw Object.assign(new Error(message), { status }) }
function json(data: unknown, status = 200) { return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } }) }
async function boundedText(response: Response | Request) {
  if (!response.body) return ''
  const reader = response.body.getReader(); let text = ''; let size = 0; const decoder = new TextDecoder()
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 8192) { await reader.cancel(); fail(413, 'Request too large') } text += decoder.decode(value, { stream: true }) }
  return text + decoder.decode()
}
async function input(request: Request): Promise<unknown> { try { return JSON.parse(await boundedText(request)) } catch { fail(400, 'Invalid request') } }
function publicOrigin(value: string, env: WebEnv) {
  const url = new URL(value)
  const local = env.TEST_ALLOW_LOCAL_ORIGINS === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname)
  if (url.origin !== value || (!local && (url.protocol !== 'https:' || !url.hostname.includes('.') || /^(?:\d|\[)/.test(url.hostname) || /\.(?:localhost|local|internal|test|invalid)$/.test(url.hostname)))) fail(400, 'Enter a public HTTPS server origin')
  return url.origin
}
/**
 * Whether a saved Server still exists. Only Cloudflare's own answer that no Worker serves the
 * workers.dev address (error 1042) counts as missing. Timeouts, outages and every other error stay
 * unreachable, so a Server that is merely offline is never forgotten.
 */
async function probeServer(value: string, env: WebEnv): Promise<'available' | 'missing' | 'unreachable'> {
  let origin: string
  try { origin = publicOrigin(value, env) } catch { return 'unreachable' }
  try {
    const response = await fetch(origin + '/.well-known/llll', { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    const text = await boundedText(response)
    if (response.status === 404 && new URL(origin).hostname.endsWith('.workers.dev') && /^error code: 1042\s*$/.test(text)) return 'missing'
    if (!response.ok) return 'unreachable'
    return (JSON.parse(text) as { kind?: unknown }).kind === 'server' ? 'available' : 'unreachable'
  } catch { return 'unreachable' }
}
function resumePath(data: { oauthNext?: 'create' | 'domain', updateRequest?: unknown, factoryRequest?: { accountId: string; workerName: string; origin: string }, storageRequest?: { accountId: string; workerName: string; origin: string } }) {
  if (data.oauthNext === 'domain') return '/domain?resume=1'
  if (data.factoryRequest) return '/create?' + new URLSearchParams({ tab: 'cloudflare', factory: '1', account: data.factoryRequest.accountId, worker: data.factoryRequest.workerName, server: data.factoryRequest.origin }).toString()
  if (data.storageRequest) return '/create?' + new URLSearchParams({ tab: 'cloudflare', storage: '1', account: data.storageRequest.accountId, worker: data.storageRequest.workerName, server: data.storageRequest.origin }).toString()
  return '/create?tab=cloudflare' + (data.updateRequest ? '&resume=update' : '')
}
/** A string field of a request body, for limits keyed on what is asked rather than who asks. */
function bodyField(body: unknown, name: string) {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined
  return typeof value === 'string' ? value.slice(0, 128) : ''
}
async function rateLimit(request: Request, env: WebEnv, subject = request.headers.get('cf-connecting-ip') || 'local') {
  const key = await digest(subject + ':' + Math.floor(Date.now() / 60000))
  const row = await env.DB.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(key, Date.now() + 120000).first<{ count: number }>()
  if ((row?.count || 0) > 60) fail(429, 'Too many requests. Try again shortly.')
}
async function handle(request: Request, env: WebEnv): Promise<Response> {
  if (new URL(request.url).pathname === '/api/health') return json({ ok: true, component: 'web', commit: env.BUILD_COMMIT || 'development', version: env.BUILD_VERSION || 'development' })
  const url = new URL(request.url); const path = url.pathname
  const legacyPath = path.replace(/\/+$/, '')
  const legacyEntry = ['/open', '/deploy'].includes(legacyPath) || (legacyPath === '/servers' && url.searchParams.has('server'))
  if (['GET', 'HEAD'].includes(request.method) && legacyEntry) {
    const target = new URL(request.url)
    target.pathname = '/create'
    if (legacyPath === '/deploy') {
      target.searchParams.set('tab', target.searchParams.get('method') === 'vps' ? 'vps' : 'cloudflare')
      target.searchParams.delete('method')
    }
    return Response.redirect(target.toString(), 307)
  }
  // Servers call the relay from their Worker, without a browser Origin; the token and its own rate limit guard it.
  if (path === '/api/telegram/notify' && request.method === 'POST') return json(await relayTelegram(env, await input(request), fail))
  // Pairing from a browser: the Server registers and collects a code from its Worker; Telegram calls the webhook.
  // Every Server's Worker reaches this relay from the same client address, so these two are limited
  // per Server and per code instead: one pairing registers a code once and collects it every two seconds.
  if (path === '/api/telegram/links' && request.method === 'POST') { const body = await input(request); await rateLimit(request, env, 'telegram-links:' + bodyField(body, 'serverId')); return json(await createTelegramLink(env, body, fail)) }
  if (path === '/api/telegram/links/claim' && request.method === 'POST') { const body = await input(request); await rateLimit(request, env, 'telegram-claim:' + bodyField(body, 'code')); return json(await claimTelegramLink(env, body, fail)) }
  if (path === '/api/telegram/webhook' && request.method === 'POST') return json(await telegramWebhook(env, request, await input(request), fail))
  // A Server opened in Telegram asks from its own origin. Telegram's signed launch data, not a
  // cookie, proves who is asking, so any origin may call it.
  if (path === '/api/telegram/subscribe' && request.method === 'OPTIONS') return new Response(null, { status: 204 })
  if (path === '/api/telegram/subscribe' && request.method === 'POST') {
    await rateLimit(request, env)
    return json(await subscribeTelegram(env, await input(request), fail))
  }
  if (path.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method)) {
    if (request.headers.get('origin') !== env.PUBLIC_ORIGIN) fail(403, 'Origin mismatch')
    await rateLimit(request, env)
  }
  if (path === '/api/servers/register' && request.method === 'POST') {
    const value = z.object({ id: uuidSchema, origin: z.string().max(2048) }).parse(await input(request))
    const origin = publicOrigin(value.origin, env)
    const proof = await fetch(origin + '/.well-known/llll', { redirect: 'manual', signal: AbortSignal.timeout(10000) })
    if (!proof.ok) fail(400, 'The server could not verify this server')
    const data = JSON.parse(await boundedText(proof)) as { id?: string; origin?: string; aliases?: unknown; kind?: string }
    const aliases = Array.isArray(data.aliases) ? data.aliases.filter((item): item is string => typeof item === 'string' && item.length <= 2048) : []
    if (data.id !== value.id || (data.origin !== origin && !aliases.includes(origin)) || data.kind !== 'server') fail(400, 'Server ownership proof did not match')
    const registered = await env.DB.prepare('INSERT INTO server_directory(id,origin,verified_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET verified_at=excluded.verified_at WHERE origin=excluded.origin RETURNING id').bind(value.id, origin, Date.now()).first()
    if (!registered) fail(409, 'This server ID is registered to another server')
    return json({ ok: true })
  }
  if (path === '/api/servers/status' && request.method === 'POST') {
    // Browsers cannot read Cloudflare's error page across origins, so the Shell asks here before forgetting a Server.
    const { origins } = z.object({ origins: z.array(z.string().max(2048)).min(1).max(20) }).strict().parse(await input(request))
    const unique = [...new Set(origins)]
    return json({ servers: await Promise.all(unique.map(async origin => ({ origin, status: await probeServer(origin, env) }))) })
  }
  const lookup = path.match(/^\/api\/servers\/([a-f0-9-]{36})$/)
  if (lookup && request.method === 'GET') {
    if (!uuidSchema.safeParse(lookup[1]).success) fail(404, 'Server not found')
    const row = await env.DB.prepare('SELECT origin FROM server_directory WHERE id=?').bind(lookup[1]).first<{ origin: string }>()
    if (!row) fail(404, 'Server is not in the directory. Connect its server by address.')
    return json(row)
  }
  if (path === '/api/deploy/factory/enable' && request.method === 'POST') {
    const session = await webSession(request, env)
    const value = z.object({ accountId: z.string().regex(/^[a-f0-9]{32}$/u), workerName: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u), paidConsent: z.literal(true), size: z.enum(['small', 'standard', 'large']).default('standard'), timeoutSeconds: z.number().int().min(1).max(600).default(120), processes: z.number().int().min(32).max(512).default(128) }).strict().parse(await input(request))
    const grant = session.data.grant
    if (!grant || grant.expiresAt <= Date.now()) fail(401, 'Reconnect Cloudflare first')
    const accounts = await cloudflare<{ id: string }[]>(grant.accessToken, '/accounts')
    if (!accounts.some(account => account.id === value.accountId)) fail(403, 'Choose the Cloudflare account that owns this Server')
    return json(await enableL4Factory(grant.accessToken, value.accountId, value.workerName, value.paidConsent, value))
  }
  if (path === '/api/deploy/storage/enable' && request.method === 'POST') {
    const session = await webSession(request, env)
    const value = z.object({ accountId: z.string().regex(/^[a-f0-9]{32}$/u), workerName: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u) }).parse(await input(request))
    const grant = session.data.grant
    if (!grant || grant.expiresAt <= Date.now()) fail(401, 'Reconnect Cloudflare first')
    const accounts = await cloudflare<{ id: string }[]>(grant.accessToken, '/accounts')
    if (!accounts.some(account => account.id === value.accountId)) fail(403, 'Choose the Cloudflare account that owns this Server')
    return json(await enableL4Files(grant.accessToken, value.accountId, value.workerName))
  }
  if (path === '/api/deploy/config') return json({ oauth: Boolean(env.CLOUDFLARE_OAUTH_CLIENT_ID), telegramBot: env.TELEGRAM_BOT_USERNAME || null })
  if (path === '/api/deploy/releases' && request.method === 'GET') {
    const cacheKey = new Request(env.PUBLIC_ORIGIN + '/api/deploy/releases')
    try {
      const cached = await caches.default.match(cacheKey)
      if (cached) return new Response(cached.body, cached)
    } catch { /* Cache API unavailable in tests; fetch directly. */ }
    const releases = await listReleases(env.GITHUB_TOKEN)
    const response = new Response(JSON.stringify({ releases }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } })
    try { await caches.default.put(cacheKey, response.clone()) } catch { /* See above. */ }
    return response
  }
  if (path === '/api/deploy/oauth' && request.method === 'GET') {
    if (!env.CLOUDFLARE_OAUTH_CLIENT_ID) fail(503, 'Cloudflare OAuth is not configured yet')
    await rateLimit(request, env)
    const session = await webSession(request, env, true)
    if (session.data.worker && !session.data.completed && url.searchParams.get('resume') !== '1') fail(409, 'Resume your current deployment before starting another')
    if (url.searchParams.get('factory') === '1') session.data.factoryRequest = z.object({ accountId: z.string().regex(/^[a-f0-9]{32}$/u), workerName: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u), origin: z.string().url() }).parse({ accountId: url.searchParams.get('account'), workerName: url.searchParams.get('worker'), origin: url.searchParams.get('server') })
    else delete session.data.factoryRequest
    if (url.searchParams.get('storage') === '1') session.data.storageRequest = z.object({ accountId: z.string().regex(/^[a-f0-9]{32}$/u), workerName: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u), origin: z.string().url() }).parse({ accountId: url.searchParams.get('account'), workerName: url.searchParams.get('worker'), origin: url.searchParams.get('server') })
    else delete session.data.storageRequest
    const running = await env.DB.prepare('SELECT lease_until FROM deployment_sessions WHERE id_hash=?').bind(session.id).first<{ lease_until: number }>()
    if (running && running.lease_until > Date.now()) fail(409, 'Wait for the current deployment step to finish before reconnecting')
    delete session.data.grant
    session.data.state = randomCode(); session.data.verifier = randomCode(); delete session.data.error
    session.data.oauthNext = url.searchParams.get('next') === 'domain' ? 'domain' : 'create'
    await session.save()
    const target = new URL(CLOUDFLARE_AUTH_URL)
    target.search = new URLSearchParams({ response_type: 'code', client_id: env.CLOUDFLARE_OAUTH_CLIENT_ID, redirect_uri: env.PUBLIC_ORIGIN + '/api/deploy/callback', scope: CLOUDFLARE_SCOPES, state: session.data.state, code_challenge: await pkceChallenge(session.data.verifier), code_challenge_method: 'S256' }).toString()
    return new Response(null, { status: 302, headers: { Location: target.toString(), ...(session.cookie ? { 'Set-Cookie': session.cookie } : {}) } })
  }
  if (path === '/api/deploy/callback' && request.method === 'GET') {
    const session = await webSession(request, env)
    if (!session.data.state || url.searchParams.get('state') !== session.data.state || !session.data.verifier) fail(400, 'Authorization could not be verified. Start again.')
    const verifier = session.data.verifier
    delete session.data.state; delete session.data.verifier; await session.save()
    if (url.searchParams.has('error') || !url.searchParams.get('code')) {
      // Surface Cloudflare's reason (it names the refused scope) instead of a generic cancellation.
      const detail = (url.searchParams.get('error_description') || '').slice(0, 300)
      session.data.error = detail ? `Cloudflare refused the authorization: ${detail}` : 'Cloudflare authorization was cancelled'
      await session.save(); return Response.redirect(env.PUBLIC_ORIGIN + resumePath(session.data), 303)
    }
    session.data.grant = await oauthGrant(new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code')!, code_verifier: verifier, redirect_uri: env.PUBLIC_ORIGIN + '/api/deploy/callback' }), env.CLOUDFLARE_OAUTH_CLIENT_ID!)
    const expectedAccount = session.data.oauthNext === 'domain'
      ? session.data.domainRequest?.accountId
      : session.data.accountId && !session.data.completed ? session.data.accountId : undefined
    if (expectedAccount) {
      const accounts = await cloudflare<{ id: string }[]>(session.data.grant.accessToken, '/accounts')
      if (!accounts.some(account => account.id === expectedAccount)) {
        delete session.data.grant
        session.data.error = 'Reconnect the Cloudflare account that owns this Server'
        await session.save()
        if (session.data.oauthNext === 'domain')
          return Response.redirect(env.PUBLIC_ORIGIN + resumePath(session.data), 303)
        fail(403, 'Reconnect the same Cloudflare account to resume this server')
      }
    }
    await session.save()
    return Response.redirect(env.PUBLIC_ORIGIN + resumePath(session.data), 303)
  }
  if (path === '/api/deploy/session') {
    const session = await webSession(request, env); const data = session.data
    let authorized = Boolean(data.grant && data.grant.expiresAt > Date.now())
    let accounts: { id: string; name: string }[] = []
    if (authorized) {
      try { accounts = await cloudflare(data.grant!.accessToken, '/accounts') }
      catch (error) {
        if (!error || typeof error !== 'object' || !('status' in error) || ![401, 403].includes(Number(error.status))) throw error
        delete data.grant; authorized = false; await session.save()
      }
    }
    return json({ authorized, accounts: accounts.map(a => ({ id: a.id, name: a.name })), accountId: data.accountId, sessionExpiresAt: session.expiresAt, grantExpiresAt: data.grant?.expiresAt, step: data.step, progress: data.progress, paused: data.paused?.map(item => ({ serverId: item.serverId, name: item.name, version: item.version })), name: data.name, ownerEmail: data.ownerEmail, version: data.version, grantExpiresIn: data.grant ? Math.max(0, Math.round((data.grant.expiresAt - Date.now()) / 1000)) : undefined, error: data.error, accessKept: data.accessKept, accessError: data.accessError, completed: data.completed, claim: data.completed ? `${data.origin}/setup#claim=${data.setupToken}` : undefined, origin: data.completed ? data.origin : undefined, deployments: data.deployments?.map(({ setupToken, ...item }) => ({ ...item, claim: `${item.origin}/setup#claim=${setupToken}` })), updateRequest: data.updateRequest, update: publicUpdate(data), domainRequest: publicDomainRequest(data) })
  }
  if (path === '/api/deploy/domain/prepare' && request.method === 'POST') {
    const session = await webSession(request, env, true)
    try { rememberDomainRequest(session.data, await input(request)) }
    catch (error) { fail(400, error instanceof Error ? error.message : 'Invalid domain request') }
    await session.save()
    const response = json({ ok: true, authorized: Boolean(session.data.grant && session.data.grant.expiresAt > Date.now()), domainRequest: publicDomainRequest(session.data) })
    if (session.cookie) response.headers.set('Set-Cookie', session.cookie)
    return response
  }
  if (path === '/api/deploy/domain/start' && request.method === 'POST') {
    const session = await webSession(request, env)
    if (!session.data.domainRequest) fail(409, 'Open this page from your Server’s Settings')
    if (!session.data.grant || session.data.grant.expiresAt <= Date.now()) fail(401, 'Reconnect Cloudflare first')
    const renewedCookie = session.renew()
    if (session.data.grant.expiresAt < Date.now() + 120000) {
      try {
        session.data.grant = await refreshCloudflareGrant(session.data.grant)
      }
      catch {
        delete session.data.grant
        await session.save()
        fail(401, 'Reconnect Cloudflare first')
      }
    }
    await session.save()
    const leaseUntil = Date.now() + 300000
    const lease = await env.DB.prepare('UPDATE deployment_sessions SET lease_until=? WHERE id_hash=? AND lease_until<? RETURNING id_hash').bind(leaseUntil, session.id, Date.now()).first()
    if (!lease) fail(409, 'The domain change is already running; wait before retrying')
    try {
      const domain = await applyDomainChange(session.data, session.data.grant.accessToken)
      const response = json({ domain })
      response.headers.set('Set-Cookie', renewedCookie)
      return response
    }
    catch (error) {
      throw Object.assign(new Error(error instanceof Error ? error.message : 'The domain change did not complete.'), { status: 409 })
    }
    finally {
      await env.DB.prepare('UPDATE deployment_sessions SET lease_until=0 WHERE id_hash=? AND lease_until=?').bind(session.id, leaseUntil).run()
    }
  }
  if (path === '/api/deploy/setup/recover' && request.method === 'POST') {
    const session = await webSession(request, env)
    const value = ownerRecoverySchema.parse(await input(request))
    const result = await recoverOwnerSetup(session.data, value)
    await session.save()
    return json(result)
  }
  if (path === '/api/deploy/servers' && request.method === 'GET') {
    const session = await webSession(request, env)
    const grant = session.data.grant
    if (!grant || grant.expiresAt <= Date.now()) fail(401, 'Reconnect Cloudflare to refresh your Servers')
    const accountId = z.string().regex(/^[a-f0-9]{32}$/).parse(url.searchParams.get('accountId'))
    const accounts = await cloudflare<{ id: string }[]>(grant.accessToken, '/accounts')
    if (!accounts.some(account => account.id === accountId)) fail(403, 'Choose an account authorized by Cloudflare')
    const servers = await listL4Servers(grant.accessToken, accountId, { strict: true })
    return json({ servers: servers.flatMap(server => {
      try {
        return [{ origin: publicOrigin(server.origin, env), name: [...(session.data.deployments || []), ...[session.data]].find(item => item.origin === server.origin && item.accountId === accountId)?.name || server.configuration.appName, version: server.version, accountId, workerName: server.workerName }]
      } catch { return [] }
    }) })
  }
  if (['/api/deploy/disconnect', '/api/deploy/pause', '/api/deploy/resume'].includes(path) && request.method === 'POST') {
    const session = await webSession(request, env)
    const running = await env.DB.prepare('SELECT lease_until FROM deployment_sessions WHERE id_hash=?').bind(session.id).first<{ lease_until: number }>()
    if (running && running.lease_until > Date.now()) fail(409, 'Wait for the current deployment step to finish')
    if (path.endsWith('/disconnect')) delete session.data.grant
    else if (path.endsWith('/pause')) {
      if (session.data.worker && !session.data.completed) {
        const { grant: _grant, deployments: _deployments, paused: _paused, state: _state, verifier: _verifier, ...attempt } = session.data
        if ((session.data.paused?.length ?? 0) >= 20) fail(409, 'Resume an existing paused deployment before starting another')
        session.data.paused = [...(session.data.paused || []), attempt]
      }
      clearDeployment(session.data)
    } else {
      if (session.data.worker && !session.data.completed) fail(409, 'Pause the current deployment first')
      const { serverId } = z.object({ serverId: uuidSchema }).parse(await input(request))
      const attempt = session.data.paused?.find(item => item.serverId === serverId)
      if (!attempt) fail(404, 'Paused deployment not found')
      clearDeployment(session.data)
      Object.assign(session.data, attempt)
      session.data.paused = session.data.paused?.filter(item => item.serverId !== serverId)
    }
    await session.save()
    return json({ ok: true })
  }
  if (path === '/api/deploy/start' && request.method === 'POST') {
    const session = await webSession(request, env)
    if (!session.data.grant || session.data.grant.expiresAt <= Date.now()) fail(401, 'Reconnect Cloudflare first')
    if (session.data.worker && !session.data.completed) fail(409, 'Resume the existing deployment')
    const value = z.object({ accountId: z.string().regex(/^[a-f0-9]{32}$/), name: z.string().trim().min(1).max(80), ownerEmail: z.string().email(), version: z.string().regex(VERSION_PATTERN), keepAccess: z.boolean().default(true) }).parse(await input(request))
    const accounts = await cloudflare<{ id: string }[]>(session.data.grant.accessToken, '/accounts')
    if (!accounts.some(a => a.id === value.accountId)) fail(403, 'Choose an account authorized by Cloudflare')
    // Fail fast when the grant cannot touch Workers scripts (unchecked consent
    // scope or a Cloudflare user role without Workers rights). Otherwise this
    // surfaces two phases later as an assets-upload 403.
    try {
      const probe = await fetch(`https://api.cloudflare.com/client/v4/accounts/${value.accountId}/workers/scripts?per_page=1`, { headers: { Authorization: `Bearer ${session.data.grant.accessToken}` }, signal: AbortSignal.timeout(20000) })
      if (probe.status === 403) fail(403, 'Cloudflare denied Workers access for this grant. Reconnect Cloudflare and approve every requested permission, or ask an account admin for Workers rights.')
    } catch (error) { if (error instanceof Error && 'status' in error) throw error }
    clearDeployment(session.data)
    Object.assign(session.data, deploymentParameters(value.accountId, value.name, value.version, value.ownerEmail), { keepAccess: value.keepAccess }); await session.save()
    return json({ ok: true })
  }
  if (path === '/api/deploy/update/prepare' && request.method === 'POST') {
    const session = await webSession(request, env, true)
    const value = updateRequestSchema.parse(await input(request))
    const grant = session.data.grant
    let body: Record<string, unknown>
    if (grant && grant.expiresAt > Date.now()) {
      await prepareUpdate(session.data, value, grant.accessToken)
      body = { ok: true, update: publicUpdate(session.data) }
    } else {
      await rememberUpdate(session.data, value)
      body = { ok: true, remembered: true, request: session.data.updateRequest }
    }
    await session.save()
    const response = json(body)
    if (session.cookie) response.headers.set('Set-Cookie', session.cookie)
    return response
  }
  if (path === '/api/deploy/update/start' && request.method === 'POST') {
    const session = await webSession(request, env)
    const grant = session.data.grant
    if (!grant || grant.expiresAt <= Date.now()) fail(401, 'Reconnect Cloudflare first')
    if (!session.data.updateRequest) fail(409, 'Open this page from your Server’s Settings')
    const options = z.object({ keepAccess: z.boolean().default(true) }).parse(await input(request).catch(() => ({})))
    await prepareUpdate(session.data, session.data.updateRequest, grant.accessToken)
    delete session.data.update!.error
    session.data.update!.keepAccess = options.keepAccess
    await session.save()
    return json({ update: publicUpdate(session.data) })
  }
  if (path === '/api/deploy/update/forget' && request.method === 'POST') {
    const session = await webSession(request, env)
    delete session.data.updateRequest
    delete session.data.update
    await session.save()
    return json({ ok: true })
  }
  if (path === '/api/deploy/update/advance' && request.method === 'POST') {
    const session = await webSession(request, env)
    if (!session.data.update) fail(409, 'Start the update from your Server’s Settings')
    if (!session.data.grant || session.data.grant.expiresAt <= Date.now()) fail(401, 'Reconnect Cloudflare first')
    const renewedCookie = session.renew()
    if (session.data.grant.expiresAt < Date.now() + 120000) {
      session.data.grant = await refreshCloudflareGrant(session.data.grant)
      await session.save()
    }
    const leaseUntil = Date.now() + 2700000
    const lease = await env.DB.prepare('UPDATE deployment_sessions SET lease_until=? WHERE id_hash=? AND lease_until<? RETURNING id_hash').bind(leaseUntil, session.id, Date.now()).first()
    if (!lease) fail(409, 'The update is already running; wait before retrying')
    try {
      delete session.data.update.error
      await advanceUpdate(session.data, session.data.grant.accessToken, session.save)
    } catch (error) {
      session.data.update.error = error instanceof Error ? error.message : 'The update did not complete.'
      await failUpdate(session.data, session.data.grant.accessToken)
      await session.save()
      throw error
    } finally {
      await env.DB.prepare('UPDATE deployment_sessions SET lease_until=0 WHERE id_hash=? AND lease_until=?').bind(session.id, leaseUntil).run()
    }
    const response = json({ update: publicUpdate(session.data) })
    response.headers.set('Set-Cookie', renewedCookie)
    return response
  }
  if (path === '/api/deploy/advance' && request.method === 'POST') {
    const session = await webSession(request, env)
    if (session.data.completed) return json({ completed: true })
    const leaseUntil = Date.now() + 600000
    const lease = await env.DB.prepare('UPDATE deployment_sessions SET lease_until=? WHERE id_hash=? AND lease_until<? RETURNING id_hash').bind(leaseUntil, session.id, Date.now()).first()
    if (!lease) fail(409, 'Deployment is already running; wait before retrying')
    try { delete session.data.error; await advanceDeployment(session.data, env, session.save) }
    catch (error) {
      const failure = deploymentFailure(error)
      session.data.error = failure.message
      if (failure.reconnect) delete session.data.grant
      await session.save()
      fail(409, failure.message)
    }
    finally { await env.DB.prepare('UPDATE deployment_sessions SET lease_until=0 WHERE id_hash=? AND lease_until=?').bind(session.id, leaseUntil).run() }
    return json({ step: session.data.step, completed: session.data.completed })
  }
  if (path === '/.well-known/llll') return json({ product: 'llll', kind: 'client', origin: env.PUBLIC_ORIGIN, id: 'client', name: 'L4', apiVersion: 1 })
  if (path.startsWith('/api/')) fail(404, 'API route not found')
  // Never pipe the SPA's HTML fallback into a shell. Assets are available only
  // in a release archive; a missing installer on a feature Preview is a 404.
  if (path.startsWith('/install') || /\.(?:sh|json)$/i.test(path)) {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 })
    const asset = await env.ASSETS.fetch(request)
    const type = asset.headers.get('Content-Type') || ''
    if (!asset.ok || type.includes('text/html')) return new Response('Not found', { status: 404 })
    const response = new Response(asset.body, asset)
    if (path.endsWith('.sh')) response.headers.set('Content-Type', 'text/plain; charset=utf-8')
    response.headers.set('Cache-Control', 'no-cache')
    return response
  }
  // Static Assets' SPA fallback is index.html, which is the prerendered landing
  // page. UUID routes need Nuxt's client-only entry to preserve their URL.
  const serverPath = /^\/([a-f0-9-]{36})(?:\/|$)/i.exec(path)
  if (['GET', 'HEAD'].includes(request.method) && serverPath && uuidSchema.safeParse(serverPath[1]).success) {
    // auto-trailing-slash redirects /200.html to /200; fetch its canonical URL
    // internally so that redirect cannot replace the browser's Server route.
    return env.ASSETS.fetch(new Request(new URL('/200', url), request))
  }
  if (['GET', 'HEAD'].includes(request.method)) {
    if (path === '/robots.txt' && env.ENVIRONMENT === 'preview') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    const markdown = contentMarkdownPath(path, request.headers.get('Accept'))
    if (markdown) {
      const asset = await env.ASSETS.fetch(new Request(new URL(markdown, url), request))
      if (asset.ok && !(asset.headers.get('Content-Type') || '').includes('text/html')) return markdownResponse(asset, markdown, env)
      if (markdown !== path) return withVary(await env.ASSETS.fetch(request))
      return new Response('Not found', { status: 404 })
    }
    if (path === '/' || CONTENT_PAGE.test(path)) return withVary(await env.ASSETS.fetch(request))
  }
  return env.ASSETS.fetch(request)
}
// Docs, blog and changelog pages have a Markdown copy at `<path>.md` for
// agents, also returned for `Accept: text/markdown`. The home page answers
// with /llms.txt, which is Markdown describing L4 and linking those pages.
const CONTENT_PAGE = /^\/(?:docs|blog|changelog)(?:\/[^/]+)*$/
export function contentMarkdownPath(path: string, accept: string | null): string | null {
  const wantsMarkdown = (accept || '').toLowerCase().includes('text/markdown')
  if (path === '/') return wantsMarkdown ? '/llms.txt' : null
  let clean = path
  while (clean.endsWith('/')) clean = clean.slice(0, -1)
  if (!CONTENT_PAGE.test(clean)) return null
  if (clean.endsWith('.md')) return clean
  if (/\.(?:txt|json|xml)$/.test(clean) || !wantsMarkdown) return null
  return clean + '.md'
}
function markdownResponse(asset: Response, path: string, env: WebEnv) {
  const response = new Response(asset.body, asset)
  response.headers.set('Content-Type', 'text/markdown; charset=utf-8')
  response.headers.set('Link', `<${env.PUBLIC_ORIGIN}${path === '/llms.txt' ? '/' : path.slice(0, -3)}>; rel="canonical"`)
  response.headers.set('X-Robots-Tag', 'noindex')
  response.headers.set('Vary', 'Accept')
  return response
}
function withVary(response: Response) {
  const output = new Response(response.body, response)
  output.headers.append('Vary', 'Accept')
  return output
}
export default {
  async fetch(request: Request, env: WebEnv) {
    if (env.ENVIRONMENT === 'preview') env = { ...env, PUBLIC_ORIGIN: new URL(request.url).origin, CLOUDFLARE_OAUTH_CLIENT_ID: undefined }
    let response: Response
    try { response = await handle(request, env) }
    catch (error) {
      const status = error instanceof z.ZodError ? 400 : typeof error === 'object' && error && 'status' in error ? Number(error.status) : 500
      response = json({ error: { message: error instanceof z.ZodError ? 'Invalid request' : error instanceof Error ? error.message : 'Request failed' } }, status)
    }
    if (new URL(request.url).pathname === '/api/telegram/subscribe') {
      response = new Response(response.body, response)
      response.headers.set('Access-Control-Allow-Origin', '*')
      response.headers.set('Access-Control-Allow-Methods', 'POST')
      response.headers.set('Access-Control-Allow-Headers', 'Content-Type')
      response.headers.set('Access-Control-Max-Age', '86400')
    }
    // PR Previews share production's content; keep them out of search results.
    if (env.ENVIRONMENT === 'preview') { response = new Response(response.body, response); response.headers.set('X-Robots-Tag', 'noindex, nofollow') }
    return withSiteSecurityHeaders(request, response)
  },
  async scheduled(_event: ScheduledController, env: WebEnv) {
    await env.DB.batch([env.DB.prepare('DELETE FROM deployment_sessions WHERE expires_at<?').bind(Date.now()), env.DB.prepare('DELETE FROM rate_limits WHERE expires_at<?').bind(Date.now()), env.DB.prepare('DELETE FROM telegram_links WHERE expires_at<?').bind(Date.now())])
    await ensureTelegramWebhook(env).catch(() => {})
  },
} satisfies ExportedHandler<WebEnv>
