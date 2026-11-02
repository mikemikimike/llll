import { z } from 'zod'
import type { L4Env } from '../../workers/env'
import { lizardCredential } from './lizard-connection'
import { releaseFinishedTaskWork } from './compute-nodes'
import { fail } from './cf'
import { readLimitedStream } from '../../workers/inbound-email-signature'

const volumeSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/u), name: z.string().min(1).max(100), attachedTo: z.string().nullable().optional() })
const uuid = z.string().uuid()
async function boundedJson(response: Response) {
  const data = await readLimitedStream(response.body, 100000)
  if (!data.ok) throw new Error('Provider response exceeded limit')
  return JSON.parse(new TextDecoder().decode(data.bytes)) as unknown
}
export function lizardVolumeName(workspaceId: string) { return 'l4-workspace-' + uuid.parse(workspaceId).replaceAll('-', '') }
/** The unique name is stable. A timed-out create is reconciled by name, never retried blindly. */
export async function createLizardVolume(env: L4Env, workspaceId: string, region: string) {
  const name = lizardVolumeName(workspaceId), credential = await lizardCredential(env)
  z.string().regex(/^[a-z0-9-]{1,64}$/u).parse(region)
  let response: Response
  try { response = await fetch(`https://lizard.build/api/projects/${encodeURIComponent(credential.projectId)}/volumes`, { method: 'POST', headers: { 'X-API-Key': credential.apiKey, 'Content-Type': 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(30000), body: JSON.stringify({ name, sizeGb: 5, region }) }) }
  catch { fail(503, 'lizard_volume_uncertain', 'Lizard disk creation outcome is unknown; inspect it before retrying') }
  if (!response.ok) fail(response.status >= 500 ? 503 : 400, 'lizard_volume_failed', 'Lizard did not accept the disk request')
  try { const disk = volumeSchema.parse(await boundedJson(response)); if (disk.name !== name) throw Error('wrong disk'); return { id: disk.id, name } }
  catch { fail(503, 'lizard_volume_uncertain', 'Lizard disk response was invalid; inspect it before retrying') }
}
export async function findLizardVolume(env: L4Env, workspaceId: string) {
  const name = lizardVolumeName(workspaceId), credential = await lizardCredential(env)
  let response: Response
  try { response = await fetch(`https://lizard.build/api/projects/${encodeURIComponent(credential.projectId)}/volumes/${encodeURIComponent(name)}`, { headers: { 'X-API-Key': credential.apiKey }, redirect: 'manual', signal: AbortSignal.timeout(30000) }) }
  catch { fail(503, 'lizard_volume_unavailable', 'Lizard disk inventory is unavailable') }
  if (response.status === 404) return null
  if (!response.ok) fail(503, 'lizard_volume_unavailable', 'Lizard disk inventory is unavailable')
  try { const disk = volumeSchema.parse(await boundedJson(response)); if (disk.name !== name) throw Error('wrong disk'); return disk }
  catch { fail(503, 'lizard_volume_unavailable', 'Lizard disk ownership response is invalid') }
}
/** Cleanup may discard only a setup disk which never held a Task workspace. */
export async function deleteUnusedLizardVolume(env: L4Env, workspaceId: string, nodeId: string | null) {
  const disk = await findLizardVolume(env, workspaceId)
  if (!disk) return { deleted: true }
  if (disk.attachedTo) fail(409, 'lizard_volume_attached', 'Lizard disk is still attached')
  const nodes = await env.DB.prepare('SELECT id FROM compute_nodes WHERE name=?').bind('Lizard ' + workspaceId).all<{ id: string }>()
  if (nodes.results.some(node => node.id !== nodeId)) fail(409, 'lizard_volume_ownership', 'Lizard disk ownership is uncertain')
  if (nodeId && !nodes.results.some(node => node.id === nodeId)) fail(409, 'lizard_volume_ownership', 'Lizard compute node is unavailable')
  if (nodeId) {
    // Finished Tasks release their workspaces here too, not only when the Node asks before its next Task.
    await releaseFinishedTaskWork(env, nodeId)
    if (await env.DB.prepare("SELECT 1 FROM factory_workspaces WHERE node_id=? AND status<>'released' LIMIT 1").bind(nodeId).first()) fail(409, 'lizard_volume_in_use', 'Lizard disk holds work of unfinished Tasks. Mark finished Tasks Done or archive them, then delete the storage')
  }
  const credential = await lizardCredential(env)
  let response: Response
  try { response = await fetch(`https://lizard.build/api/projects/${encodeURIComponent(credential.projectId)}/volumes/${encodeURIComponent(disk.id)}`, { method: 'DELETE', headers: { 'X-API-Key': credential.apiKey }, redirect: 'manual', signal: AbortSignal.timeout(30000) }) }
  catch { fail(503, 'lizard_volume_cleanup_uncertain', 'Lizard disk cleanup outcome is unknown') }
  if (!response.ok && response.status !== 404) fail(503, 'lizard_volume_cleanup_failed', 'Lizard disk cleanup failed')
  return { deleted: true }
}
