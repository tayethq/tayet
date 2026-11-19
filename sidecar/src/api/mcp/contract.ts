// The contract of the sidecar's MCP tools (ADR-087 dec. 5(c); PLANO-AGENTES §0.3.13): the arguments and
// results of the tools, in product vocabulary only. This file is under the WHOLE deny list of the
// native contract (eslint.config.js; no allowlist). The MCP envelope (JSON-RPC, `content`,
// `structuredContent`, `isError`) is the SDK's and stays outside this lint.
//
// Ids are the native API's opaque tokens (api/ids.ts): `C…`/`D…` conversation, `U…` person; a message
// is its `ts` inside its conversation. A `cursor` is opaque and comes from an earlier answer.
import type { ApiApproval, ApiApprovalOption, ApiApprovalStatus, ApiCommand, ApiCommandsAccepted, ApiConversationList, ApiPanelAccepted, ApiErrorCode, ApiMessage, ApiMessageList, ApiPeopleList, ApiPerson, ApiRefused } from '../contract'

export interface McpListConversationsArgs {
  limit?: number
  cursor?: string
}
export type McpListConversationsResult = ApiConversationList

export interface McpListMembersArgs {
  conversation: string
  limit?: number
  cursor?: string
}
export type McpListMembersResult = ApiPeopleList

// `after` is a `ts`: only messages after it (exclusive). `thread` is the `ts` of a thread's first message.
export interface McpReadMessagesArgs {
  conversation: string
  after?: string
  limit?: number
  thread?: string
  cursor?: string
}
export type McpReadMessagesResult = ApiMessageList

// `thread` is the `ts` of a thread's first message; `mentions` are `U…` tokens.
export interface McpSendMessageArgs {
  conversation: string
  text: string
  thread?: string
  mentions?: string[]
}
export type McpSendMessageResult = ApiMessage

// `message` is the `ts`; `emoji` is the character itself (not a `:name:`).
export interface McpReactArgs {
  conversation: string
  message: string
  emoji: string
}
// False when the agent already had that reaction (nothing changed).
export interface McpReactResult {
  changed: boolean
}

export interface McpGetPersonArgs {
  id: string
}
export type McpGetPersonResult = ApiPerson

// `timeout_s`: default 25, at most 50 (a larger value is cut to 50). `after`: the `cursor` of the previous
// answer; absent → only mentions from now on.
export interface McpWaitForMentionArgs {
  timeout_s?: number
  after?: string
}

export const WAIT_DEFAULT_S = 25
export const WAIT_MAX_S = 50

// Every outcome carries the `cursor` to pass as `after` next time. `resync`: the cursor is from another
// run of the agent or too old — re-read what you need with `read_messages` and continue from `cursor`.
export type McpWaitForMentionResult =
  | { mention: { conversation: string; message: ApiMessage }; cursor: string }
  | { timedOut: true; cursor: string }
  | { resync: true; cursor: string }

// ── Approval cards (A3-3b; ADR-091, Proposto; PLANO-AGENTES §0.3.16 item 13) ──────────────────────

// `markdown`: default true, as send_message. `options`: 1 to 25, `id` [a-z0-9_-]{1,32} unique, at most one
// `primary` (the native POST's rules). Answers the card as a message (`approval.state: 'open'`).
// `needed`: 2 to 10, the card asks for that many answers (the answer then carries `approval.needed` and
// an empty `approval.answers`).
export interface McpRequestApprovalArgs {
  conversation: string
  text: string
  options: ApiApprovalOption[]
  thread?: string
  mentions?: string[]
  markdown?: boolean
  needed?: number
}
export type McpRequestApprovalResult = ApiMessage

// `id` is the card's `ts`. `timeout_s`: default 25, at most 50.
export interface McpWaitForApprovalArgs {
  conversation: string
  id: string
  timeout_s?: number
}
// The card's state once it is no longer open (`answered` with `answer.option`, or `closed`); or, when the
// time ran out with the card still open, `timedOut` (call again). A card with `needed`: `answered` with
// all its `answers` read, or `closed`; `timedOut` carries `approval`, the last state read.
export type McpWaitForApprovalResult = ApiApprovalStatus | { conversation: string; id: string; timedOut: true; approval?: ApiApproval }

// `text`: the request's new text (absent → the request stays).
export interface McpCloseApprovalArgs {
  conversation: string
  id: string
  text?: string
  markdown?: boolean
}
// The final state: `closed`, or `answered` when a person's answer came first (its event already went out).
// A card with `needed`: `needed` and `answers`, `answered` only when they were all in and read.
export type McpCloseApprovalResult = ApiApprovalStatus

// ── Pinned panel (A3-6; ADR-091, Proposto, dec. 13; PLANO-AGENTES §0.3.16 item 13) ─────────────────

// `text`: 1 byte to 8 KiB, Markdown unless `markdown` is false; `title`: plain text, one line, at most 75
// characters. Answers when queued; the write goes out within 10 s.
export interface McpSetPanelArgs {
  conversation: string
  text: string
  title?: string
  markdown?: boolean
}
export type McpSetPanelResult = ApiPanelAccepted

export interface McpClearPanelArgs {
  conversation: string
}
// `pending: false`: there was nothing to clear (no panel, or already cleared) and nothing pending.
export interface McpClearPanelResult {
  conversation: string
  pending: boolean
}

// ── Commands (A4-2a; ADR-093, Proposto; PLANO-AGENTES §0.3.22 item 9) ──────────────────────────────

// The whole set, for every conversation the agent is a member of (an empty list clears it). Answers once kept;
// `pending` is the number of conversations still to write (one write every 10 s, shared with the panel).
export interface McpSetCommandsArgs {
  commands: ApiCommand[]
}
export type McpSetCommandsResult = ApiCommandsAccepted

// `pending: 0`: nothing was written and there was no set.
export type McpClearCommandsResult = ApiCommandsAccepted

// A refused call: `isError: true`, `content[0].text` = the code; `structuredContent` = this.
export type McpErrorCode = Exclude<ApiErrorCode, 'unauthorized' | 'forbidden_origin' | 'misdirected' | 'not_found' | 'method_not_allowed'>
export interface McpToolError {
  code: McpErrorCode
  // With `rate_limited`: how long to wait before retrying.
  retryAfterMs?: number
  // With `content_refused`: what to rephrase (the local API's list).
  refused?: ApiRefused[]
}
