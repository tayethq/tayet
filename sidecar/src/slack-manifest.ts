// `--slack-manifest <file>` (PLANO-AGENTES §0.3.25 items 1–3; A4-3): a Slack app manifest, in JSON, read at the
// boot before the core starts; its `features.slash_commands[]` become the agent's declared set of commands (the
// A4-2a core, core/commands.ts), declared on the first healthy sync by the PUT /v1/commands path.
//
// - `command` → the name (without the slash, lowercase), `description` → the description, `usage_hint` → the hint.
// - Out of the rules (item 2) — a file that cannot be read or is not JSON (YAML is not accepted), a name outside
//   the rule of §0.3.21 item 4, a repeated name, a missing description, more than 25 commands, a set over 8 KiB, a
//   leak-scan finding (the write's own probe, api/edge.ts scanCommandsProbe): a UsageError whose message says the
//   position of the entry and the rule, never the content. The sidecar does not start (64).
// - A description over 100 characters or a hint over 60 is cut at the limit, with an ellipsis; the caller logs one
//   line with the counts. A manifest with no slash commands declares the empty set.
import { readFileSync } from 'node:fs'
import { COMMAND_DESCRIPTION_MAX, COMMAND_HINT_MAX, COMMANDS_MAX, type CommandEntry } from '@tayet/shared/internal'
import { UsageError } from './args'
import { scanCommandsProbe } from './api/edge'
import { validateCommands, type CommandsCore } from './core/commands'

export interface SlackManifest {
  commands: CommandEntry[]
  // How many descriptions and hints were cut at the limit.
  cut: { descriptions: number; hints: number }
}

const ELLIPSIS = '…'
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// Cut at `max` code points (the ellipsis included); the trimmed text when it fits.
function cutAt(text: string, max: number): { text: string; cut: boolean } {
  const trimmed = text.trim()
  const points = [...trimmed]
  if (points.length <= max) return { text: trimmed, cut: false }
  return { text: points.slice(0, max - 1).join('').trimEnd() + ELLIPSIS, cut: true }
}

const fail = (rule: string): never => {
  throw new UsageError(`--slack-manifest: ${rule}`)
}

// The set of a manifest already parsed (pure; the tests call it).
export function commandsOfManifest(raw: unknown): SlackManifest {
  if (!isRecord(raw)) fail('the manifest is not a JSON object')
  const features = (raw as Record<string, unknown>).features
  if (features !== undefined && !isRecord(features)) fail('features is not an object')
  const list = isRecord(features) ? features.slash_commands : undefined
  if (list === undefined) return { commands: [], cut: { descriptions: 0, hints: 0 } }
  if (!Array.isArray(list)) fail('features.slash_commands is not a list')
  const entries = list as unknown[]
  if (entries.length > COMMANDS_MAX) fail(`more than ${COMMANDS_MAX} slash commands`)
  const seen = new Set<string>()
  const commands: CommandEntry[] = []
  const cut = { descriptions: 0, hints: 0 }
  entries.forEach((entry, i) => {
    const at = `slash command ${i + 1}`
    if (!isRecord(entry)) fail(`${at} is not an object`)
    const e = entry as Record<string, unknown>
    if (typeof e.command !== 'string') fail(`${at}: command is missing`)
    const name = (e.command as string).replace(/^\//, '').toLowerCase()
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) fail(`${at}: the command must be a slash and 1 to 32 of a-z, 0-9, - and _, starting with a letter or a digit`)
    if (seen.has(name)) fail(`${at}: the command repeats an earlier one`)
    seen.add(name)
    if (typeof e.description !== 'string' || e.description.trim() === '') fail(`${at}: description is missing`)
    const description = cutAt(e.description as string, COMMAND_DESCRIPTION_MAX)
    if (description.cut) cut.descriptions += 1
    let hint: string | undefined
    if (e.usage_hint !== undefined && e.usage_hint !== null) {
      if (typeof e.usage_hint !== 'string') fail(`${at}: usage_hint is not text`)
      const h = cutAt(e.usage_hint as string, COMMAND_HINT_MAX)
      if (h.cut) cut.hints += 1
      if (h.text !== '') hint = h.text
    }
    commands.push({ name, description: description.text, ...(hint !== undefined && { hint }) })
  })
  // The write's strict rules (one line each, the 8 KiB of the whole set), then its leak-scan.
  let valid: CommandEntry[]
  try {
    valid = validateCommands(commands)
  } catch {
    const at = commands.findIndex((c) => {
      try {
        validateCommands([c])
        return false
      } catch {
        return true
      }
    })
    return fail(at >= 0 ? `slash command ${at + 1}: description and usage_hint must be one line each` : 'the slash commands are over 8 KiB')
  }
  if (scanCommandsProbe(valid).length > 0) {
    const at = valid.findIndex((c) => scanCommandsProbe([c]).length > 0)
    fail(`slash command ${at + 1}: an internal identifier in the command, the description or the usage_hint`)
  }
  return { commands: valid, cut }
}

// The file at the boot: read once, JSON only.
export function readSlackManifest(file: string): SlackManifest {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return fail('the file cannot be read')
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail('the file is not JSON (YAML is not accepted)')
  }
  return commandsOfManifest(raw)
}

// The first healthy sync of a run (§0.3.25 item 3). With a manifest, its set is declared by the PUT /v1/commands
// path (the facade): the hashes per conversation keep what did not change from being written again, and a PUT or
// a DELETE (set_commands, clear_commands) after it holds until the next boot. Without one, nothing changes: the
// boot compares the hashes of the stored set (A4-2a).
export function declareAtBoot(commands: Pick<CommandsCore, 'facade' | 'reconcile'>, manifest: SlackManifest | undefined, log: (line: Record<string, unknown>) => void): Promise<void> {
  if (manifest === undefined) {
    commands.reconcile()
    return Promise.resolve()
  }
  return commands.facade.set(manifest.commands).then(
    () => log({ evt: 'slack-manifest-declared', commands: manifest.commands.length }),
    (err: unknown) => log({ evt: 'slack-manifest-failed', name: err instanceof Error ? err.name : typeof err }),
  )
}
