import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { Permission } from '../../shared/permissions'
import type { AuthorizationContext } from '../../shared/authorization'
import type { L4Env } from '../../workers/env'
import type { Membership } from '../../server/utils/guards'
import { listMessageMembers } from '../../server/utils/message-service'

const state = vi.hoisted(() => ({
  serverId: '00000000-0000-4000-8000-000000000001',
  permissions: (1 << 19) | (1 << 12),
  isOwner: false,
  projectPolicies: [] as Array<{ id: string; projectId: string; policyId: string; policyVersion: number; permissions: number }>,
}))
const serverId = state.serverId

vi.mock('../../server/utils/guards', () => ({
  requireMember: async () => ({
    isOwner: state.isOwner,
    ownerId: 'owner',
    perms: state.permissions,
    user: { id: 'member', kind: 'human', displayName: 'Member', avatarR2Key: null },
    authorization: {
      serverId: state.serverId,
      principal: {
        id: 'member', kind: 'human', roleId: 'member-role', roleName: 'Member',
        permissions: state.permissions, isOwner: state.isOwner, projectPolicies: state.projectPolicies,
      },
      credential: { kind: 'session' },
    },
  }),
}))

let db: DatabaseSync
let env: L4Env

beforeAll(() => {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getRouterParam', (_event: unknown, key: string) => key === 'id' ? serverId : undefined)
})

afterAll(() => vi.unstubAllGlobals())

beforeEach(() => {
  state.permissions = Permission.readTasks | Permission.mcpConnect
  state.isOwner = false
  state.projectPolicies = []
  db = new DatabaseSync(':memory:')
  db.exec(INIT_SQL)
  db.exec(`
    INSERT INTO server_identity(singleton,id) VALUES (1,'${serverId}');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES
      ('owner-role','owner','Owner',${Permission.readTasks | Permission.mcpConnect}),
      ('member-role','custom:member','Member',${Permission.readTasks | Permission.mcpConnect});
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES
      ('owner','human','Owner','active','owner-role','2026-10-29'),
      ('member','human','Member','active','member-role','2026-10-29'),
      ('active-agent','agent','Active Agent','active','member-role','2026-10-29'),
      ('paused-agent','agent','Paused Agent','active','member-role','2026-10-29');
    INSERT INTO server(id,name,owner_id) VALUES ('${serverId}','Fixture','owner');
    INSERT INTO agents(user_id,created_by,status,instructions) VALUES
      ('active-agent','owner','active','private'),('paused-agent','owner','paused','private');
  `)
  env = {
    DB: d1(db),
    SERVER_DO: { getByName: () => ({ snapshot: async () => [] }) },
  } as unknown as L4Env
})

afterEach(() => db.close())

function event() {
  return { path: `/api/servers/${serverId}/task-agents`, method: 'GET', context: { cloudflare: { env, context: {} } } }
}

function authorization(): AuthorizationContext {
  return {
    serverId,
    principal: {
      id: 'member', kind: 'human', roleId: 'member-role', roleName: 'Member',
      permissions: state.permissions, isOwner: state.isOwner, projectPolicies: state.projectPolicies,
    },
    credential: { kind: 'mcp', scopes: ['messages:read'] },
  }
}

function membership(): Membership {
  return {
    user: { id: 'member', kind: 'human', displayName: 'Member', avatarR2Key: null },
    serverId,
    roleId: 'member-role',
    roleName: 'Member',
    perms: state.permissions,
    ownerId: 'owner',
    isOwner: state.isOwner,
    authorization: authorization(),
  }
}

async function listMembers() {
  return (await import('../../server/api/servers/[id]/members.get')).default(event() as never)
}

async function listTaskAgents() {
  return (await import('../../server/api/servers/[id]/task-agents.get')).default(event() as never)
}

it('keeps task assignees aligned with HTTP members and MCP member visibility', async () => {
  const members = await listMembers()
  expect(members.members.filter(member => member.user.kind === 'agent')).toEqual([])
  expect(await listTaskAgents()).toEqual({ agents: [] })
  expect((await listMessageMembers(env, membership(), { kind: 'agent' })).members).toEqual([])

  state.projectPolicies = [{ id: 'grant', projectId: 'project', policyId: 'agents', policyVersion: 1, permissions: Permission.useAgents }]
  const projectVisibleMembers = await listMembers()
  const projectVisibleIds = projectVisibleMembers.members.filter(member => member.user.kind === 'agent').map(member => member.user.id)
  expect(projectVisibleIds).toEqual(['active-agent', 'paused-agent'])
  expect((await listTaskAgents()).agents.map(agent => agent.id)).toEqual(projectVisibleIds)
  expect((await listMessageMembers(env, membership(), { kind: 'agent' })).members.map(member => member.id).sort()).toEqual([...projectVisibleIds].sort())

  state.projectPolicies = []
  state.permissions |= Permission.useAgents
  const visibleMembers = await listMembers()
  const visibleIds = visibleMembers.members.filter(member => member.user.kind === 'agent').map(member => member.user.id)
  expect(visibleIds).toEqual(['active-agent', 'paused-agent'])
  expect((await listTaskAgents()).agents.map(agent => agent.id)).toEqual(visibleIds)
  expect((await listMessageMembers(env, membership(), { kind: 'agent' })).members.map(member => member.id).sort()).toEqual([...visibleIds].sort())
})
