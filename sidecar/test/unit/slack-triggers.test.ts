import { describe, it, expect } from 'vitest'
import { TRIGGER_SOURCE_MAX_AGE_MS, TRIGGER_TTL_MS, TriggerTable, type TriggerOrigin } from '../../src/api/slack/triggers'
import { SlackError } from '../../src/api/slack/errors'

// The trigger_ids of the Slack layer, on an injected clock: 30 s from the moment they are minted, born expired when
// the source is more than 60 s old, one use per origin across several ids, nothing spent by an open that fails.

const CLICK: TriggerOrigin = { kind: 'card', conversation: 'CGENERALAAA', card: '1732000001.000100', person: 'UALICEAAAAA' }
const COMMAND: TriggerOrigin = { kind: 'command', conversation: 'CGENERALAAA', message: '1732000002.000100', person: 'UALICEAAAAA' }

const world = () => {
  let now = 1_732_000_100_000
  return { table: new TriggerTable(() => now), advance: (ms: number) => void (now += ms), now: () => now }
}
const codeOf = (fn: () => unknown): string => {
  try {
    fn()
    return 'ok'
  } catch (err) {
    return err instanceof SlackError ? err.code : String(err)
  }
}

describe('trigger_id', () => {
  it('valid for 30 s from the moment it is minted; then expired', () => {
    const w = world()
    const id = w.table.issue(CLICK, w.now())
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    w.advance(TRIGGER_TTL_MS - 1)
    const a = w.table.begin(id)
    expect(a.origin).toEqual(CLICK)
    a.settle(false)
    w.advance(1)
    expect(codeOf(() => w.table.begin(id))).toBe('expired_trigger_id')
  })

  it('born expired when the answer (or the command) is more than 60 s old when the payload is built', () => {
    const w = world()
    expect(codeOf(() => w.table.begin(w.table.issue(CLICK, w.now() - TRIGGER_SOURCE_MAX_AGE_MS - 1)))).toBe('expired_trigger_id')
    expect(codeOf(() => w.table.begin(w.table.issue(COMMAND, w.now() - TRIGGER_SOURCE_MAX_AGE_MS - 1)))).toBe('expired_trigger_id')
    expect(codeOf(() => w.table.begin(w.table.issue(COMMAND, w.now() - TRIGGER_SOURCE_MAX_AGE_MS)).settle(false))).toBe('ok')
  })

  it('not of the format → invalid_trigger_id; unknown → expired_trigger_id', () => {
    const w = world()
    expect(codeOf(() => w.table.begin('13345224609.738474920.8088930838d88f008e0'))).toBe('invalid_trigger_id')
    expect(codeOf(() => w.table.begin('0'.repeat(32)))).toBe('expired_trigger_id')
  })

  it('one use per origin: two ids of the same click (an HTTP redelivery), one open spends both', () => {
    const w = world()
    const first = w.table.issue(CLICK, w.now())
    w.advance(5_000)
    const second = w.table.issue(CLICK, w.now())
    const other = w.table.issue({ ...CLICK, card: '1732000009.000100' }, w.now())
    w.table.begin(second).settle(true)
    expect(codeOf(() => w.table.begin(first))).toBe('exchanged_trigger_id')
    expect(codeOf(() => w.table.begin(second))).toBe('exchanged_trigger_id')
    expect(codeOf(() => w.table.begin(other).settle(false))).toBe('ok')
  })

  it('an open that fails spends nothing; an open in flight holds the origin', () => {
    const w = world()
    const id = w.table.issue(COMMAND, w.now())
    const a = w.table.begin(id)
    expect(codeOf(() => w.table.begin(id))).toBe('exchanged_trigger_id')
    a.settle(false)
    const b = w.table.begin(id)
    b.settle(true)
    expect(codeOf(() => w.table.begin(id))).toBe('exchanged_trigger_id')
  })

  it('clear(): nothing opens any more', () => {
    const w = world()
    const id = w.table.issue(CLICK, w.now())
    w.table.clear()
    expect(codeOf(() => w.table.begin(id))).toBe('expired_trigger_id')
    expect(w.table.size).toBe(0)
  })
})
