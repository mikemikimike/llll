import { DurableObject } from 'cloudflare:workers'
import { z } from 'zod'
import type { L4Env } from './env'
import { lizardComputeAssets } from './lizard-compute-assets'
import { createLizardSandbox, deleteLizardSandbox, extendLizardSandbox, listOwnedLizardSandboxes } from '../server/utils/lizard-sandboxes'
import { createLizardVolume, deleteUnusedLizardVolume, findLizardVolume } from '../server/utils/lizard-volumes'
import { execLizardBootstrap, exposeLizardBridge, writeLizardBootstrapFile } from '../server/utils/lizard-transport'
import { serviceLizardBridge } from '../server/utils/lizard-bridge'
import { encryptSecret, decryptSecret, type EncryptedSecret } from '../shared/encrypted-secret'
import { nowIso } from '../shared/ids'
import { fail } from '../server/utils/cf'

const uuid = z.string().uuid(), token = z.string().regex(/^[a-f0-9]{64}$/u)
type Phase = 'volume' | 'volume_creating' | 'volume_uncertain' | 'vm' | 'vm_creating' | 'vm_uncertain' | 'bootstrap' | 'booting' | 'pairing' | 'ready' | 'stopping' | 'stopped' | 'discarding' | 'failed'
type State = { workspaceId: string; phase: Phase; createdAt: number; vmAttemptedAt?: number; pairingAt?: number; expiresAt?: number; volumeId?: string; sandboxId?: string; nodeId?: string; image?: string; secret?: EncryptedSecret; idleSince?: number; error?: string; retainedStorage?: boolean; stopRequested?: boolean; paused?: boolean }
type Secrets = { pairing?: string; relayKey?: string; accessToken?: string; hostname?: string }
const delay = 1000, setupExpiry = 10 * 60_000, idleExpiry = 120_000, bridgeBudget = 8000, bridgeIdle = 2000, bridgePause = 250
const storageUncertain = 'Storage removal outcome is uncertain; check it again before starting.'
const randomSecret = () => [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2,'0')).join('')

/** One bounded Lizard node per Server. DO state records intent before any billable effect. */
export class LizardComputeDurableObject extends DurableObject<L4Env> {
  private working = false
  private async current() { return await this.ctx.storage.get<State>('state') }
  private async save(state: State) {
    await this.ctx.storage.transaction(async storage => {
      const current = await storage.get<State>('state')
      if (current?.workspaceId === state.workspaceId && current.phase !== 'stopped') {
        if (state.phase !== 'stopped' && current.stopRequested) state.stopRequested = true
        if (current.paused) state.paused = true
      }
      await storage.put('state', state)
    })
  }
  private async activeRun(nodeId: string) {
    return Boolean(await this.env.DB.prepare("SELECT 1 FROM agent_runs WHERE status='running' AND deadline>? AND json_extract(environment_json,'$.computeNodeId')=? LIMIT 1").bind(nowIso(), nodeId).first())
  }
  private async secrets(state: State): Promise<Secrets> {
    if (!this.env.AUTH_SECRET || !state.secret) return {}
    return JSON.parse(await decryptSecret(this.env.AUTH_SECRET, 'lizard-compute:' + state.workspaceId, state.secret)) as Secrets
  }
  private async setSecrets(state: State, value: Secrets) {
    if (!this.env.AUTH_SECRET || this.env.AUTH_SECRET.length < 32) fail(503, 'secret_unavailable', 'Server encryption is unavailable')
    state.secret = await encryptSecret(this.env.AUTH_SECRET, 'lizard-compute:' + state.workspaceId, JSON.stringify(value))
    await this.save(state)
  }
  async status() {
    const state = await this.current()
    return state ? { phase: state.phase, workspaceId: state.workspaceId, nodeId: state.nodeId ?? null, error: state.error ?? null, retainedStorage: state.retainedStorage ?? false, paused: state.paused ?? false, expiresAt: state.expiresAt ?? null } : { phase: 'stopped', workspaceId: null, nodeId: null, error: null, retainedStorage: false, paused: false, expiresAt: null }
  }
  /** A new pairing token is needed only for the initial setup, not when resuming a Node. */
  async start(workspaceId: string, pairing?: string) {
    return this.ctx.blockConcurrencyWhile(async () => {
    const existing = await this.current()
    if (existing && existing.phase !== 'stopped') return this.status()
    if (existing?.error === storageUncertain) fail(409, 'lizard_storage_uncertain', 'Check Lizard storage before starting compute')
    const state: State = existing?.nodeId && existing.volumeId
      ? { ...existing, phase: 'vm', createdAt: Date.now(), sandboxId: undefined, expiresAt: undefined, error: undefined, idleSince: undefined, stopRequested: false, paused: false }
      : { workspaceId: uuid.parse(workspaceId), phase: 'volume', createdAt: Date.now() }
    uuid.parse(state.workspaceId)
    if (!state.nodeId) token.parse(pairing)
    // An Owner's stop turned the Node off. The resumed VM's daemon keeps the Node's token on the
    // disk and never pairs again, so the Server must accept it before its first request arrives.
    if (state.nodeId) await this.env.DB.prepare('UPDATE compute_nodes SET enabled=1 WHERE id=?').bind(state.nodeId).run()
    await this.setSecrets(state, { pairing: state.nodeId ? undefined : pairing })
    await this.ctx.storage.setAlarm(Date.now() + 1)
    return this.status()
    })
  }
  async ensure(nodeId: string) {
    const existing = await this.current()
    if (!existing?.nodeId || existing.nodeId !== nodeId) fail(403, 'lizard_node_denied', 'Compute Node does not belong to this provider')
    if (existing.phase === 'discarding') fail(409, 'lizard_storage_busy', 'Lizard storage is being removed')
    if (existing.error === storageUncertain) fail(409, 'lizard_storage_uncertain', 'Check Lizard storage before starting compute')
    if (existing.paused) fail(409, 'lizard_paused', 'Lizard compute was stopped by the Server owner')
    if (existing.phase === 'stopped') return this.start(existing.workspaceId)
    return this.status()
  }
  async stop() {
    const state = await this.current()
    if (!state) return this.status()
    if (state.phase === 'stopped') { state.paused = true; await this.save(state); return this.status() }
    if (state.phase === 'discarding') { state.paused = true; await this.save(state); return this.status() }
    // Do not discard an in-flight create: its response may still identify a
    // billable VM. The next alarm reconciles it before cleanup.
    state.stopRequested = true; state.paused = true
    if (!['volume_creating','volume_uncertain','vm_creating','vm_uncertain','booting'].includes(state.phase)) state.phase = 'stopping'
    await this.save(state); await this.ctx.storage.setAlarm(Date.now() + 1)
    return this.status()
  }
  async discardUnusedStorage() {
    const state = await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.current()
      if (!current || current.phase !== 'stopped') fail(409, 'lizard_compute_active', 'Stop the Lizard VM before deleting storage')
      current.phase = 'discarding'; await this.save(current); await this.ctx.storage.setAlarm(Date.now() + 30000)
      return current
    })
    try {
      await deleteUnusedLizardVolume(this.env, state.workspaceId, state.nodeId ?? null)
      if (state.nodeId) await this.env.DB.prepare('UPDATE compute_nodes SET enabled=0 WHERE id=?').bind(state.nodeId).run()
      state.nodeId = undefined; state.volumeId = undefined; state.image = undefined; state.retainedStorage = false; state.error = undefined
      state.phase = 'stopped'; await this.save(state); await this.ctx.storage.deleteAlarm()
      return this.status()
    } catch (error) {
      state.phase = 'stopped'
      if (!(error && typeof error === 'object' && 'statusCode' in error && Number(error.statusCode) === 409)) state.error = storageUncertain
      await this.save(state); await this.ctx.storage.deleteAlarm()
      throw error
    }
  }
  private async cleanup(state: State) {
    // A Run can arrive just as the idle timer fires. Keep its existing VM
    // rather than cancel an action which was admitted during that race.
    if (!state.paused && !state.stopRequested && state.nodeId && state.sandboxId && Date.now() < (state.expiresAt ?? 0) - 5000) {
      const active = await this.env.DB.prepare("SELECT 1 FROM agent_runs WHERE status='running' AND deadline>? AND json_extract(environment_json,'$.computeNodeId')=? LIMIT 1").bind(nowIso(), state.nodeId).first()
      if (active) { state.phase = 'ready'; state.idleSince = undefined; await this.save(state); await this.ctx.storage.setAlarm(Date.now() + delay); return }
    }
    // Pairing may have succeeded just before a storage/network failure.
    // Recover only the exact Node name minted for this workspace.
    if (!state.nodeId) {
      const nodes = await this.env.DB.prepare('SELECT id FROM compute_nodes WHERE name=?').bind('Lizard ' + state.workspaceId).all<{ id: string }>()
      if (nodes.results.length > 1) throw Error('Lizard Node ownership is ambiguous')
      if (nodes.results[0]) { state.nodeId = nodes.results[0].id; await this.save(state) }
    }
    if (state.nodeId) {
      await this.env.DB.batch([
        this.env.DB.prepare("UPDATE factory_actions SET status=CASE WHEN status IN ('claimed','executing') THEN 'uncertain' ELSE 'cancelled' END WHERE workspace_id IN (SELECT id FROM factory_workspaces WHERE node_id=?) AND (status IN ('claimed','executing') OR (?=1 AND status IN ('pending','approved')))").bind(state.nodeId, state.paused ? 1 : 0),
        this.env.DB.prepare('UPDATE compute_nodes SET last_seen=NULL WHERE id=?').bind(state.nodeId),
      ])
    }
    // An uncertain create is reconciled by the exact marker before disk cleanup.
    const ids = await listOwnedLizardSandboxes(this.env, state.workspaceId)
    if (state.sandboxId && !ids.includes(state.sandboxId)) ids.push(state.sandboxId)
    for (const id of ids) await deleteLizardSandbox(this.env, id, state.workspaceId)
    state.sandboxId = undefined; state.expiresAt = undefined
    // The disk holds the paired Node's identity, which repository environments and Factory
    // workspaces pin. Keep it so the next Run or Start resumes the same Node; only an explicit
    // "Delete unused storage" removes it. An Owner's stop turns the Node off until Start.
    if (state.nodeId && state.volumeId) {
      state.retainedStorage = true
      if (state.paused) await this.env.DB.prepare('UPDATE compute_nodes SET enabled=0 WHERE id=?').bind(state.nodeId).run()
    }
    else try {
      await deleteUnusedLizardVolume(this.env, state.workspaceId, state.nodeId ?? null)
      state.volumeId = undefined; state.retainedStorage = false
      if (state.nodeId) await this.env.DB.prepare('UPDATE compute_nodes SET enabled=0 WHERE id=?').bind(state.nodeId).run()
      state.nodeId = undefined; state.image = undefined
    }
    catch (error) {
      if (error && typeof error === 'object' && 'data' in error && (error.data as { error?: { code?: string } })?.error?.code === 'lizard_volume_in_use') state.retainedStorage = true
      else throw error
    }
    state.phase = 'stopped'; state.stopRequested = false; await this.setSecrets(state, {}); await this.ctx.storage.deleteAlarm()
  }
  private async guest(state: State) {
    const sandboxId = state.sandboxId!
    await execLizardBootstrap(this.env, sandboxId, 'mkdir -p /workspace/l4/packages/compute-node/src', { timeoutMs: 30000 })
    for (const [path, content] of Object.entries(lizardComputeAssets)) await writeLizardBootstrapFile(this.env, sandboxId, '/workspace/l4/packages/compute-node/' + path, content)
    await execLizardBootstrap(this.env, sandboxId, 'apk add --no-cache docker nodejs e2fsprogs util-linux coreutils >/tmp/l4-setup.log 2>&1 && (mountpoint -q /sys/fs/cgroup || mount -t cgroup2 none /sys/fs/cgroup) && mkdir -p /workspace/docker', { timeoutMs: 180000 })
    await execLizardBootstrap(this.env, sandboxId, 'nohup dockerd --data-root=/workspace/docker --host=unix:///var/run/docker.sock >/tmp/l4-docker.log 2>&1 </dev/null &', { timeoutMs: 30000 })
    await execLizardBootstrap(this.env, sandboxId, 'for i in $(seq 1 40); do docker info >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1', { timeoutMs: 50000 })
    if (!state.image) {
      await execLizardBootstrap(this.env, sandboxId, 'docker build -f packages/compute-node/Dockerfile.workspace -t l4-workspace:managed . >/tmp/l4-build.log 2>&1', { timeoutMs: 180000, workdir: '/workspace/l4' })
      const result = await execLizardBootstrap(this.env, sandboxId, ['docker','image','inspect','l4-workspace:managed','--format','{{.Id}}'], { timeoutMs: 30000 })
      const image = result.stdout.trim()
      if (!/^sha256:[a-f0-9]{64}$/u.test(image)) throw Error('Invalid image')
      state.image = image; await this.save(state)
    } else await execLizardBootstrap(this.env, sandboxId, ['docker','image','inspect',state.image], { timeoutMs: 30000 })
    const secret = await this.secrets(state), relayKey = randomSecret()
    await execLizardBootstrap(this.env, sandboxId, 'nohup node /workspace/l4/packages/compute-node/src/lizard-relay.mjs >/tmp/l4-relay.log 2>&1 </dev/null &', { timeoutMs: 30000, envs: { LLLL_RELAY_KEY: relayKey } })
    const bridge = await exposeLizardBridge(this.env, sandboxId)
    await this.setSecrets(state, { ...secret, ...bridge, relayKey })
    await execLizardBootstrap(this.env, sandboxId, 'nohup node /workspace/l4/packages/compute-node/src/daemon.mjs >/tmp/l4-node.log 2>&1 </dev/null &', { timeoutMs: 30000, envs: { LLLL_NODE_STATE: '/workspace/l4-node-state', LLLL_WORKSPACE_IMAGE: state.image, LLLL_SERVER_ORIGIN: 'http://localhost:3900', LLLL_PAIRING_TOKEN: secret.pairing ?? '', LLLL_WORKSPACE_DISK_BYTES: '1073741824', LLLL_SHARED_KERNEL_TRUSTED: '1', LLLL_COMPUTE_PROVIDER: 'lizard' } })
  }
  override async alarm() {
    if (this.working) return
    this.working = true
    try {
    let state = await this.current()
    if (!state || ['stopped','failed'].includes(state.phase)) return
    if (state.phase === 'discarding') { state.phase = 'stopped'; state.error = storageUncertain; await this.save(state); await this.ctx.storage.deleteAlarm(); return }
    // On a lost in-flight setup never rerun an operation with an uncertain effect.
    if (state.phase === 'volume_creating') state.phase = 'volume_uncertain'
    if (state.phase === 'vm_creating') state.phase = 'vm_uncertain'
    if (state.phase === 'booting') { state.phase = 'stopping'; state.error = 'Compute setup was interrupted; the VM is being cleaned up.' }
    await this.save(state)
    await this.ctx.storage.setAlarm(Date.now() + 30000)
    try {
      if (state.phase === 'stopping') { await this.cleanup(state); return }
      if (state.phase === 'volume') {
        state.phase = 'volume_creating'; await this.save(state)
        if (state.stopRequested) { state.phase = 'stopping'; await this.save(state); await this.ctx.storage.setAlarm(Date.now() + 1); return }
        const disk = await createLizardVolume(this.env, state.workspaceId, 'us-east-1')
        state.stopRequested ||= (await this.current())?.stopRequested
        state.volumeId = disk.id; state.phase = state.stopRequested ? 'stopping' : 'vm'; await this.save(state)
      } else if (state.phase === 'volume_uncertain') {
        const disk = await findLizardVolume(this.env, state.workspaceId)
        if (disk) { state.volumeId = disk.id; state.phase = state.stopRequested ? 'stopping' : 'vm'; await this.save(state) }
        else if (Date.now() > state.createdAt + setupExpiry) { state.error = 'Disk creation is uncertain; reconciliation continues.'; await this.save(state) }
      } else if (state.phase === 'vm') {
        state.phase = 'vm_creating'; state.vmAttemptedAt = Date.now(); await this.save(state)
        if (state.stopRequested) { state.phase = 'stopping'; await this.save(state); await this.ctx.storage.setAlarm(Date.now() + 1); return }
        const vm = await createLizardSandbox(this.env, { workspaceId: state.workspaceId, volumeId: state.volumeId, timeoutMs: setupExpiry, region: 'us-east-1', size: 'small' })
        state.stopRequested ||= (await this.current())?.stopRequested
        state.sandboxId = vm.sandboxId; state.expiresAt = Date.now() + setupExpiry; state.phase = state.stopRequested ? 'stopping' : 'bootstrap'; await this.save(state)
      } else if (state.phase === 'vm_uncertain') {
        const ids = await listOwnedLizardSandboxes(this.env, state.workspaceId)
        if (ids.length === 1) { state.sandboxId = ids[0]; state.expiresAt = state.createdAt + setupExpiry; state.phase = state.stopRequested ? 'stopping' : 'bootstrap'; await this.save(state) }
        else if (ids.length > 1 || Date.now() > (state.vmAttemptedAt ?? state.createdAt) + setupExpiry + 30000) { state.phase = 'stopping'; state.error = 'VM creation requires cleanup.'; await this.save(state) }
      } else if (state.phase === 'bootstrap') {
        state.phase = 'booting'; await this.save(state)
        await this.guest(state)
        state.stopRequested ||= (await this.current())?.stopRequested
        state.phase = state.stopRequested ? 'stopping' : 'pairing'; state.pairingAt = Date.now(); await this.save(state)
      } else if (state.phase === 'pairing' || state.phase === 'ready') {
        const secret = await this.secrets(state)
        if (!secret.hostname || !secret.accessToken || !secret.relayKey) throw Error('Missing bridge')
        const pairingState = state, connection = { hostname: secret.hostname, accessToken: secret.accessToken, relayKey: secret.relayKey }
        // Drain the relay queue: a Node's heartbeats, begin and result calls arrive together, and its
        // relay answers 504 after 14 seconds, which stops the running operation.
        const persist = async (nodeId: string) => { pairingState.nodeId = nodeId; await this.save(pairingState) }
        let result: { processed: boolean; accepted?: boolean; nodeId?: string } = await serviceLizardBridge(this.env, connection, state.nodeId, persist)
        // While a Run uses this Node, keep listening between alarms: each Factory operation needs
        // several relayed calls (claim, begin, heartbeats, result), and an alarm comes only every second.
        const busy = state.phase === 'ready' && state.nodeId ? await this.activeRun(state.nodeId) : false
        for (const until = performance.now() + bridgeBudget, idleUntil = performance.now() + bridgeIdle; !result.nodeId && (result.processed || busy) && performance.now() < until;) {
          const next = await serviceLizardBridge(this.env, connection, state.nodeId, persist)
          if (next.processed) { result = { ...next, accepted: result.accepted || next.accepted }; continue }
          if (!busy || performance.now() >= idleUntil) break
          await new Promise(resolve => setTimeout(resolve, bridgePause))
        }
        state.stopRequested ||= (await this.current())?.stopRequested
        const paired = result.processed && result.nodeId ? result.nodeId : state.phase === 'pairing' && state.nodeId && result.processed && result.accepted ? state.nodeId : null
        if (result.processed && result.nodeId) {
          // A newly paired Node replaces this provider's earlier one: environments that named it follow.
          await this.env.DB.prepare(`UPDATE agent_environments SET config_json=json_set(config_json,'$.computeNodeId',?1),version=version+1,updated_at=?2
            WHERE json_extract(config_json,'$.computeNodeId') IN (SELECT id FROM compute_nodes WHERE id<>?1 AND enabled=0 AND json_extract(capabilities_json,'$.provider')='lizard')`).bind(result.nodeId, nowIso()).run()
          state.nodeId = result.nodeId; state.phase = 'ready'; state.idleSince = Date.now(); await this.setSecrets(state, { ...secret, pairing: undefined })
        }
        else if (paired) { state.phase = 'ready'; state.idleSince = Date.now(); await this.save(state) }
        if (state.stopRequested) state.phase = 'stopping'
        if (state.phase === 'pairing' && Date.now() > (state.pairingAt ?? state.createdAt) + 90000) { state.phase = 'stopping'; state.error = 'Compute did not connect; the VM is being cleaned up.'; await this.save(state) }
        if (state.phase === 'ready' && state.nodeId) {
          const active = await this.activeRun(state.nodeId)
          if (active) state.idleSince = undefined
          else state.idleSince ??= Date.now()
          if (active && state.sandboxId && Date.now() > (state.expiresAt ?? 0) - 60000) state.expiresAt = (await extendLizardSandbox(this.env, state.sandboxId, state.workspaceId)).expiresAt
          if ((!active && Date.now() > state.idleSince! + idleExpiry) || Date.now() > (state.expiresAt ?? 0) - 5000) state.phase = 'stopping'
          await this.save(state)
        }
      }
      state = (await this.current())!
      if (!['stopped','failed'].includes(state.phase)) await this.ctx.storage.setAlarm(Date.now() + (state.phase === 'ready' || state.phase === 'pairing' ? delay : state.phase === 'volume_uncertain' || state.phase === 'vm_uncertain' ? 30000 : 1))
    } catch (error) {
      // Creation calls have unknown outcomes; reconcile rather than create again.
      state = (await this.current())!
      console.warn('lizard.compute.alarm_failed', { phase: state.phase, code: (error as { data?: { error?: { code?: string } } })?.data?.error?.code ?? (error instanceof Error ? error.message.slice(0, 120) : 'unknown') })
      if (state.phase === 'volume_creating') state.phase = 'volume_uncertain'
      else if (state.phase === 'vm_creating') state.phase = 'vm_uncertain'
      else if (state.phase === 'booting') { state.phase = 'stopping'; state.error = 'Compute setup failed; the VM is being cleaned up.' }
      else if (state.phase === 'pairing' || state.phase === 'ready') {
        if ((state.phase === 'pairing' && Date.now() > (state.pairingAt ?? state.createdAt) + 90000) || Date.now() > (state.expiresAt ?? state.createdAt + setupExpiry)) { state.phase = 'stopping'; state.error = 'Compute connection expired; the VM is being cleaned up.' }
      }
      await this.save(state)
      // A connected Node's heartbeats keep its operation alive; a long pause would expire that lease.
      await this.ctx.storage.setAlarm(Date.now() + (state.phase === 'pairing' || state.phase === 'ready' ? delay * 2 : 30000))
    }
    } finally { this.working = false }
  }
}
