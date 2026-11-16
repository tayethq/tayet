import { describe, it, expect } from 'vitest'
import { scanCommandsProbe, scanEdge, scanPanelProbe } from '../../src/api/edge'

// ADR-089 dec. 1: structural fields with the full set; user content (message text, rich, file name)
// with the id shapes and envelope keys only.
const message = (over: Record<string, unknown> = {}) => ({
  id: '1730900000.100123',
  conversation: 'CAAAAAAAAAA',
  author: 'UAAAAAAAAAA',
  text: 'ok',
  mentionsMe: false,
  reactions: [],
  ...over,
})
const patterns = (v: unknown): string[] => scanEdge(v).map((l) => `${l.path} ${l.pattern}`)

describe('edge scan', () => {
  it('"verify" and "cofre" pass in a message text, rich and a file name', () => {
    expect(patterns({ messages: [message({ text: 'please verify the backup; deixei no cofre' })] })).toEqual([])
    expect(patterns(message({ rich: { t: 'p', children: [{ t: 'text', text: 'decrypt the archive' }] } }))).toEqual([])
    expect(patterns(message({ files: [{ id: 'FA', name: 'escrow-olm.pdf', mimetype: 'application/pdf', size: 1 }] }))).toEqual([])
  })

  it('an mxid, room id, event id or media URI in the content blocks', () => {
    expect(patterns({ messages: [message({ text: 'fale com @alice:tayet.local' })] })).toEqual(['$.messages[0].text mxid'])
    expect(patterns(message({ rich: { t: 'link', href: 'mxc://x/y' } }))).toEqual(['$.rich.href mxc-uri'])
    expect(patterns(message({ text: '$' + 'A'.repeat(43) }))).toEqual(['$.text event-id'])
    expect(patterns(message({ files: [{ id: 'FA', name: '!r:tayet.local', mimetype: 'x', size: 1 }] }))).toEqual(['$.files[0].name room-id'])
    expect(patterns(message({ rich: { formatted_body: 'x' } }))).toEqual(['$.rich.formatted_body envelope-key'])
  })

  it('structural fields get the full set: an mxid or the vocabulary in a name blocks', () => {
    expect(patterns({ conversations: [{ id: 'CA', name: '@alice:tayet.local', kind: 'dm', memberCount: 2 }] })).toEqual([
      '$.conversations[0].name mxid',
    ])
    expect(patterns({ id: 'UA', name: 'cofre', kind: 'member' })).toEqual(['$.name custody-identity'])
    // A `name` outside a message's files is structural even next to a message.
    expect(patterns({ type: 'member.changed', conversation: 'CA', person: { id: 'UA', name: 'verify', kind: 'member' }, state: 'joined' })).toEqual([
      '$.person.name verify',
    ])
  })

  it('no opaque keys: a raw id in an id field blocks', () => {
    expect(patterns(message({ author: '@alice:tayet.local' }))).toEqual(['$.author mxid'])
    expect(patterns(message({ thread: '$' + 'B'.repeat(43) }))).toEqual(['$.thread event-id'])
  })
})

// ADR-089 addendum (A3-3): an approval card's option ids and labels — and the chosen option's id — are the
// agent's content; the rest of the card is structural.
describe('edge scan — approval cards', () => {
  const card = (approval: Record<string, unknown>) => message({ text: 'Publicar?', approval })

  it('a label or an id with a denied word passes as content (message, state answer, event)', () => {
    expect(patterns(card({ options: [{ id: 'verify', label: 'Verificar', style: 'primary' }, { id: 'escrow', label: 'Abrir o cofre' }], state: 'open' }))).toEqual([])
    expect(patterns(card({ options: [{ id: 'verify', label: 'Verificar' }], state: 'answered', answer: { option: 'verify', by: 'UB', at: 2 } }))).toEqual([])
    expect(patterns({ conversation: 'CA', id: '1.000001', approval: { options: [{ id: 'olm', label: 'decrypt' }], state: 'answered', answer: { option: 'olm', by: 'UB', at: 1 } } })).toEqual([])
    expect(patterns({ type: 'approval.answered', conversation: 'CA', id: '1.000001', option: 'verify', by: 'UB', at: 1 })).toEqual([])
  })

  it('an id shape in a label, an option id or the chosen option still blocks (content gets the id shapes)', () => {
    expect(patterns(card({ options: [{ id: 'a', label: 'fale com @alice:tayet.local' }] }))).toEqual(['$.approval.options[0].label mxid'])
    expect(patterns({ type: 'approval.answered', conversation: 'CA', id: '1.000001', option: '!r:tayet.local', by: 'UB', at: 1 })).toEqual(['$.option room-id'])
  })

  it('the structural fields of a card keep the full set: a protocol id or word there blocks', () => {
    expect(patterns(card({ options: [{ id: 'a', label: 'A' }], state: 'answered', answer: { option: 'a', by: '@bob:tayet.local', at: 1 } }))).toEqual([
      '$.approval.answer.by mxid',
    ])
    expect(patterns(card({ options: [{ id: 'a', label: 'A', style: 'verify' }] }))).toEqual(['$.approval.options[0].style verify'])
    expect(patterns({ type: 'approval.answered', conversation: 'CA', id: '1.000001', option: 'a', by: '@bob:tayet.local', at: 1 })).toEqual(['$.by mxid'])
    // `option` is content only in the answered event and in a card's answer.
    expect(patterns({ type: 'member.changed', conversation: 'CA', option: 'verify' })).toEqual(['$.option verify'])
  })
})

describe('edge scan — pinned panel (ADR-089 addendum, A3-6)', () => {
  it('a denied word in the panel’s text or title passes as content', () => {
    expect(patterns({ conversation: 'CA', panel: { title: 'Verificar o cofre', text: 'decrypt the escrow backup', updatedAt: 1 }, pending: false })).toEqual([])
    expect(scanPanelProbe('CA', 'verify', 'olm')).toEqual([])
  })

  it('an id shape in the text or the title still blocks; the structural fields keep the full set', () => {
    expect(patterns({ conversation: 'CA', panel: { title: '!r:tayet.local', text: 'falar com @alice:tayet.local', updatedAt: 1 }, pending: false })).toEqual([
      '$.panel.text mxid',
      '$.panel.title room-id',
    ])
    expect(scanPanelProbe('CA', 'ok', '@bob:tayet.local').map((l) => `${l.path} ${l.pattern}`)).toEqual(['$.panel.title mxid'])
    expect(patterns({ conversation: 'CA', panel: null, pending: false, unreadable: true, extra: 'verify' })).toEqual(['$.extra verify'])
    expect(patterns({ conversation: '@bob:tayet.local', panel: null, pending: false })).toEqual(['$.conversation mxid'])
  })
})

describe('edge scan — commands (ADR-089 addendum, A4-2a)', () => {
  it('a denied word in a command’s name, description or hint passes as content', () => {
    expect(patterns({ commands: [{ name: 'verify', description: 'Decrypt the escrow backup', hint: '<cofre>' }], pending: 1 })).toEqual([])
    expect(scanCommandsProbe([{ name: 'olm', description: 'unverified', hint: 'verify' }])).toEqual([])
  })

  it('an id shape in any of the three blocks; a denied word in a structural field blocks', () => {
    expect(patterns({ commands: [{ name: '@a:tayet.local', description: 'ver !r:tayet.local', hint: 'mxc://x/y' }], pending: 0 })).toEqual([
      '$.commands[0].name mxid',
      '$.commands[0].description room-id',
      '$.commands[0].hint mxc-uri',
    ])
    expect(scanCommandsProbe([{ name: 'ok', description: 'ok', hint: '$' + 'A'.repeat(43) }]).map((l) => `${l.path} ${l.pattern}`)).toEqual(['$.commands[0].hint event-id'])
    expect(patterns({ commands: [{ name: 'ok', description: 'ok', kind: 'verify' }], pending: 0 })).toEqual(['$.commands[0].kind verify'])
    expect(patterns({ commands: [], pending: 0, extra: 'escrow' })).toEqual(['$.extra escrow'])
  })
})

describe('edge scan — a message’s command (ADR-089 addendum, A4-2b)', () => {
  it('a denied word in the command’s name or args passes as content, in a listing and in an event', () => {
    const command = { name: 'verify', args: 'decrypt the escrow backup\nno cofre' }
    expect(patterns({ messages: [message({ text: '/verify decrypt the escrow backup', command })] })).toEqual([])
    expect(patterns({ type: 'mention', conversation: 'CAAAAAAAAAA', message: message({ command }) })).toEqual([])
  })

  it('an id shape in the name or the args blocks; a denied word in another field of the command blocks', () => {
    expect(patterns(message({ command: { name: '@a:tayet.local', args: 'ver !r:tayet.local' } }))).toEqual(['$.command.name mxid', '$.command.args room-id'])
    expect(patterns(message({ command: { name: 'ok', args: '$' + 'A'.repeat(43) } }))).toEqual(['$.command.args event-id'])
    expect(patterns(message({ command: { name: 'ok', args: '', kind: 'verify' } }))).toEqual(['$.command.kind verify'])
    // Outside a message, a `command` object is structural.
    expect(patterns({ command: { name: 'verify', args: '' } })).toEqual(['$.command.name verify'])
  })
})
