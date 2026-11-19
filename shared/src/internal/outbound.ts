import { RelationType } from 'matrix-js-sdk'
import type { ApprovalOption, FormField, FormValues, RichDoc, UserId } from '../domain'
import { richTextContent } from './rich-text'
import { userIdToRaw } from './protocol-ids'
import type { MatrixMsgtype } from './msgtype'
import type { EncryptedFile } from './wire-types'
import type { CommandEntry } from './commands'
import type { FormSubmissionLabel } from './forms'
import {
  FORM_BLOCK,
  FORM_MSGTYPE,
  FORM_REL_TYPE,
  FORM_RESULT_BLOCK,
  FORM_RESULT_MSGTYPE,
  FORM_SUBMISSION_BLOCK,
  FORM_SUBMISSION_MSGTYPE,
  APPROVAL_BLOCK,
  APPROVAL_MSGTYPE,
  APPROVAL_RESPONSE_BLOCK,
  APPROVAL_RESPONSE_MSGTYPE,
  COMMANDS_BLOCK,
  COMMANDS_MSGTYPE,
  COMMANDS_REL_TYPE,
  COMMAND_MARKER,
  PANEL_BLOCK,
  PANEL_MSGTYPE,
  PANEL_REL_TYPE,
  RESPONSE_REL_TYPE,
} from './product-events'

// Outbound content builders (S-a2, ADR-088 dec. 5): the PURE assembly of what a send puts on the
// wire — no client, no crypto, no upload. The gateway decides the SDK method (sendTextMessage vs
// sendMessage, and the threadId argument), resolves the targets (thread root, reply target, the
// event to edit or react to), encrypts and uploads, then hands the resulting ids/envelope here.
// Key order is part of the contract: the client's outbound-content-shape test pins it byte-for-byte
// (JSON.stringify), so a reorder here is a behaviour change.

// The relation a text send carries. Reply-inside-thread is not a shape (the gateway rejects it).
export type TextRelation = { thread: string } | { replyTo: string }

// ADR-093 (Proposto): the command a text send carries — the command's name (without the slash) and the
// agent it is for.
export type TextCommand = { name: string; agent: UserId }

// Text content: the serializer's fragment (ADR-012), the command marker (ADR-093, when the send carries a
// command), the intentional mentions (ADR-037 M2 — UserId → mxid resolved HERE, empty/absent omits the
// annotation; a command adds its agent once) and at most one relation, always last. The caller has
// checked the command (name rule, text prefix, an agent).
export function buildTextContent(text: string, rich?: RichDoc, mentions?: UserId[], relation?: TextRelation, command?: TextCommand) {
  const fragment = richTextContent(text, rich)
  const userIds = (mentions ?? []).map(userIdToRaw)
  const agent = command ? userIdToRaw(command.agent) : undefined
  if (agent !== undefined && !userIds.includes(agent)) userIds.push(agent)
  const markerFragment = command && agent !== undefined ? { [COMMAND_MARKER]: { name: command.name, to: agent } } : undefined
  const mentionsFragment = userIds.length ? { 'm.mentions': { user_ids: userIds } } : undefined
  if (relation && 'thread' in relation) {
    return {
      msgtype: 'm.text',
      ...fragment,
      ...markerFragment,
      ...mentionsFragment,
      'm.relates_to': { rel_type: RelationType.Thread, event_id: relation.thread },
    }
  }
  if (relation) {
    // Reply envelope (PLANO-FASE-1-REPLY §0.4): EXACTLY { 'm.in_reply_to': { event_id } } — no rel_type,
    // no is_falling_back, no legacy fallback in body/formatted_body.
    return {
      msgtype: 'm.text',
      ...fragment,
      ...markerFragment,
      ...mentionsFragment,
      'm.relates_to': { 'm.in_reply_to': { event_id: relation.replyTo } },
    }
  }
  return { msgtype: 'm.text', ...fragment, ...markerFragment, ...mentionsFragment }
}

// Where the uploaded bytes live: in an E2E room, the envelope minted by the cipher plus the mxc of the
// ciphertext (the event carries `file` INSTEAD of `url`, ADR-016); otherwise the mxc of the plaintext.
export type AttachmentMedia = { encrypted: Omit<EncryptedFile, 'url'>; url: string } | { url: string }

// Attachment content: msgtype inferred by the caller from the mimetype (P1), plaintext name/mimetype/
// size in `info` (inside the Megolm payload when encrypted), thread relation appended last.
export function buildAttachmentContent(
  msgtype: MatrixMsgtype,
  name: string,
  mimetype: string,
  size: number,
  media: AttachmentMedia,
  threadRoot?: string,
): Record<string, unknown> {
  const content: Record<string, unknown> =
    'encrypted' in media
      ? { msgtype, body: name, file: { ...media.encrypted, url: media.url }, info: { mimetype, size } }
      : { msgtype, body: name, url: media.url, info: { mimetype, size } }
  if (threadRoot) content['m.relates_to'] = { rel_type: RelationType.Thread, event_id: threadRoot }
  return content
}

// Edit content (ADR-012 × m.replace): the post-edit content, formatted_body included, lives INSIDE
// m.new_content; the top-level body is the `* `-prefixed plain fallback for non-edit-aware clients.
export function buildEditContent(text: string, rich: RichDoc | undefined, targetEventId: string) {
  const fragment = richTextContent(text, rich)
  return {
    msgtype: 'm.text',
    body: `* ${fragment.body}`,
    'm.new_content': { msgtype: 'm.text', ...fragment },
    'm.relates_to': { rel_type: RelationType.Replace, event_id: targetEventId },
  }
}

// Reaction content: an m.annotation relation keyed by the emoji. The return type keeps the enum member
// narrow, so the gateway passes it to sendEvent(EventType.Reaction, …) without a cast.
export function buildReactionContent(
  targetEventId: string,
  key: string,
): { 'm.relates_to': { rel_type: RelationType.Annotation; event_id: string; key: string } } {
  return {
    'm.relates_to': { rel_type: RelationType.Annotation, event_id: targetEventId, key },
  }
}

// ADR-091 dec. 2 (A3-2): a person's answer to an approval card — the answer's own type, a
// plain fallback body (the option's label, what another client shows), the block naming the chosen
// option's `id`, and the relation to the card, always last. `m.relates_to` stays at the top level of the
// content: in an encrypted conversation the cipher lifts it into the envelope in clear (as for a
// thread or an edit), which is what the server's relation read — the aggregator of every client and
// the sidecar — and the notification rules depend on.
export function buildApprovalAnswerContent(cardEventId: string, option: string, label: string) {
  return {
    msgtype: APPROVAL_RESPONSE_MSGTYPE,
    body: label,
    [APPROVAL_RESPONSE_BLOCK]: { option },
    'm.relates_to': { rel_type: RESPONSE_REL_TYPE, event_id: cardEventId },
  }
}

// ADR-091 dec. 1 (A3-3): the approval card the sidecar sends. The card's own type; the request
// as the usual body/formatted body — the plain body is ONLY the request (no list of options: another
// client shows the request, and the options are the block's); the block carrying the options (`style`
// only when set) and, for a card that asks for several answers (ADR-104), `needed` beside them; the
// intentional mentions and the thread relation, last, as in buildTextContent. Without `needed` the content
// is the one of a card resolved by its first answer, byte for byte.
export function buildApprovalContent(text: string, rich: RichDoc | undefined, options: readonly ApprovalOption[], mentions?: UserId[], thread?: string, needed?: number) {
  const fragment = richTextContent(text, rich)
  const mentionsFragment = mentions?.length ? { 'm.mentions': { user_ids: mentions.map(userIdToRaw) } } : undefined
  return {
    msgtype: APPROVAL_MSGTYPE,
    ...fragment,
    [APPROVAL_BLOCK]: { options: approvalOptionsOf(options), ...(needed !== undefined && { needed }) },
    ...mentionsFragment,
    ...(thread !== undefined && { 'm.relates_to': { rel_type: RelationType.Thread, event_id: thread } }),
  }
}

// The edit of a card (A3-3): the request changed (PATCH) or the card closed (the close and the seal). The
// new content keeps the card's type and block — the ORIGINAL options (an edit never changes them; the
// reader takes them from the original anyway), the original `needed` when the card has it (ADR-104 dec. 13)
// and, when `closed`, the closing mark. The top-level body is the `* `-prefixed fallback, as in
// buildEditContent.
export function buildApprovalEditContent(text: string, rich: RichDoc | undefined, options: readonly ApprovalOption[], closed: boolean, targetEventId: string, needed?: number) {
  const fragment = richTextContent(text, rich)
  return {
    msgtype: APPROVAL_MSGTYPE,
    body: `* ${fragment.body}`,
    'm.new_content': {
      msgtype: APPROVAL_MSGTYPE,
      ...fragment,
      [APPROVAL_BLOCK]: { options: approvalOptionsOf(options), ...(needed !== undefined && { needed }), ...(closed && { closed: true }) },
    },
    'm.relates_to': { rel_type: RelationType.Replace, event_id: targetEventId },
  }
}

const approvalOptionsOf = (options: readonly ApprovalOption[]) =>
  options.map((o) => ({ id: o.id, label: o.label, ...(o.style !== undefined && { style: o.style }) }))

// ADR-091 dec. 12 (A3-5): a new pinned panel. The panel's type; the content as the usual body
// and formatted body; the block with the title when there is one (an empty block otherwise, so another
// reader tells it apart from a stray message of the type); the relation to the conversation's creation
// event, last. `m.relates_to` stays at the top level: in an encrypted conversation the cipher lifts it
// into the envelope in clear, which is what the server's relation read of the anchor depends on. Used by
// the client's stack test (A3-5) and the sidecar (A3-6).
export function buildPanelContent(text: string, rich: RichDoc | undefined, title: string | undefined, createEventId: string) {
  const fragment = richTextContent(text, rich)
  return {
    msgtype: PANEL_MSGTYPE,
    ...fragment,
    [PANEL_BLOCK]: panelBlockOf(title, false),
    'm.relates_to': { rel_type: PANEL_REL_TYPE, event_id: createEventId },
  }
}

// The edit of a panel (A3-5): new content, a new title (or none), or the clear — the closing mark
// `cleared: true` with an empty body and no title (PLANO-AGENTES §0.3.18 item 2; writing again is another
// edit of the same message). The top-level body is the `* `-prefixed fallback, as in buildEditContent.
export function buildPanelEditContent(
  edit: { text: string; rich?: RichDoc; title?: string } | { cleared: true },
  targetEventId: string,
) {
  const cleared = 'cleared' in edit
  const fragment = cleared ? richTextContent('') : richTextContent(edit.text, edit.rich)
  return {
    msgtype: PANEL_MSGTYPE,
    body: `* ${fragment.body}`,
    'm.new_content': {
      msgtype: PANEL_MSGTYPE,
      ...fragment,
      [PANEL_BLOCK]: panelBlockOf(cleared ? undefined : edit.title, cleared),
    },
    'm.relates_to': { rel_type: RelationType.Replace, event_id: targetEventId },
  }
}

const panelBlockOf = (title: string | undefined, cleared: boolean) => ({
  ...(title !== undefined && { title }),
  ...(cleared && { cleared: true as const }),
})

// ADR-093 (Proposto): the commands manifest's fallback body — one line per command, "/name — description"
// (what another client shows).
export function commandsFallbackBody(commands: readonly CommandEntry[]): string {
  return commands.map((c) => `/${c.name} — ${c.description}`).join('\n')
}

const commandsOf = (commands: readonly CommandEntry[]) =>
  commands.map((c) => ({ name: c.name, description: c.description, ...(c.hint !== undefined && { hint: c.hint }) }))

// ADR-093 (Proposto) (A4-1): a new commands manifest. The manifest's type; the fallback body; the block with
// the commands; the relation to the conversation's creation event, last — as buildPanelContent, and never
// mentions. `m.relates_to` stays at the top level: in an encrypted conversation the cipher lifts it into the
// envelope in clear, which the server's relation read of the anchor and the unread rule depend on. Used by
// the client's stack test (A4-1) and the sidecar (A4-2).
export function buildCommandsContent(commands: readonly CommandEntry[], createEventId: string) {
  return {
    msgtype: COMMANDS_MSGTYPE,
    body: commandsFallbackBody(commands),
    [COMMANDS_BLOCK]: { commands: commandsOf(commands) },
    'm.relates_to': { rel_type: COMMANDS_REL_TYPE, event_id: createEventId },
  }
}

// The edit of a manifest (A4-1): a new set of commands, or the clear — the mark `cleared: true` with an
// empty body and no commands (as the panel's clear). The top-level body is the `* `-prefixed fallback, as in
// buildEditContent. Never mentions.
export function buildCommandsEditContent(edit: { commands: readonly CommandEntry[] } | { cleared: true }, targetEventId: string) {
  const cleared = 'cleared' in edit
  const body = cleared ? '' : commandsFallbackBody(edit.commands)
  return {
    msgtype: COMMANDS_MSGTYPE,
    body: `* ${body}`,
    'm.new_content': {
      msgtype: COMMANDS_MSGTYPE,
      body,
      [COMMANDS_BLOCK]: cleared ? { cleared: true as const } : { commands: commandsOf(edit.commands) },
    },
    'm.relates_to': { rel_type: RelationType.Replace, event_id: targetEventId },
  }
}

// The person's submission of an agent's form: its own type, the form's title as the plain body (never a
// value), the block naming the definition and carrying the values and the copy of the labels the person
// saw, and the form relation to the anchor.
export function buildFormSubmissionContent(
  anchorEventId: string,
  formEventId: string,
  title: string,
  values: FormValues,
  labels: readonly FormSubmissionLabel[],
) {
  return {
    msgtype: FORM_SUBMISSION_MSGTYPE,
    body: title,
    [FORM_SUBMISSION_BLOCK]: { form: formEventId, values, labels },
    'm.relates_to': { rel_type: FORM_REL_TYPE, event_id: anchorEventId },
  }
}

// One field of a definition as it travels: the domain field with a list's choices lifted to the field
// (`options` or `groups`), and a context's formatted text as the usual format/formatted body pair.
export function formFieldWire(field: FormField): Record<string, unknown> {
  if (field.kind === 'context') {
    const { body: _body, ...format } = richTextContent(field.text, field.rich)
    return { kind: 'context', text: field.text, ...format }
  }
  if (field.kind === 'select' || field.kind === 'multiSelect') {
    const { choices, ...rest } = field
    return { ...rest, ...choices }
  }
  return { ...field }
}

// The agent's definition of a form: its own type, the title as the plain body, the block naming the
// trigger (the answer to the card, or the command message) and carrying the title, the submit label, the
// fields and the agent's optional state, and the form relation to the anchor, last.
export function buildFormDefinitionContent(
  anchorEventId: string,
  trigger: string,
  title: string,
  submitLabel: string,
  fields: readonly FormField[],
  meta?: string,
) {
  return {
    msgtype: FORM_MSGTYPE,
    body: title,
    [FORM_BLOCK]: { trigger, title, submitLabel, fields: fields.map(formFieldWire), ...(meta !== undefined && { meta }) },
    'm.relates_to': { rel_type: FORM_REL_TYPE, event_id: anchorEventId },
  }
}

// The agent's result for a submission: its own type, a plain body (the messages, or "ok"), the block
// naming the submission with `ok: true` or the errors by field id, and the form relation to the anchor.
export function buildFormResultContent(anchorEventId: string, submissionEventId: string, outcome: { ok: true } | { errors: Record<string, string> }) {
  const errors = 'errors' in outcome ? outcome.errors : undefined
  return {
    msgtype: FORM_RESULT_MSGTYPE,
    body: errors !== undefined ? Object.values(errors).join('\n') : 'ok',
    [FORM_RESULT_BLOCK]: errors !== undefined ? { submission: submissionEventId, errors: { ...errors } } : { submission: submissionEventId, ok: true as const },
    'm.relates_to': { rel_type: FORM_REL_TYPE, event_id: anchorEventId },
  }
}
