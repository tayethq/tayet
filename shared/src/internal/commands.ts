// ADR-093 (Proposto): the agent's `/` commands — the manifest's block and the command marker of a person's
// message. Pure — no SDK, no network — so the client (A4-1) and the sidecar (A4-2) read the same shape
// (PLANO-AGENTES §0.3.21 items 1, 2, 4 and 7). The write validates strictly (the sidecar, A4-2); this read is
// tolerant.
import { COMMANDS_BLOCK, COMMANDS_MSGTYPE, COMMAND_MARKER } from './product-events'
import { LINE_BREAK } from './panel'

// The limits (§0.3.21 item 4). The name is kept without the slash, ASCII only (trigger: the first agent that
// asks for accents). Description and hint: one line each, counted in code points after a trim.
export const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const COMMAND_DESCRIPTION_MAX = 100
export const COMMAND_HINT_MAX = 60
export const COMMANDS_MAX = 25
export const COMMANDS_MANIFEST_MAX_BYTES = 8 * 1024

// One command as the manifest declares it.
export interface CommandEntry {
  name: string
  description: string
  hint?: string
}

export interface CommandsBlock {
  commands: CommandEntry[]
  cleared: boolean
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// One line of text, trimmed, between `min` and `max` code points; else undefined.
function oneLine(raw: unknown, min: number, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  const length = [...text].length
  if (LINE_BREAK.test(text) || length < min || length > max) return undefined
  return text
}

// A name that keeps the rule, else undefined. Never trimmed: a name with spaces is outside the rule.
export function commandNameOf(raw: unknown): string | undefined {
  return typeof raw === 'string' && COMMAND_NAME_RE.test(raw) ? raw : undefined
}

// A description that keeps the rule (1 to 100 code points, one line), else undefined.
export function commandDescriptionOf(raw: unknown): string | undefined {
  return oneLine(raw, 1, COMMAND_DESCRIPTION_MAX)
}

// A hint: `''` when absent or blank (0 is allowed), the trimmed text when it keeps the rule (up to 60 code
// points, one line), else undefined (outside the rule).
export function commandHintOf(raw: unknown): string | undefined {
  if (raw === undefined) return ''
  return oneLine(raw, 0, COMMAND_HINT_MAX)
}

// The block of the content a manifest SHOWS (the author's latest edit's new content, or the original):
// undefined when the content is not a manifest or its block is present and not an object (the agent has no
// commands). An absent block is a manifest with no commands, not cleared. Tolerant: an entry outside the
// rule is dropped; of the rest, a repeated name keeps the first; then the first 25. A cleared manifest has
// no commands.
export function readCommandsBlock(content: Record<string, unknown>): CommandsBlock | undefined {
  if (content.msgtype !== COMMANDS_MSGTYPE) return undefined
  const block = content[COMMANDS_BLOCK]
  if (block === undefined) return { commands: [], cleared: false }
  if (!isRecord(block)) return undefined
  if (block.cleared === true) return { commands: [], cleared: true }
  const raw = Array.isArray(block.commands) ? block.commands : []
  const seen = new Set<string>()
  const commands: CommandEntry[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const name = commandNameOf(entry.name)
    const description = commandDescriptionOf(entry.description)
    const hint = commandHintOf(entry.hint)
    if (name === undefined || description === undefined || hint === undefined || seen.has(name)) continue
    seen.add(name)
    commands.push({ name, description, ...(hint !== '' && { hint }) })
    if (commands.length === COMMANDS_MAX) break
  }
  return { commands, cleared: false }
}

// The command marker of a message's content, raw (`to` is the agent's protocol id: below the barrel only),
// or undefined when there is none or it is outside the rule.
export function readCommandMarker(content: Record<string, unknown>): { name: string; to: string } | undefined {
  const marker = content[COMMAND_MARKER]
  if (!isRecord(marker)) return undefined
  const name = commandNameOf(marker.name)
  if (name === undefined || typeof marker.to !== 'string' || marker.to === '') return undefined
  return { name, to: marker.to }
}

// Whether a message's text starts with the command: "/name" followed by the end or whitespace (the
// arguments are the rest). The send checks the same before sending (§0.3.21 items 7–8).
export function startsWithCommand(text: string, name: string): boolean {
  const prefix = `/${name}`
  if (!text.startsWith(prefix)) return false
  const next = text.charAt(prefix.length)
  return next === '' || /\s/.test(next)
}
