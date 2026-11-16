// The agent's `/` commands in the sidecar (ADR-093, Proposto; PLANO-AGENTES §0.3.21 items 10–11 and §0.3.22,
// A4-2a): the agent declares ONE set, valid in every conversation it is a member of, and the sidecar writes the
// manifest — a message of the agent related to the conversation's creation event by the commands' relation
// type, updated by edits (core/anchored.ts) — in each of them.
//
// - The set is validated strictly (§0.3.21 item 4): name, description and hint by the shared rules, at most
//   25, no repeated name, no unknown field, the manifest at most 8 KiB (the JSON of `{ commands }`, in UTF-8).
//   The leak-scan of the three fields is the API layer's, before the facade (api/edge.ts).
// - On disk (§0.3.22 item 2): `<store>/commands.json`, 0600, written atomically and in sequence — the declared
//   set and, per conversation, the hash of the version written there. The conversation is the API token,
//   never a protocol id. Kept across the device wipes, as approvals.json.
// - Distribution (item 3): every conversation the agent is a member of whose hash differs from the set's is
//   marked pending (the panel's scheduler, the `commands` lane); one whose hash is the set's is unmarked.
//   Joining a conversation marks it; leaving it drops its pending version and its hash. At the boot (the first
//   healthy sync) the hashes are compared and only what differs is written: a restart with no change reads
//   and writes nothing. Declaring the same set again writes nothing.
// - Clearing (item 4): DELETE, or an empty set, clears in every conversation with a manifest written (the
//   edit carrying the clear mark) and empties the set; with nothing written and no set there is nothing to do.
// - Writing (item 5): the first write in a conversation looks for the agent's own manifest through the
//   anchor's relations and edits it; with none, sends a new one.
// - The re-edit on entry (item 7): a person's live entry (the panel's trigger and window, core/panels.ts
//   `afterEntry`) rewrites the conversation's manifest with the stored set — nothing is decrypted — after the
//   panel's part. An empty set rewrites nothing; a write of the manifest scheduled in that conversation after
//   the window opened (a PUT, a DELETE, the boot's or a join's) cancels it, as a new write does the panel's.
// - A revocation or a stop of the core stops the scheduler: what is pending is lost (the hashes say what the
//   next boot writes).
// - Nothing of the protocol and nothing of the content reaches a log line.
import type { Room } from 'matrix-js-sdk'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  COMMANDS_MANIFEST_MAX_BYTES,
  COMMANDS_MAX,
  COMMANDS_REL_TYPE,
  buildCommandsContent,
  buildCommandsEditContent,
  commandDescriptionOf,
  commandHintOf,
  commandNameOf,
  readCommandsBlock,
  type CommandEntry,
} from '@tayet/shared/internal'
import type { ApiCommandsAccepted, ApiCommandsStatus } from '../api/contract'
import { anchorOf, createAnchoredReader, type AnchoredClient, type AnchoredLane, type AnchoredOutcome, type AnchoredScheduler, type OwnAnchored } from './anchored'
import type { SendResult } from './queue'
import type { Resolver } from './read'
import type { WriteJob } from './send'
import { WriteError } from './write'
import { writeJsonAtomic } from '../store'

type Log = (line: Record<string, unknown>) => void

const COMMAND_FIELDS: ReadonlySet<string> = new Set(['name', 'description', 'hint'])
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// The strict validation of a declared set (§0.3.21 item 4): the normalized set (description and hint trimmed,
// an empty hint left out), or WriteError — `invalid_argument` for a rule, `payload_too_large` over 8 KiB.
export function validateCommands(raw: unknown): CommandEntry[] {
  if (!Array.isArray(raw) || raw.length > COMMANDS_MAX) throw new WriteError('invalid_argument')
  const seen = new Set<string>()
  const out: CommandEntry[] = []
  for (const entry of raw) {
    if (!isRecord(entry) || Object.keys(entry).some((k) => !COMMAND_FIELDS.has(k))) throw new WriteError('invalid_argument')
    const name = commandNameOf(entry.name)
    const description = typeof entry.description === 'string' ? commandDescriptionOf(entry.description) : undefined
    const hint = entry.hint === undefined || typeof entry.hint === 'string' ? commandHintOf(entry.hint) : undefined
    if (name === undefined || description === undefined || hint === undefined || seen.has(name)) throw new WriteError('invalid_argument')
    seen.add(name)
    out.push({ name, description, ...(hint !== '' && { hint }) })
  }
  if (Buffer.byteLength(JSON.stringify({ commands: out }), 'utf8') > COMMANDS_MANIFEST_MAX_BYTES) throw new WriteError('payload_too_large')
  return out
}

// The hash of a version: what `commands.json` keeps per conversation (the order counts: it is the fallback's).
export const hashOf = (commands: readonly CommandEntry[]): string => createHash('sha256').update(JSON.stringify(commands)).digest('hex')

export type CommandsVersion = { kind: 'write'; commands: CommandEntry[]; hash: string } | { kind: 'clear' }

export interface CommandsFacade {
  // The whole set; an empty one clears. Settles once the set is on disk and the writes are queued.
  set(commands: unknown): Promise<ApiCommandsAccepted>
  // null: nothing written and no set — nothing to do (the 204).
  clear(): Promise<ApiCommandsAccepted | null>
  get(): ApiCommandsStatus
}

export interface CommandsDeps {
  client: AnchoredClient & { getRooms(): Room[] }
  resolver: Pick<Resolver, 'tokenOfRoom'>
  enqueue(job: WriteJob): Promise<SendResult>
  scheduler: AnchoredScheduler
  file: string
  log: Log
}

export interface CommandsCore {
  facade: CommandsFacade
  // The file of earlier runs (a file that cannot be read is an empty set, with a log line).
  load(): Promise<void>
  // The first healthy sync: write only what differs (item 3).
  reconcile(): void
  // The agent's own membership changed (a join marks the conversation; a leave forgets it).
  noteMembership(roomId: string, membership: string | undefined): void
  // A person's entry window opens (core/panels.ts `afterEntry`); what it returns, called at the window's end, is
  // the re-edit (item 7) — none if a write was scheduled in that conversation since.
  entry(roomId: string): () => void
  // Whether a command name is in the set declared now (the read side's port, PLANO-AGENTES §0.3.23 item 1).
  declares(name: string): boolean
  // Resolves once the file writes queued so far are done.
  idle(): Promise<void>
  // The revocation or the stop of the core; resolves once the file writes in flight are done.
  stop(): Promise<void>
}

export function createCommandsCore(deps: CommandsDeps): CommandsCore {
  const { client, resolver, log } = deps
  const me = (): string => {
    const id = client.getUserId()
    if (id === null) throw new Error('no user id')
    return id
  }
  const reader = createAnchoredReader(client, me, COMMANDS_REL_TYPE)
  let declared: CommandEntry[] = []
  let declaredHash = hashOf([])
  // Conversation token → the hash of the version written there.
  const written = new Map<string, string>()
  let saving: Promise<void> = Promise.resolve()
  let stopped = false

  const persist = (): Promise<void> => {
    saving = saving
      .then(() => writeJsonAtomic(deps.file, { commands: declared, written: Object.fromEntries(written) }))
      .catch(() => log({ evt: 'commands-file-error' }))
    return saving
  }

  const joined = (roomId: string): Room | null => {
    const room = client.getRoom(roomId)
    return room !== null && room.getMyMembership() === 'join' ? room : null
  }

  const isCleared = (found: OwnAnchored): boolean => found.shown !== undefined && readCommandsBlock(found.shown.content)?.cleared === true

  const write = async (roomId: string, version: CommandsVersion): Promise<AnchoredOutcome> => {
    const room = joined(roomId)
    if (room === null) return { kind: 'not-member' }
    let found: OwnAnchored | null
    try {
      found = await reader.find(roomId)
    } catch {
      log({ evt: 'commands-read-failed' })
      return { kind: 'failed' }
    }
    const token = resolver.tokenOfRoom(roomId)
    let content: Record<string, unknown>
    if (version.kind === 'clear') {
      // Nothing to clear: no manifest, or one already cleared.
      if (found === null || isCleared(found)) {
        if (written.delete(token)) void persist()
        return { kind: 'ok' }
      }
      content = buildCommandsEditContent({ cleared: true }, found.eventId)
    } else if (found !== null) {
      content = buildCommandsEditContent({ commands: version.commands }, found.eventId)
    } else {
      const anchor = anchorOf(room)
      if (anchor === undefined) {
        log({ evt: 'commands-anchor-missing' })
        return { kind: 'failed' }
      }
      content = buildCommandsContent(version.commands, anchor)
    }
    const result = await deps.enqueue({ kind: 'commands', channel: roomId, content })
    if (result.ok) {
      if (found === null) reader.remember(roomId, result.messageId)
      // A conversation left while the write flew is not kept.
      if (joined(roomId) !== null) {
        if (version.kind === 'clear') written.delete(token)
        else written.set(token, version.hash)
        // Chained, not awaited: the scheduler's turn ends with the server's answer.
        void persist()
      }
      return { kind: 'ok' }
    }
    switch (result.error.kind) {
      case 'rate-limited':
        return { kind: 'rate-limited', retryAfterMs: result.error.retryAfterMs }
      case 'not-member':
        return { kind: 'not-member' }
      case 'revoked':
      case 'stopped':
        return { kind: 'stop' }
      case 'reply-in-thread':
      case 'failed':
        return { kind: 'failed' }
    }
  }

  const lane: AnchoredLane<CommandsVersion> = deps.scheduler.lane<CommandsVersion>('commands', write)
  // Bumped by every write scheduled in a conversation: an entry window that saw it change re-edits nothing.
  const scheduled = new Map<string, number>()
  const schedule = (roomId: string, version: CommandsVersion): void => {
    scheduled.set(roomId, (scheduled.get(roomId) ?? 0) + 1)
    lane.schedule(roomId, version)
  }

  // One conversation against the set: the set's hash written → nothing pending; else the set (or, with no
  // set, the clear of what was written).
  const settle = (roomId: string): void => {
    const have = written.get(resolver.tokenOfRoom(roomId))
    if (declared.length > 0) {
      if (have === declaredHash) lane.drop(roomId)
      else schedule(roomId, { kind: 'write', commands: declared, hash: declaredHash })
    } else if (have !== undefined) {
      schedule(roomId, { kind: 'clear' })
    } else {
      lane.drop(roomId)
    }
  }

  // Every conversation the agent is a member of; the hashes of conversations it is no longer in leave the file.
  const distribute = async (): Promise<void> => {
    const tokens = new Set<string>()
    for (const room of client.getRooms()) {
      if (room.getMyMembership() !== 'join') continue
      tokens.add(resolver.tokenOfRoom(room.roomId))
      settle(room.roomId)
    }
    let pruned = false
    for (const token of [...written.keys()]) {
      if (!tokens.has(token)) pruned = written.delete(token) || pruned
    }
    if (pruned) await persist()
  }

  const declare = async (commands: CommandEntry[]): Promise<number> => {
    const hash = hashOf(commands)
    if (hash !== declaredHash) {
      declared = commands
      declaredHash = hash
      await persist()
    }
    await distribute()
    return lane.count()
  }

  const facade: CommandsFacade = {
    set: (raw) =>
      Promise.resolve().then(async () => {
        if (stopped) throw new WriteError('unavailable')
        return { pending: await declare(validateCommands(raw)) }
      }),
    async clear() {
      if (stopped) throw new WriteError('unavailable')
      if (declared.length === 0) {
        // No set: only what is written (in the conversations the agent is still in) is cleared.
        await distribute()
        if (lane.count() === 0) return null
        return { pending: lane.count() }
      }
      return { pending: await declare([]) }
    },
    get: () => ({ commands: declared.map((c) => ({ ...c })), pending: lane.count() }),
  }

  return {
    facade,
    declares: (name) => declared.some((c) => c.name === name),
    async load() {
      let raw: unknown
      try {
        raw = JSON.parse(await readFile(deps.file, 'utf8'))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log({ evt: 'commands-file-unreadable' })
        return
      }
      // A file that cannot be read is ignored whole: never a clear of what was written.
      let commands: CommandEntry[]
      try {
        if (!isRecord(raw)) throw new Error('not an object')
        commands = validateCommands(raw.commands ?? [])
      } catch {
        return log({ evt: 'commands-file-unreadable' })
      }
      declared = commands
      declaredHash = hashOf(declared)
      if (isRecord(raw) && isRecord(raw.written)) for (const [token, hash] of Object.entries(raw.written)) if (typeof hash === 'string') written.set(token, hash)
    },
    reconcile() {
      if (stopped) return
      void distribute()
    },
    noteMembership(roomId, membership) {
      if (stopped) return
      if (membership === 'join') return settle(roomId)
      if (membership !== 'leave' && membership !== 'ban') return
      lane.drop(roomId)
      if (written.delete(resolver.tokenOfRoom(roomId))) void persist()
    },
    entry(roomId) {
      const opened = scheduled.get(roomId) ?? 0
      return () => {
        if (stopped || declared.length === 0 || joined(roomId) === null || lane.pending(roomId) || (scheduled.get(roomId) ?? 0) !== opened) return
        lane.schedule(roomId, { kind: 'write', commands: declared, hash: declaredHash })
      }
    },
    idle: () => saving,
    stop() {
      stopped = true
      deps.scheduler.stop()
      return saving
    },
  }
}
