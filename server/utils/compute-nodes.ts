import { z } from 'zod'
import { dockerCapabilities, factorySnapshot, type ComputeNode } from '../../shared/software-factory'
import type { AuthorizationContext } from '../../shared/authorization'
import { newId, nowIso } from '../../shared/ids'
import type { L4Env } from '../../workers/env'
import { getServerId } from '../../shared/server-id'
import { factoryHash } from './factory-authority'
import { actionColumns, authorizeFactoryAction, expireFactoryActions, type ActionRow } from './factory-actions'
import { githubSourceGrant } from './github-agent-client'
import { giteaCredentials } from './gitea'
import { fail } from './cf'

/** A Gitea token never reaches a Node. The Node fetches through this Server with a capability bound to
 * one executing bootstrap and its lease, so it ends with the lease. */
export async function computeSourceCapability(env: L4Env, actionId: string, lease: string) {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) fail(503, 'compute_source', 'Server credential encryption is unavailable')
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`compute-source:${actionId}:${lease}`)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
const secret = () => [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('')
export function requireComputeOwner(auth: AuthorizationContext) {
  if (auth.principal.kind !== 'human' || !auth.principal.isOwner || auth.credential.kind !== 'session' || auth.delegation) fail(403, 'compute_denied', 'Compute administration needs a human Owner session')
}
export async function listComputeNodes(env: L4Env, auth: AuthorizationContext): Promise<ComputeNode[]> {
  requireComputeOwner(auth)
  const rows = await env.DB.prepare('SELECT id,name,enabled,capabilities_json AS capabilitiesJson,last_seen AS lastSeen FROM compute_nodes ORDER BY created_at').all<{ id: string; name: string; enabled: number; capabilitiesJson: string; lastSeen: string | null }>()
  return rows.results.map(({ enabled, capabilitiesJson, ...row }) => ({ ...row, enabled: Boolean(enabled), capabilities: JSON.parse(capabilitiesJson) }))
}
export async function prepareComputePairing(env: L4Env, auth: AuthorizationContext, name: string) {
  requireComputeOwner(auth)
  z.string().trim().min(1).max(80).parse(name)
  await env.DB.prepare('DELETE FROM compute_pairings WHERE expires_at<=?').bind(nowIso()).run()
  const token = secret(), expiresAt = new Date(Date.now() + 10 * 60000).toISOString()
  const inserted = await env.DB.prepare('INSERT INTO compute_pairings(token_hash,name,created_by,expires_at) SELECT ?,?,?,? WHERE (SELECT count(*) FROM compute_pairings)<10 RETURNING token_hash').bind(await factoryHash(token), name.trim(), auth.principal.id, expiresAt).first()
  if (!inserted) fail(429, 'compute_pairing_limit', 'Pairing limit reached')
  return { token, expiresAt }
}
export async function pairComputeNode(env: L4Env, token: string, capabilities: z.infer<typeof dockerCapabilities>) {
  const parsed = dockerCapabilities.parse(capabilities), id = newId(), credential = secret()
  const pairing = await env.DB.prepare('DELETE FROM compute_pairings WHERE token_hash=? AND expires_at>? RETURNING name,created_by AS createdBy').bind(await factoryHash(token), nowIso()).first<{ name: string; createdBy: string }>()
  if (!pairing) fail(403, 'compute_pairing_invalid', 'Pairing is unavailable or expired')
  await env.DB.prepare('INSERT INTO compute_nodes(id,name,token_hash,capabilities_json,last_seen,created_by,created_at) VALUES(?,?,?,?,?,?,?)')
    .bind(id, pairing.name, await factoryHash(credential), JSON.stringify(parsed), nowIso(), pairing.createdBy, nowIso()).run()
  return { nodeId: id, token: credential, serverId: await getServerId(env.DB) }
}
export async function disableComputeNode(env: L4Env, auth: AuthorizationContext, id: string) {
  requireComputeOwner(auth)
  await env.DB.batch([
    env.DB.prepare('UPDATE compute_nodes SET enabled=0,token_hash=? WHERE id=?').bind(await factoryHash(secret()), id),
    env.DB.prepare("UPDATE factory_actions SET status=CASE WHEN status IN ('claimed','executing') THEN 'uncertain' ELSE 'cancelled' END WHERE workspace_id IN (SELECT id FROM factory_workspaces WHERE node_id=?) AND status IN ('pending','approved','claimed','executing')").bind(id),
  ])
}
export async function requireComputeNode(env: L4Env, credential: string, transport: 'direct' | 'lizard' = 'direct') {
  // One round trip finds the Node and records that it was seen; a refused transport still counts as seen.
  const node = await env.DB.prepare('UPDATE compute_nodes SET last_seen=? WHERE token_hash=? AND enabled=1 RETURNING id,capabilities_json AS capabilitiesJson').bind(nowIso(), await factoryHash(credential)).first<{ id: string; capabilitiesJson: string }>()
  if (!node) fail(403, 'compute_revoked', 'Compute Node authorization unavailable')
  const provider = JSON.parse(node.capabilitiesJson).provider
  if ((provider === 'lizard') !== (transport === 'lizard')) fail(403, 'compute_transport_denied', 'Compute Node transport does not match its provider')
  return node
}
export const computePollSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('claim') }).strict(),
  z.object({ operation: z.literal('workspaces') }).strict(),
  z.object({ operation: z.enum(['begin', 'heartbeat']), id: z.string().uuid(), lease: z.string().min(32).max(100) }).strict(),
  z.object({ operation: z.literal('result'), id: z.string().uuid(), lease: z.string().min(32).max(100),
    result: z.object({ ok: z.boolean(), exitCode: z.number().int().min(-1).max(255), output: z.string().max(64000), runtimeMs: z.number().int().min(0).max(900000), snapshot: factorySnapshot.optional() }).strict() }).strict(),
])
/** A Done or archived Task's work is in its pull request. With nothing of it queued or running, its workspace
 * on this Node is released: the Node may drop that disk, and an Owner may delete Lizard's retained storage. */
export async function releaseFinishedTaskWork(env: L4Env, nodeId: string) {
  await env.DB.prepare(`UPDATE factory_workspaces SET status='released',updated_at=? WHERE node_id=? AND status<>'released'
    AND task_id IN (SELECT id FROM tasks WHERE status='done' OR archived_at IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM factory_actions a WHERE a.workspace_id=factory_workspaces.id AND a.status IN ('pending','approved','claimed','executing'))`).bind(nowIso(), nodeId).run()
}
export async function computePoll(env: L4Env, nodeId: string, input: z.infer<typeof computePollSchema>, scopedActionId: string | null = null) {
  await expireFactoryActions(env)
  if (input.operation === 'workspaces') {
    // A Node keeps one disk per Task workspace and has room for only a few. It removes every disk
    // of its own that is not in the returned list.
    await releaseFinishedTaskWork(env, nodeId)
    const keep = await env.DB.prepare("SELECT id FROM factory_workspaces WHERE node_id=? AND status<>'released'").bind(nodeId).all<{ id: string }>()
    return { keep: keep.results.map(row => row.id) }
  }
  if (input.operation === 'claim') {
    const row = await env.DB.prepare(`SELECT ${actionColumns} FROM factory_actions WHERE status='approved' AND (? IS NULL OR id=?)
      AND workspace_id IN (SELECT id FROM factory_workspaces WHERE node_id=?) AND json_extract(request_json,'$.operation')<>'publish'
      AND NOT EXISTS(SELECT 1 FROM factory_actions a JOIN factory_workspaces w ON w.id=a.workspace_id WHERE w.node_id=? AND a.status IN ('claimed','executing')) ORDER BY created_at LIMIT 1`).bind(scopedActionId, scopedActionId, nodeId, nodeId).first<ActionRow>()
    if (!row) return { job: null }
    try { await authorizeFactoryAction(env, row) } catch {
      await env.DB.prepare("UPDATE factory_actions SET status='cancelled' WHERE id=? AND status='approved'").bind(row.id).run()
      return { job: null }
    }
    const lease = secret(), leaseUntil = new Date(Date.now() + 15000).toISOString()
    const claimed = await env.DB.prepare("UPDATE factory_actions SET status='claimed',lease_token=?,lease_until=? WHERE id=? AND status='approved' AND NOT EXISTS(SELECT 1 FROM factory_actions a JOIN factory_workspaces w ON w.id=a.workspace_id WHERE w.node_id=? AND a.status IN ('claimed','executing')) RETURNING id").bind(lease, leaseUntil, row.id, nodeId).first()
    return { job: claimed ? { id: row.id, lease } : null }
  }
  const row = await env.DB.prepare(`SELECT ${actionColumns} FROM factory_actions WHERE id=? AND lease_token=? AND workspace_id IN (SELECT id FROM factory_workspaces WHERE node_id=?)`).bind(input.id, input.lease, nodeId).first<ActionRow>()
  if (!row) fail(403, 'compute_job_denied', 'Job is outside this Node lease')
  if (input.operation === 'result' && ['completed','failed'].includes(row.status)) {
    const normalize = (value: typeof input.result) => JSON.stringify({ ok: value.ok, exitCode: value.exitCode, output: value.output, runtimeMs: value.runtimeMs, ...(value.snapshot ? { snapshot: { ...value.snapshot, evidence: [] } } : {}) })
    if (!row.resultJson || normalize(JSON.parse(row.resultJson)) !== normalize(input.result)) fail(409, 'compute_receipt_changed', 'A completed receipt cannot change')
    return { accepted: true }
  }
  if (!['claimed', 'executing'].includes(row.status) || !row.leaseUntil || row.leaseUntil <= nowIso()) fail(409, 'compute_job_uncertain', 'The job lease ended; never replay it')
  let context
  try { context = await authorizeFactoryAction(env, row) } catch {
    await env.DB.prepare("UPDATE factory_actions SET status='cancelled' WHERE id=? AND status IN ('claimed','executing')").bind(row.id).run()
    fail(403, 'compute_job_revoked', 'Stop this job immediately; authorization was revoked')
  }
  if (context.request.operation === 'publish') fail(403, 'compute_job_denied', 'Provider publication belongs to the Server broker')
  if (input.operation === 'heartbeat') {
    await env.DB.prepare("UPDATE factory_actions SET lease_until=? WHERE id=? AND status IN ('claimed','executing')").bind(new Date(Date.now() + 15000).toISOString(), row.id).run()
    return { continue: true }
  }
  if (input.operation === 'begin') {
    if (row.status !== 'claimed') fail(409, 'compute_job_uncertain', 'Job execution was already started; never replay it')
    const started = await env.DB.prepare("UPDATE factory_actions SET status='executing' WHERE id=? AND status='claimed' RETURNING id").bind(row.id).first()
    if (!started) fail(409, 'compute_job_uncertain', 'Job was already started')
    await env.DB.prepare("UPDATE tasks SET factory_state='executing' WHERE id=? AND assignee_id=?").bind(context.run.taskId, context.run.agentId).run()
    const bootstrap = context.request.operation === 'bootstrap', gitea = context.environment.provider === 'gitea'
    const sourceToken = bootstrap && !gitea ? await githubSourceGrant(env, { connectionId: context.environment.gitConnectionId, installationId: context.environment.sourceInstallationId, repositoryId: context.environment.sourceRepoId }, async () => { await authorizeFactoryAction(env, row) }) : undefined
    let source: { remote: string; authorization: string } | undefined
    if (bootstrap && gitea) {
      await giteaCredentials(env, context.environment.gitConnectionId)
      let origin: string
      try { origin = new URL(env.PUBLIC_ORIGIN || '').origin } catch { fail(409, 'compute_source', 'Configure this Server’s public origin before fetching Gitea source') }
      source = { remote: `${origin}/api/compute-agent/source/${row.id}.git`, authorization: `Bearer ${await computeSourceCapability(env, row.id, input.lease)}` }
    }
    return { id: row.id, workspaceId: context.workspace.id, serverId: context.auth.serverId, taskId: context.run.taskId, agentId: context.run.agentId, diskBytes: context.capabilities.diskBytes,
      request: context.request, executionBudgetMs: Math.max(1, Math.min(context.request.operation === 'exec' ? context.request.timeoutMs + ('provider' in context.capabilities ? 240000 : 0) : 120000, (JSON.parse(context.run.mandateJson).execution?.workspaceRuntimeMs ?? 3600000) - context.workspace.runtimeMs, Date.parse(row.expiresAt) - Date.now())), image: context.capabilities.image, baseSha: context.environment.baseSha, repository: context.environment.sourceRepo,
      // Only the trusted fetch broker consumes this single-repository READ token, then revokes it. Never mount it in a workspace.
      ...(sourceToken ? { sourceToken } : {}), ...(source ? { source } : {}) }
  }
  if (input.operation !== 'result') fail(400, 'compute_operation_invalid', 'Invalid result operation')
  if (row.status !== 'executing') fail(409, 'compute_job_not_started', 'The job must be started once before delivering a receipt')
  const result = input.result
  if (result.snapshot && context.request.operation !== 'snapshot') fail(400, 'compute_result_invalid', 'Unexpected snapshot')
  if (result.snapshot && result.snapshot.baseSha !== context.environment.baseSha) fail(409, 'factory_base_changed', 'Snapshot base does not match the Task mandate')
  if (result.snapshot) {
    const receipts = await env.DB.prepare("SELECT id,request_json AS requestJson,result_json AS resultJson FROM factory_actions WHERE workspace_id=? AND status IN ('completed','failed') AND json_extract(request_json,'$.operation')='exec' ORDER BY created_at DESC LIMIT 10").bind(context.workspace.id).all<{ id: string; requestJson: string; resultJson: string }>()
    result.snapshot.evidence = await Promise.all(receipts.results.map(async receipt => {
      const value = JSON.parse(receipt.resultJson)
      return { actionId: receipt.id, command: JSON.parse(receipt.requestJson).command.slice(0, 500), exitCode: value.exitCode, outputDigest: await factoryHash(value.output) }
    }))
  }
  const snapshotJson = result.ok && result.snapshot ? JSON.stringify(result.snapshot) : null
  const encoded = JSON.stringify({ ...result, ...(snapshotJson ? { snapshotDigest: await factoryHash(snapshotJson) } : {}) })
  if (new TextEncoder().encode(encoded).byteLength > 400000) fail(413, 'compute_result_large', 'Result exceeds the workspace limit')
  await env.DB.batch([
    env.DB.prepare("UPDATE tasks SET factory_state=? WHERE id=? AND assignee_id=? AND EXISTS(SELECT 1 FROM factory_actions WHERE id=? AND status='executing')").bind(result.ok ? 'workspace_ready' : 'workspace_failed', context.run.taskId, context.run.agentId, row.id),
    env.DB.prepare(`UPDATE factory_workspaces SET commands=commands+1,runtime_ms=runtime_ms+?,updated_at=?,
      status=CASE WHEN ?='bootstrap' AND ?=1 THEN 'ready' WHEN ?='release' AND ?=1 THEN 'released' ELSE status END,
      snapshot_json=CASE WHEN ? IS NOT NULL THEN ? WHEN ? IN ('exec','write','bootstrap','release') THEN NULL ELSE snapshot_json END WHERE id=?
      AND EXISTS(SELECT 1 FROM factory_actions WHERE id=? AND status='executing')`)
      .bind(result.runtimeMs, nowIso(), context.request.operation, result.ok ? 1 : 0, context.request.operation, result.ok ? 1 : 0, snapshotJson, snapshotJson, context.request.operation, context.workspace.id, row.id),
    env.DB.prepare("UPDATE factory_actions SET status=?,result_json=?,completed_at=? WHERE id=? AND status='executing'").bind(result.ok ? 'completed' : 'failed', encoded, nowIso(), row.id),
  ])
  return { accepted: true }
}
