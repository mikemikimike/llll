import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { CHANNEL_PERMISSION_MASK } from '../shared/channel-permissions'

function isoTimestamps() {
  return {
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  }
}

function authTimestamps() {
  return {
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast(unixepoch() * 1000 as integer))`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast(unixepoch() * 1000 as integer))`),
  }
}

/** Better Auth owns the auth_* tables. L4's domain identity lives in users. */
export const authUsers = sqliteTable('auth_users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  ...authTimestamps(),
})

export const authSessions = sqliteTable('auth_sessions', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  token: text('token').notNull().unique(),
  ...authTimestamps(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
}, table => [
  index('auth_sessions_user_id_idx').on(table.userId),
])

export const authAccounts = sqliteTable('auth_accounts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
  scope: text('scope'),
  password: text('password'),
  ...authTimestamps(),
}, table => [
  uniqueIndex('auth_accounts_provider_account_idx').on(table.providerId, table.accountId),
  index('auth_accounts_user_id_idx').on(table.userId),
])

export const authVerifications = sqliteTable('auth_verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(sql`(cast(unixepoch() * 1000 as integer))`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).default(sql`(cast(unixepoch() * 1000 as integer))`),
})

/** Better Auth OAuth Provider storage. Token values are SHA-256 digests. */

export const oauthClient = sqliteTable('auth_oauth_client', {
  id: text('id').primaryKey(),
  clientId: text('client_id').notNull().unique(),
  clientSecret: text('client_secret'),
  clientDiscoveryId: text('client_discovery_id'),
  disabled: integer('disabled', { mode: 'boolean' }).default(false),
  skipConsent: integer('skip_consent', { mode: 'boolean' }),
  enableEndSession: integer('enable_end_session', { mode: 'boolean' }),
  subjectType: text('subject_type'),
  scopes: text('scopes'),
  clientCredentialsScopes: text('client_credentials_scopes').default('[]'),
  userId: text('user_id').references(() => authUsers.id),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
  name: text('name'),
  uri: text('uri'),
  icon: text('icon'),
  contacts: text('contacts'),
  tos: text('tos'),
  policy: text('policy'),
  softwareId: text('software_id'),
  softwareVersion: text('software_version'),
  softwareStatement: text('software_statement'),
  redirectUris: text('redirect_uris').notNull(),
  postLogoutRedirectUris: text('post_logout_redirect_uris'),
  backchannelLogoutUri: text('backchannel_logout_uri'),
  backchannelLogoutSessionRequired: integer('backchannel_logout_session_required', { mode: 'boolean' }),
  tokenEndpointAuthMethod: text('token_endpoint_auth_method'),
  applicationType: text('application_type'),
  jwks: text('jwks'),
  jwksUri: text('jwks_uri'),
  grantTypes: text('grant_types'),
  responseTypes: text('response_types'),
  requirePKCE: integer('require_p_k_c_e', { mode: 'boolean' }),
  dpopBoundAccessTokens: integer('dpop_bound_access_tokens', { mode: 'boolean' }).default(false),
  referenceId: text('reference_id'),
  metadata: text('metadata'),
}, table => [
  index('auth_oauth_client_user_id_idx').on(table.userId),
])

export const oauthResource = sqliteTable('auth_oauth_resource', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull().unique(),
  name: text('name').notNull(),
  accessTokenTtl: integer('access_token_ttl'),
  refreshTokenTtl: integer('refresh_token_ttl'),
  signingAlgorithm: text('signing_algorithm'),
  signingKeyId: text('signing_key_id'),
  allowedScopes: text('allowed_scopes'),
  customClaims: text('custom_claims'),
  dpopBoundAccessTokensRequired: integer('dpop_bound_access_tokens_required', { mode: 'boolean' }).default(false),
  disabled: integer('disabled', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
  policyVersion: integer('policy_version').default(1),
  metadata: text('metadata'),
})

export const oauthClientResource = sqliteTable('auth_oauth_client_resource', {
  id: text('id').primaryKey(),
  clientId: text('client_id').notNull().references(() => oauthClient.clientId, { onDelete: 'cascade' }),
  resourceId: text('resource_id').notNull().references(() => oauthResource.identifier, { onDelete: 'cascade' }),
  metadata: text('metadata'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }),
}, table => [
  index('auth_oauth_client_resource_client_id_idx').on(table.clientId),
  index('auth_oauth_client_resource_resource_id_idx').on(table.resourceId),
  uniqueIndex('auth_oauth_client_resource_client_id_resource_id_unique').on(table.clientId, table.resourceId),
])

export const oauthRefreshToken = sqliteTable('auth_oauth_refresh_token', {
  id: text('id').primaryKey(),
  token: text('token').notNull().unique(),
  clientId: text('client_id').notNull().references(() => oauthClient.clientId),
  sessionId: text('session_id').references(() => authSessions.id, { onDelete: 'set null' }),
  userId: text('user_id').notNull().references(() => authUsers.id),
  referenceId: text('reference_id'),
  authorizationCodeId: text('authorization_code_id'),
  resources: text('resources'),
  requestedUserInfoClaims: text('requested_user_info_claims'),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  revoked: integer('revoked', { mode: 'timestamp_ms' }),
  rotatedAt: integer('rotated_at', { mode: 'timestamp_ms' }),
  rotationReplayResponse: text('rotation_replay_response'),
  rotationReplayExpiresAt: integer('rotation_replay_expires_at', { mode: 'timestamp_ms' }),
  authTime: integer('auth_time', { mode: 'timestamp_ms' }),
  confirmation: text('confirmation'),
  scopes: text('scopes').notNull(),
}, table => [
  index('auth_oauth_refresh_token_client_id_idx').on(table.clientId),
  index('auth_oauth_refresh_token_session_id_idx').on(table.sessionId),
  index('auth_oauth_refresh_token_user_id_idx').on(table.userId),
  index('auth_oauth_refresh_token_authorization_code_id_idx').on(table.authorizationCodeId),
])

export const oauthAccessToken = sqliteTable('auth_oauth_access_token', {
  id: text('id').primaryKey(),
  token: text('token').notNull().unique(),
  clientId: text('client_id').notNull().references(() => oauthClient.clientId),
  sessionId: text('session_id').references(() => authSessions.id, { onDelete: 'set null' }),
  userId: text('user_id').references(() => authUsers.id),
  referenceId: text('reference_id'),
  authorizationCodeId: text('authorization_code_id'),
  resources: text('resources'),
  requestedUserInfoClaims: text('requested_user_info_claims'),
  refreshId: text('refresh_id').references(() => oauthRefreshToken.id),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  revoked: integer('revoked', { mode: 'timestamp_ms' }),
  confirmation: text('confirmation'),
  scopes: text('scopes').notNull(),
}, table => [
  index('auth_oauth_access_token_client_id_idx').on(table.clientId),
  index('auth_oauth_access_token_session_id_idx').on(table.sessionId),
  index('auth_oauth_access_token_user_id_idx').on(table.userId),
  index('auth_oauth_access_token_authorization_code_id_idx').on(table.authorizationCodeId),
  index('auth_oauth_access_token_refresh_id_idx').on(table.refreshId),
])

export const oauthConsent = sqliteTable('auth_oauth_consent', {
  id: text('id').primaryKey(),
  clientId: text('client_id').notNull().references(() => oauthClient.clientId),
  userId: text('user_id').references(() => authUsers.id),
  referenceId: text('reference_id'),
  resources: text('resources'),
  requestedUserInfoClaims: text('requested_user_info_claims'),
  scopes: text('scopes').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, table => [
  index('auth_oauth_consent_client_id_idx').on(table.clientId),
  index('auth_oauth_consent_user_id_idx').on(table.userId),
])

export const oauthClientAssertion = sqliteTable('auth_oauth_client_assertion', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
})

export const oauthTables = {
  oauthClient, oauthResource, oauthClientResource, oauthRefreshToken,
  oauthAccessToken, oauthConsent, oauthClientAssertion,
}

/** Server-wide admission policy and login-method switches. */
export const authSettings = sqliteTable('auth_settings', {
  id: integer('id').primaryKey().default(1),
  registrationMode: text('registration_mode', { enum: ['open', 'invite_only'] }).notNull().default('invite_only'),
  emailEnabled: integer('email_enabled', { mode: 'boolean' }).notNull().default(true),
  githubEnabled: integer('github_enabled', { mode: 'boolean' }).notNull().default(false),
  googleEnabled: integer('google_enabled', { mode: 'boolean' }).notNull().default(false),
  linkedinEnabled: integer('linkedin_enabled', { mode: 'boolean' }).notNull().default(false),
  twitterEnabled: integer('twitter_enabled', { mode: 'boolean' }).notNull().default(false),
  telegramEnabled: integer('telegram_enabled', { mode: 'boolean' }).notNull().default(false),
  turnstileEnabled: integer('turnstile_enabled', { mode: 'boolean' }).notNull().default(false),
  emailFrom: text('email_from'),
  emailFromName: text('email_from_name'),
  ...isoTimestamps(),
}, table => [
  check('auth_settings_singleton_check', sql`${table.id} = 1`),
  check('auth_settings_registration_mode_check', sql`${table.registrationMode} in ('open', 'invite_only')`),
])

/** OAuth and Turnstile secrets entered in the owner UI. Secrets are AES-GCM encrypted. */
export const authProviderCredentials = sqliteTable('auth_provider_credentials', {
  provider: text('provider', { enum: ['github', 'google', 'twitter', 'telegram', 'linkedin', 'turnstile'] }).primaryKey(),
  publicKey: text('public_key').notNull(),
  secretCiphertext: text('secret_ciphertext').notNull(),
  secretIv: text('secret_iv').notNull(),
  secretVersion: integer('secret_version').notNull().default(1),
  ...isoTimestamps(),
}, table => [
  check('auth_provider_credentials_provider_check', sql`${table.provider} in ('github', 'google', 'twitter', 'telegram', 'linkedin', 'turnstile')`),
])

/** Immutable published Privacy, Terms, and server Rules bundle. */
export const onboardingRevisions = sqliteTable('onboarding_revisions', {
  id: text('id').primaryKey(),
  version: integer('version').notNull(),
  privacyJson: text('privacy_json').notNull(),
  termsJson: text('terms_json').notNull(),
  rulesJson: text('rules_json').notNull(),
  createdBy: text('created_by').notNull().references(() => authUsers.id),
  createdAt: text('created_at').notNull(),
}, table => [
  uniqueIndex('onboarding_revisions_version_unique').on(table.version),
])

/** The exact published onboarding bundle accepted by an authentication identity. */
export const onboardingAcceptances = sqliteTable('onboarding_acceptances', {
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  revisionId: text('revision_id').notNull().references(() => onboardingRevisions.id, { onDelete: 'cascade' }),
  acceptedAt: text('accepted_at').notNull(),
}, table => [
  primaryKey({ columns: [table.userId, table.revisionId] }),
  index('onboarding_acceptances_revision_idx').on(table.revisionId),
])

/** Server-wide RealtimeKit credentials entered by the owner. The API token is AES-GCM encrypted. */
export const realtimekitSettings = sqliteTable('realtimekit_settings', {
  id: integer('id').primaryKey().default(1),
  accountId: text('account_id').notNull(),
  appId: text('app_id').notNull(),
  apiTokenCiphertext: text('api_token_ciphertext').notNull(),
  apiTokenIv: text('api_token_iv').notNull(),
  apiTokenVersion: integer('api_token_version').notNull().default(1),
  hostPreset: text('host_preset').notNull(),
  participantPreset: text('participant_preset').notNull(),
  ...isoTimestamps(),
}, table => [
  check('realtimekit_settings_singleton_check', sql`${table.id} = 1`),
])

export const roles = sqliteTable('roles', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  permissionsBitmask: integer('permissions_bitmask').notNull(),
  resourceAccessJson: text('resource_access_json').notNull().default('{}'),
  position: integer('position').notNull().default(0),
  isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
  mentionable: integer('mentionable', { mode: 'boolean' }).notNull().default(false),
  ...isoTimestamps(),
})

/** Server participants. Humans map to Better Auth identities; agents do not log in. */
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['human', 'agent'] }).notNull().default('human'),
  handle: text('handle').unique(),
  displayName: text('display_name').notNull(),
  avatarR2Key: text('avatar_r2_key'),
  status: text('status', { enum: ['pending', 'active', 'removed'] }).notNull().default('pending'),
  roleId: text('role_id').references(() => roles.id),
  nickname: text('nickname'),
  joinedAt: text('joined_at'),
  ...isoTimestamps(),
}, table => [
  index('users_status_idx').on(table.status),
  index('users_kind_idx').on(table.kind),
  index('users_role_id_idx').on(table.roleId),
  check('users_kind_check', sql`${table.kind} in ('human', 'agent')`),
  check('users_status_check', sql`${table.status} in ('pending', 'active', 'removed')`),
  check('users_active_role_check', sql`${table.status} <> 'active' or (${table.roleId} is not null and ${table.joinedAt} is not null)`),
])

/** Stateful AI participant profile. Runtime memory lives in its Agent Durable Object. */
export const agents = sqliteTable('agents', {
  harness: text('harness', { enum: ['think', 'pi'] }).notNull().default('pi'),
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  model: text('model').notNull().default('@cf/moonshotai/kimi-k2.7-code'),
  instructions: text('instructions').notNull().default(''),
  status: text('status', { enum: ['active', 'paused'] }).notNull().default('active'),
  /** open: anyone who may use Agents invokes it; granted: only the Owner and holders of Agent access. */
  access: text('access', { enum: ['open', 'granted'] }).notNull().default('open'),
  createdBy: text('created_by').notNull().references(() => users.id),
  lastActiveAt: text('last_active_at'),
  /** Set when the Agent is deleted. The profile row stays for history. */
  archivedAt: text('archived_at'),
  archivedBy: text('archived_by'),
  ...isoTimestamps(),
}, table => [
  index('agents_status_idx').on(table.status),
  check('agents_status_check', sql`${table.status} in ('active', 'paused')`),
])

/** Server-visible state for active conversational turns. Think remains authoritative for execution. */
export const agentTurns = sqliteTable('agent_turns', {
  submissionId: text('submission_id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.userId, { onDelete: 'cascade' }),
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  sourceMessageId: text('source_message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  initiatedBy: text('initiated_by').notNull().references(() => users.id),
  requestId: text('request_id'),
  status: text('status', { enum: ['queued', 'thinking', 'tool', 'waiting_approval'] }).notNull().default('queued'),
  detail: text('detail'),
  draftMessageId: text('draft_message_id').references(() => messages.id, { onDelete: 'set null' }),
  approvalJson: text('approval_json'),
  ...isoTimestamps(),
}, table => [
  index('agent_turns_channel_agent_idx').on(table.channelId, table.agentId, table.createdAt),
  uniqueIndex('agent_turns_request_id_unique').on(table.requestId),
  check('agent_turns_status_check', sql`${table.status} in ('queued', 'thinking', 'tool', 'waiting_approval')`),
])

export const serverSchema = sqliteTable('server_schema', {
  id: integer('id').primaryKey().default(1),
  version: text('version').notNull(),
}, table => [check('server_schema_id_check', sql`${table.id} = 1`), check('server_schema_version_check', sql`${table.version} = 'server-v2'`)])

/** Private update journal; membership and Server content remain independent. */
export const serverUpdateControl = sqliteTable('server_update_control', {
  id: integer('id').primaryKey().notNull(),
  revision: integer('revision').notNull(),
  payload: text('payload').notNull(),
}, table => [check('server_update_control_singleton', sql`${table.id} = 1`)])

export const serverIdentity = sqliteTable('server_identity', {
  singleton: integer('singleton').notNull().unique(),
  id: text('id').primaryKey(),
}, table => [check('server_identity_singleton_check', sql`${table.singleton} = 1`), check('server_identity_uuid_check', sql`length(${table.id}) = 36 AND substr(${table.id},15,1) = '4' AND substr(${table.id},20,1) IN ('8','9','a','b')`)])

/** Small, typed Server settings that do not deserve a dedicated table. */
export const serverSettings = sqliteTable('server_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/** One pending owner claim. The setup token is stored only as a digest and removed on success. */
export const serverSetup = sqliteTable('server_setup', {
  singleton: integer('singleton').primaryKey(),
  email: text('email').notNull(),
  tokenHash: text('token_hash').notNull(),
  serverName: text('server_name').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [check('server_setup_singleton_check', sql`${table.singleton} = 1`)])

export const connectionGrants = sqliteTable('connection_grants', {
  codeHash: text('code_hash').primaryKey(), userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }), sessionId: text('session_id').notNull().references(() => authSessions.id, { onDelete: 'cascade' }), challenge: text('challenge').notNull(), redirectUri: text('redirect_uri').notNull(), expiresAt: integer('expires_at').notNull(),
})
export const accountRecovery = sqliteTable('account_recovery', {
  userId: text('user_id').primaryKey().references(() => authUsers.id, { onDelete: 'cascade' }), codeHash: text('code_hash').notNull().unique(), createdAt: integer('created_at').notNull(),
})

/** One independent Server; its permanent UUID also identifies its community. */
export const server = sqliteTable('server', {
  id: text('id').primaryKey().references(() => serverIdentity.id),
  singleton: integer('singleton').notNull().default(1),
  name: text('name').notNull(),
  iconR2Key: text('icon_r2_key'),
  ownerId: text('owner_id').notNull().references(() => users.id),
  ...isoTimestamps(),
}, table => [
  uniqueIndex('server_singleton_idx').on(table.singleton),
  check('server_singleton_check', sql`${table.singleton} = 1`),
])

/** Revocable MCP credentials. Only their SHA-256 digests are retained. */
export const mcpAccessTokens = sqliteTable('mcp_access_tokens', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull(),
  tokenPrefix: text('token_prefix').notNull(),
  scopesJson: text('scopes_json').notNull(),
  subjectId: text('subject_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdBy: text('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
  ...isoTimestamps(),
}, table => [
  uniqueIndex('mcp_access_tokens_hash_unique').on(table.tokenHash),
  index('mcp_access_tokens_subject_id_idx').on(table.subjectId),
  index('mcp_access_tokens_created_by_idx').on(table.createdBy),
  index('mcp_access_tokens_active_idx').on(table.revokedAt, table.createdAt),
])

/** Explicit human consent binds an OAuth connection to one acting Member. */
export const mcpOauthConnections = sqliteTable('mcp_oauth_connections', {
  id: text('id').primaryKey(),
  clientId: text('client_id').notNull().references(() => oauthClient.clientId, { onDelete: 'cascade' }),
  subjectId: text('subject_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdBy: text('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  resource: text('resource').notNull(),
  scopesJson: text('scopes_json').notNull(),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
}, table => [
  index('mcp_oauth_connections_created_by_idx').on(table.createdBy),
  index('mcp_oauth_connections_subject_id_idx').on(table.subjectId),
])

/** Owner-controlled anonymous project heartbeat. No server data is included. */
export const telemetrySettings = sqliteTable('telemetry_settings', {
  id: integer('id').primaryKey().default(1),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  updatedAt: text('updated_at').notNull(),
}, table => [
  check('telemetry_settings_singleton_check', sql`${table.id} = 1`),
])

/** Owner-configured S3-compatible destination for manual off-site backups. */
export const backupDestinations = sqliteTable('backup_destinations', {
  id: integer('id').primaryKey().default(1),
  endpoint: text('endpoint').notNull(),
  region: text('region').notNull().default('auto'),
  bucket: text('bucket').notNull(),
  prefix: text('prefix').notNull().default('llll'),
  accessKeyId: text('access_key_id').notNull(),
  secretAccessKeyCiphertext: text('secret_access_key_ciphertext').notNull(),
  secretAccessKeyIv: text('secret_access_key_iv').notNull(),
  secretAccessKeyVersion: integer('secret_access_key_version').notNull().default(1),
  lastBackupKey: text('last_backup_key'),
  lastBackupAt: text('last_backup_at'),
  lastBackupSizeBytes: integer('last_backup_size_bytes'),
  ...isoTimestamps(),
}, table => [
  check('backup_destinations_singleton_check', sql`${table.id} = 1`),
])

export const channelCategories = sqliteTable('channel_categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  ...isoTimestamps(),
}, table => [
  index('channel_categories_position_idx').on(table.position),
])

export const channels = sqliteTable('channels', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  topic: text('topic').notNull().default(''),
  type: text('type', { enum: ['text', 'thread', 'dm'] }).notNull(),
  visibility: text('visibility', { enum: ['server', 'private'] }).notNull().default('server'),
  categoryId: text('category_id').references(() => channelCategories.id, { onDelete: 'set null' }),
  position: integer('position').notNull().default(0),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  /** Legacy metadata retained for forward-compatible migration of existing conversations. */
  dmKind: text('dm_kind', { enum: ['pair', 'group'] }).notNull().default('pair'),
  dmOwnerId: text('dm_owner_id').references(() => users.id, { onDelete: 'set null' }),
  /** Ordered `low:high` participant IDs of a 1:1 DM; unique, so a pair never gets two DMs. */
  dmPairKey: text('dm_pair_key'),
  /** The active Live room's RealtimeKit meeting. */
  liveMeetingId: text('live_meeting_id'),
  /** Set on an archived root text channel: readable history, no new activity, hidden from Chat. */
  archivedAt: text('archived_at'),
  archivedBy: text('archived_by').references(() => users.id, { onDelete: 'set null' }),
  parentId: text('parent_id').references((): AnySQLiteColumn => channels.id, { onDelete: 'cascade' }),
  parentMessageId: text('parent_message_id').references((): AnySQLiteColumn => messages.id, { onDelete: 'cascade' }),
  ...isoTimestamps(),
}, table => [
  index('channels_position_idx').on(table.position),
  index('channels_type_idx').on(table.type),
  index('channels_category_id_idx').on(table.categoryId),
  index('channels_parent_id_idx').on(table.parentId),
  uniqueIndex('channels_thread_root_unique').on(table.parentMessageId).where(sql`${table.type} = 'thread'`),
  uniqueIndex('channels_dm_pair_key_unique').on(table.dmPairKey).where(sql`${table.dmPairKey} is not null`),
  check('channels_type_check', sql`${table.type} in ('text', 'thread', 'dm')`),
  check('channels_visibility_check', sql`${table.visibility} in ('server', 'private')`),
  check('channels_dm_private_check', sql`${table.type} <> 'dm' or ${table.visibility} = 'private'`),
  check('channels_thread_parent_check', sql`
    (${table.type} = 'thread' and ${table.parentId} is not null and ${table.parentMessageId} is not null)
    or (${table.type} <> 'thread' and ${table.parentId} is null and ${table.parentMessageId} is null)
  `),
])

/** Per-role send/attach/start-live denies for server channels. Allows are grants. Threads inherit their parent. */
export const channelRoleDenies = sqliteTable('channel_role_denies', {
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  roleId: text('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  denyMask: integer('deny_mask').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [
  primaryKey({ columns: [table.channelId, table.roleId] }),
  check('channel_role_denies_mask_check', sql`${table.denyMask} > 0 and (${table.denyMask} & ~${sql.raw(String(CHANNEL_PERMISSION_MASK))}) = 0`),
])

/** Access to private channels, including DMs. Threads inherit their parent. */
export const channelMembers = sqliteTable('channel_members', {
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  hiddenAt: text('hidden_at'),
  joinedAt: text('joined_at').notNull(),
}, table => [
  primaryKey({ columns: [table.channelId, table.userId] }),
  index('channel_members_user_id_idx').on(table.userId),
])

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  authorId: text('author_id').notNull().references(() => users.id),
  content: text('content').notNull(),
  replyToId: text('reply_to_id').references((): AnySQLiteColumn => messages.id, { onDelete: 'set null' }),
  editedAt: text('edited_at'),
  deletedAt: text('deleted_at'),
  createdAt: text('created_at').notNull(),
}, table => [
  index('messages_channel_created_idx').on(table.channelId, table.createdAt, table.id),
  index('messages_author_id_idx').on(table.authorId),
  index('messages_live_channel_id_idx').on(table.channelId, table.id).where(sql`${table.deletedAt} is null`),
])

export const channelReads = sqliteTable('channel_reads', {
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  lastReadMessageId: text('last_read_message_id').references(() => messages.id, { onDelete: 'set null' }),
  updatedAt: text('updated_at').notNull(),
}, table => [
  primaryKey({ columns: [table.channelId, table.userId] }),
  index('channel_reads_user_id_idx').on(table.userId),
])

export const invites = sqliteTable('invites', {
  code: text('code').primaryKey(),
  creatorId: text('creator_id').notNull().references(() => users.id),
  maxUses: integer('max_uses').notNull().default(0),
  uses: integer('uses').notNull().default(0),
  expiresAt: text('expires_at'),
  createdAt: text('created_at').notNull(),
}, table => [
  index('invites_creator_id_idx').on(table.creatorId),
  index('invites_expires_at_idx').on(table.expiresAt),
])

export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  messageId: text('message_id').references(() => messages.id, { onDelete: 'cascade' }),
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  uploaderId: text('uploader_id').notNull().references(() => users.id),
  r2Key: text('r2_key').notNull().unique(),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  width: integer('width'),
  height: integer('height'),
  createdAt: text('created_at').notNull(),
}, table => [
  index('attachments_message_id_idx').on(table.messageId),
  index('attachments_channel_id_idx').on(table.channelId),
  index('attachments_uploader_id_idx').on(table.uploaderId),
  check('attachments_size_check', sql`${table.sizeBytes} > 0`),
])

export const messageReactions = sqliteTable('message_reactions', {
  messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  emoji: text('emoji').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [
  primaryKey({ columns: [table.messageId, table.userId, table.emoji] }),
  index('message_reactions_user_id_idx').on(table.userId),
])

export const messagePins = sqliteTable('message_pins', {
  messageId: text('message_id').primaryKey().references(() => messages.id, { onDelete: 'cascade' }),
  pinnedBy: text('pinned_by').notNull().references(() => users.id),
  pinnedAt: text('pinned_at').notNull(),
}, table => [
  index('message_pins_pinned_by_idx').on(table.pinnedBy),
  index('message_pins_pinned_at_idx').on(table.pinnedAt),
])

export const messageMentions = sqliteTable('message_mentions', {
  messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** The Role this mention reached the Member through; null for a direct mention. */
  roleId: text('role_id'),
}, table => [
  primaryKey({ columns: [table.messageId, table.userId] }),
  index('message_mentions_user_id_idx').on(table.userId),
])

export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: text('user_agent'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  /** `telegram` targets go through the Shell's relay; endpoint is then `telegram:` plus a token digest. */
  transport: text('transport', { enum: ['webpush', 'telegram'] }).notNull().default('webpush'),
  relayOrigin: text('relay_origin'),
  relayToken: text('relay_token'),
}, table => [
  index('push_subscriptions_user_id_idx').on(table.userId),
  check('push_subscriptions_transport_check', sql`${table.transport} in ('webpush', 'telegram')`),
])

export const notificationOutbox = sqliteTable('notification_outbox', {
  eventId: text('event_id').notNull(),
  subscriptionId: text('subscription_id').notNull().references(() => pushSubscriptions.id, { onDelete: 'cascade' }),
  recipientId: text('recipient_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['mention', 'dm_message', 'live_started', 'mail'] }).notNull(),
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  payloadJson: text('payload_json').notNull(),
  attempts: integer('attempts').notNull().default(0),
  availableAt: text('available_at').notNull(),
  leaseToken: text('lease_token'),
  leaseUntil: text('lease_until'),
  deliveredAt: text('delivered_at'),
  failedAt: text('failed_at'),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
}, table => [
  primaryKey({ columns: [table.eventId, table.subscriptionId] }),
  index('notification_outbox_due_idx').on(table.availableAt).where(sql`${table.deliveredAt} is null and ${table.failedAt} is null`),
  check('notification_outbox_kind_check', sql`${table.kind} in ('mention', 'dm_message', 'live_started', 'mail')`),
])

/** Cloudflare-managed mail domains attached to this single-server server. */
export const emailDomains = sqliteTable('email_domains', {
  id: text('id').primaryKey(),
  zoneId: text('zone_id').notNull(),
  domain: text('domain').notNull(),
  appHostname: text('app_hostname').notNull(),
  ...isoTimestamps(),
}, table => [
  uniqueIndex('email_domains_domain_unique').on(table.domain),
])

/** A mailbox is a private channel. Its email conversation channels are ordinary threads. */
export const emailMailboxes = sqliteTable('email_mailboxes', {
  channelId: text('channel_id').primaryKey().references(() => channels.id, { onDelete: 'cascade' }),
  domainId: text('domain_id').notNull().references(() => emailDomains.id, { onDelete: 'cascade' }),
  localPart: text('local_part').notNull(),
  displayName: text('display_name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  ...isoTimestamps(),
}, table => [
  uniqueIndex('email_mailboxes_address_unique').on(table.domainId, table.localPart),
  check('email_mailboxes_local_part_check', sql`${table.localPart} = lower(${table.localPart}) and length(${table.localPart}) between 1 and 64`),
])

export const emailThreads = sqliteTable('email_threads', {
  channelId: text('channel_id').primaryKey().references(() => channels.id, { onDelete: 'cascade' }),
  mailboxChannelId: text('mailbox_channel_id').notNull().references(() => emailMailboxes.channelId, { onDelete: 'cascade' }),
  subject: text('subject').notNull(),
  status: text('status', { enum: ['inbox', 'archive', 'spam', 'trash'] }).notNull().default('inbox'),
  participantsJson: text('participants_json').notNull().default('[]'),
  lastMessageAt: text('last_message_at').notNull(),
  ...isoTimestamps(),
}, table => [
  index('email_threads_mailbox_status_latest_idx').on(table.mailboxChannelId, table.status, table.lastMessageAt),
  check('email_threads_status_check', sql`${table.status} in ('inbox', 'archive', 'spam', 'trash')`),
])

/** Protocol metadata extending a normal L4 message. Internal notes have no row here. */
export const emailMessages = sqliteTable('email_messages', {
  messageId: text('message_id').primaryKey().references(() => messages.id, { onDelete: 'cascade' }),
  threadChannelId: text('thread_channel_id').notNull().references(() => emailThreads.channelId, { onDelete: 'cascade' }),
  direction: text('direction', { enum: ['inbound', 'outbound'] }).notNull(),
  fromAddress: text('from_address').notNull(),
  fromName: text('from_name'),
  toJson: text('to_json').notNull().default('[]'),
  ccJson: text('cc_json').notNull().default('[]'),
  bccJson: text('bcc_json').notNull().default('[]'),
  rfcMessageId: text('rfc_message_id'),
  providerMessageId: text('provider_message_id'),
  deliveryStartedAt: text('delivery_started_at'),
  replyToJson: text('reply_to_json').notNull().default('[]'),
  inReplyTo: text('in_reply_to'),
  referencesJson: text('references_json').notNull().default('[]'),
  deliveryStatus: text('delivery_status', { enum: ['received', 'pending', 'sent', 'failed'] }).notNull().default('received'),
  rawR2Key: text('raw_r2_key'),
  createdAt: text('created_at').notNull(),
  /** The mailbox that received or sent it; Message-IDs are unique within a mailbox. */
  mailboxChannelId: text('mailbox_channel_id').references(() => emailMailboxes.channelId, { onDelete: 'cascade' }),
  /** Outbound sender request key, or the raw SHA-256 of an inbound message that has no RFC Message-ID. Unique within a mailbox, so a retry is not stored twice. */
  clientRequestId: text('client_request_id'),
  deliveryAttempts: integer('delivery_attempts').notNull().default(0),
  deliveryError: text('delivery_error'),
  deliveredAt: text('delivered_at'),
  /** `markdown` is sent as sanitized HTML with a text/plain alternative. */
  bodyFormat: text('body_format', { enum: ['text', 'markdown'] }).notNull().default('text'),
}, table => [
  uniqueIndex('email_messages_mailbox_rfc_message_id_unique').on(table.mailboxChannelId, table.rfcMessageId).where(sql`${table.rfcMessageId} is not null`),
  uniqueIndex('email_messages_mailbox_client_request_unique').on(table.mailboxChannelId, table.clientRequestId).where(sql`${table.clientRequestId} is not null`),
  index('email_messages_thread_created_idx').on(table.threadChannelId, table.createdAt),
  check('email_messages_direction_check', sql`${table.direction} in ('inbound', 'outbound')`),
  check('email_messages_delivery_status_check', sql`${table.deliveryStatus} in ('received', 'pending', 'sent', 'failed')`),
  check('email_messages_body_format_check', sql`${table.bodyFormat} in ('text', 'markdown')`),
])

/**
 * An email being written: private to its author in one mailbox, either a new
 * email or a reply in one conversation. Attachments are the author's unsent uploads.
 */
export const mailDrafts = sqliteTable('mail_drafts', {
  id: text('id').primaryKey(),
  mailboxChannelId: text('mailbox_channel_id').notNull().references(() => emailMailboxes.channelId, { onDelete: 'cascade' }),
  threadChannelId: text('thread_channel_id').references(() => emailThreads.channelId, { onDelete: 'cascade' }),
  authorId: text('author_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  toJson: text('to_json').notNull().default('[]'),
  ccJson: text('cc_json').notNull().default('[]'),
  bccJson: text('bcc_json').notNull().default('[]'),
  subject: text('subject').notNull().default(''),
  content: text('content').notNull().default(''),
  bodyFormat: text('body_format', { enum: ['text', 'markdown'] }).notNull().default('text'),
  attachmentIdsJson: text('attachment_ids_json').notNull().default('[]'),
  ...isoTimestamps(),
}, table => [
  index('mail_drafts_author_mailbox_idx').on(table.authorId, table.mailboxChannelId, table.updatedAt),
  uniqueIndex('mail_drafts_author_thread_unique').on(table.authorId, table.threadChannelId).where(sql`${table.threadChannelId} is not null`),
  check('mail_drafts_body_format_check', sql`${table.bodyFormat} in ('text', 'markdown')`),
])

/** Pending live-file deletion keys survive removal of their mailbox. */
export const fileDeletions = sqliteTable('file_deletions', {
  key: text('key').primaryKey(),
  scopeId: text('scope_id').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [index('file_deletions_scope_idx').on(table.scopeId)])

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  actorId: text('actor_id').notNull().references(() => users.id),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  metaJson: text('meta_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
}, table => [
  index('audit_log_created_at_idx').on(table.createdAt),
  index('audit_log_actor_id_idx').on(table.actorId),
])

/** User-created databases are logical collections inside the server D1. */
export const databaseDefinitions = sqliteTable('database_definitions', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  createdBy: text('created_by').notNull().references(() => users.id),
  archivedAt: text('archived_at'),
  ...isoTimestamps(),
}, table => [
  index('database_definitions_position_idx').on(table.position),
])

/** A field maps a human name and type onto one whitelisted database_items slot. */
export const databaseFields = sqliteTable('database_fields', {
  id: text('id').primaryKey(),
  databaseId: text('database_id').notNull().references(() => databaseDefinitions.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type', { enum: ['text', 'number', 'boolean', 'date', 'select'] }).notNull(),
  slot: text('slot').notNull(),
  configJson: text('config_json').notNull().default('{}'),
  position: integer('position').notNull().default(0),
  createdBy: text('created_by').notNull().references(() => users.id),
  ...isoTimestamps(),
}, table => [
  uniqueIndex('database_fields_name_unique').on(table.databaseId, table.name),
  uniqueIndex('database_fields_slot_unique').on(table.databaseId, table.type, table.slot),
  index('database_fields_position_idx').on(table.databaseId, table.position),
  check('database_fields_type_check', sql`${table.type} in ('text', 'number', 'boolean', 'date', 'select')`),
])

/** Scalar custom fields use bounded typed slots; semantic names stay in database_fields. */
export const databaseItems = sqliteTable('database_items', {
  id: text('id').primaryKey(),
  databaseId: text('database_id').notNull().references(() => databaseDefinitions.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  position: integer('position').notNull().default(0),
  version: integer('version').notNull().default(1),
  createdBy: text('created_by').notNull().references(() => users.id),
  text1: text('text_1'),
  text2: text('text_2'),
  text3: text('text_3'),
  text4: text('text_4'),
  text5: text('text_5'),
  text6: text('text_6'),
  text7: text('text_7'),
  text8: text('text_8'),
  text9: text('text_9'),
  text10: text('text_10'),
  text11: text('text_11'),
  text12: text('text_12'),
  text13: text('text_13'),
  text14: text('text_14'),
  text15: text('text_15'),
  text16: text('text_16'),
  number1: real('number_1'),
  number2: real('number_2'),
  number3: real('number_3'),
  number4: real('number_4'),
  number5: real('number_5'),
  number6: real('number_6'),
  number7: real('number_7'),
  number8: real('number_8'),
  boolean1: integer('boolean_1', { mode: 'boolean' }),
  boolean2: integer('boolean_2', { mode: 'boolean' }),
  boolean3: integer('boolean_3', { mode: 'boolean' }),
  boolean4: integer('boolean_4', { mode: 'boolean' }),
  boolean5: integer('boolean_5', { mode: 'boolean' }),
  boolean6: integer('boolean_6', { mode: 'boolean' }),
  boolean7: integer('boolean_7', { mode: 'boolean' }),
  boolean8: integer('boolean_8', { mode: 'boolean' }),
  date1: text('date_1'),
  date2: text('date_2'),
  date3: text('date_3'),
  date4: text('date_4'),
  date5: text('date_5'),
  date6: text('date_6'),
  date7: text('date_7'),
  date8: text('date_8'),
  select1: text('select_1'),
  select2: text('select_2'),
  select3: text('select_3'),
  select4: text('select_4'),
  select5: text('select_5'),
  select6: text('select_6'),
  select7: text('select_7'),
  select8: text('select_8'),
  ...isoTimestamps(),
}, table => [
  index('database_items_database_position_idx').on(table.databaseId, table.position),
  check('database_items_version_check', sql`${table.version} > 0`),
])

/** A shared, named lens over one Database. Config refers to semantic Field ids only. */
export const databaseViews = sqliteTable('database_views', {
  id: text('id').primaryKey(),
  databaseId: text('database_id').notNull().references(() => databaseDefinitions.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  layout: text('layout', { enum: ['table', 'board', 'calendar', 'list'] }).notNull().default('table'),
  configJson: text('config_json').notNull().default('{"visibleFieldIds":null,"filters":[],"sorts":[{"fieldId":"title","direction":"asc"}],"groupFieldId":null,"dateFieldId":null}'),
  position: integer('position').notNull().default(0),
  version: integer('version').notNull().default(1),
  createdBy: text('created_by').notNull().references(() => users.id),
  ...isoTimestamps(),
}, table => [
  uniqueIndex('database_views_name_unique').on(table.databaseId, table.name),
  index('database_views_database_position_idx').on(table.databaseId, table.position),
  check('database_views_layout_check', sql`${table.layout} in ('table', 'board', 'calendar', 'list')`),
  check('database_views_version_check', sql`${table.version} > 0`),
])

/** Rich-text documents are durable server data. */
export const documents = sqliteTable('documents', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  content: text('content').notNull().default(''),
  position: integer('position').notNull().default(0),
  version: integer('version').notNull().default(1),
  createdBy: text('created_by').notNull().references(() => users.id),
  ...isoTimestamps(),
}, table => [
  index('documents_position_idx').on(table.position),
  check('documents_version_check', sql`${table.version} > 0`),
])

export const canvases = sqliteTable('canvases', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  position: integer('position').notNull().default(0),
  version: integer('version').notNull().default(1),
  createdBy: text('created_by').notNull().references(() => users.id),
  ...isoTimestamps(),
}, table => [
  index('canvases_position_idx').on(table.position),
  check('canvases_version_check', sql`${table.version} > 0`),
])

export const canvasNodes = sqliteTable('canvas_nodes', {
  id: text('id').primaryKey(),
  canvasId: text('canvas_id').notNull().references(() => canvases.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['note', 'text'] }).notNull().default('note'),
  content: text('content').notNull().default(''),
  x: real('x').notNull().default(0),
  y: real('y').notNull().default(0),
  width: real('width').notNull().default(240),
  height: real('height').notNull().default(144),
  color: text('color', { enum: ['neutral', 'orange', 'blue', 'green', 'red'] }).notNull().default('neutral'),
  version: integer('version').notNull().default(1),
  createdBy: text('created_by').notNull().references(() => users.id),
  ...isoTimestamps(),
}, table => [
  index('canvas_nodes_canvas_idx').on(table.canvasId, table.createdAt),
  check('canvas_nodes_kind_check', sql`${table.kind} in ('note', 'text')`),
  check('canvas_nodes_color_check', sql`${table.color} in ('neutral', 'orange', 'blue', 'green', 'red')`),
  check('canvas_nodes_version_check', sql`${table.version} > 0`),
])

export const canvasEdges = sqliteTable('canvas_edges', {
  id: text('id').primaryKey(),
  canvasId: text('canvas_id').notNull().references(() => canvases.id, { onDelete: 'cascade' }),
  fromNodeId: text('from_node_id').notNull().references(() => canvasNodes.id, { onDelete: 'cascade' }),
  toNodeId: text('to_node_id').notNull().references(() => canvasNodes.id, { onDelete: 'cascade' }),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, table => [
  uniqueIndex('canvas_edges_nodes_unique').on(table.canvasId, table.fromNodeId, table.toNodeId),
  index('canvas_edges_canvas_idx').on(table.canvasId, table.createdAt),
  check('canvas_edges_not_self_check', sql`${table.fromNodeId} <> ${table.toNodeId}`),
])

/** Private, cross-device shortcuts. Target existence is checked at the API boundary. */
export const dataBookmarks = sqliteTable('data_bookmarks', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  targetType: text('target_type', { enum: ['database_view', 'document', 'canvas'] }).notNull(),
  targetId: text('target_id').notNull(),
  position: integer('position').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, table => [
  primaryKey({ columns: [table.userId, table.targetType, table.targetId] }),
  index('data_bookmarks_user_position_idx').on(table.userId, table.position, table.createdAt),
  check('data_bookmarks_target_type_check', sql`${table.targetType} in ('database_view', 'document', 'canvas')`),
])

/** Declarative internal tools. Drafts are mutable; published versions are immutable snapshots. */
export const gadgets = sqliteTable('gadgets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  draftSpecJson: text('draft_spec_json').notNull(),
  draftRevision: integer('draft_revision').notNull().default(1),
  publishedVersion: integer('published_version'),
  position: integer('position').notNull().default(0),
  createdBy: text('created_by').notNull().references(() => users.id),
  ...isoTimestamps(),
}, table => [
  index('gadgets_position_idx').on(table.position, table.createdAt),
  check('gadgets_draft_revision_check', sql`${table.draftRevision} > 0`),
  check('gadgets_published_version_check', sql`${table.publishedVersion} is null or ${table.publishedVersion} > 0`),
])

export const gadgetVersions = sqliteTable('gadget_versions', {
  id: text('id').primaryKey(),
  gadgetId: text('gadget_id').notNull().references(() => gadgets.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  specJson: text('spec_json').notNull(),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: text('created_at').notNull(),
}, table => [
  uniqueIndex('gadget_versions_number_unique').on(table.gadgetId, table.version),
  check('gadget_versions_version_check', sql`${table.version} > 0`),
])

/** Task boards are shared product state, so they live in D1 rather than an Agent DO. */
export const taskBoards = sqliteTable('task_boards', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  createdBy: text('created_by').notNull().references(() => users.id),
  archivedAt: text('archived_at'),
  ...isoTimestamps(),
}, table => [
  index('task_boards_position_idx').on(table.position),
])

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(), name: text('name').notNull(), description: text('description').notNull().default(''),
  archivedAt: text('archived_at'), version: integer('version').notNull().default(1),
  createdBy: text('created_by').notNull().references(() => users.id), ...isoTimestamps(),
})
export const projectRepositories = sqliteTable('project_repositories', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(), host: text('host').notNull(), externalId: text('external_id').notNull(),
  slug: text('slug').notNull(), defaultBranch: text('default_branch').notNull(), environmentId: text('environment_id').unique(),
  createdBy: text('created_by').notNull().references(() => users.id), createdAt: text('created_at').notNull(),
}, table => [uniqueIndex('project_repository_identity').on(table.projectId, table.provider, table.host, table.externalId)])

export const projectPolicies = sqliteTable('project_policies', {
  id: text('id').primaryKey(), name: text('name').notNull().unique(), description: text('description').notNull().default(''),
  permissionsBitmask: integer('permissions_bitmask').notNull(), version: integer('version').notNull().default(1),
  createdBy: text('created_by').references(() => users.id), ...isoTimestamps(),
})
/**
 * Scoped access: one Member or Role gets a Policy (a Project, or Agent access through one Agent)
 * or a set of permissions on one resource: a channel, mailbox, App draft or version, or MCP connection.
 */
export const grants = sqliteTable('grants', {
  id: text('id').primaryKey(),
  memberId: text('member_id').references(() => users.id, { onDelete: 'cascade' }), roleId: text('role_id').references(() => roles.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').references(() => agents.userId, { onDelete: 'cascade' }),
  policyId: text('policy_id').references(() => projectPolicies.id, { onDelete: 'cascade' }),
  permissions: integer('permissions'),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  channelId: text('channel_id').references(() => channels.id, { onDelete: 'cascade' }),
  mailboxId: text('mailbox_id').references(() => emailMailboxes.channelId, { onDelete: 'cascade' }),
  gadgetId: text('gadget_id').references(() => gadgets.id, { onDelete: 'cascade' }),
  gadgetVersionId: text('gadget_version_id').references(() => gadgetVersions.id, { onDelete: 'cascade' }),
  connectionId: text('connection_id').references(() => mcpOutboundConnections.id, { onDelete: 'cascade' }),
  dailyRuns: integer('daily_runs'), expiresAt: text('expires_at'),
  createdBy: text('created_by').references(() => users.id), createdAt: text('created_at').notNull(),
}, table => [
  check('grants_subject', sql`(${table.memberId} IS NOT NULL AND ${table.roleId} IS NULL) OR (${table.roleId} IS NOT NULL AND ${table.memberId} IS NULL)`),
  check('grants_content', sql`(${table.policyId} IS NULL) <> (${table.permissions} IS NULL)`),
  check('grants_permissions', sql`${table.permissions} IS NULL OR ${table.permissions} > 0`),
  check('grants_daily_runs', sql`${table.dailyRuns} IS NULL OR ${table.dailyRuns} BETWEEN 1 AND 10000`),
  // One scope at most. None means the whole Server, which only Agent access may use.
  check('grants_one_scope', sql`(${table.projectId} IS NOT NULL) + (${table.channelId} IS NOT NULL) + (${table.mailboxId} IS NOT NULL) + (${table.gadgetId} IS NOT NULL) + (${table.gadgetVersionId} IS NOT NULL) + (${table.connectionId} IS NOT NULL) <= 1`),
  check('grants_scope', sql`${table.agentId} IS NOT NULL OR ${table.projectId} IS NOT NULL OR ${table.channelId} IS NOT NULL OR ${table.mailboxId} IS NOT NULL OR ${table.gadgetId} IS NOT NULL OR ${table.gadgetVersionId} IS NOT NULL OR ${table.connectionId} IS NOT NULL`),
  check('grants_agent_limits', sql`${table.agentId} IS NOT NULL OR (${table.dailyRuns} IS NULL AND ${table.expiresAt} IS NULL)`),
  // Policies apply to Projects and Agent access; resource grants carry their own permissions.
  check('grants_policy_scope', sql`(${table.policyId} IS NOT NULL) = (${table.channelId} IS NULL AND ${table.mailboxId} IS NULL AND ${table.gadgetId} IS NULL AND ${table.gadgetVersionId} IS NULL AND ${table.connectionId} IS NULL)`),
  // Channel: a Role may send, attach files or start Live (sendMessages, attachFiles, startLive).
  check('grants_channel', sql`${table.channelId} IS NULL OR (${table.roleId} IS NOT NULL AND (${table.permissions} & ~112) = 0)`),
  // Mailbox: a Member reads (readMail), sends (+ sendMail) or manages it (+ manageChannels).
  check('grants_mailbox', sql`${table.mailboxId} IS NULL OR (${table.memberId} IS NOT NULL AND ${table.permissions} IN (536870912, 1610612736, 1610612738))`),
  // Apps: a Role may use a draft or a published version (useGadgets).
  check('grants_gadget', sql`(${table.gadgetId} IS NULL AND ${table.gadgetVersionId} IS NULL) OR (${table.roleId} IS NOT NULL AND ${table.permissions} = 1024)`),
  // MCP connection: a Member, Agent or Role may use it (useExternalTools).
  check('grants_connection', sql`${table.connectionId} IS NULL OR ${table.permissions} = 33554432`),
  uniqueIndex('grants_member_identity').on(table.memberId, sql`coalesce(${table.agentId},'')`, sql`coalesce(${table.projectId},'')`, table.policyId).where(sql`${table.memberId} IS NOT NULL AND ${table.policyId} IS NOT NULL`),
  uniqueIndex('grants_role_identity').on(table.roleId, sql`coalesce(${table.agentId},'')`, sql`coalesce(${table.projectId},'')`, table.policyId).where(sql`${table.roleId} IS NOT NULL AND ${table.policyId} IS NOT NULL`),
  uniqueIndex('grants_channel_identity').on(table.channelId, table.roleId).where(sql`${table.channelId} IS NOT NULL`),
  uniqueIndex('grants_mailbox_identity').on(table.mailboxId, table.memberId).where(sql`${table.mailboxId} IS NOT NULL`),
  uniqueIndex('grants_gadget_identity').on(table.gadgetId, table.roleId).where(sql`${table.gadgetId} IS NOT NULL`),
  uniqueIndex('grants_gadget_version_identity').on(table.gadgetVersionId, table.roleId).where(sql`${table.gadgetVersionId} IS NOT NULL`),
  uniqueIndex('grants_connection_identity').on(table.connectionId, sql`coalesce(${table.memberId},'')`, sql`coalesce(${table.roleId},'')`).where(sql`${table.connectionId} IS NOT NULL`),
  index('grants_member').on(table.memberId, table.agentId, table.projectId),
  index('grants_role').on(table.roleId, table.agentId, table.projectId),
  index('grants_project').on(table.projectId),
  index('grants_member_mailbox').on(table.memberId, table.mailboxId).where(sql`${table.mailboxId} IS NOT NULL`),
])

export const tasks = sqliteTable('tasks', {
  projectId: text('project_id').references(() => projects.id),
  id: text('id').primaryKey(),
  boardId: text('board_id').notNull().references(() => taskBoards.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  status: text('status', { enum: ['backlog', 'ready', 'review', 'done', 'failed'] }).notNull().default('backlog'),
  priority: text('priority', { enum: ['low', 'normal', 'high', 'urgent'] }).notNull().default('normal'),
  dueAt: text('due_at'),
  position: integer('position').notNull().default(0),
  /** The member responsible for the task, human or agent. */
  assigneeId: text('assignee_id').references(() => users.id, { onDelete: 'set null' }),
  environmentId: text('environment_id'),
  channelId: text('channel_id').references(() => channels.id, { onDelete: 'set null' }),
  /** Hidden channel holding the task's discussion, created on first use. */
  discussionChannelId: text('discussion_channel_id').references(() => channels.id, { onDelete: 'set null' }),
  createdBy: text('created_by').notNull().references(() => users.id),
  resultSummary: text('result_summary'),
  resultDetails: text('result_details'),
  lastError: text('last_error'),
  archivedAt: text('archived_at'),
  /** The chat message this task was created from. No foreign key: the task outlives the message. */
  sourceChannelId: text('source_channel_id'),
  sourceMessageId: text('source_message_id'),
  /** The pull request the task's agent published, and the latest preview found for it. */
  pullUrl: text('pull_url'),
  previewUrl: text('preview_url'),
  ...isoTimestamps(),
}, table => [
  index('tasks_board_status_position_idx').on(table.boardId, table.status, table.position),
  index('tasks_assignee_id_idx').on(table.assigneeId),
  index('tasks_source_message_idx').on(table.sourceChannelId, table.sourceMessageId).where(sql`${table.sourceMessageId} IS NOT NULL`),
  uniqueIndex('tasks_discussion_channel_unique').on(table.discussionChannelId).where(sql`${table.discussionChannelId} is not null`),
  check('tasks_status_check', sql`${table.status} in ('backlog', 'ready', 'review', 'done', 'failed')`),
  check('tasks_priority_check', sql`${table.priority} in ('low', 'normal', 'high', 'urgent')`),
])

/** Human-readable task numbers are database-assigned while UUIDs remain stable internal keys. */
export const taskNumbers = sqliteTable('task_numbers', {
  taskId: text('task_id').primaryKey().references(() => tasks.id, { onDelete: 'cascade' }),
  number: integer('number').notNull().unique(),
})

export const taskNumberSequence = sqliteTable('task_number_sequence', {
  id: integer('id').primaryKey(),
  nextNumber: integer('next_number').notNull(),
}, table => [
  check('task_number_sequence_singleton_check', sql`${table.id} = 1`),
  check('task_number_sequence_next_check', sql`${table.nextNumber} > 0`),
])

export const taskLabels = sqliteTable('task_labels', {
  id: text('id').primaryKey(),
  boardId: text('board_id').notNull().references(() => taskBoards.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').notNull().default('neutral'),
  position: integer('position').notNull().default(0),
  createdBy: text('created_by').notNull().references(() => users.id),
  ...isoTimestamps(),
}, table => [
  uniqueIndex('task_labels_board_name_unique').on(table.boardId, table.name),
  index('task_labels_board_position_idx').on(table.boardId, table.position),
])

export const taskLabelLinks = sqliteTable('task_label_links', {
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  labelId: text('label_id').notNull().references(() => taskLabels.id, { onDelete: 'cascade' }),
}, table => [
  primaryKey({ columns: [table.taskId, table.labelId] }),
  index('task_label_links_label_idx').on(table.labelId),
])

export const taskDependencies = sqliteTable('task_dependencies', {
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  dependsOnTaskId: text('depends_on_task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
}, table => [
  primaryKey({ columns: [table.taskId, table.dependsOnTaskId] }),
  index('task_dependencies_depends_on_idx').on(table.dependsOnTaskId),
  check('task_dependencies_not_self_check', sql`${table.taskId} <> ${table.dependsOnTaskId}`),
])

export const taskChecklistItems = sqliteTable('task_checklist_items', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  position: integer('position').notNull().default(0),
  createdBy: text('created_by').notNull().references(() => users.id),
  ...isoTimestamps(),
}, table => [
  index('task_checklist_items_task_position_idx').on(table.taskId, table.position),
])

export const taskAttachments = sqliteTable('task_attachments', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  uploaderId: text('uploader_id').notNull().references(() => users.id),
  r2Key: text('r2_key').notNull().unique(),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  width: integer('width'),
  height: integer('height'),
  createdAt: text('created_at').notNull(),
}, table => [
  index('task_attachments_task_created_idx').on(table.taskId, table.createdAt),
  check('task_attachments_size_check', sql`${table.sizeBytes} > 0`),
])

export const mcpOutboundConnections = sqliteTable('mcp_outbound_connections', {
  id: text('id').primaryKey(),
  serverId: text('server_id').notNull().references(() => server.id, { onDelete: 'cascade' }),
  ownerId: text('owner_id').references(() => users.id, { onDelete: 'cascade' }),
  createdBy: text('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), providerId: text('provider_id').notNull(),
  enabled: integer('enabled').notNull().default(0), revision: integer('revision').notNull().default(1),
  grantsJson: text('grants_json').notNull(), toolNamesJson: text('tool_names_json').notNull(), toolsJson: text('tools_json').notNull().default('[]'),
  credentialJson: text('credential_json'), credentialExpiresAt: text('credential_expires_at'),
  checkedAt: text('checked_at'), lastError: text('last_error'), ...isoTimestamps(),
}, table => [index('mcp_outbound_server_owner').on(table.serverId, table.ownerId), check('mcp_outbound_enabled', sql`${table.enabled} IN (0,1)`)])

export const schema = {
  projectPolicies,
  grants,
  mcpOutboundConnections,
  fileDeletions,
  mailDrafts,
  serverSchema,
  serverUpdateControl,
  serverIdentity,
  serverSettings,
  serverSetup,
  connectionGrants,
  accountRecovery,
  authUsers,
  authSessions,
  authAccounts,
  authVerifications,
  oauthClient,
  oauthResource,
  oauthClientResource,
  oauthRefreshToken,
  oauthAccessToken,
  oauthConsent,
  oauthClientAssertion,
  authSettings,
  authProviderCredentials,
  onboardingRevisions,
  onboardingAcceptances,
  users,
  agents,
  agentTurns,
  server,
  mcpAccessTokens,
  mcpOauthConnections,
  roles,
  channelCategories,
  channels,
  channelRoleDenies,
  channelMembers,
  messages,
  channelReads,
  invites,
  attachments,
  messageReactions,
  messagePins,
  messageMentions,
  pushSubscriptions,
  notificationOutbox,
  emailDomains,
  emailMailboxes,
  emailThreads,
  emailMessages,
  auditLog,
  databaseDefinitions,
  databaseFields,
  databaseItems,
  databaseViews,
  documents,
  canvases,
  canvasNodes,
  canvasEdges,
  dataBookmarks,
  taskBoards,
  projects,
  projectRepositories,
  tasks,
  taskNumbers,
  taskNumberSequence,
  taskLabels,
  taskLabelLinks,
  taskDependencies,
  taskChecklistItems,
  taskAttachments,
}
