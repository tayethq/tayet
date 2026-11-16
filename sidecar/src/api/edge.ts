// The leak-scan at the sidecar's edge (ADR-087 dec. 4; ADR-089 dec. 1; PLANO-AGENTES §0.3.6 adj. 4):
// every response and every event of the local API passes here before it leaves the process.
//
// Two layers, by field:
// - STRUCTURAL fields (ids, names, topics, kinds, keys — everything that is not user content) get the
//   full pattern set: a protocol word there is the product talking.
// - USER CONTENT gets only the id shapes (mxid, room id, event id, media URI) and the envelope keys:
//   a person may write "verify" or "cofre" in a message (measured false positives, §0.3.6); an id
//   there is still a construction leak. The content fields are explicit (CONTENT below), by path.
//
// No opaque keys: at this edge every id is a token (api/ids.ts), so nothing is exempt. A finding →
// the caller withholds the value (500 `internal` for a response; `unavailable` for an event) and one
// `leak-blocked` line names the path and the pattern, never the value.
import { findProtocolLeaks, ID_SHAPE_PATTERNS, type Leak } from '@tayet/shared/leak-scan'

// The user-content fields of the contract (api/contract.ts), by position:
// - `text` and `rich` (the whole subtree) of a message;
// - `name` of a file of a message (`files[].name`);
// - an approval card's options (ADR-089 addendum, A3-3): `id` and `label` of each option, and the chosen
//   option's `id` — in the `approval` of a message or of the state answer (`approval.answer.option`) and
//   in the `approval.answered` event (`option`). The agent wrote them: "Verificar" is a label, not the
//   product talking. Everything else of the card (`style`, `state`, `by`, `at`) is structural.
// - the pinned panel's `text` and `title` (ADR-089 addendum, A3-6), in the panel's GET: the agent wrote them.
//   `updatedAt` and the rest of the answer are structural.
// - the agent's `/` commands (ADR-089 addendum, A4-2a): `name`, `description` and `hint` of each command, in the
//   `commands` of the commands' GET: the agent wrote them. `pending` is structural.
// Any other `name` (conversation, person, the agent) is structural.
export const CONTENT_FIELDS = [
  'message.text',
  'message.rich',
  'message.files[].name',
  'approval.options[].id',
  'approval.options[].label',
  'approval.answer.option',
  'approval.answered.option',
  'panel.text',
  'panel.title',
  'commands[].name',
  'commands[].description',
  'commands[].hint',
  'message.command.name',
  'message.command.args',
] as const

const NO_OPAQUE: ReadonlySet<string> = new Set()
const STRIPPED = '\u0000'

interface Split {
  structural: unknown
  content: Array<{ path: string; value: unknown }>
}

// A message object is recognized by its shape (id + conversation + author + text): that is where the
// content fields live, wherever the message sits (a listing, an event).
function isMessage(v: Record<string, unknown>): boolean {
  return typeof v.id === 'string' && typeof v.conversation === 'string' && typeof v.author === 'string' && typeof v.text === 'string'
}

function split(root: unknown): Split {
  const content: Split['content'] = []
  const strip = (value: unknown, path: string): unknown => {
    content.push({ path, value })
    return STRIPPED
  }
  // An `approval` object: the options' id/label and the answer's option are content; the rest structural.
  const approval = (v: Record<string, unknown>, path: string): unknown => {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      const p = `${path}.${k}`
      if (k === 'options' && Array.isArray(val)) {
        out[k] = val.map((o, i) => {
          if (o === null || typeof o !== 'object' || Array.isArray(o)) return walk(o, `${p}[${i}]`)
          const { id, label, ...rest } = o as Record<string, unknown>
          return walk({ ...rest, id: strip(id, `${p}[${i}].id`), label: strip(label, `${p}[${i}].label`) }, `${p}[${i}]`)
        })
      } else if (k === 'answer' && val !== null && typeof val === 'object' && !Array.isArray(val)) {
        const { option, ...rest } = val as Record<string, unknown>
        out[k] = walk(option === undefined ? rest : { ...rest, option: strip(option, `${p}.option`) }, p)
      } else {
        out[k] = walk(val, p)
      }
    }
    return out
  }
  const walk = (v: unknown, path: string): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`))
    if (v === null || typeof v !== 'object') return v
    const obj = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    const message = isMessage(obj)
    const answered = obj.type === 'approval.answered'
    for (const [k, val] of Object.entries(obj)) {
      const p = `${path}.${k}`
      if (k === 'approval' && val !== null && typeof val === 'object' && !Array.isArray(val)) {
        out[k] = approval(val as Record<string, unknown>, p)
      } else if (k === 'panel' && val !== null && typeof val === 'object' && !Array.isArray(val)) {
        const { text, title, ...rest } = val as Record<string, unknown>
        out[k] = walk({ ...rest, text: strip(text, `${p}.text`), ...(title !== undefined && { title: strip(title, `${p}.title`) }) }, p)
      } else if (k === 'commands' && Array.isArray(val)) {
        out[k] = val.map((c, i) => {
          if (c === null || typeof c !== 'object' || Array.isArray(c)) return walk(c, `${p}[${i}]`)
          const { name, description, hint, ...rest } = c as Record<string, unknown>
          const q = `${p}[${i}]`
          return walk({ ...rest, name: strip(name, `${q}.name`), description: strip(description, `${q}.description`), ...(hint !== undefined && { hint: strip(hint, `${q}.hint`) }) }, q)
        })
      } else if (message && k === 'command' && val !== null && typeof val === 'object' && !Array.isArray(val)) {
        // ADR-089 addendum (A4-2b): a command's name and args are what the person typed.
        const { name, args, ...rest } = val as Record<string, unknown>
        out[k] = walk({ ...rest, name: strip(name, `${p}.name`), args: strip(args, `${p}.args`) }, p)
      } else if (answered && k === 'option') {
        out[k] = strip(val, p)
      } else if (message && (k === 'text' || k === 'rich')) {
        content.push({ path: p, value: val })
        out[k] = STRIPPED
      } else if (message && k === 'files' && Array.isArray(val)) {
        out[k] = val.map((f, i) => {
          if (f === null || typeof f !== 'object') return walk(f, `${p}[${i}]`)
          const { name, ...rest } = f as Record<string, unknown>
          content.push({ path: `${p}[${i}].name`, value: name })
          return walk({ ...rest, name: STRIPPED }, `${p}[${i}]`)
        })
      } else {
        out[k] = walk(val, p)
      }
    }
    return out
  }
  return { structural: walk(root, '$'), content }
}

export function scanEdge(root: unknown): Leak[] {
  const { structural, content } = split(root)
  const leaks = findProtocolLeaks(structural, NO_OPAQUE)
  for (const { path, value } of content) {
    for (const leak of findProtocolLeaks(value, NO_OPAQUE, ID_SHAPE_PATTERNS)) {
      leaks.push({ ...leak, path: path + leak.path.slice(1) })
    }
  }
  return leaks
}

// The answer a write would give, scanned before the write (server.ts `preflight`, the MCP tools): a
// probe message with the text (and the file name) the write would carry. What the edge would withhold
// after the send is refused before any effect — a withheld answer invites a retry and a duplicate.
export function scanWriteProbe(conversation: string, text: string, fileName?: string): Leak[] {
  return scanEdge({
    id: '0.000000',
    conversation,
    author: 'U',
    text,
    mentionsMe: false,
    reactions: [],
    ...(fileName !== undefined && { files: [{ id: 'F', name: fileName, mimetype: 'application/octet-stream', size: 0 }] }),
  })
}

// The answer a card would give (the approvals POST, request_approval): the probe message with the card's
// options — an id shape in a label is refused before any effect, as in a text.
export function scanApprovalProbe(conversation: string, text: string, options: ReadonlyArray<{ id: string; label: string; style?: string }>): Leak[] {
  return scanEdge({ id: '0.000000', conversation, author: 'U', text, mentionsMe: false, reactions: [], approval: { options, state: 'open' } })
}

// The answer of the panel's GET with the text and title a PUT would carry: an id shape in either is refused
// before anything is queued.
export function scanPanelProbe(conversation: string, text: string, title?: string): Leak[] {
  return scanEdge({ conversation, panel: { ...(title !== undefined && { title }), text, updatedAt: 0 }, pending: true })
}

// The answer of the commands' GET with the set a PUT would carry: an id shape in a name, a description or a
// hint is refused before anything is written (ADR-093; PLANO-AGENTES §0.3.22 item 1).
export function scanCommandsProbe(commands: ReadonlyArray<{ name: unknown; description: unknown; hint?: unknown }>): Leak[] {
  return scanEdge({ commands, pending: 0 })
}

// One user-content value alone (a file name in a header): the id shapes and the envelope keys only.
export function scanContent(value: unknown): Leak[] {
  return findProtocolLeaks(value, NO_OPAQUE, ID_SHAPE_PATTERNS)
}

export function logLeaks(log: (line: Record<string, unknown>) => void, where: string, leaks: readonly Leak[]): void {
  for (const leak of leaks) log({ evt: 'leak-blocked', where, path: leak.path, pattern: leak.pattern })
}
