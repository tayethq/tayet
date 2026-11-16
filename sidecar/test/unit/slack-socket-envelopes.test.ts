import { describe, it, expect } from 'vitest'
import type { SlackEnvelope } from '../../src/api/slack/contract'
import { ACK_TIMEOUT_MS, createEnvelopeDispatcher, type EnvelopeTarget } from '../../src/api/slack/envelopes'
import { manualClock } from '../support/slack-socket'

// The envelope dispatcher (PLANO-AGENTES §0.3.12 items 10, 11; S-f2): one ack table by envelope_id
// whatever the type, redelivery 1, 2, 3 after 3 s each with retry_reason 'timeout', then the drop.

const setup = () => {
  const clock = manualClock()
  const logs: Array<Record<string, unknown>> = []
  const d = createEnvelopeDispatcher({ log: (l) => logs.push(l), timers: clock })
  const sent: SlackEnvelope[] = []
  const target: EnvelopeTarget = { send: (f) => (sent.push(f), true) }
  return { clock, logs, d, sent, target }
}

describe('envelope dispatcher', () => {
  it('sends Slack’s frame and an ack resolves it', async () => {
    const { d, sent, target } = setup()
    const { id, outcome } = d.dispatch(target, 'events_api', { event: { type: 'message' } })
    expect(sent).toEqual([{ envelope_id: id, type: 'events_api', payload: { event: { type: 'message' } }, accepts_response_payload: false, retry_attempt: 0, retry_reason: '' }])
    d.ack(JSON.stringify({ envelope_id: id, payload: {} }))
    expect(await outcome).toEqual({ acked: true })
    expect(d.pending).toBe(0)
  })

  it('no ack → redelivered with retry_attempt 1, 2, 3 and retry_reason timeout, then dropped', async () => {
    const { clock, logs, d, sent, target } = setup()
    const { id, outcome } = d.dispatch(target, 'events_api', { event: { type: 'message' } })
    for (let i = 0; i < 3; i++) clock.advance(ACK_TIMEOUT_MS)
    expect(sent.map((f) => [f.envelope_id, f.retry_attempt, f.retry_reason])).toEqual([
      [id, 0, ''],
      [id, 1, 'timeout'],
      [id, 2, 'timeout'],
      [id, 3, 'timeout'],
    ])
    expect(d.pending).toBe(1)
    clock.advance(ACK_TIMEOUT_MS)
    expect(await outcome).toEqual({ acked: false, reason: 'timeout' })
    expect(sent).toHaveLength(4)
    expect(logs).toEqual([
      { evt: 'envelope-redelivered', envelope_id: id, type: 'events_api', attempt: 1 },
      { evt: 'envelope-redelivered', envelope_id: id, type: 'events_api', attempt: 2 },
      { evt: 'envelope-redelivered', envelope_id: id, type: 'events_api', attempt: 3 },
      { evt: 'envelope-dropped', envelope_id: id, type: 'events_api', reason: 'timeout' },
    ])
  })

  it('an ack after a redelivery stops it', async () => {
    const { clock, d, sent, target } = setup()
    const { id, outcome } = d.dispatch(target, 'events_api', {})
    clock.advance(ACK_TIMEOUT_MS)
    d.ack({ envelope_id: id })
    clock.advance(ACK_TIMEOUT_MS * 5)
    expect(await outcome).toEqual({ acked: true })
    expect(sent).toHaveLength(2)
  })

  it('an unknown, repeated or malformed ack is ignored with one line and no id of the client', () => {
    const { logs, d, target } = setup()
    const { id } = d.dispatch(target, 'events_api', {})
    d.ack({ envelope_id: id })
    d.ack({ envelope_id: id })
    d.ack('{"envelope_id":"@alice:server.example"}')
    d.ack('not json')
    d.ack([1])
    expect(logs).toEqual([{ evt: 'ack-unknown' }, { evt: 'ack-unknown' }, { evt: 'ack-unknown' }, { evt: 'ack-unknown' }])
  })

  it('a closed connection drops what it owes; another connection is not touched', async () => {
    const { d, target } = setup()
    const other: EnvelopeTarget = { send: () => true }
    const a = d.dispatch(target, 'events_api', {})
    const b = d.dispatch(other, 'events_api', {})
    d.drop(target)
    expect(await a.outcome).toEqual({ acked: false, reason: 'closed' })
    expect(d.pending).toBe(1)
    d.ack({ envelope_id: b.id })
    expect(await b.outcome).toEqual({ acked: true })
  })

  it('a frame that does not leave (closed socket, edge) is dropped at once', async () => {
    const { logs, d } = setup()
    const { id, outcome } = d.dispatch({ send: () => false }, 'events_api', {})
    expect(await outcome).toEqual({ acked: false, reason: 'unsent' })
    expect(logs).toEqual([{ evt: 'envelope-dropped', envelope_id: id, type: 'events_api', reason: 'unsent' }])
  })

  it('interactive and slash_commands are known with no emitter; their ack carries the response (A3, A4)', async () => {
    const { d, sent, target } = setup()
    expect(d.kinds).toEqual(['events_api', 'interactive', 'slash_commands'])
    const { id, outcome } = d.dispatch(target, 'interactive', { type: 'block_actions' })
    expect(sent[0]).toMatchObject({ type: 'interactive', accepts_response_payload: true })
    d.ack({ envelope_id: id, payload: { text: 'ok' } })
    expect(await outcome).toEqual({ acked: true, payload: { text: 'ok' } })
  })

  it('a new kind is one register call (the dispatcher is not reopened); an unregistered kind throws', () => {
    const { d, sent, target } = setup()
    expect(() => d.dispatch(target, 'workflow_step', {})).toThrow()
    d.register('workflow_step', { acceptsResponsePayload: false })
    d.dispatch(target, 'workflow_step', {})
    expect(sent[0]?.type).toBe('workflow_step')
  })
})
