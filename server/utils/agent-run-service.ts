import { requireProject } from './project-service'
import { admitMcpConnections } from './outbound-mcp'
import { agentProviderCatalog, catalogAgentModel } from './agent-providers'
import { agentConversationModel } from './agent-conversation-model'
import { newId, nowIso } from '../../shared/ids'
import { hasPermission, Permission } from '../../shared/permissions'
import { projectPermissionAllowed, projectSubjectPermissionAllowed, type ProjectPolicyGrant } from '../../shared/project-access'
import { resourceAccessAllows, resourceAccessWithin, RESOURCE_KINDS, type ResourceAccess } from '../../shared/resource-access'
import type { AuthorizationContext } from '../../shared/authorization'
import { intersectResources, runRequestSchema, RUN_QUEUE_WAIT_MS, type AgentRun, type RunMandate, type RunRequest } from '../../shared/agent-execution'
import type { L4Env } from '../../workers/env'
import { asRpc, piRuntimeConfigured } from '../../workers/env'
import { loadAuthorizationContext } from './authorization'
import { requireChannelAccessForMember, requireMemberForUser } from './channel-access'
import { getTask } from './task-service'
import { fail } from './cf'
import { admitRunEnvironment, findCodeEnvironment, requireRunEnvironment } from './code-environment-service'
import { repositoryResourceId, type RunEnvironment } from '../../shared/code-environments'
import { fanoutAgentTurns } from '../../workers/agent-turns'
import { agentWebhook } from './agent-webhooks'
import { agentAccessMode, agentInvocationAllowed } from './agent-access'

const runColumns = `id, session_id as sessionId, agent_id as agentId, channel_id as channelId, initiated_by as initiatedBy,
 task_id as taskId, source_message_id as sourceMessageId, status, prompt, model, instructions, mandate_json as mandateJson, result_text as resultText,
 environment_json as environmentJson, files_key as filesKey,
 last_error as lastError, model_calls as modelCalls, total_tokens as totalTokens, event_cursor as eventCursor,
 deadline, created_at as createdAt, updated_at as updatedAt`

export async function piConfigured(env: L4Env): Promise<boolean> {
  return piRuntimeConfigured(env) || Boolean(env.AGENT_RUN_DO && (env.FILES || env.TICKETS) && (await agentProviderCatalog(env)).models.length)
}
export async function findAgentRun(env: L4Env, id: string): Promise<AgentRun | null> {
  return env.DB.prepare(`SELECT ${runColumns} FROM agent_runs WHERE id = ?`).bind(id).first<AgentRun>()
}

async function wakeAdmittedRun(env: L4Env, run: AgentRun): Promise<void> {
  if (!['queued', 'running'].includes(run.status) && !(run.status === 'failed' && run.sourceMessageId)) return
  if (run.sourceMessageId && ['queued', 'running'].includes(run.status)) {
    await env.DB.prepare(`INSERT INTO agent_turns(submission_id,agent_id,channel_id,source_message_id,initiated_by,status,detail,created_at,updated_at)
      SELECT id,agent_id,channel_id,source_message_id,initiated_by,'queued','Queued',created_at,updated_at FROM agent_runs
      WHERE id=? AND status IN ('queued','running') ON CONFLICT(submission_id) DO NOTHING`).bind(run.id).run()
    await fanoutAgentTurns(env, run.channelId, run.agentId)
  }
  await asRpc<{ wake: (id: string) => Promise<void> }>(env.AGENT_RUN_DO!.getByName(`run:${run.id}`)).wake(run.id)
}

/** Check both current authority and the immutable upper bound accepted for this Run. */
export async function runAuthorization(env: L4Env, run: Pick<AgentRun, 'id' | 'agentId' | 'channelId' | 'initiatedBy' | 'mandateJson'> & { environmentJson?: string | null }): Promise<AuthorizationContext> {
  const auth = await loadAuthorizationContext(env, { principalId: run.agentId, credential: { kind: 'agent_runtime', id: run.id }, delegatedBy: run.initiatedBy })
  if (!auth || !auth.delegation) fail(403, 'run_revoked', 'Run authorization was revoked')
  const mandate = JSON.parse(run.mandateJson) as RunMandate
  if (mandate.parentRunId) {
    if (mandate.rootDeadline && mandate.rootDeadline <= nowIso()) fail(403, 'delegation_expired', 'The original execution window ended')
    const parent = await findAgentRun(env, mandate.parentRunId)
    if (!parent || parent.initiatedBy !== run.initiatedBy || ['failed', 'cancelled'].includes(parent.status)) fail(403, 'delegation_revoked', 'The parent mandate was stopped')
    const parentMandate = JSON.parse(parent.mandateJson) as RunMandate
    if (mandate.depth !== (parentMandate.depth ?? 0) + 1 || (mandate.depth ?? 0) > 16 || mandate.rootRunId !== (parentMandate.rootRunId ?? parent.id) || mandate.projectId !== parentMandate.projectId) fail(403, 'delegation_revoked', 'The delegation chain changed')
    await runAuthorization(env, parent)
  }
  const retainPolicies = (current: ProjectPolicyGrant[] = [], ceiling: ProjectPolicyGrant[] = []) => ceiling.map(saved => {
    const found = current.find(grant => grant.id === saved.id && grant.projectId === saved.projectId && grant.policyId === saved.policyId && grant.policyVersion === saved.policyVersion && grant.permissions === saved.permissions)
    if (!found) fail(403, 'run_revoked', 'Project access changed; start a new attempt')
    return found
  })
  auth.principal.projectPolicies = retainPolicies(auth.principal.projectPolicies, mandate.agentProjectPolicies)
  auth.delegation.projectPolicies = retainPolicies(auth.delegation.projectPolicies, mandate.initiatorProjectPolicies)
  if (mandate.projectId) auth.projectScope = { id: mandate.projectId, ...(run.environmentJson ? { repositoryId: repositoryResourceId(JSON.parse(run.environmentJson) as RunEnvironment) } : {}) }
  // Agent access is judged on the person's grants as loaded, before the mandate narrows them below.
  const delegation = { ...auth.delegation }
  if ((auth.principal.permissions & mandate.agentPermissions) !== mandate.agentPermissions
    || (!auth.delegation.isOwner && ((auth.delegation.permissions! & mandate.permissions) !== mandate.permissions))
    || !resourceAccessWithin(mandate.agentResourceAccess ?? {}, auth.principal.resourceAccess)
    || !resourceAccessWithin(mandate.resourceAccess ?? {}, auth.delegation.resourceAccess)) {
    fail(403, 'run_revoked', 'Run permissions were reduced; start a new attempt with the current role')
  }
  const intersect = (current: ResourceAccess | undefined, cap: ResourceAccess | undefined): ResourceAccess =>
    Object.fromEntries(RESOURCE_KINDS.map(kind => [kind, current?.[kind] == null ? cap?.[kind] ?? null : current[kind]!.filter(id => resourceAccessAllows(cap, kind, id))]))
  auth.principal.permissions &= mandate.agentPermissions
  auth.principal.resourceAccess = intersect(auth.principal.resourceAccess, mandate.agentResourceAccess)
  auth.delegation.permissions = (auth.delegation.isOwner ? mandate.permissions : auth.delegation.permissions! & mandate.permissions)
  auth.delegation.isOwner = false
  auth.delegation.resourceAccess = intersect(auth.delegation.resourceAccess, mandate.resourceAccess)
  // Agent access was judged above, and what it granted is now pinned by the mandate. The live grant list
  // would otherwise be saved with every tool call and Factory action, and an unrelated grant to this
  // person (another project, an expiry) would revoke work in flight.
  delete auth.delegation.agentAccess
  // Every remaining check reads the database independently: run them as one round of requests,
  // since each Run is re-authorized on every model call, tool call and Node request.
  await Promise.all([
    (async () => {
      const [actor, profile] = await Promise.all([
        env.DB.prepare(`SELECT u.kind FROM users u WHERE u.id=? AND u.status='active'`).bind(run.initiatedBy).first<{ kind: string }>(),
        env.DB.prepare("SELECT status,harness,access FROM agents WHERE user_id=?").bind(run.agentId).first<{ status: string; harness: string; access: 'open' | 'granted' }>(),
      ])
      if (!actor || actor.kind !== 'human' || !profile || !agentInvocationAllowed(profile.access, delegation, mandate.projectId)) fail(403, 'run_revoked', 'Agent access was revoked')
      if (profile.status !== 'active' || profile.harness !== 'pi') fail(403, 'run_revoked', 'Agent is paused')
    })(),
    ...[run.agentId, run.initiatedBy].map(async id => {
      const row = await env.DB.prepare("SELECT id,kind,display_name as displayName,avatar_r2_key as avatarR2Key FROM users WHERE id=? AND status='active'")
        .bind(id).first<{ id: string; kind: 'human' | 'agent'; displayName: string; avatarR2Key: string | null }>()
      if (!row) fail(403, 'run_revoked', 'Member unavailable')
      await requireChannelAccessForMember(env, requireMemberForUser(env, row, auth.serverId), run.channelId, Permission.sendMessages)
    }),
    (async () => {
      const taskProject = await env.DB.prepare('SELECT project_id AS projectId FROM tasks WHERE id=(SELECT task_id FROM agent_runs WHERE id=?)').bind(run.id).first<{ projectId: string | null }>()
      if (taskProject && mandate.projectId !== undefined && mandate.projectId !== taskProject.projectId) fail(403, 'project_mandate', 'Task project changed; start a new attempt')
      const projectId = taskProject?.projectId ?? mandate.projectId
      if (projectId) {
        const project = await requireProject(env, auth, projectId)
        if (project.archivedAt) fail(403, 'project_archived', 'Project execution is unavailable while archived')
      }
    })(),
    run.environmentJson ? requireRunEnvironment(env, auth, JSON.parse(run.environmentJson) as RunEnvironment) : undefined,
  ])
  return auth
}

export async function createAgentRun(env: L4Env, actor: AuthorizationContext, request: RunRequest, ceiling?: RunMandate): Promise<AgentRun> {
  const { agentExecutionPolicy } = await import('./agent-execution-policy')
  const executionPolicy = await agentExecutionPolicy(env)
  const input = runRequestSchema.parse(request)
  if (actor.principal.kind !== 'human') fail(403, 'forbidden', 'Cannot invoke agents')
  const agent = await loadAuthorizationContext(env, { principalId: input.agentId, credential: { kind: 'agent_runtime' }, delegatedBy: actor.principal.id })
  // What this person may do through this Agent: their own Role plus Agent access they hold for it.
  let invoker: AuthorizationContext = agent?.delegation && !actor.principal.isOwner
    ? { ...actor, principal: { ...actor.principal, permissions: agent.delegation.permissions!, projectPolicies: agent.delegation.projectPolicies } } : actor
  const requestedTask = input.taskId ? await getTask(env, invoker, input.taskId) : null
  const requestedProjectId = requestedTask?.projectId ?? null
  if (requestedProjectId) {
    actor = { ...actor, projectScope: { id: requestedProjectId } }
    invoker = { ...invoker, projectScope: { id: requestedProjectId } }
  }
  const pairDm = await env.DB.prepare("SELECT id FROM channels WHERE id=? AND type='dm' AND (SELECT count(*) FROM channel_members WHERE channel_id=channels.id)=2").bind(input.channelId).first()
  if (pairDm) fail(400, 'thread_required', 'Send a message to the agent to start a reply thread')
  const sameRequest = (run: AgentRun) => {
    if (input.toolConnectionIds && JSON.stringify([...input.toolConnectionIds].sort()) !== JSON.stringify(((JSON.parse(run.mandateJson) as RunMandate).toolConnections ?? []).map(cap => cap.id).sort())) fail(409, 'call_conflict', 'Run connection selection changed')
    if (run.channelId !== input.channelId || run.prompt !== input.prompt || run.taskId !== (input.taskId ?? null)
      || run.sourceMessageId !== (input.sourceMessageId ?? null)
      || (input.environmentId && JSON.parse(run.environmentJson ?? '{}').id !== input.environmentId)) fail(409, 'run_conflict', 'Request key was already used for different work')
  }
  if (input.sourceMessageId) {
    const source = await env.DB.prepare('SELECT m.id FROM messages m JOIN channels c ON c.id=? WHERE m.id=? AND (m.channel_id=c.id OR c.parent_message_id=m.id)')
      .bind(input.channelId, input.sourceMessageId).first()
    if (!source) fail(404, 'not_found', 'Source message not found in this conversation')
  }
  if (agent?.delegation && !agentInvocationAllowed(await agentAccessMode(env, input.agentId), agent.delegation, requestedProjectId)) fail(403, 'forbidden', 'Cannot invoke agents')
  let admissionError: string | null = null
  // An external Agent thinks on its own computer: it needs a Run coordinator, not a model provider.
  const external = Boolean(await agentWebhook(env, input.agentId))
  if (external && !env.AGENT_RUN_DO) fail(409, 'pi_unconfigured', 'Agent execution is unavailable. Ask the Server operator to check its configuration.')
  if (!external && !await piConfigured(env)) {
    if (input.sourceMessageId && env.AGENT_RUN_DO) admissionError = 'Agent execution is unavailable. Ask the Server operator to check its configuration.'
    else fail(409, 'pi_unconfigured', 'Agent execution is unavailable. Ask the Server operator to check its configuration.')
  }
  const previous = await env.DB.prepare('SELECT id FROM agent_runs WHERE agent_id=? AND initiated_by=? AND idempotency_key=?')
    .bind(input.agentId, actor.principal.id, input.idempotencyKey).first<{ id: string }>()
  if (previous) {
    const run = (await findAgentRun(env, previous.id))!
    sameRequest(run)
    await runAuthorization(env, run)
    await wakeAdmittedRun(env, run)
    return run
  }
  const profile = await env.DB.prepare(`SELECT a.harness,a.status,a.model,a.instructions FROM agents a JOIN users u ON u.id=a.user_id WHERE a.user_id=? AND u.status='active'`)
    .bind(input.agentId).first<{ harness: string; status: string; model: string; instructions: string }>()
  if (!profile || profile.harness !== 'pi' || profile.status !== 'active') fail(409, 'agent_unavailable', 'Choose an active agent')
  if (!agent) fail(403, 'forbidden', 'Agent unavailable')
  if (requestedProjectId) agent.projectScope = { id: requestedProjectId }
  const computer = Boolean(input.taskId && (requestedProjectId ? projectPermissionAllowed(agent, requestedProjectId, Permission.useComputer)
    : hasPermission(agent.principal.permissions, Permission.useComputer) && (invoker.principal.isOwner || hasPermission(invoker.principal.permissions, Permission.useComputer))))
  let projectId: string | null = null
  let environmentId = input.environmentId ?? null
  if (input.taskId) {
    if (requestedProjectId ? !projectSubjectPermissionAllowed(agent.principal, requestedProjectId, Permission.executeTasks) : !hasPermission(agent.principal.permissions, Permission.executeTasks)) fail(403, 'agent_task_permission', requestedProjectId
      ? 'The assigned agent needs Execute assigned tasks in this project or its Server role. Give it the Developer policy in the project.'
      : 'The assigned agent’s Server role does not allow Execute assigned tasks. Put the task in a project and give the agent the Developer policy there.')
    if (!invoker.principal.isOwner && (requestedProjectId ? !projectPermissionAllowed(invoker, requestedProjectId, Permission.executeTasks) : !hasPermission(invoker.principal.permissions, Permission.executeTasks))) fail(403, 'actor_task_permission', 'You need Execute assigned tasks in this project or your Server role.')
    const admissionTask = await getTask(env, agent, input.taskId)
    if (!admissionTask || admissionTask.assigneeId !== input.agentId) fail(403, 'forbidden', 'Task must be assigned to this agent')
    for (const id of [input.agentId, actor.principal.id]) {
      const member = await env.DB.prepare("SELECT id,kind,display_name as displayName,avatar_r2_key as avatarR2Key FROM users WHERE id=? AND status='active'").bind(id).first<{ id: string; kind: 'human' | 'agent'; displayName: string; avatarR2Key: string | null }>()
      if (!member) fail(403, 'report_access', 'Report channel member is unavailable')
      try { await requireChannelAccessForMember(env, requireMemberForUser(env, member, actor.serverId), input.channelId, Permission.sendMessages) }
      catch { fail(403, 'report_access', id === input.agentId ? 'The assigned agent needs access and Send messages in the report channel.' : 'You need access and Send messages in the report channel.') }
    }
    const task = await getTask(env, agent, input.taskId)
    if (!task || task.assigneeId !== input.agentId) fail(403, 'forbidden', 'Task must be assigned to this agent')
    projectId = task.projectId ?? null
    if (ceiling?.projectId !== undefined && ceiling.projectId !== projectId) fail(403, 'project_mandate', 'Child work must remain in the original project')
    if (environmentId && task.environmentId && environmentId !== task.environmentId) fail(403, 'code_denied', 'Use the task’s configured environment')
    environmentId ??= task.environmentId ?? null
  }
  const catalog = external ? null : await agentProviderCatalog(env, { actorId: actor.principal.id })
  const selected = catalog ? await agentConversationModel(env, input.channelId) : null
  const requested = catalog ? selected ?? (profile.model || catalog.defaultModel) : 'external'
  const resolved = catalog && requested ? catalogAgentModel(env, requested, catalog) : requested
  const model = resolved ?? requested ?? 'Unconfigured'
  const modelError = !catalog ? null : selected && !resolved
    ? 'The conversation model is disabled; choose another model'
    : profile.model && !selected && !resolved
      ? 'The agent model is unavailable; choose another model in agent settings'
      : model === 'Unconfigured' ? 'Connect a model provider in Server settings' : null
  if (modelError) {
    if (input.sourceMessageId && env.AGENT_RUN_DO) admissionError = modelError
    else fail(409, 'model_unavailable', modelError)
  }
  // A person's daily limit from Agent access is enforced inside the admission below, like the Agent's own.
  const accessBudget = agent.delegation?.agentAccess?.dailyRuns ?? null
  const accessSince = new Date(Date.now() - 86400000).toISOString()
  const now = nowIso()
  const sessionId = newId()
  await env.DB.prepare('INSERT INTO agent_sessions (id,agent_id,channel_id,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(agent_id,channel_id) DO NOTHING')
    .bind(sessionId, input.agentId, input.channelId, now, now).run()
  const session = await env.DB.prepare('SELECT id FROM agent_sessions WHERE agent_id=? AND channel_id=?').bind(input.agentId, input.channelId).first<{ id: string }>()
  const id = newId()
  if (ceiling?.parentRunId) {
    const parent = await findAgentRun(env, ceiling.parentRunId)
    if (!parent || parent.initiatedBy !== actor.principal.id || parent.status !== 'running') fail(403, 'delegation_revoked', 'The parent run is no longer active')
    const parentMandate = JSON.parse(parent.mandateJson) as RunMandate
    if (ceiling.depth !== (parentMandate.depth ?? 0) + 1 || (ceiling.depth ?? 0) > (parentMandate.execution?.maxDepth ?? 2) || ceiling.rootRunId !== (parentMandate.rootRunId ?? parent.id) || projectId !== parentMandate.projectId) fail(403, 'delegation_scope', 'Child work exceeds the parent mandate')
    await runAuthorization(env, parent)
  }
  const restrictPolicies = (current: ProjectPolicyGrant[] = [], cap?: ProjectPolicyGrant[]) => current.filter(grant => (!projectId || grant.projectId === projectId) && (!ceiling || cap?.some(saved => JSON.stringify(saved) === JSON.stringify(grant))))
  const mandate: RunMandate = { projectId, agentProjectPolicies: restrictPolicies(agent.principal.projectPolicies, ceiling?.agentProjectPolicies), initiatorProjectPolicies: restrictPolicies(invoker.principal.projectPolicies, ceiling?.initiatorProjectPolicies), permissions: invoker.principal.permissions, resourceAccess: actor.principal.resourceAccess,
    agentPermissions: agent.principal.permissions, agentResourceAccess: agent.principal.resourceAccess,
    computer, execution: ceiling ? ceiling.execution : executionPolicy, rootRunId: ceiling?.rootRunId ?? id, parentRunId: ceiling?.parentRunId, rootDeadline: ceiling?.rootDeadline,
    maxSteps: executionPolicy.maxSteps, maxModelCalls: executionPolicy.maxModelCalls,
    maxToolCalls: executionPolicy.maxToolCalls, maxTokens: executionPolicy.maxTokens }
  if (!input.taskId && !ceiling) {
    const repositories = await env.DB.prepare(`SELECT r.id,r.environment_id AS environmentId,e.version FROM project_repositories r
      JOIN projects p ON p.id=r.project_id JOIN agent_environments e ON e.id=r.environment_id
      WHERE p.archived_at IS NULL AND e.enabled=1 ORDER BY r.created_at LIMIT 25`).all<{ id: string; environmentId: string; version: number }>()
    mandate.chatRepositories = repositories.results
  }
  if (ceiling) {
    mandate.depth = ceiling.depth ?? 0
    mandate.permissions &= ceiling.permissions
    mandate.agentPermissions &= ceiling.agentPermissions
    mandate.resourceAccess = intersectResources(mandate.resourceAccess, ceiling.resourceAccess)
    mandate.agentResourceAccess = intersectResources(mandate.agentResourceAccess, ceiling.agentResourceAccess)
    mandate.computer &&= ceiling.computer
    mandate.maxSteps = Math.min(mandate.maxSteps, ceiling.maxSteps)
    mandate.maxModelCalls = Math.min(mandate.maxModelCalls, ceiling.maxModelCalls)
    mandate.maxToolCalls = Math.min(mandate.maxToolCalls, ceiling.maxToolCalls)
    mandate.maxTokens = Math.min(mandate.maxTokens, ceiling.maxTokens)
  }
  // Admission checks source conversation access before creating an executable record.
  const pending = { id, agentId: input.agentId, channelId: input.channelId, initiatedBy: actor.principal.id, mandateJson: JSON.stringify(mandate) }
  const execution = await runAuthorization(env, pending)
  mandate.toolConnections = await admitMcpConnections(env, execution, input.toolConnectionIds, ceiling ? ceiling.toolConnections ?? [] : undefined)
  let environment: RunEnvironment | null = null
  if (ceiling && environmentId !== (ceiling.environmentId ?? null)) fail(403, 'code_denied', 'Subtasks and scheduled work cannot change repository environments')
  if (environmentId) {
    if (!mandate.computer) fail(403, 'code_denied', 'Repository execution needs computer permission in a task-backed mandate')
    if (execution.projectScope) { const found = await findCodeEnvironment(env, environmentId); execution.projectScope.repositoryId = found ? repositoryResourceId(found) : '' }
    environment = await admitRunEnvironment(env, execution, environmentId)
    if (ceiling?.environmentVersion !== undefined && environment.version !== ceiling.environmentVersion) fail(403, 'code_revoked', 'Repository mandate must be renewed after configuration changes')
    mandate.environmentId = environment.id
    mandate.environmentVersion = environment.version
  }
  const admitted = await env.DB.prepare(`INSERT INTO agent_runs (id,session_id,agent_id,channel_id,initiated_by,task_id,source_message_id,idempotency_key,status,prompt,model,instructions,mandate_json,environment_json,deadline,created_at,updated_at,last_error,result_message_id)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM agent_runs WHERE agent_id=? AND created_at>=?)<?
    AND (? IS NULL OR (SELECT count(*) FROM agent_runs WHERE json_extract(mandate_json,'$.rootRunId')=?)<?)
    AND (? IS NULL OR (SELECT count(*) FROM agent_runs WHERE agent_id=? AND initiated_by=? AND created_at>=?)<?)
    ON CONFLICT(agent_id,initiated_by,idempotency_key) DO NOTHING RETURNING id`)
    .bind(id, session!.id, input.agentId, input.channelId, actor.principal.id, input.taskId ?? null, input.sourceMessageId ?? null, input.idempotencyKey, admissionError ? 'failed' : 'queued',
      input.prompt, model, profile.instructions, JSON.stringify(mandate), environment ? JSON.stringify(environment) : null,
      new Date(Date.now() + RUN_QUEUE_WAIT_MS).toISOString(), now, now, admissionError, admissionError ? newId() : null, input.agentId, new Date(Date.now() - 86400000).toISOString(), executionPolicy.dailyRuns,
      mandate.parentRunId ?? null, mandate.rootRunId!, (mandate.execution?.maxChildRuns ?? 0) + 1,
      accessBudget, input.agentId, actor.principal.id, accessSince, accessBudget ?? 0).first<{ id: string }>()
  if (!admitted) {
    const duplicate = await env.DB.prepare('SELECT id FROM agent_runs WHERE agent_id=? AND initiated_by=? AND idempotency_key=?').bind(input.agentId, actor.principal.id, input.idempotencyKey).first<{ id: string }>()
    if (duplicate) {
      const run = (await findAgentRun(env, duplicate.id))!
      sameRequest(run)
      await runAuthorization(env, run)
      await wakeAdmittedRun(env, run)
      return run
    }
    if (accessBudget) {
      const used = await env.DB.prepare('SELECT count(*) AS n FROM agent_runs WHERE agent_id=? AND initiated_by=? AND created_at>=?')
        .bind(input.agentId, actor.principal.id, accessSince).first<{ n: number }>()
      if ((used?.n ?? 0) >= accessBudget) fail(429, 'access_budget', 'Your daily run limit for this agent is reached')
    }
    fail(429, 'run_budget', 'Agent daily run limit reached')
  }
  const run = (await findAgentRun(env, id))!
  await wakeAdmittedRun(env, run)
  return run
}

export async function runCapability(env: L4Env, runId: string): Promise<string> {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) throw new Error('Run signing secret unavailable')
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`agent-run:${runId}`)))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function verifyRunCapability(env: L4Env, runId: string, token: string): Promise<boolean> {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) return false
  if (!/^[0-9a-f]{64}$/u.test(token)) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const signature = Uint8Array.from(token.match(/../gu)!, byte => Number.parseInt(byte, 16))
  return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(`agent-run:${runId}`))
}
