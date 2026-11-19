import { describe, it, expect } from 'vitest'
import { CONTENT_FIELDS, refusedOf, scanCommandsProbe, scanWriteProbe, scanEdge, scanFormProbe, scanFormResultProbe, scanPanelProbe, scanReactionProbe, withheld, withholdMessages } from '../../src/api/edge'

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
    expect(patterns({ type: 'member.changed', conversation: 'CA', person: { id: 'UA', name: 'verify', kind: 'member' }, state: 'joined' })).toEqual([])
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

// An agent's form, as the core hands a submission to its listener: the form's texts, ids and meta are the
// agent's content; the values are the person's; the rest is structural.
describe('edge scan — an agent’s form', () => {
  const option = (value: string, label: string, description?: string) => ({ value, label, ...(description !== undefined && { description }) })
  const fields = (over: Record<string, unknown> = {}) => [
    { kind: 'context', text: 'Leia antes de verify' },
    { kind: 'longText', id: 'verify', label: 'Verificar', hint: 'abra o cofre', placeholder: 'decrypt', optional: false, minLength: 0, maxLength: 3000, initial: 'escrow', ...over },
    { kind: 'select', id: 's', label: 'L', optional: true, choices: { options: [option('olm', 'Verificar', 'cofre')] } },
    { kind: 'multiSelect', id: 'm', label: 'L', optional: true, choices: { groups: [{ label: 'Cofre', options: [option('a', 'verify')] }] } },
    { kind: 'radio', id: 'r', label: 'L', optional: false, options: [option('escrow', 'Verificar')] },
  ]
  const submitted = (over: { form?: Record<string, unknown>; values?: Record<string, unknown>; origin?: Record<string, unknown> } = {}) => ({
    conversation: 'CAAAAAAAAAA',
    form: { id: '1.000001', title: 'Verificar', submitLabel: 'Abrir o cofre', fields: fields(), meta: '{"verify":true}', ...over.form },
    submission: { id: '1.000002', by: 'UAAAAAAAAAA', at: 1, values: over.values ?? { verify: 'deixei no cofre', s: 'olm', m: ['a'] } },
    origin: { kind: 'card', anchor: '1.000000', ...over.origin },
  })
  const ID = '@alice:tayet.local'

  it('a "Verificar" label and a value with "cofre" pass; every content path is listed', () => {
    expect(patterns(submitted())).toEqual([])
    for (const path of ['form.title', 'form.meta', 'form.fields[].choices.groups[].options[].description', 'submission.values', 'result.errors']) {
      expect(CONTENT_FIELDS).toContain(path)
    }
  })

  it('an id shape in any content path blocks', () => {
    const over = (o: Record<string, unknown>) => patterns(submitted({ form: { fields: fields(o) } }))
    expect(patterns(submitted({ form: { title: ID } }))).toEqual(['$.form.title mxid'])
    expect(patterns(submitted({ form: { submitLabel: ID } }))).toEqual(['$.form.submitLabel mxid'])
    expect(patterns(submitted({ form: { meta: ID } }))).toEqual(['$.form.meta mxid'])
    for (const key of ['id', 'label', 'hint', 'placeholder', 'initial']) expect(over({ [key]: ID })).toEqual([`$.form.fields[1].${key} mxid`])
    expect(patterns(submitted({ form: { fields: [{ kind: 'context', text: ID }] } }))).toEqual(['$.form.fields[0].text mxid'])
    expect(patterns(submitted({ form: { fields: [{ kind: 'radio', id: 'r', label: 'L', options: [option(ID, 'x'), option('y', ID), option('z', 'z', ID)] }] } }))).toEqual([
      '$.form.fields[0].options[0].value mxid',
      '$.form.fields[0].options[1].label mxid',
      '$.form.fields[0].options[2].description mxid',
    ])
    expect(patterns(submitted({ form: { fields: [{ kind: 'multiSelect', id: 'm', label: 'L', choices: { groups: [{ label: ID, options: [option('a', ID)] }] } }] } }))).toEqual([
      '$.form.fields[0].choices.groups[0].label mxid',
      '$.form.fields[0].choices.groups[0].options[0].label mxid',
    ])
    expect(patterns(submitted({ values: { verify: 'veja !r:tayet.local' } }))).toEqual(['$.submission.values.verify room-id'])
    // A value's key is a field id (the core hands over only those): the field's id carries the finding.
    expect(patterns(submitted({ form: { fields: fields({ id: ID }) }, values: { [ID]: 'x' } }))).toEqual(['$.form.fields[1].id mxid'])
  })

  it('the structural fields keep the full set: a denied word or a raw id there blocks', () => {
    expect(patterns(submitted({ origin: { kind: 'verify' } }))).toEqual(['$.origin.kind verify'])
    expect(patterns(submitted({ form: { fields: fields({ kind: 'cofre' }) } }))).toEqual(['$.form.fields[1].kind custody-identity'])
    expect(patterns({ ...submitted(), submission: { id: '1.000002', by: ID, at: 1, values: {} } })).toEqual(['$.submission.by mxid'])
  })

  it('the definition probe: denied words pass in the texts; an id shape blocks before any effect', () => {
    expect(scanFormProbe('CAAAAAAAAAA', { title: 'Verificar', submitLabel: 'cofre', fields: fields(), meta: 'verify' })).toEqual([])
    expect(scanFormProbe('CAAAAAAAAAA', { title: 'T', submitLabel: 'S', fields: fields({ label: ID }) }).map((l) => l.path)).toEqual(['$.form.fields[1].label'])
    expect(scanFormProbe('CAAAAAAAAAA', { title: 'T', submitLabel: 'S', fields: 'x', meta: ID }).map((l) => l.path)).toEqual(['$.form.meta'])
  })

  it('the result probe: denied words pass in the messages and the field ids; an id shape blocks', () => {
    expect(scanFormResultProbe('CAAAAAAAAAA', { verify: 'abra o cofre' })).toEqual([])
    expect(scanFormResultProbe('CAAAAAAAAAA', { verify: `fale com ${ID}` }).map((l) => `${l.path} ${l.pattern}`)).toEqual(['$.result.errors.verify mxid'])
  })
})

// A user id in content needs a boundary before its `@`: the address of an scp, a git remote, an rsync target
// and host:port are text a person or an agent writes. A structural field keeps the full set.
describe('edge scan — an address is not a user id in content', () => {
  const ADDRESSES = [
    'scp dev@build-host:project/test/goldens/home.png .',
    'git clone git@github.com:org/repo.git',
    'rsync -av user@host:dir/ .',
    'ssh root@10.0.0.1:22',
    'ana@vereda.com:8080',
  ]

  it.each(ADDRESSES)('passes in a message text, rich and a file name: %s', (text) => {
    expect(patterns({ messages: [message({ text })] })).toEqual([])
    expect(patterns(message({ rich: { t: 'p', children: [{ t: 'text', text }] } }))).toEqual([])
    expect(patterns(message({ files: [{ id: 'FA', name: text, mimetype: 'text/plain', size: 1 }] }))).toEqual([])
  })

  it.each(ADDRESSES)('still blocks in a structural field; passes in a name written by people: %s', (text) => {
    expect(patterns({ conversations: [{ id: 'CA', name: 'geral', kind: text, memberCount: 2 }] })).toEqual(['$.conversations[0].kind mxid'])
    expect(patterns({ conversations: [{ id: 'CA', name: text, kind: 'public', memberCount: 2 }] })).toEqual([])
  })
})

// A write's refusal as the caller's fault: the product names of the four id shapes, the field without `$.`, and
// any other finding keeps the refusal internal (null).
describe('refusedOf', () => {
  it('maps each id shape to its product name and the path to the field', () => {
    const leaks = [
      { path: '$.text', pattern: 'mxid', value: 'x', content: true as const },
      { path: '$.approval.options[0].label', pattern: 'room-id', value: 'x', content: true as const },
      { path: '$.panel.title', pattern: 'event-id', value: 'x', content: true as const },
      { path: '$.files[0].name', pattern: 'mxc-uri', value: 'x', content: true as const },
    ]
    expect(refusedOf(leaks)).toEqual([
      { field: 'text', pattern: 'user_id' },
      { field: 'approval.options[0].label', pattern: 'conversation_id' },
      { field: 'panel.title', pattern: 'message_id' },
      { field: 'files[0].name', pattern: 'media_address' },
    ])
    expect(JSON.stringify(refusedOf(leaks))).not.toContain('"x"')
  })

  it('any finding that is not an id shape → null; no finding → null', () => {
    expect(refusedOf([{ path: '$.text', pattern: 'mxid', value: 'x', content: true }, { path: '$.conversation', pattern: 'verify', value: 'x' }])).toBeNull()
    expect(refusedOf([])).toBeNull()
  })

  it('decides by where the finding came from: an id shape of the structural scan → null', () => {
    const inConversation = scanWriteProbe('!abc:tayet.local', 'ok')
    expect(inConversation.map((l) => `${l.path} ${l.pattern}`)).toEqual(['$.conversation room-id'])
    expect(refusedOf(inConversation)).toBeNull()
    const mixed = scanWriteProbe('!abc:tayet.local', 'ask @alice:tayet.local')
    expect(mixed.map((l) => `${l.path} ${l.pattern}`)).toEqual(['$.conversation room-id', '$.text mxid'])
    expect(refusedOf(mixed)).toBeNull()
    expect(refusedOf(scanWriteProbe('CAAAAAAAAAA', 'ask @alice:tayet.local'))).toEqual([{ field: 'text', pattern: 'user_id' }])
  })

  it('a form probe with an envelope key inside a content object → null (the content scan found it, but it is no id shape)', () => {
    const leaks = scanFormProbe('CAAAAAAAAAA', {
      title: 'Pedido',
      submitLabel: 'Enviar',
      fields: [{ id: 'c', kind: 'context', text: 'ok', rich: [{ t: 'p', format: 'x', children: [{ t: 'text', text: 'ok' }] }] }],
    })
    expect(leaks.map((l) => `${l.path} ${l.pattern}`)).toEqual(['$.form.fields[0].rich[0].format envelope-key'])
    expect(leaks[0]?.content).toBe(true)
    expect(refusedOf(leaks)).toBeNull()
  })
})

// A listing withholds only the message whose content carries an id shape, as an event does; the rest of the page
// comes back. A structural finding leaves the message as it is, for the scan of the whole answer.
describe('withholdMessages', () => {
  const held = (m: ReturnType<typeof message> & { thread?: string }) => ({
    id: m.id,
    conversation: m.conversation,
    author: m.author,
    text: '',
    mentionsMe: m.mentionsMe,
    reactions: [],
    unavailable: true,
    ...(m.thread !== undefined && { thread: m.thread }),
  })
  const page = (middle: ReturnType<typeof message>) => ({
    messages: [message({ id: '1730900000.000300', text: 'primeira' }), middle, message({ id: '1730900000.000100', text: 'terceira', reactions: [{ emoji: '👍', count: 1, mine: false }] })],
    next: 'cur_1',
  })
  const findings = (leaks: ReturnType<typeof withholdMessages>['leaks']) => leaks.map((l) => `${l.path} ${l.pattern}`)

  it('an id shape in the middle message’s text: only it goes out withheld, the others intact, the findings with the path in the answer', () => {
    const middle = message({ id: '1730900000.000200', text: 'fale com @alice:tayet.local', mentionsMe: true, reactions: [{ emoji: '👀', count: 2, mine: true }], thread: '1730900000.000050' })
    const body = page(middle)
    const out = withholdMessages(body)
    expect(out.body).toEqual({ ...body, messages: [body.messages[0], held(middle), body.messages[2]] })
    expect(findings(out.leaks)).toEqual(['$.messages[1].text mxid'])
    expect(out.leaks.every((l) => l.content === true)).toBe(true)
    expect(scanEdge(out.body)).toEqual([])
  })

  it.each([
    ['rich', { rich: { t: 'link', href: 'mxc://x/y' } }, '$.messages[1].rich.href mxc-uri'],
    ['a file name', { files: [{ id: 'FA', name: '!r:tayet.local', mimetype: 'x', size: 1 }] }, '$.messages[1].files[0].name room-id'],
    ['a card option label', { approval: { options: [{ id: 'ok', label: 'ver @bob:tayet.local' }], state: 'open' } }, '$.messages[1].approval.options[0].label mxid'],
    ['a command’s args', { command: { name: 'buscar', args: '$' + 'A'.repeat(43) } }, '$.messages[1].command.args event-id'],
  ])('the same for an id shape in %s', (_what, over, finding) => {
    const middle = message({ id: '1730900000.000200', ...over })
    const body = page(middle)
    const out = withholdMessages(body)
    expect(out.body).toEqual({ ...body, messages: [body.messages[0], held(middle), body.messages[2]] })
    expect(findings(out.leaks)).toEqual([finding])
    expect(scanEdge(out.body)).toEqual([])
  })

  it('a structural finding in the message (a raw id in author) leaves it as it is, for the scan of the whole answer', () => {
    for (const middle of [message({ id: '1730900000.000200', author: '@alice:tayet.local' }), message({ id: '1730900000.000200', author: '@alice:tayet.local', text: 'e @bob:tayet.local' })]) {
      const body = page(middle)
      const out = withholdMessages(body)
      expect(out.body).toBe(body)
      expect(out.leaks).toEqual([])
      expect(findings(scanEdge(out.body))).toContain('$.messages[1].author mxid')
    }
  })

  it('one message alone (not a listing) is handled too, with the path from the root', () => {
    const one = message({ text: 'fale com @alice:tayet.local' })
    const out = withholdMessages(one)
    expect(out.body).toEqual(held(one))
    expect(findings(out.leaks)).toEqual(['$.text mxid'])
  })

  it('a clean answer comes back as it is, with no finding', () => {
    const body = page(message({ id: '1730900000.000200', text: 'pode verificar o cofre?' }))
    expect(withholdMessages(body)).toEqual({ body, leaks: [] })
    expect(withholdMessages(body).body).toBe(body)
  })
})

// Names written by people: a conversation's `name` and `topic`, a person's `name` and the agent's own `name` get the
// id shapes and the two internal account identifiers (a person's and the agent's name also the custody account's).
// A finding there still withholds the whole answer: it is not a content finding.
describe('edge scan — names written by people', () => {
  const conversation = (over: Record<string, unknown> = {}) => ({ id: 'CA', name: 'geral', kind: 'public', topic: 'Avisos', memberCount: 3, ...over })
  const person = (over: Record<string, unknown> = {}) => ({ id: 'UA', name: 'Alice', kind: 'member', ...over })
  const agent = (over: Record<string, unknown> = {}) => ({ id: 'UG', workspace: 'TA', name: 'Relatórios', kind: 'agent', ...over })
  const fields: Array<[string, (v: string) => unknown, string]> = [
    ['a conversation name', (v) => ({ conversations: [conversation({ name: v })] }), '$.conversations[0].name'],
    ['a conversation topic', (v) => conversation({ topic: v }), '$.topic'],
    ['a person name', (v) => ({ people: [person({ name: v })] }), '$.people[0].name'],
    ['the agent name', (v) => agent({ name: v }), '$.name'],
  ]

  it.each(fields)('the vocabulary passes in %s', (_what, build) => {
    for (const v of ['Verificação de contas', 'escrow-team', 'decrypt the backup', 'olm', 'megolm']) expect(patterns(build(v))).toEqual([])
  })

  it('`cofre` passes in a conversation name and topic; in a person name and the agent name it flags', () => {
    expect(patterns({ conversations: [conversation({ name: 'cofre', topic: 'o cofre do time' })] })).toEqual([])
    expect(patterns({ people: [person({ name: 'cofre' })] })).toEqual(['$.people[0].name custody-identity'])
    expect(patterns(agent({ name: 'cofre' }))).toEqual(['$.name custody-identity'])
  })

  it.each(fields)('an id shape and the two internal identifiers flag in %s', (_what, build, path) => {
    expect(patterns(build('@alice:tayet.local'))).toEqual([`${path} mxid`])
    expect(patterns(build('!r:tayet.local'))).toEqual([`${path} room-id`])
    expect(patterns(build('u-abcdefghij23'))).toEqual([`${path} opaque-localpart`])
    expect(patterns(build('a-abcdefghij23'))).toEqual([`${path} agent-localpart`])
  })

  it('a finding in a name carries no content mark: refusedOf → null', () => {
    for (const [, build] of fields) {
      const leaks = scanEdge(build('@alice:tayet.local'))
      expect(leaks).toHaveLength(1)
      expect(leaks[0]?.content).toBeUndefined()
      expect(refusedOf(leaks)).toBeNull()
    }
  })

  it('conversation.added and member.changed with the vocabulary in the names pass', () => {
    expect(patterns({ type: 'conversation.added', conversation: conversation({ name: 'Verificação de contas', topic: 'decrypt' }) })).toEqual([])
    expect(patterns({ type: 'member.changed', conversation: 'CA', person: person({ name: 'Verônica (verificação)' }), state: 'joined' })).toEqual([])
    expect(patterns({ type: 'member.changed', conversation: 'CA', person: person({ name: 'u-abcdefghij23' }), state: 'left' })).toEqual(['$.person.name opaque-localpart'])
  })

  it('a `name` or `topic` in any other object keeps the full set', () => {
    expect(patterns({ name: 'verificar', topic: 'cofre' })).toEqual(['$.name verify', '$.topic custody-identity'])
    expect(patterns({ id: 'UA', name: 'verificar' })).toEqual(['$.name verify'])
    expect(patterns({ kind: 'public', name: 'verificar' })).toEqual(['$.name verify'])
  })

  it('the other fields of a conversation, a person and the agent stay structural', () => {
    expect(patterns(conversation({ kind: 'verified' }))).toEqual(['$.kind verify'])
    expect(patterns(person({ id: '@alice:tayet.local' }))).toEqual(['$.id mxid'])
    expect(patterns(agent({ workspace: 'escrow' }))).toEqual(['$.workspace escrow'])
  })

  it('a withheld listing or event never changes because of a name: withholdMessages leaves a page of people as it is', () => {
    const body = { people: [person({ name: '@alice:tayet.local' })] }
    expect(withholdMessages(body)).toEqual({ body, leaks: [] })
  })
})

// A reaction's `emoji` is user content: the id shapes only, with the content mark.
describe('edge scan — a reaction’s emoji is content', () => {
  const reacted = (emoji: string) => message({ reactions: [{ emoji: '👍', count: 1, mine: false }, { emoji, count: 2, mine: true }] })

  it('the vocabulary passes in a message’s reaction and in reaction.changed', () => {
    expect(patterns(reacted('verificado'))).toEqual([])
    expect(patterns({ type: 'reaction.changed', conversation: 'CA', id: '1.000001', reactions: [{ emoji: 'cofre', count: 1, mine: false }] })).toEqual([])
  })

  it('an id shape flags, with the content mark, in a message and in reaction.changed', () => {
    const inMessage = scanEdge(reacted('@alice:tayet.local'))
    expect(inMessage.map((l) => `${l.path} ${l.pattern}`)).toEqual(['$.reactions[1].emoji mxid'])
    expect(inMessage[0]?.content).toBe(true)
    const inEvent = scanEdge({ type: 'reaction.changed', conversation: 'CA', id: '1.000001', reactions: [{ emoji: '!r:tayet.local', count: 1, mine: false }] })
    expect(inEvent.map((l) => `${l.path} ${l.pattern}`)).toEqual(['$.reactions[0].emoji room-id'])
    expect(inEvent[0]?.content).toBe(true)
  })

  it('the rest of a reaction stays structural', () => {
    expect(patterns(message({ reactions: [{ emoji: '👍', count: 1, mine: false, kind: 'verified' }] }))).toEqual(['$.reactions[0].kind verify'])
  })

  it('a listed message with an id shape in a reaction goes out withheld; its neighbours intact', () => {
    const body = { messages: [message({ id: '1730900000.000300' }), reacted('@alice:tayet.local'), message({ id: '1730900000.000100' })] }
    const out = withholdMessages(body)
    expect((out.body.messages as Array<Record<string, unknown>>).map((m) => m.unavailable ?? false)).toEqual([false, true, false])
    expect(out.leaks.map((l) => `${l.path} ${l.pattern}`)).toEqual(['$.messages[1].reactions[1].emoji mxid'])
    expect(scanEdge(out.body)).toEqual([])
  })

  it('CONTENT_FIELDS lists the reaction', () => {
    expect(CONTENT_FIELDS).toContain('message.reactions[].emoji')
    expect(CONTENT_FIELDS).toContain('reaction.changed.reactions[].emoji')
  })
})

// The withheld form of a message keeps its thread.
describe('withheld', () => {
  it('keeps the thread of a reply; a message with no thread gets none', () => {
    expect(withheld(message({ text: 'x', thread: '1730900000.000050', threadSummary: { replyCount: 1, latestReplyAt: 1 } }))).toEqual({
      id: '1730900000.100123',
      conversation: 'CAAAAAAAAAA',
      author: 'UAAAAAAAAAA',
      text: '',
      mentionsMe: false,
      reactions: [],
      unavailable: true,
      thread: '1730900000.000050',
    })
    expect(withheld(message())).not.toHaveProperty('thread')
  })
})

// ADR-104 (Aprovadores 2): each answer's option of a card that asks for several answers is content; the
// reaction write's probe.
describe('edge scan — the answers of a card that asks for several (ADR-104)', () => {
  const card = (option: string) =>
    message({ text: 'Publicar?', approval: { options: [{ id: 'verify', label: 'Verificar' }], needed: 2, answers: [{ option: 'verify', by: 'UB', at: 1 }, { option, by: 'UC', at: 2 }, { by: 'UD', at: 3 }], state: 'open' } })

  it('an option id with a denied word in `answers` does not withhold the message (listing and state)', () => {
    expect(patterns(card('escrow'))).toEqual([])
    const out = withholdMessages({ messages: [card('olm')] })
    expect(out.leaks).toEqual([])
    expect((out.body.messages[0] as Record<string, unknown>).unavailable).toBeUndefined()
    expect(patterns({ conversation: 'CA', id: '1.000001', approval: { options: [{ id: 'olm', label: 'decrypt' }], needed: 2, answers: [{ option: 'olm', by: 'UB', at: 1 }], state: 'open' } })).toEqual([])
  })

  it('an id shape in an answer still withholds it, with the content mark; the rest of an answer stays structural', () => {
    const found = scanEdge(card('@alice:tayet.local'))
    expect(found.map((l) => `${l.path} ${l.pattern}`)).toEqual(['$.approval.answers[1].option mxid'])
    expect(found[0]?.content).toBe(true)
    const out = withholdMessages({ messages: [card('@alice:tayet.local')] })
    expect((out.body.messages[0] as Record<string, unknown>).unavailable).toBe(true)
    expect(patterns(message({ approval: { options: [], needed: 2, answers: [{ option: 'a', by: '@bob:tayet.local', at: 1 }] } }))).toEqual(['$.approval.answers[0].by mxid'])
    expect(patterns(message({ approval: { options: [], needed: 2, answers: [{ by: 'UB', at: 1, kind: 'verified' }] } }))).toEqual(['$.approval.answers[0].kind verify'])
  })

  it('CONTENT_FIELDS lists the option of each answer', () => {
    expect(CONTENT_FIELDS).toContain('approval.answers[].option')
  })
})

describe('the reaction write probe (ADR-104 dec. 23)', () => {
  it('an emoji or a short text passes; an id shape is found, named by the argument (`emoji`), with the content mark', () => {
    for (const emoji of ['👍', '❤️', '🇧🇷', 'ok', 'verificado']) expect(scanReactionProbe('CA', emoji), emoji).toEqual([])
    const found = scanReactionProbe('CA', '@nome:servidor.local')
    expect(found.map((l) => `${l.path} ${l.pattern}`)).toEqual(['$.emoji mxid'])
    expect(refusedOf(found)).toEqual([{ field: 'emoji', pattern: 'user_id' }])
    expect(refusedOf(scanReactionProbe('CA', 'mxc://servidor.local/x'))).toEqual([{ field: 'emoji', pattern: 'media_address' }])
  })

  it('an id shape in the conversation stays a structural finding (refusedOf → null)', () => {
    expect(refusedOf(scanReactionProbe('!sala:servidor.local', '👍'))).toBeNull()
  })
})
