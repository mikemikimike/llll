import { agentAccessModeSchema, agentAccessSchema, type AgentAccessDTO, type AgentAccessGrant, type AgentAccessMode, type DelegatedAgentAccess } from '../../shared/agent-access'
import type { AuthorizationContext } from '../../shared/authorization'
import { newId, nowIso } from '../../shared/ids'
import { hasPermission, Permission, PermissionGrants } from '../../shared/permissions'
import { ProjectPolicyPermissions, projectPermissionAllowed, projectSubjectPermissionAllowed, type ProjectPolicyGrant } from '../../shared/project-access'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { writeAudit } from './messages'

/**
 * Agent access: a grant with an Agent. The holder may use that Agent with the grant's
 * Policy even beyond their own Role. The Agent's own Role stays the ceiling, and only
 * someone who holds those permissions in that scope can grant them.
 */
export async function loadAgentAccess(env: L4Env, agentId: string, memberId: string, roleId: string): Promise<DelegatedAgentAccess> {
  const rows = await env.DB.prepare(`SELECT g.id,g.project_id AS projectId,p.id AS policyId,p.version AS policyVersion,p.permissions_bitmask AS permissions,g.daily_runs AS dailyRuns
    FROM grants g JOIN project_policies p ON p.id=g.policy_id LEFT JOIN projects j ON j.id=g.project_id
    WHERE g.agent_id=? AND (g.member_id=? OR g.role_id=?) AND (g.expires_at IS NULL OR g.expires_at>?)
      AND (g.project_id IS NULL OR j.archived_at IS NULL) ORDER BY g.id`)
    .bind(agentId, memberId, roleId, nowIso()).all<ProjectPolicyGrant & { projectId: string | null; dailyRuns: number | null }>()
  const access: DelegatedAgentAccess = { grants: rows.results.length, permissions: 0, projectPolicies: [], dailyRuns: null }
  for (const { dailyRuns, ...grant } of rows.results) {
    // Holding Agent access is itself permission to use that Agent.
    if (grant.projectId) access.projectPolicies.push({ ...grant, projectId: grant.projectId, permissions: grant.permissions | Permission.useAgents })
    else access.permissions |= grant.permissions | Permission.useAgents
    if (dailyRuns) access.dailyRuns = Math.min(access.dailyRuns ?? dailyRuns, dailyRuns)
  }
  return access
}

/** Whether the initiating person may invoke this Agent at all. Project grants count everywhere for invocation;
 * their permissions still apply only in their Project. */
export function agentInvocationAllowed(mode: AgentAccessMode, delegation: NonNullable<AuthorizationContext['delegation']>, projectId?: string | null): boolean {
  if (delegation.isOwner || (delegation.agentAccess?.grants ?? 0) > 0) return true
  if (mode === 'granted') return false
  return projectId ? projectSubjectPermissionAllowed(delegation, projectId, Permission.useAgents) : hasPermission(delegation.permissions ?? 0, Permission.useAgents)
}

export async function agentAccessMode(env: L4Env, agentId: string): Promise<AgentAccessMode> {
  const row = await env.DB.prepare('SELECT access FROM agents WHERE user_id=?').bind(agentId).first<{ access: AgentAccessMode }>()
  return row?.access ?? 'open'
}

function canManageAgentAccess(auth: AuthorizationContext): boolean {
  return auth.principal.kind === 'human' && auth.credential.kind === 'session' && !auth.delegation
    && (auth.principal.isOwner || hasPermission(auth.principal.permissions, Permission.manageAgents))
}
function requireAgentAccessManager(auth: AuthorizationContext) {
  if (!canManageAgentAccess(auth)) fail(403, 'access_denied', 'Manage agents with a human session is required')
}
async function requireAgent(env: L4Env, agentId: string) {
  const agent = await env.DB.prepare("SELECT a.user_id AS id FROM agents a JOIN users u ON u.id=a.user_id WHERE a.user_id=? AND u.kind='agent' AND u.status='active'").bind(agentId).first()
  if (!agent) fail(404, 'not_found', 'Agent not found')
}

/** Granting, changing or removing access needs authority over its whole scope: Manage roles for the Server,
 * Manage projects for one Project, and every permission it carries. */
function assertScopeAuthority(auth: AuthorizationContext, permissions: number, projectId: string | null) {
  if (auth.principal.isOwner) return
  if (projectId ? !projectPermissionAllowed(auth, projectId, Permission.manageProjects) : !hasPermission(auth.principal.permissions, Permission.manageRoles)) {
    fail(403, 'access_denied', projectId ? 'Manage this project before changing its agent access' : 'Manage roles before granting Server-wide agent access')
  }
  for (const grant of PermissionGrants) if ((permissions & grant.flag) && !(projectId
    ? projectPermissionAllowed(auth, projectId, grant.flag)
    : hasPermission(auth.principal.permissions, grant.flag))) fail(403, 'access_denied', 'Cannot grant permissions you do not have')
}

export async function listAgentAccess(env: L4Env, auth: AuthorizationContext, agentId: string): Promise<AgentAccessDTO> {
  requireAgentAccessManager(auth)
  await requireAgent(env, agentId)
  const grants = (await env.DB.prepare(`SELECT g.id,g.agent_id AS agentId,g.policy_id AS policyId,p.name AS policyName,p.permissions_bitmask AS permissions,
      g.member_id AS memberId,g.role_id AS roleId,coalesce(u.display_name,r.name) AS name,coalesce(u.kind,'role') AS kind,
      g.project_id AS projectId,j.name AS projectName,g.daily_runs AS dailyRuns,g.expires_at AS expiresAt,g.created_at AS createdAt
    FROM grants g JOIN project_policies p ON p.id=g.policy_id LEFT JOIN users u ON u.id=g.member_id LEFT JOIN roles r ON r.id=g.role_id LEFT JOIN projects j ON j.id=g.project_id
    WHERE g.agent_id=? ORDER BY name,j.name,p.name,g.id`).bind(agentId).all<AgentAccessGrant>()).results
  return { access: await agentAccessMode(env, agentId), grants, canManage: true }
}

export async function grantAgentAccess(env: L4Env, auth: AuthorizationContext, agentId: string, request: unknown): Promise<AgentAccessGrant> {
  requireAgentAccessManager(auth)
  await requireAgent(env, agentId)
  const input = agentAccessSchema.parse(request)
  const policy = await env.DB.prepare('SELECT id,permissions_bitmask AS permissions FROM project_policies WHERE id=?').bind(input.policyId).first<{ id: string; permissions: number }>()
  if (!policy) fail(404, 'not_found', 'Policy not found')
  if (input.projectId) {
    const project = await env.DB.prepare('SELECT archived_at AS archivedAt FROM projects WHERE id=?').bind(input.projectId).first<{ archivedAt: string | null }>()
    if (!project) fail(404, 'not_found', 'Project not found')
    if (project.archivedAt) fail(409, 'project_archived', 'Restore the project before changing access')
    if ((policy.permissions & ~ProjectPolicyPermissions) !== 0) fail(400, 'policy_scope', 'This policy includes server permissions and cannot be granted within a project')
  }
  if (input.expiresAt && input.expiresAt <= nowIso()) fail(400, 'access_expiry', 'Choose a future expiry')
  assertScopeAuthority(auth, policy.permissions, input.projectId)
  const target = input.memberId
    ? await env.DB.prepare("SELECT id FROM users WHERE id=? AND kind='human' AND status='active'").bind(input.memberId).first()
    : await env.DB.prepare("SELECT id FROM roles WHERE id=? AND key<>'owner'").bind(input.roleId).first()
  if (!target) fail(400, 'access_target', 'Choose an active person or a non-owner role')
  if (input.memberId === auth.principal.id || (input.roleId && input.roleId === auth.principal.roleId)) fail(400, 'access_target', 'Grant agent access to someone else')
  const id = newId()
  const inserted = await env.DB.prepare(`INSERT INTO grants(id,member_id,role_id,agent_id,policy_id,project_id,daily_runs,expires_at,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id`)
    .bind(id, input.memberId, input.roleId, agentId, policy.id, input.projectId, input.dailyRuns, input.expiresAt, auth.principal.id, nowIso()).first()
  if (!inserted) fail(409, 'access_exists', 'This access is already granted')
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'agent.access.grant', targetType: 'agent', targetId: agentId,
    meta: { grantId: id, policyId: policy.id, projectId: input.projectId }, authorization: auth })
  return (await listAgentAccess(env, auth, agentId)).grants.find(grant => grant.id === id)!
}

/** Removal takes effect at the next authority check of every Run that relied on it. */
export async function revokeAgentAccess(env: L4Env, auth: AuthorizationContext, agentId: string, grantId: string): Promise<void> {
  requireAgentAccessManager(auth)
  const current = (await listAgentAccess(env, auth, agentId)).grants.find(grant => grant.id === grantId)
  if (!current) fail(404, 'not_found', 'Access not found')
  assertScopeAuthority(auth, current.permissions, current.projectId)
  await env.DB.prepare('DELETE FROM grants WHERE id=? AND agent_id=?').bind(grantId, agentId).run()
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'agent.access.revoke', targetType: 'agent', targetId: agentId, meta: { grantId }, authorization: auth })
}

/** Restricting an Agent to granted access needs only Manage agents; opening it to everyone with Use agents
 * widens who reaches its Role, so it needs Manage roles too. */
export async function setAgentAccessMode(env: L4Env, auth: AuthorizationContext, agentId: string, request: unknown): Promise<AgentAccessMode> {
  requireAgentAccessManager(auth)
  await requireAgent(env, agentId)
  const { access } = agentAccessModeSchema.parse(request)
  if (access === 'open' && !auth.principal.isOwner && !hasPermission(auth.principal.permissions, Permission.manageRoles)) fail(403, 'access_denied', 'Manage roles before opening an agent to everyone who uses agents')
  await env.DB.prepare('UPDATE agents SET access=?,updated_at=? WHERE user_id=?').bind(access, nowIso(), agentId).run()
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'agent.access.mode', targetType: 'agent', targetId: agentId, meta: { access }, authorization: auth })
  return access
}
