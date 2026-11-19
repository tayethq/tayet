// The Slack layer's edge (PLANO-AGENTES §0.3.12 item 2). The native data the layer translates has
// already passed the native edge (api/edge.ts `scanEdge`) — the layer calls it on every ApiMessage and
// every listing BEFORE translating. What the translation adds is then scanned here, by path:
// - USER CONTENT of the Slack shape — the `text` of a message object (`type: 'message'` + `ts`) and the
//   `name`/`title` of its files; at the top of an answer, the `text` (chat.update echoes the message's
//   text there, §8.20), the `files` (files.completeUploadExternal) and the `file` (files.info, S-f3) — gets
//   the id shapes only (an mrkdwn
//   `<@U…>` is a token, never an id). A reaction's `name` in the `reactions` of a message object is user content
//   too: whoever reacted chose it. The content paths are these and nothing else: a `text` or a `name` anywhere
//   else (an object that is not a message) stays structural, except the names below;
// - NAMES WRITTEN BY PEOPLE — what translates a conversation's name and topic, a person's name and the agent's own
//   name — get the id shapes and the two internal account identifiers; a person's name also the custody account's.
//   By the shape of their object: a channel (`is_channel` and `is_im`): `name` and `topic.value` (`purpose` is not
//   one of them); a user (`is_bot`, `team_id` and `profile`): `name`, `real_name`, `profile.display_name` and
//   `profile.real_name`; the auth.test answer (`url`, `user_id` and `bot_id` at the top): `user`; in a
//   `block_actions` payload, `channel.name`, `user.name` and `user.username`; in a `view_submission` payload,
//   `user.name` and `user.username`; in a `slash_commands` payload, `channel_name` and `user_name`. A finding there
//   is `internal_error`, as in a structural field;
// - in a `block_actions` payload (A3-4, slack/interactive.ts), the agent's own button fields —
//   `actions[].action_id`, `actions[].block_id`, `actions[].value` and `actions[].text.text` — are user
//   content too (ADR-089 addendum, A3-4); the rest of the payload is structural;
// - in the `payload` of a `slash_commands` envelope (A4-3, slack/commands.ts), what the person wrote — `command`
//   (the "/name") and `text` (the args) — is user content too (ADR-089 dec. 1, as `message.command.name`/`args` at
//   the native edge); the rest of the payload is structural;
// - in a form's `view` — the `view` of a `view_submission` payload and the `view` at the top of the views.open
//   answer (slack/views.ts) — the agent's texts (`title.text`, `submit.text`, `close.text`, `private_metadata`,
//   `callback_id`, `external_id` and the whole `blocks`) and the person's values (`state.values`) are user content;
//   so are the KEYS of `state.values` (the agent's `block_id` and `action_id`): they get the id shapes and no
//   check against the deny list. The rest of the view is structural;
// - every other field is STRUCTURAL: the full pattern set, as at the native edge;
// - every KEY is checked against the contract's deny list minus the closed allowlist (`event_id`).
// A finding → `internal_error` and one `leak-blocked` line (path and pattern, never the value).
import { CONVERSATION_NAME_PATTERNS, findProtocolLeaks, ID_SHAPE_PATTERNS, PERSON_NAME_PATTERNS, type Leak, type ProtocolPattern } from '@tayet/shared/leak-scan'
import { SLACK_VOCAB_DENY } from '../../../contract-vocabulary.mjs'

const NO_OPAQUE: ReadonlySet<string> = new Set()
const STRIPPED = '\u0000'
const VOCAB = new RegExp(SLACK_VOCAB_DENY, 'i')

// A message object — and an `app_mention` event (S-f2), whose `text` is the message's.
const isSlackMessage = (v: Record<string, unknown>): boolean => (v.type === 'message' || v.type === 'app_mention') && typeof v.ts === 'string'

// The content fields of one action of a `block_actions` payload.
const ACTION_CONTENT = ['action_id', 'block_id', 'value'] as const
// The content fields of a `slash_commands` payload.
const COMMAND_CONTENT = ['command', 'text'] as const
// The agent's texts of a form's view.
const VIEW_TEXTS = ['title', 'submit', 'close'] as const
const VIEW_CONTENT = ['private_metadata', 'callback_id', 'external_id', 'blocks'] as const

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

const CONVERSATION = CONVERSATION_NAME_PATTERNS
const PERSON = PERSON_NAME_PATTERNS
const isChannel = (v: Record<string, unknown>): boolean => typeof v.is_channel === 'boolean' && typeof v.is_im === 'boolean'
const isUser = (v: Record<string, unknown>): boolean => typeof v.is_bot === 'boolean' && typeof v.team_id === 'string' && isRecord(v.profile)
const isAuthTest = (v: Record<string, unknown>): boolean => typeof v.url === 'string' && typeof v.user_id === 'string' && typeof v.bot_id === 'string'

interface Name {
  path: string
  value: string
  patterns: readonly ProtocolPattern[]
}

function split(root: unknown): { structural: unknown; content: Array<{ path: string; value: unknown }>; names: Name[]; keys: Leak[] } {
  const content: Array<{ path: string; value: unknown }> = []
  const names: Name[] = []
  const keys: Leak[] = []
  // The listed keys of `v` that hold a string are names: taken out for their own scan.
  const named = (v: Record<string, unknown>, p: string, sets: Readonly<Record<string, readonly ProtocolPattern[]>>): Record<string, unknown> => {
    const out = { ...v }
    for (const [k, patterns] of Object.entries(sets)) {
      const value = out[k]
      if (typeof value !== 'string') continue
      names.push({ path: `${p}.${k}`, value, patterns })
      out[k] = STRIPPED
    }
    return out
  }
  const view = (v: unknown, p: string): unknown => {
    if (!isRecord(v)) return walk(v, p)
    const out: Record<string, unknown> = { ...v }
    for (const k of VIEW_TEXTS) {
      const t = out[k]
      if (!isRecord(t) || !('text' in t)) continue
      content.push({ path: `${p}.${k}.text`, value: t.text })
      out[k] = { ...t, text: STRIPPED }
    }
    for (const k of VIEW_CONTENT) {
      if (!(k in out)) continue
      content.push({ path: `${p}.${k}`, value: out[k] })
      out[k] = STRIPPED
    }
    const state = out.state
    if (isRecord(state) && isRecord(state.values)) {
      const q = `${p}.state.values`
      for (const [block, actions] of Object.entries(state.values)) {
        content.push({ path: q, value: block })
        if (!isRecord(actions)) {
          content.push({ path: `${q}.${block}`, value: actions })
          continue
        }
        for (const [action, value] of Object.entries(actions)) content.push({ path: `${q}.${block}`, value: action }, { path: `${q}.${block}.${action}`, value })
      }
      out.state = { ...state, values: STRIPPED }
    }
    return walk(out, p)
  }
  const walk = (v: unknown, path: string): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`))
    if (v === null || typeof v !== 'object') return v
    let obj = v as Record<string, unknown>
    if (isChannel(obj)) {
      obj = named(obj, path, { name: CONVERSATION })
      if (isRecord(obj.topic)) obj.topic = named(obj.topic, `${path}.topic`, { value: CONVERSATION })
    } else if (isUser(obj)) {
      obj = named(obj, path, { name: PERSON, real_name: PERSON })
      obj.profile = named(obj.profile as Record<string, unknown>, `${path}.profile`, { display_name: PERSON, real_name: PERSON })
    } else if (path === '$' && isAuthTest(obj)) {
      obj = named(obj, path, { user: PERSON })
    }
    const message = isSlackMessage(obj)
    const blockActions = obj.type === 'block_actions'
    const slashCommand = obj.type === 'slash_commands'
    const viewSubmission = obj.type === 'view_submission'
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(obj)) {
      const p = `${path}.${k}`
      if (VOCAB.test(k)) keys.push({ path: p, pattern: 'contract-vocabulary', value: k })
      if (slashCommand && k === 'payload' && val !== null && typeof val === 'object' && !Array.isArray(val)) {
        const payload = { ...(val as Record<string, unknown>) }
        for (const f of COMMAND_CONTENT) {
          if (!(f in payload)) continue
          content.push({ path: `${p}.${f}`, value: payload[f] })
          payload[f] = STRIPPED
        }
        out[k] = walk(named(payload, p, { channel_name: CONVERSATION, user_name: PERSON }), p)
      } else if (blockActions && k === 'actions' && Array.isArray(val)) {
        out[k] = val.map((a, i) => {
          if (a === null || typeof a !== 'object' || Array.isArray(a)) return walk(a, `${p}[${i}]`)
          const action = { ...(a as Record<string, unknown>) }
          for (const f of ACTION_CONTENT) {
            if (!(f in action)) continue
            content.push({ path: `${p}[${i}].${f}`, value: action[f] })
            action[f] = STRIPPED
          }
          const text = action.text
          if (text !== null && typeof text === 'object' && !Array.isArray(text) && 'text' in text) {
            content.push({ path: `${p}[${i}].text.text`, value: (text as Record<string, unknown>).text })
            action.text = { ...(text as Record<string, unknown>), text: STRIPPED }
          }
          return walk(action, `${p}[${i}]`)
        })
      } else if ((blockActions || viewSubmission) && k === 'user' && isRecord(val)) {
        out[k] = walk(named(val, p, { name: PERSON, username: PERSON }), p)
      } else if (blockActions && k === 'channel' && isRecord(val)) {
        out[k] = walk(named(val, p, { name: CONVERSATION }), p)
      } else if (message && k === 'reactions' && Array.isArray(val)) {
        out[k] = val.map((r, i) => {
          if (!isRecord(r) || !('name' in r)) return walk(r, `${p}[${i}]`)
          content.push({ path: `${p}[${i}].name`, value: r.name })
          return walk({ ...r, name: STRIPPED }, `${p}[${i}]`)
        })
      } else if (k === 'view' && (viewSubmission || path === '$')) {
        out[k] = view(val, p)
      } else if ((message || path === '$') && k === 'text') {
        content.push({ path: p, value: val })
        out[k] = STRIPPED
      } else if ((message || path === '$') && k === 'files' && Array.isArray(val)) {
        out[k] = val.map((f, i) => {
          if (f === null || typeof f !== 'object') return walk(f, `${p}[${i}]`)
          const { name, title, ...rest } = f as Record<string, unknown>
          content.push({ path: `${p}[${i}].name`, value: name }, { path: `${p}[${i}].title`, value: title })
          return walk({ ...rest, name: STRIPPED, title: STRIPPED }, `${p}[${i}]`)
        })
      } else if (path === '$' && k === 'file' && val !== null && typeof val === 'object' && !Array.isArray(val)) {
        const { name, title, ...rest } = val as Record<string, unknown>
        content.push({ path: `${p}.name`, value: name }, { path: `${p}.title`, value: title })
        out[k] = walk({ ...rest, name: STRIPPED, title: STRIPPED }, p)
      } else {
        out[k] = walk(val, p)
      }
    }
    return out
  }
  return { structural: walk(root, '$'), content, names, keys }
}

export function scanSlack(root: unknown): Leak[] {
  const { structural, content, names, keys } = split(root)
  const leaks = [...keys, ...findProtocolLeaks(structural, NO_OPAQUE)]
  for (const { path, value, patterns } of names) {
    for (const leak of findProtocolLeaks(value, NO_OPAQUE, patterns)) leaks.push({ ...leak, path })
  }
  for (const { path, value } of content) {
    for (const leak of findProtocolLeaks(value, NO_OPAQUE, ID_SHAPE_PATTERNS)) leaks.push({ ...leak, path: path + leak.path.slice(1) })
  }
  return leaks
}
