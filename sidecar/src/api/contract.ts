// The public contract of the sidecar's local API (ADR-087 dec. 5(a); PLANO-AGENTES §0.3.6). EVERY type
// that reaches an agent over HTTP or SSE is declared here, in product vocabulary only: the lint of
// this file denies protocol words in property and exported names (eslint.config.js, the barrel's
// deny list), and a test scans the keys of real responses against the same list.
//
// Ids are opaque tokens (api/ids.ts): `C…`/`D…` conversation, `U…` person, `T…` workspace, `F…` file;
// a message is identified by its `ts` inside its conversation.

// ADR-094 (Proposto): 'group' is a conversation of 3 to 9 people with no authored name.
export type ConversationKind = 'public' | 'private' | 'dm' | 'group'
export type PersonKind = 'member' | 'guest' | 'agent'

export interface ApiMe {
  id: string
  workspace: string
  name: string
  kind: 'agent'
}

export interface ApiConversation {
  id: string
  name: string
  kind: ConversationKind
  topic?: string
  // The other person of a direct conversation.
  peer?: string
  memberCount: number
}

export interface ApiPerson {
  id: string
  name: string
  kind: PersonKind
}

export type ApiMemberState = 'joined' | 'invited' | 'left'

export interface ApiReaction {
  emoji: string
  count: number
  mine: boolean
}

export interface ApiFile {
  id: string
  name: string
  mimetype: string
  size: number
  width?: number
  height?: number
}

export interface ApiThreadSummary {
  replyCount: number
  // Milliseconds since the epoch.
  latestReplyAt: number
}

// A rich-text node of the product (the domain's RichDoc, structural: `t` + text/children/href/items).
export type ApiRich = Record<string, unknown>

export interface ApiMessage {
  id: string
  conversation: string
  author: string
  text: string
  rich?: ApiRich
  // The `ts` of the thread's first message, when this one is a reply in a thread.
  thread?: string
  // The `ts` of the message this one quotes.
  replyTo?: string
  mentionsMe: boolean
  // The people this message mentions (`U…` tokens), when it mentions anyone (ADR-089 dec. 3).
  mentions?: string[]
  reactions: ApiReaction[]
  files?: ApiFile[]
  // Milliseconds since the epoch.
  editedAt?: number
  threadSummary?: ApiThreadSummary
  // The content cannot be read yet (or was withheld at the edge); `text` is empty.
  unavailable?: true
  // A kind of content this API does not carry; `text` is empty.
  unsupported?: true
  // An approval card (ADR-091, A3-3): the request is `text`/`rich`; the options always. `state` and
  // `answer` come only on the agent's OWN cards — another agent's card carries the options alone.
  approval?: ApiApproval
  // A `/` command for THIS agent (ADR-093, PLANO-AGENTES §0.3.23 items 1–6): a person's message whose
  // command names this agent, among its mentions, with a name in the set the agent declared now. `name`
  // without the slash; `args` the plain text after "/name", leading whitespace removed ('' with none) — the
  // whole rich stays in `rich`. Never on an edited message, never on another agent's message.
  command?: ApiMessageCommand
}

export interface ApiMessageCommand {
  name: string
  args: string
}

// ── Approval cards (ADR-091 (Proposto), A3-3) ─────────────────────────────────────────────────────
// At most one `primary`; `id` is [a-z0-9_-]{1,32}, unique on the card; `label` 1–75 characters.
export interface ApiApprovalOption {
  id: string
  label: string
  style?: 'primary' | 'danger'
}

// open: no answer counts yet; answered: the first valid answer of a person decided it (the card may
// already be sealed); closed: closed with no valid answer before the close.
export type ApiApprovalState = 'open' | 'answered' | 'closed'

export interface ApiApprovalAnswer {
  // The `id` of the chosen option. Absent while the answer cannot be read yet (who and when are known).
  option?: string
  // The person who answered (`U…`).
  by: string
  // Milliseconds since the epoch (the server's instant of the answer).
  at: number
}

export interface ApiApproval {
  options: ApiApprovalOption[]
  state?: ApiApprovalState
  answer?: ApiApprovalAnswer
}

// GET /v1/conversations/:id/approvals/:ts — the current state of one of the agent's own cards.
export interface ApiApprovalStatus {
  conversation: string
  id: string
  approval: ApiApproval
}

// ── Pinned panel (ADR-091 (Proposto) dec. 13, A3-6) ─────────────────────────────────────────────────
// The board the agent keeps up to date in a conversation: one per agent and conversation, outside the
// timeline, notifying no one. `updatedAt`: milliseconds since the epoch (the server's instant of the write).
export interface ApiPanel {
  title?: string
  text: string
  updatedAt: number
}

// GET /v1/conversations/:id/panel — the agent's own panel: `panel` null when there is none or it is
// cleared; `unreadable` when it exists and cannot be read (the store was lost); `pending` while a write
// (or a clear) waits for its turn.
export interface ApiPanelStatus {
  conversation: string
  panel: ApiPanel | null
  pending: boolean
  unreadable?: true
}

// PUT / DELETE /v1/conversations/:id/panel — 202: accepted, written within the budget (one panel write
// every 10 s per agent).
export interface ApiPanelAccepted {
  conversation: string
  pending: true
}

// ── Commands (ADR-093, Proposto; A4-2a, PLANO-AGENTES §0.3.22) ──────────────────────────────────────
// One `/` command the agent declares: `name` without the slash (`^[a-z0-9][a-z0-9_-]{0,31}$`), `description`
// 1–100 characters and `hint` 0–60, one line each. The set holds at most 25, distinct names, and the whole
// manifest fits in 8 KiB. It is written in every conversation the agent is a member of.
export interface ApiCommand {
  name: string
  description: string
  hint?: string
}

// GET /v1/commands — the declared set and `pending`: the number of conversations with a write (or a clear)
// waiting for its turn.
export interface ApiCommandsStatus {
  commands: ApiCommand[]
  pending: number
}

// PUT / DELETE /v1/commands — 202: accepted, written within the budget the panel shares (one write every
// 10 s per agent).
export interface ApiCommandsAccepted {
  pending: number
}

export interface ApiConversationList {
  conversations: ApiConversation[]
  next?: string
}

export interface ApiPeopleList {
  people: ApiPerson[]
  next?: string
}

export interface ApiMessageList {
  messages: ApiMessage[]
  next?: string
}

export interface ApiHealth {
  state: 'online' | 'offline'
}

export interface ApiError {
  // `retryAfterMs` comes with `rate_limited` (429), next to the `Retry-After` header in seconds.
  // `refused` comes with `content_refused` (422): what to rephrase.
  error: { code: ApiErrorCode; message: string; retryAfterMs?: number; refused?: ApiRefused[] }
}

// A write refused before any effect because what the caller sent looks like an internal id: `field` is where
// (`text`, `title`, `approval.options[0].label`, …) and `pattern` which kind of id it looks like. The matched
// text never comes back.
export type ApiRefusedPattern = 'user_id' | 'conversation_id' | 'message_id' | 'media_address'
export interface ApiRefused {
  field: string
  pattern: ApiRefusedPattern
}

// ── Request bodies (S-c2, §0.3.7 item 1). Any other field is refused (400 `invalid_argument`). ─────

// POST /v1/conversations/:id/messages. `thread` and `replyTo` are `ts` of this conversation (not
// both); `mentions` are `U…` tokens (at most 100, no repeats). `markdown: true` renders `text` as
// Markdown (S-i, PLANO-AGENTES §0.3.15): the formatted version goes only when there is formatting, and
// `text` stays the plain fallback; absent or false = the text as is; any other value is a 400.
export interface ApiPostMessage {
  text: string
  thread?: string
  replyTo?: string
  mentions?: string[]
  markdown?: boolean
}

// POST /v1/conversations/:id/approvals — an approval card: `text` is the request (`markdown` as in the
// message POST), `options` 1–25 (ApiApprovalOption; more than one `primary` is refused, never demoted).
export interface ApiPostApproval {
  text: string
  markdown?: boolean
  options: ApiApprovalOption[]
  thread?: string
  mentions?: string[]
}

// POST /v1/conversations/:id/approvals/:ts/close — closes the agent's own card; without `text` the
// request stays as it is. A card already closed answers as it is, with no new write.
export interface ApiCloseApproval {
  text?: string
  markdown?: boolean
}

// PUT /v1/conversations/:id/panel — `text` 1 byte to 8 KiB (`markdown` as in the message POST); `title`
// plain text, one line, at most 75 characters. No `thread`, no `mentions`: a panel notifies no one.
export interface ApiPutPanel {
  text: string
  markdown?: boolean
  title?: string
}

// PUT /v1/commands — the whole set (an empty list clears it, as DELETE does). Any other field, in the body
// or in a command, is refused.
export interface ApiPutCommands {
  commands: ApiCommand[]
}

// PATCH /v1/conversations/:id/messages/:ts — only the agent's own text messages and approval cards (a
// card keeps its options and its close: only the request changes). `markdown` as in POST.
export interface ApiEditMessage {
  text: string
  markdown?: boolean
}

export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden_origin'
  | 'misdirected'
  | 'not_found'
  | 'method_not_allowed'
  | 'conversation_not_found'
  | 'user_not_found'
  | 'message_not_found'
  | 'invalid_cursor'
  | 'invalid_argument'
  | 'not_member'
  | 'not_own_message'
  | 'not_editable'
  | 'not_approval'
  | 'rate_limited'
  | 'payload_too_large'
  | 'file_too_large'
  | 'file_not_found'
  | 'upstream_failed'
  | 'revoked'
  | 'unavailable'
  | 'content_refused'
  | 'internal'

// ── Events (SSE `GET /v1/events`; the same bus feeds the Slack layer's WebSocket, S-f) ─────────────

export type ApiEvent =
  | { type: 'message.received'; conversation: string; message: ApiMessage }
  | { type: 'message.edited'; conversation: string; message: ApiMessage }
  | { type: 'message.removed'; conversation: string; id: string }
  // Sent with message.received when the message mentions the agent.
  | { type: 'mention'; conversation: string; message: ApiMessage }
  | { type: 'reaction.changed'; conversation: string; id: string; reactions: ApiReaction[] }
  | { type: 'conversation.added'; conversation: ApiConversation }
  | { type: 'conversation.removed'; id: string }
  | { type: 'member.changed'; conversation: string; person: ApiPerson; state: ApiMemberState }
  | { type: 'agent.revoked' }
  // ADR-091 (A3-3): a person answered one of the agent's own cards. `id` is the card's `ts`, `option` the
  // chosen option's id, `by` the person (`U…`), `at` the answer's instant. Delivered at least once (a
  // restart between the event and the card's seal sends it again): treat it as idempotent by `id`.
  | { type: 'approval.answered'; conversation: string; id: string; option: string; by: string; at: number }
  // The stream cannot replay from the given id (another run, or older than the buffer): re-read
  // what you need through the listings (`oldest=`).
  | { type: 'resync' }

export type ApiEventType = ApiEvent['type']
