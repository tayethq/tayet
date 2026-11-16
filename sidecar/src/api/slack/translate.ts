// Native contract → Slack shapes (PLANO-AGENTES §0.3.12). Pure: the values are already tokens and have
// already passed the native edge (the caller runs `ctx.native` first).
import type { ApiConversation, ApiFile, ApiMessage, ApiPerson } from '../contract'
import type { SlackConversation, SlackFile, SlackMessage, SlackUser } from './contract'

const text = (value: string) => ({ value, creator: '', last_set: 0 })

export function slackConversation(c: ApiConversation): SlackConversation {
  const dm = c.kind === 'dm'
  // ADR-094 dec. 12: a group conversation is Slack's `mpim` — not a channel, and `is_group` stays false
  // (Slack's legacy `is_group` is a private channel). Privacy follows the rule of every non-public kind.
  const group = c.kind === 'group'
  return {
    id: c.id,
    name: c.name,
    is_channel: !dm && !group,
    is_group: false,
    is_im: dm,
    is_mpim: group,
    is_private: c.kind !== 'public',
    is_archived: false,
    is_member: true,
    created: 0,
    ...(dm && c.peer !== undefined && { user: c.peer }),
    ...(!dm && { topic: text(c.topic ?? ''), purpose: text('') }),
    num_members: c.memberCount,
  }
}

// Never `profile.email` (§0.3.12; the native person has none).
export function slackUser(p: ApiPerson, team: string): SlackUser {
  return {
    id: p.id,
    team_id: team,
    name: p.name,
    real_name: p.name,
    deleted: false,
    is_bot: p.kind === 'agent',
    profile: { display_name: p.name, real_name: p.name },
  }
}

// Slack's opaque cursors over a list the layer holds whole (an offset; nothing of the protocol).
export const cursorOf = (offset: number): string => Buffer.from(`next:${offset}`).toString('base64url')
export function offsetOf(cursor: string | undefined): number | null {
  if (cursor === undefined) return 0
  const m = /^next:(\d{1,9})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'))
  return m === null ? null : Number(m[1])
}

// Milliseconds → a Slack `ts` string (seconds, 6 decimals). For `edited.ts` and `latest_reply`: the native
// API carries those instants in ms, not the `ts` of the edit or of the reply (declared, §8.18).
export const tsOfMs = (ms: number): string => `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}000`

const filetypeOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : 'binary'
}

// The file's url_private on the local listener (S-f3): absolute, the `F…` only — nothing of the protocol.
export const fileUrlOf = (base: string, id: string): string => `${base}/slack/files/${id}`

// `base` (the listener's base URL) adds url_private / url_private_download; null (not listening) → none.
export function slackFile(f: ApiFile, base: string | null): SlackFile {
  return {
    id: f.id,
    name: f.name,
    title: f.name,
    mimetype: f.mimetype,
    filetype: filetypeOf(f.name),
    size: f.size,
    ...(f.width !== undefined && { original_w: f.width }),
    ...(f.height !== undefined && { original_h: f.height }),
    ...(base !== null && { url_private: fileUrlOf(base, f.id), url_private_download: fileUrlOf(base, f.id) }),
  }
}

export interface MessageView {
  // The agent's `U…` (the `users` of its own reactions).
  me: string
  // The message text in mrkdwn (slack/mrkdwn.ts); the plain text until then.
  text(m: ApiMessage): string
  // A reaction's Slack name (slack/emoji.ts); a character with no name stays the character.
  reaction(emoji: string): string
  // The listener's base URL: the files' url_private (S-f3); null → the files carry none.
  base: string | null
}

// `blocks` are never returned on a read (§0.3.12: the text carries the content).
export function slackMessage(m: ApiMessage, view: MessageView): SlackMessage {
  const out: SlackMessage = { type: 'message', user: m.author, text: view.text(m), ts: m.id }
  const root = m.threadSummary !== undefined
  if (m.thread !== undefined) out.thread_ts = m.thread
  else if (root) out.thread_ts = m.id
  if (m.threadSummary !== undefined) {
    out.reply_count = m.threadSummary.replyCount
    out.latest_reply = tsOfMs(m.threadSummary.latestReplyAt)
  }
  if (m.reactions.length > 0) {
    out.reactions = m.reactions.map((r) => ({ name: view.reaction(r.emoji), count: r.count, users: r.mine ? [view.me] : [] }))
  }
  if (m.files !== undefined && m.files.length > 0) {
    out.files = m.files.map((f) => slackFile(f, view.base))
    if (out.text === '') out.subtype = 'file_share'
  }
  if (m.editedAt !== undefined) out.edited = { user: m.author, ts: tsOfMs(m.editedAt) }
  return out
}
