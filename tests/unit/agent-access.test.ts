import { afterEach, beforeEach, expect, it } from 'vitest'
import { grant, ids, mcpFixture } from '../helpers/outbound-mcp'
import { Permission } from '../../shared/permissions'
import { authorize, ServerAction } from '../../shared/authorization'
import { projectPermissionAllowed } from '../../shared/project-access'
import { createProject } from '../../server/utils/project-service'
import { assignProjectPolicy, saveProjectPolicy } from '../../server/utils/project-policies'
import { grantAgentAccess, listAgentAccess, revokeAgentAccess, setAgentAccessMode } from '../../server/utils/agent-access'
import { createAgentRun, runAuthorization } from '../../server/utils/agent-run-service'

let f: ReturnType<typeof mcpFixture>, research: string
const outsider = '00000000-0000-4000-8000-000000000009'
beforeEach(async () => {
  f = mcpFixture()
  Object.assign(f.env, { SERVER_DO: { getByName: () => ({ notifyTasksChanged: async () => {} }) } })
  // Mike (the Agent) may research the web; Petya (the member) may not.
  f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(grant | Permission.browseWeb, ids.agentRole)
  f.db.prepare("INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES(?,'human','Kolya','active',?,'2026-10-25')").run(outsider, ids.memberRole)
  research = (await saveProjectPolicy(f.env, await f.actor(), { name: 'Web research', permissions: Permission.browseWeb })).id
})
afterEach(() => f.db.close())
const give = async (input: Record<string, unknown>) => grantAgentAccess(f.env, await f.actor(), ids.agent, { policyId: research, memberId: ids.member, ...input })
const start = async (as: string) => createAgentRun(f.env, await f.actor(as), { agentId: ids.agent, channelId: 'public-chat', prompt: 'Research', idempotencyKey: crypto.randomUUID() })

it('lowers the Agent to the invoking person by default', async () => {
  const { authorization } = await f.run(ids.member)
  expect(() => authorize(authorization, ServerAction.browseWeb)).toThrow()
  const owner = await f.run(ids.owner)
  expect(() => authorize(owner.authorization, ServerAction.browseWeb)).not.toThrow()
})

it('lets Agent access lift one person through one Agent, within the Agent’s own Role, until revoked', async () => {
  const access = await give({})
  const { run, authorization } = await f.run(ids.member)
  expect(() => authorize(authorization, ServerAction.browseWeb)).not.toThrow()
  // The person's own authority is unchanged, and the Agent's Role stays the ceiling.
  const own = await f.actor(ids.member)
  expect(() => authorize(own, ServerAction.browseWeb)).toThrow()
  f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(grant, ids.agentRole)
  await expect(runAuthorization(f.env, run)).rejects.toMatchObject({ statusCode: 403 })
  f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(grant | Permission.browseWeb, ids.agentRole)
  await expect(runAuthorization(f.env, run)).resolves.toBeTruthy()
  await revokeAgentAccess(f.env, await f.actor(), ids.agent, access.id)
  await expect(runAuthorization(f.env, run)).rejects.toMatchObject({ statusCode: 403 })
})

it('keeps a Run’s saved authority stable while unrelated Agent access changes', async () => {
  await give({})
  const { run } = await f.run(ids.member)
  const saved = (auth: Awaited<ReturnType<typeof runAuthorization>>) => JSON.stringify({ principal: auth.principal, delegation: auth.delegation })
  const before = saved(await runAuthorization(f.env, run))
  // Access to the same Agent in another Project, or an unrelated grant expiring, must not revoke work in flight.
  const b = (await createProject(f.env, await f.actor(), { name: 'B' })).id
  await give({ policyId: 'project-policy-developer', projectId: b })
  expect(saved(await runAuthorization(f.env, run))).toBe(before)
})

it('admits Runs under a person’s daily limit atomically', async () => {
  await give({ dailyRuns: 1 })
  const results = await Promise.allSettled([start(ids.member), start(ids.member)])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { statusCode: 429, data: { error: { code: 'access_budget' } } } })
})

it('keeps project Agent access inside its Project', async () => {
  const a = (await createProject(f.env, await f.actor(), { name: 'A' })).id
  const b = (await createProject(f.env, await f.actor(), { name: 'B' })).id
  await assignProjectPolicy(f.env, await f.actor(), a, { policyId: 'project-policy-developer', memberId: ids.agent })
  await assignProjectPolicy(f.env, await f.actor(), b, { policyId: 'project-policy-developer', memberId: ids.agent })
  await give({ policyId: 'project-policy-developer', projectId: a })
  const { run, authorization } = await f.run(ids.member)
  expect(projectPermissionAllowed(authorization, a, Permission.proposeCode)).toBe(true)
  expect(projectPermissionAllowed(authorization, b, Permission.proposeCode)).toBe(false)
  f.db.prepare('UPDATE projects SET archived_at=? WHERE id=?').run('2026-10-30T00:00:00.000Z', a)
  await expect(runAuthorization(f.env, run)).rejects.toMatchObject({ statusCode: 403 })
})

it('answers only holders of access when the Agent is restricted, and the Owner always', async () => {
  await setAgentAccessMode(f.env, await f.actor(), ids.agent, { access: 'granted' })
  await expect(start(ids.member)).rejects.toMatchObject({ statusCode: 403 })
  await expect(start(ids.owner)).resolves.toBeTruthy()
  await give({})
  await expect(start(ids.member)).resolves.toBeTruthy()
  await expect(start(outsider)).rejects.toMatchObject({ statusCode: 403 })
  const role = await grantAgentAccess(f.env, await f.actor(), ids.agent, { policyId: research, roleId: ids.memberRole })
  await expect(start(outsider)).resolves.toBeTruthy()
  expect((await listAgentAccess(f.env, await f.actor(), ids.agent)).grants.map(item => item.id)).toContain(role.id)
})

it('applies a daily Run limit and an expiry', async () => {
  const access = await give({ dailyRuns: 1 })
  await start(ids.member)
  await expect(start(ids.member)).rejects.toMatchObject({ statusCode: 429 })
  await expect(start(ids.owner)).resolves.toBeTruthy()
  f.db.prepare('UPDATE grants SET daily_runs=NULL,expires_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', access.id)
  const { authorization } = await f.run(ids.member)
  expect(() => authorize(authorization, ServerAction.browseWeb)).toThrow()
  await expect(give({ memberId: outsider, expiresAt: '2020-01-01T00:00:00.000Z' })).rejects.toMatchObject({ statusCode: 400 })
})

it('never lets someone grant what they do not hold, grant themselves, or open an Agent without Manage roles', async () => {
  const manager = '00000000-0000-4000-8000-000000000010'
  f.db.prepare("INSERT INTO roles(id,key,name,permissions_bitmask,resource_access_json) VALUES('manager-role','custom:manager','Manager',?,'{}')").run(Permission.manageAgents | Permission.manageRoles | Permission.useAgents)
  f.db.prepare("INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES(?,'human','Manager','active','manager-role','2026-10-25')").run(manager)
  const as = await f.actor(manager)
  await expect(grantAgentAccess(f.env, as, ids.agent, { policyId: research, memberId: ids.member })).rejects.toMatchObject({ statusCode: 403 })
  await expect(grantAgentAccess(f.env, await f.actor(), ids.agent, { policyId: research, memberId: ids.owner })).rejects.toMatchObject({ statusCode: 400 })
  await expect(grantAgentAccess(f.env, await f.actor(ids.member), ids.agent, { policyId: research, memberId: outsider })).rejects.toMatchObject({ statusCode: 403 })
  // Nor through their own Role.
  f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(Permission.manageAgents | Permission.manageRoles | Permission.useAgents | Permission.browseWeb, 'manager-role')
  await expect(grantAgentAccess(f.env, await f.actor(manager), ids.agent, { policyId: research, roleId: 'manager-role' })).rejects.toMatchObject({ statusCode: 400 })
  f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(Permission.manageAgents | Permission.useAgents, 'manager-role')
  const restricted = await f.actor(manager)
  await expect(setAgentAccessMode(f.env, restricted, ids.agent, { access: 'granted' })).resolves.toBe('granted')
  await expect(setAgentAccessMode(f.env, restricted, ids.agent, { access: 'open' })).rejects.toMatchObject({ statusCode: 403 })
})

it('moves existing project assignments into grants without changing them', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { readFileSync } = await import('node:fs')
  const { d1ExecSql } = await import('../../server/utils/db')
  const sql = (name: string) => d1ExecSql(readFileSync(new URL(`../../drizzle/server-migrations/${name}`, import.meta.url), 'utf8'))
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  for (const name of ['0000_server_baseline.sql', '0001_mail_drafts.sql', '0002_agent_webhooks.sql', '0003_telegram_notifications.sql']) db.exec(sql(name))
  db.exec(`INSERT INTO roles(id,key,name,permissions_bitmask,resource_access_json) VALUES('r','member','Member',0,'{}');
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('u','human','U','active','r','2026-10-25');
    INSERT INTO projects(id,name,created_by,created_at,updated_at) VALUES('p','P','u','2026-10-25','2026-10-25');
    INSERT INTO project_policy_assignments(id,project_id,policy_id,member_id,role_id,created_by,created_at) VALUES
      ('a1','p','project-policy-developer','u',NULL,'u','2026-10-25'),('a2','p','project-policy-reviewer',NULL,'r','u','2026-10-26');`)
  db.exec(sql('0004_grants.sql'))
  expect(db.prepare('SELECT id,member_id,role_id,agent_id,policy_id,project_id,created_at FROM grants ORDER BY id').all()).toEqual([
    { id: 'a1', member_id: 'u', role_id: null, agent_id: null, policy_id: 'project-policy-developer', project_id: 'p', created_at: '2026-10-25' },
    { id: 'a2', member_id: null, role_id: 'r', agent_id: null, policy_id: 'project-policy-reviewer', project_id: 'p', created_at: '2026-10-26' },
  ])
  // The previous release's project-access read still works between migration and code upload.
  expect(db.prepare(`SELECT a.id FROM project_policy_assignments a JOIN project_policies p ON p.id=a.policy_id JOIN projects j ON j.id=a.project_id
    WHERE (a.member_id=? OR a.role_id=?) AND j.archived_at IS NULL ORDER BY a.id`).all('u', 'r').map(row => row.id)).toEqual(['a1', 'a2'])
  db.exec("INSERT INTO agents(user_id,created_by) VALUES('u','u'); INSERT INTO grants(id,member_id,agent_id,policy_id,project_id,created_by,created_at) VALUES('mike','u','u','project-policy-developer','p','u','x')")
  expect(db.prepare('SELECT count(*) AS n FROM project_policy_assignments').get()!.n).toBe(2)
  expect(() => db.exec("INSERT INTO grants(id,member_id,policy_id,project_id,created_by,created_at) VALUES('dup','u','project-policy-developer','p','u','x')")).toThrow()
  expect(() => db.exec("INSERT INTO grants(id,member_id,policy_id,created_by,created_at) VALUES('server','u','project-policy-developer','u','x')")).toThrow()
  db.close()
})
