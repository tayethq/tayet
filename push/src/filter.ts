// What the homeserver's notification becomes: kept or dropped per device, and the JSON the service
// worker receives. Only three cases send: the app's per-conversation mark, the server's mention
// highlight, and an invite to a direct conversation or group. Everything else is accepted and dropped.

export interface Device {
  pushkey?: unknown
  data?: unknown
  tweaks?: unknown
}

export interface Notification {
  event_id?: unknown
  room_id?: unknown
  sender?: unknown
  type?: unknown
  sender_display_name?: unknown
  room_name?: unknown
  user_is_target?: unknown
  prio?: unknown
  content?: unknown
  devices?: unknown
}

export type Kind = 'direct' | 'group' | 'channel'

export interface Payload {
  v: 1
  kind: Kind
  invite: boolean
  conversation: string
  message: string
  thread?: string
  author: string
  channelName?: string
  body?: { type: 'text' | 'image' | 'file' | 'approval' | 'other'; text?: string }
  // Present only when the sender is an agent; the sender's account itself never travels.
  agent?: true
}

export const MARK = 'io.tayet.push'
const APPROVAL = 'io.tayet.approval'
export const MAX_TEXT = 300
export const MAX_PAYLOAD_BYTES = 3000

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

// The kind to send for this device, or undefined to drop.
export function decide(n: Notification, d: Device): { kind: Kind; invite: boolean } | undefined {
  if (typeof n.event_id !== 'string' || n.event_id === '') return undefined
  const content = isObject(n.content) ? n.content : {}
  if (n.type === 'm.room.member') {
    if (content.membership !== 'invite' || n.user_is_target !== true) return undefined
    if (content.is_direct === true) return { kind: 'direct', invite: true }
    if (n.room_name === undefined || n.room_name === null || n.room_name === '') return { kind: 'group', invite: true }
    return undefined
  }
  const tweaks = isObject(d.tweaks) ? d.tweaks : {}
  const mark = tweaks[MARK]
  if (mark === 'direct' || mark === 'group') return { kind: mark, invite: false }
  if (tweaks.highlight === true) return { kind: 'channel', invite: false }
  return undefined
}

// An agent's account: the local part is `a-` and 12 base32 characters (the client's own test).
const AGENT_LOCALPART = /^a-[a-z2-7]{12}$/
export function isAgentSender(sender: unknown): boolean {
  if (typeof sender !== 'string' || !sender.startsWith('@')) return false
  const colon = sender.indexOf(':')
  return colon > 1 && AGENT_LOCALPART.test(sender.slice(1, colon))
}

// The sender's display name, or empty. Without a display name the homeserver sends the account's local part
// instead, and an account name must never reach a title: a name equal to the local part or to the whole account
// is dropped, like a missing one.
export function authorOf(n: Notification): string {
  const name = (str(n.sender_display_name) ?? '').trim()
  const sender = str(n.sender)
  if (!name || sender === undefined) return name
  const colon = sender.indexOf(':')
  const localpart = sender.startsWith('@') && colon > 1 ? sender.slice(1, colon) : undefined
  return name === sender || name === localpart ? '' : name
}

const TEXT_TYPES = new Set(['m.text', 'm.notice', 'm.emote'])
const FILE_TYPES = new Set(['m.file', 'm.audio', 'm.video'])

function bodyOf(content: Record<string, unknown>): Payload['body'] {
  if ('ciphertext' in content) return undefined
  const text = str(content.body)
  const cut = text === undefined ? undefined : Array.from(text).slice(0, MAX_TEXT).join('')
  if (APPROVAL in content) return { type: 'approval', text: cut }
  const msgtype = str(content.msgtype) ?? ''
  const type = TEXT_TYPES.has(msgtype) ? 'text' : msgtype === 'm.image' ? 'image' : FILE_TYPES.has(msgtype) ? 'file' : 'other'
  return { type, text: cut }
}

export function buildPayload(n: Notification, kind: Kind, invite: boolean): Payload {
  const content = isObject(n.content) ? n.content : {}
  const rel = isObject(content['m.relates_to']) ? content['m.relates_to'] : {}
  return {
    v: 1,
    kind,
    invite,
    conversation: str(n.room_id) ?? '',
    message: str(n.event_id) ?? '',
    thread: rel.rel_type === 'm.thread' ? str(rel.event_id) : undefined,
    author: authorOf(n),
    channelName: kind === 'channel' ? str(n.room_name) : undefined,
    body: kind === 'channel' && !invite ? bodyOf(content) : undefined,
    agent: isAgentSender(n.sender) ? true : undefined,
  }
}

// The JSON the push service receives (encrypted), within MAX_PAYLOAD_BYTES: the text is cut, one code
// point at a time from the end, until it fits. Undefined when even an empty text does not fit.
export function serialize(p: Payload): Buffer | undefined {
  let out = Buffer.from(JSON.stringify(p))
  if (out.length <= MAX_PAYLOAD_BYTES) return out
  const text = p.body?.text
  if (p.body === undefined || text === undefined) return undefined
  const chars = Array.from(text)
  // At most MAX_TEXT tries, each a small JSON.stringify.
  for (let keep = chars.length - 1; keep >= 0; keep--) {
    out = Buffer.from(JSON.stringify({ ...p, body: { ...p.body, text: chars.slice(0, keep).join('') } }))
    if (out.length <= MAX_PAYLOAD_BYTES) return out
  }
  return undefined
}
