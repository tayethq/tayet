import { describe, expect, it } from 'vitest'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { compose, decide, parsePayload, workerLanguage, type PushPayload } from '../../src/sw/notification'

// ADR-117 dec. 4 and 5 (PR 5a of the push track): the service worker's pure half — the push JSON → title, body and
// click data in the language the page wrote; and fork S3, whether to show anything at all.

const CONV = '!conv:example.test'
const MSG = '$msg'
const base = { v: 1, invite: false, conversation: CONV, message: MSG, author: 'Ana' }
const p = (over: Record<string, unknown>): PushPayload => parsePayload({ ...base, ...over })!

describe('parsePayload', () => {
  it('only v: 1 with a conversation is ours', () => {
    for (const raw of [undefined, null, 'x', 1, {}, { v: 2, conversation: CONV }, { v: 1 }, { v: 1, conversation: '' }, { v: '1', conversation: CONV }]) {
      expect(parsePayload(raw)).toBeUndefined()
    }
    expect(parsePayload({ v: 1, conversation: CONV })).toMatchObject({ conversation: CONV, kind: 'channel', invite: false, agent: false })
  })

  it('agent only when true; the rest of the fields trimmed or dropped', () => {
    expect(p({ kind: 'direct', agent: true }).agent).toBe(true)
    expect(p({ kind: 'direct', agent: 'yes' }).agent).toBe(false)
    expect(p({ kind: 'direct', author: '  Ana  ', thread: '' })).toMatchObject({ author: 'Ana', thread: undefined })
  })
})

describe('compose: title and body, both languages', () => {
  const rows: Array<[string, Record<string, unknown>, [string, string], [string, string]]> = [
    ['direct', { kind: 'direct' }, ['Ana', 'Nova mensagem'], ['Ana', 'New message']],
    ['direct, agent', { kind: 'direct', agent: true }, ['Ana (agente)', 'Nova mensagem'], ['Ana (agent)', 'New message']],
    ['group', { kind: 'group' }, ['Ana em conversa em grupo', 'Nova mensagem'], ['Ana in a group conversation', 'New message']],
    ['group, agent', { kind: 'group', agent: true }, ['Ana (agente) em conversa em grupo', 'Nova mensagem'], ['Ana (agent) in a group conversation', 'New message']],
    ['channel, text', { kind: 'channel', channelName: 'Vendas', body: { type: 'text', text: '  oi\n  pessoal ' } }, ['Ana em Vendas', 'oi pessoal'], ['Ana in Vendas', 'oi pessoal']],
    ['channel, agent', { kind: 'channel', channelName: 'Vendas', agent: true, body: { type: 'text', text: 'ok' } }, ['Ana (agente) em Vendas', 'ok'], ['Ana (agent) in Vendas', 'ok']],
    ['channel, card', { kind: 'channel', channelName: 'Vendas', agent: true, body: { type: 'approval', text: 'Pagar?\nmais' } }, ['Ana (agente) em Vendas', 'Pede aprovação: Pagar?'], ['Ana (agent) in Vendas', 'Asks for approval: Pagar?']],
    ['channel, image', { kind: 'channel', channelName: 'V', body: { type: 'image' } }, ['Ana em V', 'Enviou uma imagem'], ['Ana in V', 'Sent an image']],
    ['channel, file', { kind: 'channel', channelName: 'V', body: { type: 'file' } }, ['Ana em V', 'Enviou um arquivo'], ['Ana in V', 'Sent a file']],
    ['channel, other', { kind: 'channel', channelName: 'V', body: { type: 'other' } }, ['Ana em V', 'Enviou uma mensagem'], ['Ana in V', 'Sent a message']],
    ['channel, no body', { kind: 'channel', channelName: 'V' }, ['Ana em V', 'Nova mensagem'], ['Ana in V', 'New message']],
    ['direct invite', { kind: 'direct', invite: true }, ['Ana', 'Nova mensagem'], ['Ana', 'New message']],
    ['group invite, agent', { kind: 'group', invite: true, agent: true }, ['Ana (agente) em conversa em grupo', 'Nova mensagem'], ['Ana (agent) in a group conversation', 'New message']],
    ['fork 8: channel without author', { kind: 'channel', author: '', channelName: 'Vendas', body: { type: 'text', text: 'x' } }, ['Vendas', 'x'], ['Vendas', 'x']],
    ['fork 8: direct without author', { kind: 'direct', author: '' }, ['Nova mensagem', 'Nova mensagem'], ['New message', 'New message']],
    ['fork 8: group without author', { kind: 'group', author: '' }, ['Nova mensagem', 'Nova mensagem'], ['New message', 'New message']],
  ]
  for (const [name, over, pt, en] of rows) {
    it(name, () => {
      const a = compose(p(over), 'pt-BR')
      const b = compose(p(over), 'en')
      expect([a.title, a.body]).toEqual(pt)
      expect([b.title, b.body]).toEqual(en)
      for (const s of [a, b]) {
        expect(findProtocolLeaksInText(`${s.title}\n${s.body}`)).toEqual([])
        expect(`${s.title}${s.body}`).not.toContain(CONV)
      }
    })
  }

  it('the text is cut like the live tab (120 + ellipsis)', () => {
    expect(compose(p({ kind: 'channel', channelName: 'V', body: { type: 'text', text: 'a'.repeat(200) } }), 'en').body).toBe(`${'a'.repeat(120)}…`)
  })

  it('the ids travel only in data', () => {
    expect(compose(p({ kind: 'group', thread: '$root' }), 'en').data).toEqual({ conversation: CONV, message: MSG, thread: '$root' })
    expect(compose(p({ kind: 'direct' }), 'en').data).toEqual({ conversation: CONV, message: MSG })
  })

  it('a push we cannot read: the generic notification, no click data', () => {
    expect(compose(undefined, 'pt-BR')).toEqual({ title: 'Tayet', body: 'Nova mensagem' })
    expect(compose(undefined, 'en')).toEqual({ title: 'Tayet', body: 'New message' })
  })
})

describe('workerLanguage', () => {
  it('the language the page wrote; else the device rule', () => {
    expect(workerLanguage('en')).toBe('en')
    expect(workerLanguage('pt-BR')).toBe('pt-BR')
    expect(['en', 'pt-BR']).toContain(workerLanguage(undefined))
    expect(workerLanguage('fr')).toBe(workerLanguage(undefined))
  })
})

describe('decide (fork S3)', () => {
  const payload = p({ kind: 'direct' })
  const live = { title: 'Ana', body: 'the decrypted text', data: { conversation: CONV, message: MSG } }
  const older = { title: 'Ana', body: 'older text', data: { conversation: CONV, message: '$older' } }
  const W = (focused: boolean, visible: boolean) => ({ focused, visible })

  it('a visible and focused window: nothing, whatever else is there', () => {
    expect(decide(payload, [W(true, true)], [], 'en')).toBeUndefined()
    expect(decide(payload, [W(false, false), W(true, true)], [live], 'en')).toBeUndefined()
    expect(decide(undefined, [W(true, true)], [], 'en')).toBeUndefined()
  })

  it('focused but hidden, visible but unfocused, hidden, no window: shown', () => {
    for (const windows of [[W(true, false)], [W(false, true)], [W(false, false)], []]) {
      expect(decide(payload, windows, [], 'en')).toEqual(compose(payload, 'en'))
    }
  })

  it('the notification of this very message is there: shown again as it is', () => {
    expect(decide(payload, [W(false, true)], [older, live], 'en')).toEqual(live)
    expect(decide(payload, [], [live], 'pt-BR')).toEqual(live)
  })

  it('another message of the conversation is there: the push replaces it', () => {
    expect(decide(payload, [], [older], 'en')).toEqual(compose(payload, 'en'))
  })

  it('existing notifications with odd data do not match', () => {
    expect(decide(payload, [], [{ title: 'x', body: 'y', data: null }, { title: 'x', body: 'y', data: 'z' }], 'en')).toEqual(compose(payload, 'en'))
    // A push without a message id never matches an existing one.
    const noMessage = p({ kind: 'direct', message: undefined })
    expect(decide(noMessage, [], [{ title: 'x', body: 'y', data: { message: '' } }], 'en')).toEqual(compose(noMessage, 'en'))
  })
})
