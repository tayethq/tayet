// The Slack layer's edge (PLANO-AGENTES §0.3.12 item 2). The native data the layer translates has
// already passed the native edge (api/edge.ts `scanEdge`) — the layer calls it on every ApiMessage and
// every listing BEFORE translating. What the translation adds is then scanned here, by path:
// - USER CONTENT of the Slack shape — the `text` of a message object (`type: 'message'` + `ts`) and the
//   `name`/`title` of its files; at the top of an answer, the `text` (chat.update echoes the message's
//   text there, §8.20), the `files` (files.completeUploadExternal) and the `file` (files.info, S-f3) — gets
//   the id shapes only (an mrkdwn
//   `<@U…>` is a token, never an id). The content paths are these and nothing else: a `text` or a `name`
//   anywhere else (a topic, a person, an object that is not a message) stays structural;
// - in a `block_actions` payload (A3-4, slack/interactive.ts), the agent's own button fields —
//   `actions[].action_id`, `actions[].block_id`, `actions[].value` and `actions[].text.text` — are user
//   content too (ADR-089 addendum, A3-4); the rest of the payload is structural;
// - in the `payload` of a `slash_commands` envelope (A4-3, slack/commands.ts), what the person wrote — `command`
//   (the "/name") and `text` (the args) — is user content too (ADR-089 dec. 1, as `message.command.name`/`args` at
//   the native edge); the rest of the payload is structural;
// - every other field is STRUCTURAL: the full pattern set, as at the native edge;
// - every KEY is checked against the contract's deny list minus the closed allowlist (`event_id`).
// A finding → `internal_error` and one `leak-blocked` line (path and pattern, never the value).
import { findProtocolLeaks, ID_SHAPE_PATTERNS, type Leak } from '@tayet/shared/leak-scan'
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

function split(root: unknown): { structural: unknown; content: Array<{ path: string; value: unknown }>; keys: Leak[] } {
  const content: Array<{ path: string; value: unknown }> = []
  const keys: Leak[] = []
  const walk = (v: unknown, path: string): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`))
    if (v === null || typeof v !== 'object') return v
    const obj = v as Record<string, unknown>
    const message = isSlackMessage(obj)
    const blockActions = obj.type === 'block_actions'
    const slashCommand = obj.type === 'slash_commands'
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
        out[k] = walk(payload, p)
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
  return { structural: walk(root, '$'), content, keys }
}

export function scanSlack(root: unknown): Leak[] {
  const { structural, content, keys } = split(root)
  const leaks = [...keys, ...findProtocolLeaks(structural, NO_OPAQUE)]
  for (const { path, value } of content) {
    for (const leak of findProtocolLeaks(value, NO_OPAQUE, ID_SHAPE_PATTERNS)) leaks.push({ ...leak, path: path + leak.path.slice(1) })
  }
  return leaks
}
