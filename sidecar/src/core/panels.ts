// The agent's own pinned panel in the sidecar (ADR-091 (Proposto) dec. 13; PLANO-AGENTES §0.3.16 items 15–17,
// §0.3.18 items 1–2 and 7, and the A3-6 forks). The panel is a message of the agent related to the
// conversation's creation event (the anchor) by the panel's relation type, updated by edits; clearing is an
// edit carrying the mark.
//
// - Nothing at rest: the panel is found through the anchor's relations, read FORWARD and paged — the agent's
//   own only; with more than one, the latest write wins — and its content is the agent's own latest edit (or
//   the original), decrypted. Only the found id is kept, in memory, per conversation. After a lost store the
//   same message is found again; its old content does not decrypt, so it is not re-edited until the next write.
// - The writes are a WriteJob of their own (`panel`, core/send.ts) through the single write queue, which hands
//   the server's limit back at once and never applies the 30 s deadline of a message (core/queue.ts).
// - The reader and the scheduler are the anchored ones (core/anchored.ts), shared with the commands manifest
//   (core/commands.ts): the panel is a relation type of the reader and a lane of the scheduler, and in the boot
//   both kinds share ONE budget (§0.3.22 item 6), the panel first when both are pending.
// - The scheduler (§0.3.16 item 17): at most ONE panel write every 10 s per agent, all conversations together,
//   in rotation among the conversations with a pending version; the newest version of a conversation replaces
//   the pending one (a clear replaces a write and the other way round). Messages first: the scheduler only
//   takes its turn when the write queue is empty, otherwise it tries again in 1 s and keeps its turn. The
//   server's limit keeps the version pending and the next attempt waits the server's `retryAfterMs`. An agent
//   no longer a member drops the version (`panel-dropped`, no id). A revocation or a stop of the core stops the
//   scheduler and what is pending is lost.
// - The re-edit on entry (§0.3.16 item 16): the live entry of a PERSON (member or guest; never an agent or an
//   infrastructure account) starts a random delay of 0–10 s per conversation; entries inside that window make
//   one re-edit. At its end, a panel that is not cleared and decrypts is written again with the same content
//   and title, under the same budget; one that does not decrypt is skipped (`panel-reedit-skipped`). A new
//   write (PUT or DELETE) in that conversation cancels the pending re-edit. With `afterEntry` (the boot: the
//   commands manifest's re-edit, §0.3.22 item 7), the window's opening calls it and the window's end calls what
//   it returned, after the panel's part; a new panel write cancels only the panel's part.
// - An entry is one AFTER the agent's own: the join of who was already there when the agent entered (it comes
//   in the timeline of the agent's own join, before it) opens no window. The criterion is the agent's
//   membership at the event, as the server sends it (MSC4115, `unsigned.membership`): only `join` counts —
//   never the room's state, which the server's `state_after` (MSC4222) already sets to the end of the batch.
//   A server that sends none keeps the entry.
// - The interval, the clock, the timer and the random source are options (the unit tests); no flag, no
//   environment variable.
// - Nothing of the protocol and nothing of the content reaches a log line.
import type { MatrixEvent, Room } from 'matrix-js-sdk'
import { EventType } from 'matrix-js-sdk'
import {
  PANEL_REL_TYPE,
  buildPanelContent,
  buildPanelEditContent,
  mayAnswer,
  panelTitleOf,
  readPanelBlock,
  richFromContent,
  type ApprovalAccounts,
} from '@tayet/shared/internal'
import type { RichDoc } from '@tayet/shared'
import type { ApiPanel, ApiPanelAccepted, ApiPanelStatus } from '../api/contract'
import {
  ANCHORED_BUSY_RETRY_MS,
  ANCHORED_FAILED_ATTEMPTS,
  ANCHORED_INTERVAL_MS,
  anchorOf,
  createAnchoredReader,
  createAnchoredScheduler,
  realTimer,
  type AnchoredClient,
  type AnchoredOutcome,
  type AnchoredReader,
  type AnchoredScheduler,
  type OwnAnchored,
  type SetTimer,
} from './anchored'
import type { SendResult } from './queue'
import { ReadError, type Resolver } from './read'
import type { WriteJob } from './send'
import { WriteError } from './write'

type Log = (line: Record<string, unknown>) => void

// §0.3.16 item 17: one panel write every 10 s per agent (the budget it shares with the commands manifest,
// core/anchored.ts).
export const PANEL_INTERVAL_MS = ANCHORED_INTERVAL_MS
// The write queue is busy (a message first): the scheduler looks again after this, keeping its turn.
export const PANEL_BUSY_RETRY_MS = ANCHORED_BUSY_RETRY_MS
// §0.3.16 item 16: the re-edit's random delay, uniform in [0, this).
export const PANEL_REEDIT_WINDOW_MS = 10_000
// The arquiteto's limit on the panel's text (A3-6 fork 5).
export const PANEL_TEXT_MAX = 8 * 1024
// A write that fails for another reason is tried again at its next turns; after this many, it is dropped.
export const PANEL_FAILED_ATTEMPTS = ANCHORED_FAILED_ATTEMPTS

export type PanelClient = AnchoredClient
export type { SetTimer }

// ── Reading the agent's own panel (the anchored reader over the panel's relation type) ───────────────
export type OwnPanel = OwnAnchored
export type PanelReader = AnchoredReader

export function createPanelReader(client: PanelClient, me: () => string): PanelReader {
  return createAnchoredReader(client, me, PANEL_REL_TYPE)
}

// ── The scheduler (the panel's lane of the anchored scheduler) ───────────────────────────────────────
export type PanelVersion = { kind: 'write'; text: string; rich?: RichDoc; title?: string } | { kind: 'clear' }

export type PanelOutcome = AnchoredOutcome

export interface SchedulerPorts {
  write(roomId: string, version: PanelVersion): Promise<PanelOutcome>
  // The write queue is empty (messages first).
  queueIdle(): boolean
  log: Log
  intervalMs?: number
  now?: () => number
  setTimer?: SetTimer
}

export interface PanelScheduler {
  // The newest version of the conversation (replaces a pending one, keeping its place in the rotation).
  schedule(roomId: string, version: PanelVersion): void
  // A version is pending or being written.
  pending(roomId: string): boolean
  // Stops for good; what is pending is lost.
  stop(): void
}

// A scheduler of the panel alone (the unit tests; the boot shares one with the commands, PanelDeps.scheduler).
export function createPanelScheduler(ports: SchedulerPorts): PanelScheduler {
  const s = createAnchoredScheduler(['panel'], ports)
  const lane = s.lane<PanelVersion>('panel', (roomId, version) => ports.write(roomId, version))
  return { schedule: lane.schedule, pending: lane.pending, stop: s.stop }
}

// ── The core: facade, writer and re-edit ─────────────────────────────────────────────────────────────
export interface PanelWrite {
  text: string
  rich?: RichDoc
  title?: string
}

// The DELETE with nothing to do: no panel (or already cleared) and nothing pending — the 204.
export interface PanelNothing {
  conversation: string
  pending: false
}

export interface PanelFacade {
  set(conversation: string, write: PanelWrite): Promise<ApiPanelAccepted>
  clear(conversation: string): Promise<ApiPanelAccepted | PanelNothing>
  get(conversation: string): Promise<ApiPanelStatus>
}

export interface PanelOptions {
  intervalMs?: number
  now?: () => number
  setTimer?: SetTimer
  // The re-edit's delay source, in [0, 1).
  random?: () => number
}

export interface PanelDeps extends PanelOptions {
  client: PanelClient
  resolver: Pick<Resolver, 'roomAnyOf' | 'tokenOfRoom'>
  enqueue(job: WriteJob): Promise<SendResult>
  queueIdle(): boolean
  accounts: () => ApprovalAccounts
  log: Log
  // The anchored scheduler shared with the commands manifest (the boot); absent → one of the panel alone,
  // over `queueIdle`, `intervalMs`, `now` and `setTimer`.
  scheduler?: AnchoredScheduler
  // Called when a re-edit window opens; what it returns is called at the window's end, after the panel's part
  // (the commands manifest's re-edit).
  afterEntry?: (roomId: string) => () => void
}

export interface PanelCore {
  facade: PanelFacade
  // A live timeline event: a person's entry starts the re-edit of the conversation (§0.3.16 item 16).
  noteEvent(ev: MatrixEvent, room: Room): void
  // The revocation or the stop of the core: the scheduler stops, the pending versions and re-edits are lost.
  stop(): void
}

// What the panel shows, for the GET.
function viewOf(panel: OwnPanel | null): Pick<ApiPanelStatus, 'panel' | 'unreadable'> {
  if (panel === null) return { panel: null }
  if (panel.shown === undefined) return { panel: null, unreadable: true }
  const block = readPanelBlock(panel.shown.content)
  if (block === undefined || block.cleared) return { panel: null }
  const body = panel.shown.content.body
  const view: ApiPanel = { ...(block.title !== undefined && { title: block.title }), text: typeof body === 'string' ? body : '', updatedAt: panel.shown.at }
  return { panel: view }
}

const isCleared = (panel: OwnPanel): boolean => panel.shown !== undefined && readPanelBlock(panel.shown.content)?.cleared === true

export function createPanelCore(deps: PanelDeps): PanelCore {
  const { client, resolver, log } = deps
  const setTimer = deps.setTimer ?? realTimer
  const random = deps.random ?? Math.random
  const me = (): string => {
    const id = client.getUserId()
    if (id === null) throw new Error('no user id')
    return id
  }
  const reader = createPanelReader(client, me)
  let stopped = false

  const write = async (roomId: string, version: PanelVersion): Promise<PanelOutcome> => {
    const room = client.getRoom(roomId)
    if (room === null || room.getMyMembership() !== 'join') return { kind: 'not-member' }
    let panel: OwnPanel | null
    try {
      panel = await reader.find(roomId)
    } catch {
      log({ evt: 'panel-read-failed' })
      return { kind: 'failed' }
    }
    let content: Record<string, unknown>
    if (version.kind === 'clear') {
      // Nothing to clear: no panel, or one already cleared.
      if (panel === null || isCleared(panel)) return { kind: 'ok' }
      content = buildPanelEditContent({ cleared: true }, panel.eventId)
    } else {
      const edit = { text: version.text, ...(version.rich !== undefined && { rich: version.rich }), ...(version.title !== undefined && { title: version.title }) }
      if (panel !== null) content = buildPanelEditContent(edit, panel.eventId)
      else {
        const anchor = anchorOf(room)
        if (anchor === undefined) {
          log({ evt: 'panel-anchor-missing' })
          return { kind: 'failed' }
        }
        content = buildPanelContent(version.text, version.rich, version.title, anchor)
      }
    }
    const result = await deps.enqueue({ kind: 'panel', channel: roomId, content })
    if (result.ok) {
      if (panel === null) reader.remember(roomId, result.messageId)
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

  const shared =
    deps.scheduler ??
    createAnchoredScheduler(['panel'], {
      queueIdle: () => deps.queueIdle(),
      log,
      ...(deps.intervalMs !== undefined && { intervalMs: deps.intervalMs }),
      ...(deps.now !== undefined && { now: deps.now }),
      setTimer,
    })
  const lane = shared.lane<PanelVersion>('panel', write)
  const scheduler = { schedule: lane.schedule, pending: lane.pending, stop: shared.stop }

  // ── Re-edit on entry ──
  const reedits = new Map<string, () => void>()
  // Windows whose panel part a new write cancelled while `afterEntry` keeps the window itself.
  const skipped = new Set<string>()
  // Bumped by every PUT/DELETE of the conversation: a re-edit that started reading before it gives up.
  const writes = new Map<string, number>()
  const cancelReedit = (roomId: string): void => {
    if (deps.afterEntry === undefined) {
      reedits.get(roomId)?.()
      reedits.delete(roomId)
    } else if (reedits.has(roomId)) {
      skipped.add(roomId)
    }
    writes.set(roomId, (writes.get(roomId) ?? 0) + 1)
  }

  const reedit = async (roomId: string): Promise<void> => {
    if (stopped || scheduler.pending(roomId)) return
    const room = client.getRoom(roomId)
    if (room === null || room.getMyMembership() !== 'join') return
    const generation = writes.get(roomId) ?? 0
    let panel: OwnPanel | null
    try {
      panel = await reader.find(roomId)
    } catch {
      log({ evt: 'panel-read-failed' })
      return
    }
    if (stopped || panel === null || (writes.get(roomId) ?? 0) !== generation || scheduler.pending(roomId)) return
    if (panel.shown === undefined) {
      log({ evt: 'panel-reedit-skipped' })
      return
    }
    const block = readPanelBlock(panel.shown.content)
    if (block === undefined || block.cleared) return
    const body = panel.shown.content.body
    const rich = richFromContent(panel.shown.content)
    scheduler.schedule(roomId, {
      kind: 'write',
      text: typeof body === 'string' ? body : '',
      ...(rich !== undefined && { rich }),
      ...(block.title !== undefined && { title: block.title }),
    })
  }

  const noteEvent = (ev: MatrixEvent, room: Room): void => {
    if (stopped || ev.getType() !== (EventType.RoomMember as string)) return
    const userId = ev.getStateKey()
    if (userId === undefined || userId === me()) return
    if (ev.getContent().membership !== 'join' || ev.getPrevContent().membership === 'join') return
    // Not an entry: the agent was not in the conversation yet at this event (it came before the agent's own join).
    const at = ev.getMembershipAtEvent()
    if (at !== undefined && at !== 'join') return
    if (!mayAnswer(userId, deps.accounts())) return
    const roomId = room.roomId
    if (reedits.has(roomId)) return
    const afterPanel = deps.afterEntry?.(roomId)
    reedits.set(
      roomId,
      setTimer(
        () => {
          reedits.delete(roomId)
          const skip = skipped.delete(roomId)
          void (async () => {
            if (!skip) await reedit(roomId)
            if (!stopped) afterPanel?.()
          })()
        },
        Math.floor(random() * PANEL_REEDIT_WINDOW_MS),
      ),
    )
  }

  // ── Facade ──
  // As the message writes: unknown → conversation_not_found; not joined → not_member.
  const joined = (conversation: string): Room => {
    const room = resolver.roomAnyOf(conversation)
    if (room.getMyMembership() !== 'join') throw new WriteError('not_member')
    return room
  }

  const facade: PanelFacade = {
    // Settles once queued; a refusal rejects (never throws synchronously).
    set: (conversation, req) =>
      Promise.resolve().then((): ApiPanelAccepted => {
        const room = joined(conversation)
        if (req.text.trim() === '' || Buffer.byteLength(req.text, 'utf8') > PANEL_TEXT_MAX) throw new WriteError('invalid_argument')
        let title: string | undefined
        if (req.title !== undefined) {
          title = panelTitleOf(req.title)
          if (title === undefined) throw new WriteError('invalid_argument')
        }
        cancelReedit(room.roomId)
        scheduler.schedule(room.roomId, {
          kind: 'write',
          text: req.text,
          ...(req.rich !== undefined && { rich: req.rich }),
          ...(title !== undefined && { title }),
        })
        return { conversation: resolver.tokenOfRoom(room.roomId), pending: true }
      }),

    async clear(conversation) {
      const room = joined(conversation)
      const token = resolver.tokenOfRoom(room.roomId)
      cancelReedit(room.roomId)
      if (!scheduler.pending(room.roomId)) {
        let panel: OwnPanel | null
        try {
          panel = await reader.find(room.roomId)
        } catch {
          throw new WriteError('upstream_failed')
        }
        if (panel === null || isCleared(panel)) return { conversation: token, pending: false }
      }
      scheduler.schedule(room.roomId, { kind: 'clear' })
      return { conversation: token, pending: true }
    },

    async get(conversation) {
      // As the message reads: unknown, or not joined → conversation_not_found.
      const room = resolver.roomAnyOf(conversation)
      if (room.getMyMembership() !== 'join') throw new ReadError('conversation_not_found')
      let panel: OwnPanel | null
      try {
        panel = await reader.find(room.roomId)
      } catch {
        throw new WriteError('upstream_failed')
      }
      return { conversation: resolver.tokenOfRoom(room.roomId), ...viewOf(panel), pending: scheduler.pending(room.roomId) }
    },
  }

  return {
    facade,
    noteEvent,
    stop() {
      stopped = true
      scheduler.stop()
      for (const cancel of reedits.values()) cancel()
      reedits.clear()
      skipped.clear()
    },
  }
}
