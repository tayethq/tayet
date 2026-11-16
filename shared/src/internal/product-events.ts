// ADR-091: the protocol names of the product's own message types — the approval card, the
// answer to it and the pinned panel. The ONE place they are spelled (PLANO-AGENTES §0.3.16, A3-1): the
// translator, the client's ACL and the sidecar read them from here. None of them crosses the barrel,
// reaches `src/ui`, a log line or a UI test.

// The card: a message of its own type, with the usual body/formatted body, and this block in the
// content carrying `options` (and, on the author's closing edit, `closed: true`).
export const APPROVAL_MSGTYPE = 'io.tayet.approval'
export const APPROVAL_BLOCK = 'io.tayet.approval'

// The answer: a message of its own type, a plain fallback body, this block carrying `{ option }`, and a
// relation of the type below to the card. The relation type travels in clear, like a thread's or an
// edit's.
export const APPROVAL_RESPONSE_MSGTYPE = 'io.tayet.approval.response'
export const APPROVAL_RESPONSE_BLOCK = 'io.tayet.approval.response'
export const RESPONSE_REL_TYPE = 'io.tayet.response'

// The panel: a message of its own type, related to the conversation's creation event by a relation of
// its own type, updated by edits — one message per agent and conversation. The body is the content (the
// usual fallback text and formatted body); this block carries the optional title and, on the clearing
// edit, `cleared: true` (PLANO-AGENTES §0.3.18 items 1–2). The timeline drops it (A3-1); the client
// reads it through the anchor's relations (A3-5, panel.ts and the ACL's panel aggregator).
export const PANEL_MSGTYPE = 'io.tayet.panel'
export const PANEL_BLOCK = 'io.tayet.panel'
export const PANEL_REL_TYPE = 'io.tayet.panel'

// ADR-093 (Proposto): the agent's `/` commands manifest — a message of its own type, related to the
// conversation's creation event by a relation of its own type, in the mould of the panel (PLANO-AGENTES
// §0.3.21 items 1–3). One per agent and conversation, updated by edits. The body is the fallback, one line
// per command ("/name — description"); this block carries `{ commands: [{ name, description, hint? }] }`
// and, on the clearing edit, `cleared: true`. Never carries mentions. Out of the timeline, the unread count
// and the notifications, like the panel.
export const COMMANDS_MSGTYPE = 'io.tayet.commands'
export const COMMANDS_BLOCK = 'io.tayet.commands'
export const COMMANDS_REL_TYPE = 'io.tayet.commands'

// ADR-093 (Proposto): the command marker of a person's message — an encrypted key of the content naming the
// command (without the slash) and the agent it is for, `{ name, to }` (PLANO-AGENTES §0.3.21 item 7). The
// agent is also in the message's mentions; the text starts with "/name".
export const COMMAND_MARKER = 'io.tayet.command'

// ADR-094 (Proposto) dec. 2: the conversation marker — a state event, empty state key, whose content
// `{ kind: 'group' }` makes the room a group conversation (and `{ kind: 'channel' }` after the conversion,
// dec. 9). Read tolerantly: only the exact value 'group' classifies; absent, malformed or any other value is
// a channel. The type never crosses the barrel (the Channel carries only `kind`).
export const CONVERSATION_EVENT = 'io.tayet.conversation'

// ADR-075 addendum: carried (`true`) by the redaction of one's own edit, never by that of the message itself.
export const EDIT_REDACTION_FIELD = 'io.tayet.edit_redaction'
