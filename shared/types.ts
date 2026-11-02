import type { JSONContent } from '@tiptap/core'
import type { DatabaseFieldType, DatabaseValue, DatabaseViewConfig, DatabaseViewLayout } from './database'

export type PresenceStatus = 'online' | 'idle' | 'offline'
export type UserStatus = 'pending' | 'active' | 'removed'
export type UserKind = 'human' | 'agent'
export type ChannelType = 'text' | 'thread' | 'dm'
export type ChannelVisibility = 'server' | 'private'

export type PublicUser = {
  id: string
  kind: UserKind
  displayName: string
  avatarR2Key: string | null
}

export type PrivateChannelMemberDTO = {
  user: PublicUser
  status: UserStatus
}

export type AgentDTO = {
  /** Older Server responses may omit this field. */
  roleId?: string | null
  harness?: 'think' | 'pi'
  id: string
  displayName: string
  avatarR2Key: string | null
  model: string
  instructions: string
  status: 'active' | 'paused'
  lastActiveAt: string | null
  createdAt: string
  updatedAt: string
}

export type TaskAgentDTO = Pick<AgentDTO, 'id' | 'displayName' | 'avatarR2Key' | 'status'>

export type AgentApprovalDTO = {
  executionId: string
  action: string
  summary: string
  input: unknown
  risk?: 'low' | 'medium' | 'high'
}

export type AgentTurnDTO = {
  submissionId: string
  agentId: string
  channelId: string
  sourceMessageId: string
  initiatedBy: string
  status: 'queued' | 'thinking' | 'tool' | 'waiting_approval'
  detail: string | null
  draftMessageId: string | null
  approval: AgentApprovalDTO | null
  createdAt: string
  updatedAt: string
}

export type TaskStatus = 'backlog' | 'ready' | 'review' | 'done' | 'failed'
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'

export type TaskLabelDTO = {
  id: string
  boardId: string
  name: string
  color: string
  position: number
  createdAt: string
  updatedAt: string
}

export type TaskChecklistItemDTO = {
  id: string
  taskId: string
  title: string
  completed: boolean
  position: number
  createdBy: string
  createdAt: string
  updatedAt: string
}

export type TaskAttachmentDTO = AttachmentDTO & {
  taskId: string
  uploaderId: string
  createdAt: string
}

export type TaskDTO = {
  projectId?: string | null
  id: string
  number: number
  boardId: string
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  dueAt: string | null
  position: number
  /** The responsible member, human or agent. */
  assigneeId: string | null
  channelId: string | null
  environmentId?: string | null
  /** Hidden channel for the task's discussion; null until someone opens it. */
  discussionChannelId: string | null
  createdBy: string
  factoryState?: string | null
  resultSummary: string | null
  resultDetails: string | null
  lastError: string | null
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  labels: TaskLabelDTO[]
  checklistTotal: number
  checklistCompleted: number
  dependencyIds: string[]
  attachmentCount: number
}

export type TaskDetailDTO = TaskDTO & {
  checklist: TaskChecklistItemDTO[]
  attachments: TaskAttachmentDTO[]
  /** The chat message the task was created from, as this viewer may see it. */
  source?: TaskSourceDTO | null
}

/**
 * `restricted`: the viewer cannot read the source conversation and sees nothing about it.
 * `deleted`: the message is gone; the conversation is still linked.
 */
export type TaskSourceDTO =
  | { state: 'available'; channelName: string; path: string; authorName: string | null; excerpt: string }
  | { state: 'deleted'; channelName: string; path: string }
  | { state: 'restricted' }

/** A task created from a message in the conversation being viewed. */
export type TaskSourceLinkDTO = {
  taskId: string; number: number; title: string; messageId: string
  status: TaskStatus
  /** An agent Run for this Task is queued or running. */
  working: boolean
  pullUrl: string | null
  previewUrl: string | null
}

/** A Task form prefilled from a chat message. */
export type TaskMessageDraftDTO = { messageId: string; channelName: string; authorName: string | null; title: string; description: string }

export type TaskBoardDTO = {
  id: string
  name: string
  position: number
  createdBy: string
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  labels: TaskLabelDTO[]
  tasks: TaskDTO[]
}

export type DatabaseFieldDTO = {
  id: string
  databaseId: string
  name: string
  type: DatabaseFieldType
  options: string[]
  /** The database a relation field points at; null for every other type. */
  relation: { databaseId: string } | null
  position: number
  createdAt: string
  updatedAt: string
}

/** What a relation value shows: the linked record's title and where it lives. */
export type LinkedRecordDTO = {
  id: string
  databaseId: string
  title: string
}

export type DatabaseItemDTO = {
  id: string
  databaseId: string
  title: string
  position: number
  version: number
  createdBy: string
  createdAt: string
  updatedAt: string
  values: Record<string, DatabaseValue>
}

export type DatabaseDTO = {
  id: string
  name: string
  position: number
  createdBy: string
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  fields: DatabaseFieldDTO[]
  items: DatabaseItemDTO[]
}

export type DatabaseViewDTO = {
  id: string
  databaseId: string
  name: string
  layout: DatabaseViewLayout
  config: DatabaseViewConfig
  position: number
  version: number
  createdBy: string
  createdAt: string
  updatedAt: string
}

export type DatabaseViewSummaryDTO = Pick<DatabaseViewDTO, 'id' | 'databaseId' | 'name' | 'layout' | 'position'>

export type DatabasePageDTO = {
  database: Omit<DatabaseDTO, 'items'>
  views: DatabaseViewDTO[]
  view: DatabaseViewDTO
  items: DatabaseItemDTO[]
  total: number
  page: number
  pageSize: number
  /** Total records per board group. The empty key represents records without a value. */
  groupCounts?: Record<string, number>
  /** Every record the loaded records' relation fields point at, by id. */
  linked: Record<string, LinkedRecordDTO>
}

export type DocumentDTO = {
  id: string
  title: string
  content: string
  position: number
  version: number
  createdBy: string
  createdAt: string
  updatedAt: string
}

export type DocumentSummaryDTO = Omit<DocumentDTO, 'content'>

export type CanvasNodeKind = 'note' | 'text'
export type CanvasNodeColor = 'neutral' | 'orange' | 'blue' | 'green' | 'red'

export type CanvasNodeDTO = {
  id: string
  canvasId: string
  kind: CanvasNodeKind
  content: string
  x: number
  y: number
  width: number
  height: number
  color: CanvasNodeColor
  version: number
  createdBy: string
  createdAt: string
  updatedAt: string
}

export type CanvasEdgeDTO = {
  id: string
  canvasId: string
  fromNodeId: string
  toNodeId: string
  createdBy: string
  createdAt: string
}

export type CanvasDTO = {
  id: string
  title: string
  position: number
  version: number
  createdBy: string
  createdAt: string
  updatedAt: string
  nodes: CanvasNodeDTO[]
  edges: CanvasEdgeDTO[]
}

export type CanvasSummaryDTO = Omit<CanvasDTO, 'nodes' | 'edges'> & {
  nodeCount: number
}

export type DatabaseSummaryDTO = Pick<DatabaseDTO, 'id' | 'name' | 'archivedAt'> & {
  itemCount: number
  views: DatabaseViewSummaryDTO[]
}

export type DataBookmarkTargetType = 'database_view' | 'document' | 'canvas'

export type DataBookmarkDTO = {
  targetType: DataBookmarkTargetType
  targetId: string
  position: number
  createdAt: string
}

export type DataResourcesDTO = {
  databases: DatabaseSummaryDTO[]
  documents: DocumentSummaryDTO[]
  canvases: CanvasSummaryDTO[]
  bookmarks: DataBookmarkDTO[]
}

export type MailboxPermission = 'read' | 'send' | 'manage'
export type MailThreadStatus = 'inbox' | 'archive' | 'spam' | 'trash'

export type MailboxDTO = {
  channelId: string
  address: string
  displayName: string
  enabled: boolean
  permission: MailboxPermission
  unreadCount: number
  /** Whether outbound email can carry attachments: the Server has file storage. */
  attachments?: boolean
}

export type MailThreadDTO = {
  channelId: string
  mailboxChannelId: string
  subject: string
  status: MailThreadStatus
  participants: string[]
  preview: string
  lastMessageAt: string
  unread: boolean
}

export type MailMessageDTO = MessageDTO & {
  email: null | {
    direction: 'inbound' | 'outbound'
    fromAddress: string
    fromName: string | null
    to: string[]
    cc: string[]
    bcc: string[]
    replyTo?: string[]
    deliveryStatus: 'received' | 'pending' | 'sent' | 'failed'
    /** Why the last delivery attempt failed, when it did. */
    deliveryError: string | null
    deliveryUncertain?: boolean
    /** `markdown` was sent as HTML; `content` is its text alternative. */
    format?: 'text' | 'markdown'
  }
}

/** An email being written, visible only to its author. A reply draft has a `threadId`. */
export type MailDraftDTO = {
  id: string
  mailboxChannelId: string
  threadId: string | null
  /** The conversation's subject, for a reply draft. */
  threadSubject: string | null
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  content: string
  format: 'text' | 'markdown'
  attachments: AttachmentDTO[]
  updatedAt: string
}

export type MailThreadPageDTO = {
  threads: MailThreadDTO[]
  /** Pass as `before` to load older conversations; null when there are none. */
  nextCursor: string | null
}

export type MailSettingsDTO = {
  configured: boolean
  domains: Array<{
    id: string
    domain: string
    appHostname: string
  }>
  sendingBound: boolean
  mailboxes: Array<MailboxDTO & { domainId: string, conversationCount: number, access: Array<{ userId: string; permission: MailboxPermission }> }>
}

export type SessionUser = PublicUser & {
  email: string | null
  status: UserStatus
  onboardingRequired: boolean
}

export type RegistrationMode = 'open' | 'invite_only'
export type AuthMode = 'builtin' | 'access'
export type AuthLoginMethod = 'email' | 'github' | 'google' | 'twitter' | 'telegram' | 'linkedin'
export type AuthCredentialProvider = Exclude<AuthLoginMethod, 'email'> | 'turnstile'

export type PublicAuthConfig = {
  mode: AuthMode
  registrationMode: RegistrationMode
  signupEnabled: boolean
  emailSignupEnabled: boolean
  passwordResetEnabled: boolean
  methods: Record<AuthLoginMethod, boolean>
  turnstile: { enabled: boolean; siteKey: string | null }
}

export type RichTextDocument = JSONContent & {
  type: 'doc'
}

export type PublicOnboardingConfig = {
  revisionId: string | null
  version: number
  privacy: RichTextDocument | null
  terms: RichTextDocument | null
  rules: RichTextDocument | null
  acceptanceRequired: boolean
  publishedAt: string | null
}

export type AuthProviderAdminDTO = {
  provider: AuthCredentialProvider
  enabled: boolean
  configured: boolean
  effective: boolean
  source: 'deployment' | 'database' | 'missing'
  publicKey: string | null
  secretReadable: boolean
}

export type AuthSettingsAdminDTO = PublicAuthConfig & {
  email: {
    enabled: boolean
    binding: boolean
    sender: string | null
    senderName: string | null
    verificationReady: boolean
    senderManagedByDeployment: boolean
  }
  providers: Record<AuthCredentialProvider, AuthProviderAdminDTO>
}

export type RealtimeKitSettingsAdminDTO = {
  configured: boolean
  source: 'deployment' | 'database' | 'missing'
  accountId: string | null
  appId: string | null
  apiTokenConfigured: boolean
  secretReadable: boolean
  hostPreset: string
  participantPreset: string
  /** Settings saved before hosts and participants had separate presets; reconnecting splits them. */
  sharedPreset: boolean
  /** Live uses the Server's kept Cloudflare access rather than a pasted token. */
  serverAccess?: boolean
}

export type AttachmentDTO = {
  id: string
  filename: string
  contentType: string
  sizeBytes: number
  width: number | null
  height: number | null
  url: string
}

export type ReactionDTO = {
  emoji: string
  count: number
  me: boolean
}

export type MessagePinDTO = {
  pinnedBy: PublicUser
  pinnedAt: string
}

export type ReplyPreviewDTO = {
  id: string
  authorId: string
  content: string
  attachmentCount: number
  deleted: boolean
}

export type MessageDTO = {
  id: string
  channelId: string
  serverId: string
  author: PublicUser
  content: string
  replyTo: ReplyPreviewDTO | null
  /** Members mentioned directly. */
  mentions: string[]
  /** Roles whose mention reached at least one Member. */
  roleMentions?: string[]
  attachments: AttachmentDTO[]
  reactions: ReactionDTO[]
  pin: MessagePinDTO | null
  threadId: string | null
  editedAt: string | null
  deletedAt: string | null
  createdAt: string
  clientId?: string
  deliveryState?: 'uploading' | 'sending' | 'failed'
}

export type MessageSearchChannelDTO = {
  id: string
  name: string
  type: ChannelType
  parentId: string | null
  parentMessageId: string | null
  /** The channel name or DM title; for a thread, its parent conversation's. */
  title: string
  /** App path of the conversation or thread holding the hit. */
  path: string
  /** The hit's channel (or a Thread's parent) is archived: still readable, closed to new activity. */
  archived?: boolean
}

export type MessageSearchHitDTO = {
  id: string
  channel: MessageSearchChannelDTO
  author: PublicUser
  content: string
  editedAt: string | null
  createdAt: string
}

export type MessageSearchResponse = {
  hits: MessageSearchHitDTO[]
  nextCursor: string | null
}

export type MessageContextResponse = {
  messages: MessageDTO[]
  targetId: string
  targetIndex: number
  hasOlder: boolean
  hasNewer: boolean
}

export type LiveKind = 'call' | 'live'

/**
 * The Live room of one Channel or Direct Message. A 1:1 Direct Message presents
 * it as a `call`; every other conversation as `live`.
 */
export type LiveState = {
  active: boolean
  meetingId: string | null
  participantIds: string[]
  startedBy: string | null
  startedAt: string | null
  kind: LiveKind
  /** A Call the other person has not answered or declined yet. */
  ringing: boolean
}

export type ServerDTO = {
  id: string
  name: string
  iconR2Key: string | null
  ownerId: string
  createdAt: string
  updatedAt: string
}

export type ChannelCategoryDTO = {
  id: string
  name: string
  position: number
  createdAt: string
}

export type ChannelRoleOverrideDTO = {
  channelId: string
  roleId: string
  allow: number
  deny: number
}

export type RightPanelTab = 'members' | 'threads' | 'pins' | 'files'

export type ChannelThreadDTO = {
  id: string
  parentMessageId: string
  title: string
  author: PublicUser
  replyCount: number
  lastReplyAt: string | null
  createdAt: string
}

export type ChannelFileDTO = AttachmentDTO & {
  messageId: string
  uploader: PublicUser
  createdAt: string
}

export type ChannelDTO = {
  id: string
  serverId: string
  name: string
  topic: string
  type: ChannelType
  visibility: ChannelVisibility
  categoryId: string | null
  position: number
  liveMeetingId: string | null
  parentId: string | null
  parentMessageId: string | null
  unread: boolean
  unreadCount?: number
  permissions?: number
  live: LiveState | null
  createdAt: string
  title?: string
  createdBy?: string | null
  dmKind?: 'pair' | 'group'
  dmOwnerId?: string | null
  participants?: PublicUser[]
  frozen?: boolean
  lastAgentMessage?: string | null
  agentWorking?: boolean
  lastMessageAt?: string | null
  /** When the channel, or a Thread's parent channel, was archived: readable, but closed to new activity. */
  archivedAt?: string | null
}

/** An archived Chat channel listed in Server settings for restore. */
export type ArchivedChannelDTO = {
  id: string
  name: string
  topic: string
  visibility: ChannelVisibility
  createdBy: string | null
  archivedAt: string
  archivedBy: { id: string, displayName: string } | null
}

/** A recently active thread shown under its channel in the navigation. */
export type SidebarThreadDTO = {
  id: string
  parentId: string
  title: string
  lastMessageAt: string
  /** The member has opened this thread, so new replies count as unread for them. */
  opened: boolean
  unread: boolean
  unreadCount: number
}

export type RoleDTO = {
  resourceAccess?: import('./resource-access').ResourceAccess
  id: string
  serverId: string
  key: string
  name: string
  permissions: number
  position: number
  isSystem: boolean
  /** Anyone may mention it; otherwise only the Owner and Members with Manage channels can. */
  mentionable?: boolean
  memberCount?: number
  policyCount?: number
}

export type MemberDTO = {
  user: PublicUser
  projectPolicies?: import('./project-access').ProjectPolicyGrant[]
  agentStatus?: AgentDTO['status']
  role: RoleDTO
  nickname: string | null
  status: PresenceStatus
}

export type AuditEntryDTO = {
  id: string
  serverId: string
  actorId: string
  actorName: string
  action: string
  targetType: string
  targetId: string
  meta: Record<string, unknown>
  createdAt: string
}

export type InvitePreviewDTO = {
  code: string
  serverId: string
  serverName: string
  expiresAt: string | null
  uses: number
  maxUses: number
}

export type AiProviderName = 'workers-ai' | 'workers-ai-rest' | 'openai-compatible' | null
export type BrowserProviderName = 'workers' | 'cloudflare-rest' | 'cdp' | null
export type EmailProviderName = 'binding' | 'cloudflare-rest' | 'gateway' | 'smtp' | null
export type EmailInboundProvider = 'binding' | 'bridge' | 'postmark' | 'mailgun' | 'ses' | null
export type CallsProviderName = 'realtimekit' | 'realtimekit-rest' | null

export type RuntimeCapabilities = {
  /** RealtimeKit calls. False when neither Cloudflare's network nor its REST API is available. */
  calls: boolean
  /** An isolated Pi execution provider is configured; tools still require Role grants. */
  containers: boolean
  browser: BrowserProviderName
  emailOutbound: boolean
  /**
   * Inbound mail path. `binding` is Cloudflare Email Routing. The other values
   * are webhooks. `null` means nothing is configured.
   */
  emailInbound: EmailInboundProvider
  /** Which outbound mail path health selected. */
  emailProvider: EmailProviderName
  /** Which calls path health selected. */
  callsProvider: CallsProviderName
}

export type SetupBindings = {
  db: boolean
  r2: boolean
  kv: boolean
  channelDo: boolean
  serverDo: boolean
  rateLimitDo: boolean
  notificationDo: boolean
  agentDo: boolean
  workersAi: boolean
  browser: boolean
}

/** Runtime details of `/api/setup/health`, returned only to signed-in members. */
export type SetupHealthDetails = {
  users: number
  bindings: SetupBindings
  aiProvider: AiProviderName
  aiModel: string | null
  capabilities: RuntimeCapabilities
  realtimekit: boolean
  twitterAuth: boolean
}

/**
 * `GET /api/setup/health`. Anyone may read the public part (the installer's
 * deploy verification and the sign-in/setup pages need it). Before owner setup
 * it also carries `users`, `adminEnv` and `bindings` so the setup page can
 * explain a misconfigured deployment. Members additionally receive
 * {@link SetupHealthDetails}.
 */
export type SetupHealth = {
  version: string
  authMode: AuthMode
  ok: boolean
  ready: boolean
  migrated: boolean
  ownerSetup: boolean
  ownerEmailHint: string | null
  adminEnv?: boolean
  appName: string
  iconUrl?: string | null
  appTitle: string
  appSubtitle: string
} & Partial<SetupHealthDetails>

export type ClientMsg =
  | { t: 'auth'; token: string }
  | { t: 'message.create'; content: string; replyToId?: string; clientId: string; attachmentIds?: string[]; agentMode?: 'queue' | 'steer' }
  | { t: 'message.update'; id: string; content: string }
  | { t: 'message.delete'; id: string }
  | { t: 'typing'; active: boolean }
  | { t: 'read'; messageId: string }
  | { t: 'reaction.add'; messageId: string; emoji: string }
  | { t: 'reaction.remove'; messageId: string; emoji: string }
  | { t: 'agent.control'; agentId: string; action: 'stop' | 'approve' | 'reject'; executionId?: string }

export type ServerMsg =
  | { t: 'hello'; channelId: string; you: PublicUser; live?: LiveState; frozen?: boolean; participants?: PublicUser[]; agentTurns?: AgentTurnDTO[] }
  | { t: 'message'; message: MessageDTO }
  | { t: 'message.update'; message: MessageDTO; streaming?: boolean }
  | { t: 'thread.created'; messageId: string; threadId: string }
  | { t: 'thread.updated'; threadId: string }
  | { t: 'message.delete'; id: string }
  | { t: 'typing'; userId: string; active: boolean }
  | { t: 'agent.start_failed'; agentId: string; initiatedBy: string; message: string }
  | { t: 'agent.state'; agentId: string; runs: AgentTurnDTO[] }
  | { t: 'presence'; users: Array<{ userId: string; status: PresenceStatus }> }
  | { t: 'live'; live: LiveState }
  | { t: 'dm.participants'; participants: PublicUser[] }
  | { t: 'dm.update'; name: string | null }
  | { t: 'reaction'; messageId: string; emoji: string; userId: string; op: 'add' | 'remove' }
  | { t: 'pin'; messageId: string; pin: MessagePinDTO | null }
  | { t: 'read.ack'; channelId: string; messageId: string; unread: boolean }
  | { t: 'error'; code: string; message: string; clientId?: string }
  | { t: 'ack'; clientId: string; id: string }

export type ServerClientMsg = { t: 'auth'; token: string; visible?: boolean } | { t: 'activity'; visible?: boolean }

export type ServerServerMsg =
  | { t: 'hello'; serverId: string }
  | { t: 'presence'; users: Array<{ userId: string; status: PresenceStatus }> }
  | { t: 'error'; code: string; message: string }
