import { describe, it, expect, afterEach } from 'vitest'
import { EventBus } from '../../src/api/bus'
import { createWaits, type SetTimer } from '../../src/api/mcp/wait'
import type { ApiApprovalStatus, ApiMessage } from '../../src/api/contract'
import { ReadError } from '../../src/core/read'
import { WriteError } from '../../src/core/write'
import type { ApprovalFacade, ApprovalRequest } from '../../src/core/approvals'
import { ALICE, GENERAL, ME, message } from '../support/slack-world'
import { callTool, idShapeLeaks, startMcp, type Era, type McpHarness, type ToolAnswer } from '../support/mcp-world'

// The approval card tools (A3-3b; ADR-091, Proposto; PLANO-AGENTES §0.3.16 item 13): request_approval,
// wait_for_approval (long-poll on the bus, as wait_for_mention) and close_approval, over a fake facade —
// the shapes, the native rules and errors, and the wait answered by an answer, a close or the timeout.

const OPTIONS = [
  { id: 'approve', label: 'Aprovar', style: 'primary' as const },
  { id: 'reject', label: 'Rejeitar', style: 'danger' as const },
]
const CARD = '1730000400.000400'

interface Timer {
  ms: number
  fire: () => void
  cancelled: boolean
}
function fakeClock(): { timers: Timer[]; setTimer: SetTimer } {
  const timers: Timer[] = []
  return {
    timers,
    setTimer: (fn, ms) => {
      const t: Timer = { ms, fire: fn, cancelled: false }
      timers.push(t)
      return () => {
        t.cancelled = true
      }
    },
  }
}

const status = (approval: ApiApprovalStatus['approval']): ApiApprovalStatus => ({ conversation: GENERAL.id, id: CARD, approval })
const OPEN = status({ options: OPTIONS, state: 'open' })
const ANSWERED = status({ options: OPTIONS, state: 'answered', answer: { option: 'reject', by: ALICE.id, at: 1730000500000 } })
const CLOSED = status({ options: OPTIONS, state: 'closed' })

function fakeApprovals(initial: ApiApprovalStatus = OPEN) {
  const calls: unknown[] = []
  let current = initial
  let failState: Error | undefined
  const card = (over: Partial<ApiMessage> = {}): ApiMessage => message({ id: CARD, author: ME.id, text: 'Publicar?', approval: { options: OPTIONS, state: 'open' }, ...over })
  const approvals: ApprovalFacade = {
    request: (c, r: ApprovalRequest) => {
      calls.push(['request', c, r])
      return Promise.resolve(card({ conversation: c, text: r.text }))
    },
    close: (c, ts, text, rich) => {
      calls.push(['close', c, ts, text, rich])
      if (current.approval.state === 'open') current = CLOSED
      return Promise.resolve(card({ id: ts, approval: current.approval }))
    },
    state: (c, ts) => {
      calls.push(['state', c, ts])
      if (failState !== undefined) return Promise.reject(failState)
      return Promise.resolve({ ...current, conversation: c, id: ts })
    },
  }
  return {
    approvals,
    calls,
    set: (s: ApiApprovalStatus) => (current = s),
    failWith: (e: Error) => (failState = e),
  }
}

let h: McpHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

const ok = (a: ToolAnswer): Record<string, unknown> => {
  expect(a.isError).not.toBe(true)
  expect(JSON.parse(a.content[0]?.text ?? 'null')).toEqual(a.structuredContent)
  expect(idShapeLeaks(a.structuredContent)).toEqual([])
  return a.structuredContent as Record<string, unknown>
}
const refused = (a: ToolAnswer): string => {
  expect(a.isError).toBe(true)
  return a.content[0]?.text ?? ''
}

describe.each<Era>(['legacy', 'modern'])('approval card tools (%s era)', (era) => {
  it('request_approval: the card back; Markdown by default; thread and mentions pass; markdown: false is literal', async () => {
    const f = fakeApprovals()
    h = await startMcp({ approvals: f.approvals })
    const c = await h.client(era)
    const m = ok(await callTool(c, 'request_approval', { conversation: GENERAL.id, text: 'Publicar **agora**?', options: OPTIONS, thread: '1730000100.000100', mentions: [ALICE.id] }))
    expect(m).toMatchObject({ id: CARD, conversation: GENERAL.id, author: ME.id, approval: { options: OPTIONS, state: 'open' } })
    ok(await callTool(c, 'request_approval', { conversation: GENERAL.id, text: '**cru**', options: [{ id: 'ok', label: 'Ok' }], markdown: false }))
    expect(f.calls).toEqual([
      [
        'request',
        GENERAL.id,
        {
          text: 'Publicar **agora**?',
          options: OPTIONS,
          rich: [{ t: 'p', children: [{ t: 'text', text: 'Publicar ' }, { t: 'strong', children: [{ t: 'text', text: 'agora' }] }, { t: 'text', text: '?' }] }],
          thread: '1730000100.000100',
          mentions: [ALICE.id],
        },
      ],
      ['request', GENERAL.id, { text: '**cru**', options: [{ id: 'ok', label: 'Ok' }] }],
    ])
  })

  it('request_approval: the native option rules → invalid_argument, before the facade', async () => {
    const f = fakeApprovals()
    h = await startMcp({ approvals: f.approvals })
    const c = await h.client(era)
    const bad: unknown[] = [
      [{ id: 'a', label: 'A', style: 'primary' }, { id: 'b', label: 'B', style: 'primary' }],
      [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }],
      [{ id: 'Não', label: 'A' }],
      [{ id: 'a', label: 'x'.repeat(76) }],
      [{ id: 'a', label: '  ' }],
    ]
    for (const options of bad) expect(refused(await callTool(c, 'request_approval', { conversation: GENERAL.id, text: 'Publicar?', options }))).toBe('invalid_argument')
    // 26 options: refused by the tool's input schema, before the handler.
    const many = Array.from({ length: 26 }, (_, n) => ({ id: `o${n}`, label: `O${n}` }))
    expect(refused(await callTool(c, 'request_approval', { conversation: GENERAL.id, text: 'Publicar?', options: many }))).toMatch(/options: Too big/)
    expect(refused(await callTool(c, 'request_approval', { conversation: GENERAL.id, text: '  ', options: OPTIONS }))).toBe('invalid_argument')
    expect(f.calls).toEqual([])
  })

  it('request_approval: 25 options pass to the facade', async () => {
    const f = fakeApprovals()
    h = await startMcp({ approvals: f.approvals })
    const c = await h.client(era)
    const options = Array.from({ length: 25 }, (_, n) => ({ id: `o${n}`, label: `O${n}` }))
    ok(await callTool(c, 'request_approval', { conversation: GENERAL.id, text: 'Qual?', options }))
    expect(f.calls).toHaveLength(1)
  })

  it('request_approval: a protocol id in a label is refused before any effect (content_refused, leak line)', async () => {
    const f = fakeApprovals()
    h = await startMcp({ approvals: f.approvals })
    const c = await h.client(era)
    const answer = await callTool(c, 'request_approval', { conversation: GENERAL.id, text: 'Publicar?', options: [{ id: 'a', label: '@bob:tayet.local' }] })
    expect(refused(answer)).toBe('content_refused')
    expect(answer.structuredContent).toEqual({ code: 'content_refused', refused: [{ field: 'approval.options[0].label', pattern: 'user_id' }] })
    expect(JSON.stringify(answer)).not.toContain('bob')
    expect(h.logs.some((l) => l.evt === 'leak-blocked' && l.where === 'mcp:request_approval')).toBe(true)
    expect(JSON.stringify(h.logs)).not.toContain('bob')
    expect(f.calls).toEqual([])
  })

  it('close_approval: an id shape in the new text → content_refused before the close', async () => {
    const f = fakeApprovals()
    h = await startMcp({ approvals: f.approvals })
    const c = await h.client(era)
    const answer = await callTool(c, 'close_approval', { conversation: GENERAL.id, id: CARD, text: 'ver mxc://tayet.local/m' })
    expect(refused(answer)).toBe('content_refused')
    expect(answer.structuredContent).toEqual({ code: 'content_refused', refused: [{ field: 'text', pattern: 'media_address' }] })
    expect(h.logs).toContainEqual({ evt: 'leak-blocked', where: 'mcp:close_approval', path: '$.text', pattern: 'mxc-uri' })
    expect(f.calls).toEqual([])
  })

  it('the facade’s errors come back with their native code; no facade → unavailable', async () => {
    const f = fakeApprovals()
    f.approvals.request = () => Promise.reject(new WriteError('not_member'))
    f.approvals.close = () => Promise.reject(new WriteError('not_approval'))
    f.failWith(new ReadError('message_not_found'))
    h = await startMcp({ approvals: f.approvals })
    const c = await h.client(era)
    expect(refused(await callTool(c, 'request_approval', { conversation: GENERAL.id, text: 'Publicar?', options: OPTIONS }))).toBe('not_member')
    expect(refused(await callTool(c, 'close_approval', { conversation: GENERAL.id, id: CARD }))).toBe('not_approval')
    expect(refused(await callTool(c, 'wait_for_approval', { conversation: GENERAL.id, id: CARD, timeout_s: 1 }))).toBe('message_not_found')
    await h.close()
    h = await startMcp()
    const c2 = await h.client(era)
    expect(refused(await callTool(c2, 'request_approval', { conversation: GENERAL.id, text: 'Publicar?', options: OPTIONS }))).toBe('unavailable')
    expect(refused(await callTool(c2, 'wait_for_approval', { conversation: GENERAL.id, id: CARD }))).toBe('unavailable')
    expect(refused(await callTool(c2, 'close_approval', { conversation: GENERAL.id, id: CARD }))).toBe('unavailable')
  })

  it('close_approval: the final state — closed, or answered when a person answered first; text is Markdown by default', async () => {
    const f = fakeApprovals()
    h = await startMcp({ approvals: f.approvals })
    const c = await h.client(era)
    expect(ok(await callTool(c, 'close_approval', { conversation: GENERAL.id, id: CARD, text: 'Cancelado *hoje*' }))).toEqual(CLOSED)
    expect(f.calls).toEqual([['close', GENERAL.id, CARD, 'Cancelado *hoje*', [{ t: 'p', children: [{ t: 'text', text: 'Cancelado ' }, { t: 'em', children: [{ t: 'text', text: 'hoje' }] }] }]]])
    f.set(ANSWERED)
    expect(ok(await callTool(c, 'close_approval', { conversation: GENERAL.id, id: CARD }))).toEqual(ANSWERED)
  })

  it('wait_for_approval: a card already answered or closed answers at once', async () => {
    const f = fakeApprovals(ANSWERED)
    h = await startMcp({ approvals: f.approvals })
    const c = await h.client(era)
    expect(ok(await callTool(c, 'wait_for_approval', { conversation: GENERAL.id, id: CARD }))).toEqual(ANSWERED)
    f.set(CLOSED)
    expect(ok(await callTool(c, 'wait_for_approval', { conversation: GENERAL.id, id: CARD }))).toEqual(CLOSED)
  })

  it('wait_for_approval: the card’s approval.answered on the bus answers the wait (a real client, a real bus)', async () => {
    const f = fakeApprovals()
    const clock = fakeClock()
    h = await startMcp({ approvals: f.approvals, setTimer: clock.setTimer })
    const c = await h.client(era)
    const p = callTool(c, 'wait_for_approval', { conversation: GENERAL.id, id: CARD })
    await until(() => clock.timers.length === 1 && f.calls.length === 1)
    expect(clock.timers[0]?.ms).toBe(25_000)
    // Another card's answer does not end it.
    h.world.emit({ type: 'approval.answered', conversation: GENERAL.id, id: '1.000001', option: 'approve', by: ALICE.id, at: 1 })
    h.world.emit({ type: 'approval.answered', conversation: GENERAL.id, id: CARD, option: 'reject', by: ALICE.id, at: 1730000500000 })
    expect(ok(await p)).toEqual(ANSWERED)
  })

  it('wait_for_approval: the timeout (cut to 50 s) → timedOut, still open', async () => {
    const f = fakeApprovals()
    const clock = fakeClock()
    h = await startMcp({ approvals: f.approvals, setTimer: clock.setTimer })
    const c = await h.client(era)
    const p = callTool(c, 'wait_for_approval', { conversation: GENERAL.id, id: CARD, timeout_s: 600 })
    await until(() => clock.timers.length === 1)
    expect(clock.timers[0]?.ms).toBe(50_000)
    clock.timers[0]!.fire()
    expect(ok(await p)).toEqual({ conversation: GENERAL.id, id: CARD, timedOut: true })
  })
})

const until = async (pred: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('the card wait (bus only)', () => {
  const card = { conversation: GENERAL.id, id: CARD }
  const edited = { type: 'message.edited' as const, conversation: GENERAL.id, message: message({ id: CARD, author: ME.id }) }

  it('subscribes before it reads: an answer published during the first read is not lost', async () => {
    const bus = new EventBus({ epoch: 'e1' })
    const waits = createWaits(bus, fakeClock().setTimer)
    let reads = 0
    const read = (): Promise<ApiApprovalStatus> => {
      reads += 1
      if (reads === 1) bus.publish({ type: 'approval.answered', conversation: GENERAL.id, id: CARD, option: 'reject', by: ALICE.id, at: 1730000500000 })
      return Promise.resolve(reads === 1 ? OPEN : ANSWERED)
    }
    expect(await waits.approval(card, read, 25_000)).toEqual({ kind: 'settled', status: ANSWERED })
  })

  it('an edit of the card (the agent’s close) is read again: closed → answers; still open → waits', async () => {
    const bus = new EventBus({ epoch: 'e1' })
    const clock = fakeClock()
    const waits = createWaits(bus, clock.setTimer)
    let now = OPEN
    const p = waits.approval(card, () => Promise.resolve(now), 25_000)
    await until(() => clock.timers.length === 1)
    bus.publish(edited)
    await new Promise((r) => setTimeout(r, 10))
    now = CLOSED
    bus.publish(edited)
    expect(await p).toEqual({ kind: 'settled', status: CLOSED })
    expect(clock.timers[0]?.cancelled).toBe(true)
    expect((bus as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0)
  })

  it('an answer that cannot be read yet (no option) is not an answer: the wait goes on until its event', async () => {
    const bus = new EventBus({ epoch: 'e1' })
    const clock = fakeClock()
    const waits = createWaits(bus, clock.setTimer)
    const pending = status({ options: OPTIONS, state: 'answered', answer: { by: ALICE.id, at: 1730000500000 } })
    let settledYet = false
    const p = waits.approval(card, () => Promise.resolve(pending), 25_000).then((v) => {
      settledYet = true
      return v
    })
    await until(() => clock.timers.length === 1)
    await new Promise((r) => setTimeout(r, 10))
    expect(settledYet).toBe(false)
    bus.publish({ type: 'approval.answered', conversation: GENERAL.id, id: CARD, option: 'reject', by: ALICE.id, at: 1730000500000 })
    expect(await p).toEqual({ kind: 'settled', status: ANSWERED })
  })

  it('agent.revoked → revoked; the layer closing → closed; the client giving up → closed', async () => {
    const bus = new EventBus({ epoch: 'e1' })
    const waits = createWaits(bus, fakeClock().setTimer)
    const read = (): Promise<ApiApprovalStatus> => Promise.resolve(OPEN)
    const r = waits.approval(card, read, 25_000)
    bus.publish({ type: 'agent.revoked' })
    expect(await r).toEqual({ kind: 'revoked' })
    const ctrl = new AbortController()
    const a = waits.approval(card, read, 25_000, ctrl.signal)
    ctrl.abort()
    expect(await a).toEqual({ kind: 'closed' })
    const c = waits.approval(card, read, 25_000)
    waits.close()
    expect(await c).toEqual({ kind: 'closed' })
    expect(await waits.approval(card, read, 25_000)).toEqual({ kind: 'closed' })
  })

  it('the card removed → the read fails and the wait rejects with it', async () => {
    const bus = new EventBus({ epoch: 'e1' })
    const clock = fakeClock()
    const waits = createWaits(bus, clock.setTimer)
    let gone = false
    const p = waits.approval(card, () => (gone ? Promise.reject(new ReadError('message_not_found')) : Promise.resolve(OPEN)), 25_000)
    await until(() => clock.timers.length === 1)
    await new Promise((r) => setTimeout(r, 10))
    gone = true
    bus.publish({ type: 'message.removed', conversation: GENERAL.id, id: CARD })
    await expect(p).rejects.toMatchObject({ code: 'message_not_found' })
  })
})

// ADR-104 (Aprovadores 2): a card that asks for several answers through the MCP — `needed` on
// request_approval, the wait across the partial events (it ends at the close), the timeout carrying the
// state, close_approval's final state; and the probe on `react`.
const BOB_ID = 'UBOB0000000'
const multiStatus = (state: 'open' | 'answered' | 'closed', answers: Array<{ option?: string; by: string; at: number }>): ApiApprovalStatus =>
  status({ options: OPTIONS, needed: 2, answers, state })
const A1 = { option: 'approve', by: ALICE.id, at: 1730000500000 }
const B1 = { option: 'reject', by: BOB_ID, at: 1730000600000 }
const answeredEv = (a: { option: string; by: string; at: number }, count: number) => ({ type: 'approval.answered' as const, conversation: GENERAL.id, id: CARD, ...a, count, needed: 2 })

describe.each<Era>(['legacy', 'modern'])('approval card tools with `needed` (%s era)', (era) => {
  it('request_approval passes `needed` to the facade and answers with it; outside 2–10 the schema refuses', async () => {
    const f = fakeApprovals()
    f.approvals.request = (c, r) => {
      f.calls.push(['request', c, r])
      return Promise.resolve(message({ id: CARD, conversation: c, author: ME.id, text: r.text, approval: { options: OPTIONS, needed: r.needed, answers: [], state: 'open' } }))
    }
    h = await startMcp({ approvals: f.approvals })
    const c = await h.client(era)
    const m = ok(await callTool(c, 'request_approval', { conversation: GENERAL.id, text: 'Publicar?', options: OPTIONS, needed: 3, markdown: false }))
    expect(m).toMatchObject({ approval: { needed: 3, answers: [], state: 'open' } })
    expect(f.calls).toEqual([['request', GENERAL.id, { text: 'Publicar?', options: OPTIONS, needed: 3 }]])
    for (const needed of [1, 11, 2.5, '3']) {
      expect(refused(await callTool(c, 'request_approval', { conversation: GENERAL.id, text: 'Publicar?', options: OPTIONS, needed })), JSON.stringify(needed)).toMatch(/needed/)
    }
    // F2: an unknown argument is dropped without an error (the schemas are not strict).
    ok(await callTool(c, 'request_approval', { conversation: GENERAL.id, text: 'Publicar?', options: OPTIONS, markdown: false, quorum: 2 }))
    expect(f.calls).toHaveLength(2)
    expect(f.calls[1]).toEqual(['request', GENERAL.id, { text: 'Publicar?', options: OPTIONS }])
  })

  it('wait_for_approval: the partial events read the card again; the wait ends when all the answers are in', async () => {
    const f = fakeApprovals(multiStatus('open', []))
    const clock = fakeClock()
    h = await startMcp({ approvals: f.approvals, setTimer: clock.setTimer })
    const c = await h.client(era)
    const p = callTool(c, 'wait_for_approval', { conversation: GENERAL.id, id: CARD })
    await until(() => clock.timers.length === 1 && f.calls.length === 1)
    f.set(multiStatus('open', [A1]))
    h.world.emit(answeredEv(A1, 1))
    await until(() => f.calls.length === 2)
    f.set(multiStatus('answered', [A1, B1]))
    h.world.emit(answeredEv(B1, 2))
    expect(ok(await p)).toEqual(multiStatus('answered', [A1, B1]))
    expect(f.calls).toHaveLength(3)
  })

  it('wait_for_approval: the timeout carries the state so far; a card closed short of N ends the wait with `closed`', async () => {
    const f = fakeApprovals(multiStatus('open', [A1]))
    const clock = fakeClock()
    h = await startMcp({ approvals: f.approvals, setTimer: clock.setTimer })
    const c = await h.client(era)
    const p = callTool(c, 'wait_for_approval', { conversation: GENERAL.id, id: CARD })
    await until(() => clock.timers.length === 1 && f.calls.length === 1)
    clock.timers[0]!.fire()
    expect(ok(await p)).toEqual({ conversation: GENERAL.id, id: CARD, timedOut: true, approval: multiStatus('open', [A1]).approval })
    f.set(multiStatus('closed', [A1]))
    expect(ok(await callTool(c, 'wait_for_approval', { conversation: GENERAL.id, id: CARD }))).toEqual(multiStatus('closed', [A1]))
  })

  it('close_approval: the final state with `needed` and `answers`', async () => {
    const f = fakeApprovals(multiStatus('open', [A1]))
    f.approvals.close = (c, ts) => {
      f.calls.push(['close', c, ts])
      return Promise.resolve(message({ id: ts, conversation: c, author: ME.id, text: 'x', approval: multiStatus('closed', [A1]).approval }))
    }
    h = await startMcp({ approvals: f.approvals })
    const c = await h.client(era)
    expect(ok(await callTool(c, 'close_approval', { conversation: GENERAL.id, id: CARD }))).toEqual(multiStatus('closed', [A1]))
  })

  it('react: an id shape in the emoji → content_refused before any effect; an emoji passes', async () => {
    h = await startMcp()
    const c = await h.client(era)
    const answer = await callTool(c, 'react', { conversation: GENERAL.id, message: '1730000200.000200', emoji: '@nome:servidor.local' })
    expect(refused(answer)).toBe('content_refused')
    expect(answer.structuredContent).toEqual({ code: 'content_refused', refused: [{ field: 'emoji', pattern: 'user_id' }] })
    expect(JSON.stringify(answer)).not.toContain('servidor')
    expect(h.logs).toContainEqual({ evt: 'leak-blocked', where: 'mcp:react', path: '$.emoji', pattern: 'mxid' })
    expect(h.world.calls.filter((x) => x.op === 'react')).toHaveLength(0)
    ok(await callTool(c, 'react', { conversation: GENERAL.id, message: '1730000200.000200', emoji: '👍' }))
    expect(h.world.calls.filter((x) => x.op === 'react')).toHaveLength(1)
  })
})
