import { describe, expect, it, vi } from 'vitest'
import type { IPushRule } from 'matrix-js-sdk'
import {
  PushRuleKeeper,
  planRoom,
  planSweep,
  type ConversationTag,
  type ExistingRule,
  type PushRulesClient,
} from '../src/acl/internal/push-rules'

// ADR-117 dec. 2 (PR 3 of the push track): the marked room rule of each direct conversation and group. The
// decision is pure (planRoom/planSweep); the keeper writes it one request at a time, remembers what it wrote until
// the sync echo, stops at a 429 until the next connection, and signals a failure without any id.

const marked = (value: unknown): ExistingRule => ({ marked: true, value })
const foreign: ExistingRule = { marked: false }

describe('planRoom / planSweep', () => {
  it('writes the missing rule, corrects the value, and leaves one in place', () => {
    expect(planRoom('!a', 'direct', undefined)).toEqual({ op: 'put', roomId: '!a', tag: 'direct' })
    expect(planRoom('!a', 'direct', marked('group'))).toEqual({ op: 'put', roomId: '!a', tag: 'direct' })
    expect(planRoom('!a', 'group', marked('group'))).toBeUndefined()
  })

  it('deletes a marked rule whose room is no conversation, and never touches a rule without the marker', () => {
    expect(planRoom('!a', undefined, marked('direct'))).toEqual({ op: 'delete', roomId: '!a' })
    expect(planRoom('!a', undefined, marked(true))).toEqual({ op: 'delete', roomId: '!a' })
    expect(planRoom('!a', undefined, undefined)).toBeUndefined()
    expect(planRoom('!a', 'direct', foreign)).toBeUndefined()
    expect(planRoom('!a', undefined, foreign)).toBeUndefined()
  })

  it('the sweep covers the desired rooms and every marked rule outside them', () => {
    const desired = new Map<string, ConversationTag>([
      ['!dm', 'direct'],
      ['!grp', 'group'],
      ['!ok', 'direct'],
      ['!theirs', 'group'],
    ])
    const existing = new Map<string, ExistingRule>([
      ['!grp', marked('direct')],
      ['!ok', marked('direct')],
      ['!theirs', foreign],
      ['!channel', marked('group')],
      ['!left', marked('direct')],
      ['!other', foreign],
    ])
    expect(planSweep(desired, existing)).toEqual([
      { op: 'put', roomId: '!dm', tag: 'direct' },
      { op: 'put', roomId: '!grp', tag: 'group' },
      { op: 'delete', roomId: '!channel' },
      { op: 'delete', roomId: '!left' },
    ])
  })
})

type Call = { op: 'put' | 'delete'; roomId: string; body?: unknown }

function rule(roomId: string, actions: unknown[]): IPushRule {
  return { rule_id: roomId, default: false, enabled: true, actions } as unknown as IPushRule
}
const markedRule = (roomId: string, value: string) => rule(roomId, ['notify', { set_tweak: 'io.tayet.push', value }])

function harness(opts: { rules?: IPushRule[]; desired?: Map<string, ConversationTag> } = {}) {
  const calls: Call[] = []
  let gate: (() => Promise<void>) | undefined
  const client = {
    pushRules: { global: { room: opts.rules ?? [] } },
    addPushRule: vi.fn(async (_scope: string, _kind: string, roomId: string, body: unknown) => {
      calls.push({ op: 'put', roomId, body })
      if (gate) await gate()
      return {}
    }),
    deletePushRule: vi.fn(async (_scope: string, _kind: string, roomId: string) => {
      calls.push({ op: 'delete', roomId })
      if (gate) await gate()
      return {}
    }),
  }
  const untranslated = vi.fn()
  const inflight: Promise<unknown>[] = []
  let live: typeof client | undefined = client
  const keeper = new PushRuleKeeper({
    client: () => live as unknown as PushRulesClient | undefined,
    desired: () => opts.desired ?? new Map(),
    telemetry: { untranslated },
    detach: (w) => void inflight.push(w),
  })
  const settle = async () => {
    for (let i = 0; i < inflight.length; i++) await inflight[i]
  }
  return {
    keeper,
    client,
    calls,
    untranslated,
    settle,
    setGate: (g: (() => Promise<void>) | undefined) => (gate = g),
    end: () => (live = undefined),
  }
}

describe('PushRuleKeeper', () => {
  it('the sweep writes the missing rule with the exact body, corrects a value and deletes a stale marked rule', async () => {
    const h = harness({
      rules: [markedRule('!grp', 'direct'), markedRule('!channel', 'group'), rule('!theirs', ['notify'])],
      desired: new Map([
        ['!dm', 'direct'],
        ['!grp', 'group'],
      ]),
    })
    h.keeper.sweep()
    await h.settle()
    expect(h.calls).toEqual([
      { op: 'put', roomId: '!dm', body: { actions: ['notify', { set_tweak: 'io.tayet.push', value: 'direct' }] } },
      { op: 'put', roomId: '!grp', body: { actions: ['notify', { set_tweak: 'io.tayet.push', value: 'group' }] } },
      { op: 'delete', roomId: '!channel' },
    ])
    expect(h.client.addPushRule.mock.calls[0]!.slice(0, 2)).toEqual(['global', 'room'])
    expect(h.client.deletePushRule.mock.calls[0]!.slice(0, 2)).toEqual(['global', 'room'])
    expect(h.untranslated).not.toHaveBeenCalled()
  })

  it('a check deletes the marked rule of a room that became a channel or that the person left', async () => {
    const h = harness({ rules: [markedRule('!was-group', 'group'), markedRule('!left', 'direct')] })
    h.keeper.check('!was-group', undefined)
    h.keeper.check('!left', undefined)
    await h.settle()
    expect(h.calls).toEqual([
      { op: 'delete', roomId: '!was-group' },
      { op: 'delete', roomId: '!left' },
    ])
  })

  it('a rule without the marker is never touched, and nothing is written when the rule is in place', async () => {
    const h = harness({
      rules: [rule('!theirs', ['dont_notify']), markedRule('!ok', 'group')],
      desired: new Map([
        ['!theirs', 'direct'],
        ['!ok', 'group'],
      ]),
    })
    h.keeper.sweep()
    h.keeper.check('!theirs', undefined)
    h.keeper.check('!theirs', 'group')
    h.keeper.check('!ok', 'group')
    await h.settle()
    expect(h.calls).toEqual([])
  })

  it('does not write again before the echo, and the ledger yields once the cache agrees', async () => {
    const h = harness()
    h.keeper.check('!dm', 'direct')
    h.keeper.check('!dm', 'direct')
    h.keeper.sweep() // desired is empty here: the ledger's rule reads as marked and outside, so it is deleted
    await h.settle()
    expect(h.calls.map((c) => c.op)).toEqual(['put', 'delete'])
    // The echo of the delete: the cache has nothing, agreeing with the ledger; a check of nothing writes nothing.
    h.keeper.check('!dm', undefined)
    await h.settle()
    expect(h.calls).toHaveLength(2)
  })

  it('one request at a time', async () => {
    const h = harness({
      desired: new Map([
        ['!a', 'direct'],
        ['!b', 'group'],
      ]),
    })
    let release!: () => void
    h.setGate(() => new Promise<void>((r) => (release = r)))
    h.keeper.sweep()
    h.keeper.check('!c', 'direct')
    await vi.waitFor(() => expect(h.calls).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(h.calls).toHaveLength(1)
    release()
    await vi.waitFor(() => expect(h.calls).toHaveLength(2))
    await new Promise((r) => setTimeout(r, 10))
    expect(h.calls).toHaveLength(2)
    h.setGate(undefined)
    release()
    await h.settle()
    expect(h.calls.map((c) => c.roomId)).toEqual(['!a', '!b', '!c'])
  })

  it('a 429 ends the writing until the next connection, whose sweep resumes it', async () => {
    const desired = new Map<string, ConversationTag>([
      ['!a', 'direct'],
      ['!b', 'group'],
    ])
    const h = harness({ desired })
    h.client.addPushRule.mockImplementationOnce(async (_s: string, _k: string, roomId: string) => {
      h.calls.push({ op: 'put', roomId })
      throw Object.assign(new Error('limited'), { httpStatus: 429, errcode: 'M_LIMIT_EXCEEDED' })
    })
    h.keeper.sweep()
    await h.settle()
    h.keeper.check('!c', 'direct')
    h.keeper.sweep()
    await h.settle()
    expect(h.calls.map((c) => c.roomId)).toEqual(['!a'])
    expect(h.untranslated).toHaveBeenCalledTimes(1)

    h.keeper.reset() // the next connection
    h.keeper.sweep()
    await h.settle()
    expect(h.calls.map((c) => c.roomId)).toEqual(['!a', '!a', '!b'])
  })

  it('a failure becomes the signal, with no id in the payload, and is swallowed', async () => {
    const h = harness({ desired: new Map([['!secret-room:x', 'direct']]) })
    h.client.addPushRule.mockRejectedValueOnce(Object.assign(new Error('boom'), { httpStatus: 500 }))
    h.keeper.sweep()
    await h.settle()
    expect(h.untranslated).toHaveBeenCalledTimes(1)
    expect(h.untranslated).toHaveBeenCalledWith({ conceptKind: 'protocol-event', shape: { eventType: 'push-rules-unwritten' } })
    expect(JSON.stringify(h.untranslated.mock.calls)).not.toContain('secret-room')
    // Not a 429: the next check still writes.
    h.keeper.check('!secret-room:x', 'direct')
    await h.settle()
    expect(h.client.addPushRule).toHaveBeenCalledTimes(2)
  })

  it('a delete of a rule already gone counts as done; the end of the session stops the queue', async () => {
    const h = harness({ rules: [markedRule('!gone', 'direct'), markedRule('!next', 'group')] })
    h.client.deletePushRule.mockImplementationOnce(async (_s: string, _k: string, roomId: string) => {
      h.calls.push({ op: 'delete', roomId })
      throw Object.assign(new Error('missing'), { httpStatus: 404 })
    })
    h.keeper.check('!gone', undefined)
    await h.settle()
    expect(h.untranslated).not.toHaveBeenCalled()
    h.end()
    h.keeper.check('!next', undefined)
    await h.settle()
    expect(h.calls.map((c) => c.roomId)).toEqual(['!gone'])
  })
})
