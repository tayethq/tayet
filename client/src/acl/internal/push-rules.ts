import { PushRuleKind, type IPushRule, type MatrixClient } from 'matrix-js-sdk'
import type { AclTelemetry } from '@tayet/shared'

// ADR-117 dec. 2: for each direct conversation and each group the person is in, a room rule (`room` kind, id = the
// room) with the action `notify` and the marker `io.tayet.push`, whose value is the conversation's kind. The push
// service sends only what carries the marker (or the server's mention highlight); the default rules stay, so the
// count is untouched (ADR-068 D1).
//
// "Ours" is a room rule whose actions carry a `set_tweak` `io.tayet.push`, whatever its value. A room rule without
// the marker is somebody else's: never read as ours, overwritten or deleted.
//
// Reconciled by state (PLANO-MOBILE §0.25 and the PR 3 forks): one full sweep per connection, and one check per
// conversation on each channel.added/changed/removed. The read is the SDK's cached rules plus what this session
// wrote and deleted (the ledger), so a write is not repeated before its sync echo. One request at a time; a 429
// ends the writing until the next connection, whose sweep resumes it. A failure is signalled without any id and
// swallowed.

export const PUSH_TWEAK = 'io.tayet.push'
export type ConversationTag = 'direct' | 'group'

export type RuleWrite = { op: 'put'; roomId: string; tag: ConversationTag } | { op: 'delete'; roomId: string }

// What is on the server for one room, as far as this session knows: a marked rule with its value, a rule without
// the marker (not ours), or nothing.
export type ExistingRule = { marked: true; value: unknown } | { marked: false }

export function markOf(rule: Pick<IPushRule, 'actions'>): { marked: true; value: unknown } | undefined {
  for (const a of rule.actions as unknown[]) {
    const tweak = a as { set_tweak?: unknown; value?: unknown } | null
    if (typeof tweak === 'object' && tweak !== null && tweak.set_tweak === PUSH_TWEAK) return { marked: true, value: tweak.value }
  }
  return undefined
}

export function ruleActions(tag: ConversationTag): IPushRule['actions'] {
  // The SDK types the tweak name as a closed enum; the marker is ours (ADR-117 dec. 2).
  return ['notify', { set_tweak: PUSH_TWEAK, value: tag }] as unknown as IPushRule['actions']
}

// The decision for one room: the write that brings it to `desired`, or none.
export function planRoom(roomId: string, desired: ConversationTag | undefined, existing: ExistingRule | undefined): RuleWrite | undefined {
  if (existing && !existing.marked) return undefined
  if (desired === undefined) return existing ? { op: 'delete', roomId } : undefined
  if (existing && existing.value === desired) return undefined
  return { op: 'put', roomId, tag: desired }
}

// The full sweep: every desired room and every room that has a marked rule.
export function planSweep(desired: ReadonlyMap<string, ConversationTag>, existing: ReadonlyMap<string, ExistingRule>): RuleWrite[] {
  const writes: RuleWrite[] = []
  for (const [roomId, tag] of desired) {
    const w = planRoom(roomId, tag, existing.get(roomId))
    if (w) writes.push(w)
  }
  for (const [roomId, rule] of existing) {
    if (desired.has(roomId) || !rule.marked) continue
    writes.push({ op: 'delete', roomId })
  }
  return writes
}

export type PushRulesClient = Pick<MatrixClient, 'addPushRule' | 'deletePushRule' | 'pushRules'>

function isRateLimited(e: unknown): boolean {
  const err = e as { httpStatus?: unknown; errcode?: unknown } | null
  return err?.httpStatus === 429 || err?.errcode === 'M_LIMIT_EXCEEDED'
}

export interface PushRuleKeeperDeps {
  // The live client of the session, or undefined once it ended.
  client: () => PushRulesClient | undefined
  // The conversations that should carry a rule, read when the sweep's turn comes.
  desired: () => Map<string, ConversationTag>
  telemetry: AclTelemetry
  // The gateway's tracker of fire-and-forget work, drained by disconnect().
  detach: (work: Promise<unknown>) => void
}

export class PushRuleKeeper {
  // room → the tag this session wrote, or null for a rule it deleted; dropped once the cache agrees.
  private readonly ledger = new Map<string, ConversationTag | null>()
  private queue: Promise<void> = Promise.resolve()
  private stopped = false
  private generation = 0

  constructor(private readonly deps: PushRuleKeeperDeps) {}

  // A new connection (or its end): the ledger, the 429 stop and the queue start over.
  reset(): void {
    this.ledger.clear()
    this.stopped = false
    this.generation += 1
    this.queue = Promise.resolve()
  }

  sweep(): void {
    this.enqueue(() => planSweep(this.deps.desired(), this.existing()))
  }

  check(roomId: string, desired: ConversationTag | undefined): void {
    if (this.stopped) return
    this.enqueue(() => {
      const w = planRoom(roomId, desired, this.existing().get(roomId))
      return w ? [w] : []
    })
  }

  // The SDK's cached room rules with this session's ledger over them.
  private existing(): Map<string, ExistingRule> {
    const out = new Map<string, ExistingRule>()
    const rules = this.deps.client()?.pushRules?.global?.room ?? []
    for (const r of rules) out.set(r.rule_id, markOf(r) ?? { marked: false })
    for (const [roomId, tag] of this.ledger) {
      const cached = out.get(roomId)
      const agrees = tag === null ? !cached : !!cached?.marked && cached.value === tag
      if (agrees) {
        this.ledger.delete(roomId)
        continue
      }
      if (tag === null) out.delete(roomId)
      else out.set(roomId, { marked: true, value: tag })
    }
    return out
  }

  private enqueue(plan: () => RuleWrite[]): void {
    const gen = this.generation
    const job = this.queue.then(() => this.run(gen, plan))
    this.queue = job
    this.deps.detach(job)
  }

  private async run(gen: number, plan: () => RuleWrite[]): Promise<void> {
    if (gen !== this.generation || this.stopped) return
    const client = this.deps.client()
    if (!client) return
    let writes: RuleWrite[]
    try {
      writes = plan()
    } catch {
      this.signal()
      return
    }
    for (const w of writes) {
      if (gen !== this.generation || this.stopped || this.deps.client() !== client) return
      try {
        if (w.op === 'put') {
          await client.addPushRule('global', PushRuleKind.RoomSpecific, w.roomId, { actions: ruleActions(w.tag) })
          this.ledger.set(w.roomId, w.tag)
        } else {
          // Already gone (another access of the account got there first): the state is the desired one.
          await client.deletePushRule('global', PushRuleKind.RoomSpecific, w.roomId).catch((e: unknown) => {
            if ((e as { httpStatus?: unknown } | null)?.httpStatus !== 404) throw e
          })
          this.ledger.set(w.roomId, null)
        }
      } catch (e) {
        if (gen !== this.generation) return
        if (isRateLimited(e)) this.stopped = true
        this.signal()
        return
      }
    }
  }

  private signal(): void {
    // Payload-free by construction (ADR-007 §3): it says WHAT failed, never for whom or which room.
    this.deps.telemetry.untranslated({ conceptKind: 'protocol-event', shape: { eventType: 'push-rules-unwritten' } })
  }
}
