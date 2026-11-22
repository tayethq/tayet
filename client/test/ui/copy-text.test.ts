import { describe, it, expect } from 'vitest'
import type { Message, MessageBody, MessageId, ChannelId, UserId, MediaRef } from '../../src/acl'
import { copyTextOf, canCopyText } from '../../src/ui/composer/copy-text'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'

// The copy rule (manifest workspace.md §25.1 items 4 and 5; PLANO-MOBILE §0.12.2 R5, N4 a): for every
// body kind and send status, what the clipboard gets, or that the action does not exist.
const msg = (body: MessageBody, over: Partial<Message> = {}): Message => ({
  id: '$m:tayet.local' as unknown as MessageId,
  channelId: '!c:tayet.local' as unknown as ChannelId,
  author: '@alice:tayet.local' as unknown as UserId,
  body,
  sentAt: 1 as unknown as Message['sentAt'],
  reactions: [],
  mine: false,
  mentionsMe: false,
  ...over,
})
const media = 'mr_abc' as unknown as MediaRef

describe('copyTextOf — what to copy', () => {
  it('plain text as it is', () => {
    expect(copyTextOf(msg({ kind: 'text', text: 'oi *você*' }))).toBe('oi *você*')
  })

  it('formatted text from the rich, never from the plain fallback', () => {
    const m = msg({ kind: 'text', text: 'plain fallback', rich: [{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'b' }] }] }] })
    expect(copyTextOf(m)).toBe('**b**')
  })

  it('a command copies its whole body, "/nome args"', () => {
    const m = msg({ kind: 'text', text: '/relatorio semana 47' }, { command: { name: 'relatorio', agent: '@a:tayet.local' as unknown as UserId } as Message['command'] })
    expect(copyTextOf(m)).toBe('/relatorio semana 47')
  })

  it('a mention leaves as "@nome", with no protocol id', () => {
    const m = msg({ kind: 'text', text: 'oi @Alice', rich: [{ t: 'p', children: [{ t: 'text', text: 'oi @Alice' }] }] })
    expect(copyTextOf(m)).toBe('oi @Alice')
    expect(findProtocolLeaksInText(copyTextOf(m)!)).toEqual([])
  })

  it('an approval card: the request through the converter, else the text; no options', () => {
    const base: Pick<Extract<MessageBody, { kind: 'approval' }>, 'options' | 'state'> = { options: [{ id: 'ok', label: 'Aprovar' }], state: { kind: 'open' } }
    expect(copyTextOf(msg({ kind: 'approval', text: 'Pode publicar?', ...base }))).toBe('Pode publicar?')
    expect(
      copyTextOf(msg({ kind: 'approval', text: 'fallback', request: [{ t: 'p', children: [{ t: 'em', children: [{ t: 'text', text: 'Pode?' }] }] }], ...base })),
    ).toBe('*Pode?*')
  })

  it('a message not sent (failed) keeps the action', () => {
    expect(copyTextOf(msg({ kind: 'text', text: 'perdida' }, { status: 'failed' }))).toBe('perdida')
    expect(canCopyText(msg({ kind: 'text', text: 'enviada' }, { status: 'sent' }))).toBe(true)
  })
})

describe('copyTextOf — where the action does not exist (§25.1 item 5, N4 a)', () => {
  const cases: Array<[string, Message]> = [
    ['image', msg({ kind: 'image', media })],
    ['file', msg({ kind: 'file', media, name: 'a.pdf', size: 1, mimetype: 'application/pdf' })],
    ['pending', msg({ kind: 'text', text: 'indo' }, { status: 'pending' })],
    ['unavailable', msg({ kind: 'unavailable', arrival: 'stalled' })],
    ['unsupported', msg({ kind: 'unsupported', shape: { eventType: 'x.custom' } })],
  ]
  for (const [name, m] of cases) {
    it(name, () => {
      expect(copyTextOf(m)).toBeUndefined()
      expect(canCopyText(m)).toBe(false)
    })
  }
})
