import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { topicOf } from '../../src/send.ts'

// The Topic header groups a subscription's pending messages per conversation. Keyed with the
// subscription's auth secret, so the push service cannot tie two subscriptions to the same conversation.
describe('Topic per subscription', () => {
  const room = '!room:example.org'
  const a = randomBytes(16)
  const b = randomBytes(16)

  it('two subscriptions, same conversation: different topics', () => {
    expect(topicOf(a, room)).not.toBe(topicOf(b, room))
  })

  it('same subscription, same conversation, two calls: same topic', () => {
    expect(topicOf(Buffer.from(a), room)).toBe(topicOf(a, room))
  })

  it('same subscription, different conversations: different topics', () => {
    expect(topicOf(a, room)).not.toBe(topicOf(a, '!other:example.org'))
  })

  it('is 32 base64url characters', () => {
    expect(topicOf(a, room)).toMatch(/^[A-Za-z0-9_-]{32}$/)
  })
})
