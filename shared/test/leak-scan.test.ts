import { describe, it, expect } from 'vitest'
import { CONVERSATION_NAME_PATTERNS, findProtocolLeaks, findProtocolLeaksInText, ID_SHAPE_PATTERNS, PERSON_NAME_PATTERNS, PROTOCOL_PATTERNS } from '../src/leak-scan'

// Teste de mesa do padrão do localpart opaco (ADR-083): acusa o formato exato de randomLocalpart e
// nenhuma palavra vizinha.

const patternsIn = (text: string): string[] => findProtocolLeaksInText(text).map((l) => l.pattern)

describe('opaque-localpart', () => {
  it.each(['u-abcdefghij23', 'Conversa com u-zq2whhwsc6nh agora', 'u-ob3ent3ngelu'])('acusa: %s', (text) => {
    expect(patternsIn(text)).toContain('opaque-localpart')
  })

  it.each([
    'u-abc',
    'u-abcdefghij234',
    'u-abcdefghij01',
    'U-ABCDEFGHIJ23',
    'menu-abcdefghij23',
    'Ana Lima',
  ])('não acusa: %s', (text) => {
    expect(patternsIn(text)).not.toContain('opaque-localpart')
  })

  it('no objeto de domínio, displayName acusa e o id opaco não', () => {
    const id = '@u-abcdefghij23:tayet.local'
    expect(findProtocolLeaks({ id, displayName: 'Ana' })).toEqual([])
    expect(findProtocolLeaks({ id, displayName: 'u-abcdefghij23' }).map((l) => l.pattern)).toEqual([
      'opaque-localpart',
    ])
  })
})

// Irmão do `u-` (ADR-086, Proposto, dec. 1/2): o localpart reservado de agente.
describe('agent-localpart', () => {
  it.each(['a-abcdefghij23', 'Relatório de a-zq2whhwsc6nh pronto', 'a-ob3ent3ngelu'])('acusa: %s', (text) => {
    expect(patternsIn(text)).toContain('agent-localpart')
  })

  it.each([
    'a-abc',
    'a-abcdefghij234',
    'a-abcdefghij01',
    'A-ABCDEFGHIJ23',
    'data-abcdefghij23',
    'u-abcdefghij23',
    'Agente de Relatórios',
  ])('não acusa: %s', (text) => {
    expect(patternsIn(text)).not.toContain('agent-localpart')
  })

  it('no objeto de domínio, displayName acusa e o id do agente não', () => {
    const id = '@a-abcdefghij23:tayet.local'
    expect(findProtocolLeaks({ id, displayName: 'Relatórios' })).toEqual([])
    expect(findProtocolLeaks({ id, displayName: 'a-abcdefghij23' }).map((l) => l.pattern)).toEqual([
      'agent-localpart',
    ])
  })
})

// ADR-089 dec. 2: id de evento (salas v4+: `$` + 43 de base64url) e `replyTo` opaco.
describe('event-id', () => {
  const eventId = '$' + 'Ab9_-'.repeat(8) + 'Ab9'

  it('o id tem 44 caracteres e acusa no texto', () => {
    expect(eventId).toHaveLength(44)
    expect(patternsIn(eventId)).toContain('event-id')
    expect(patternsIn(`veja ${eventId} aqui`)).toContain('event-id')
  })

  it.each(['$100 dollars', '1730900668.362516', '$' + 'a'.repeat(42), '$' + 'a'.repeat(44), 'US$ 43 mil'])(
    'não acusa: %s',
    (text) => {
      expect(patternsIn(text)).not.toContain('event-id')
    },
  )

  it('replyTo é chave opaca; o mesmo id num campo não opaco acusa', () => {
    expect(findProtocolLeaks({ id: eventId, threadParent: eventId, replyTo: eventId })).toEqual([])
    expect(findProtocolLeaks({ name: eventId }).map((l) => l.pattern)).toEqual(['event-id'])
  })
})

// ADR-089 dec. 1: só as formas de id, para o conteúdo do usuário na borda do sidecar.
describe('ID_SHAPE_PATTERNS', () => {
  it('são exatamente as quatro formas de id', () => {
    expect(ID_SHAPE_PATTERNS.map((p) => p.name).sort()).toEqual(['event-id', 'mxc-uri', 'mxid', 'room-id'])
  })

  it('prosa com vocabulário passa; formas de id e chaves de envelope acusam', () => {
    const scan = (v: unknown): string[] => findProtocolLeaks(v, new Set(), ID_SHAPE_PATTERNS).map((l) => l.pattern)
    expect(scan('please verify the VM backup; deixei no cofre')).toEqual([])
    expect(scan('fale com @alice:tayet.local')).toEqual(['mxid'])
    expect(scan({ t: 'p', children: [{ t: 'text', text: 'mxc://x/y' }] })).toEqual(['mxc-uri'])
    expect(scan({ formatted_body: 'oi' })).toEqual(['envelope-key'])
  })
})

// In user content, a user id only counts when its `@` does not follow a word character, `.` or `-`: the
// address of an scp, a git remote, an rsync target and host:port are ordinary text. The gates' full set
// (PROTOCOL_PATTERNS) keeps the unanchored shape.
describe('ID_SHAPE_PATTERNS — a user id needs a boundary before the `@`', () => {
  const scan = (v: unknown): string[] => findProtocolLeaks(v, new Set(), ID_SHAPE_PATTERNS).map((l) => l.pattern)
  const ADDRESSES = [
    'scp dev@build-host:project/test/goldens/home.png .',
    'git clone git@github.com:org/repo.git',
    'rsync -av user@host:dir/ .',
    'ssh root@10.0.0.1:22',
    'ana@vereda.com:8080',
  ]
  const IDS = [
    '@alice:tayet.local',
    '@alice:tayet.local can you look?',
    'ask @alice:tayet.local',
    'first line\n@alice:tayet.local',
    'ask her (@alice:tayet.local)',
    'user=@alice:tayet.local',
  ]

  it.each(ADDRESSES)('an address in content passes: %s', (text) => {
    expect(scan(text)).toEqual([])
  })

  it.each(IDS)('a user id in content still flags: %j', (text) => {
    expect(scan(text)).toEqual(['mxid'])
  })

  it('the full set is unchanged: the same address still flags as mxid', () => {
    expect(findProtocolLeaks('dev@build-host:project').map((l) => l.pattern)).toEqual(['mxid'])
    expect(findProtocolLeaksInText('dev@build-host:project').map((l) => l.pattern)).toEqual(['mxid'])
  })
})

// PLANO-AGENTES §0.3.23 item 10: `agent` is an opaque id key (AgentPanel, AgentCommand, Message.command).
describe('agent as an opaque id key', () => {
  const AGENT = '@a-bbbbbbbbbbbb:tayet.local'

  it('the agent id under `agent` passes, in a panel and in a message command', () => {
    expect(findProtocolLeaks({ agent: AGENT, title: 'Painel', text: 'ok', updatedAt: 1 })).toEqual([])
    expect(findProtocolLeaks({ id: '$x', author: '@bob:tayet.local', command: { agent: AGENT, name: 'deploy' } })).toEqual([])
    expect(findProtocolLeaks([{ agent: AGENT, name: 'status', description: 'Mostra o estado' }])).toEqual([])
  })

  it('the same id under any other key still fires, and `agent` covers only itself', () => {
    expect([...new Set(findProtocolLeaks({ command: { agentId: AGENT, name: 'deploy' } }).map((l) => l.path))]).toEqual(['$.command.agentId'])
    expect([...new Set(findProtocolLeaks({ agent: AGENT, name: AGENT }).map((l) => l.path))]).toEqual(['$.name'])
    // An object under `agent` is walked: nothing inside it is exempt.
    expect(findProtocolLeaks({ agent: { name: AGENT } }).length).toBeGreaterThan(0)
  })
})

// ADR-094 (Proposto) dec. 1: `participants` on a group Channel is a UserId[] — an opaque id key whose string
// elements inherit the array's key; the group's display text in `name` is still scanned.
describe('participants as an opaque id key', () => {
  const group = (name: string) => ({
    id: '!g:tayet.local',
    name,
    kind: 'group',
    memberCount: 3,
    unread: { count: 0, mentions: 0 },
    participants: ['@ana:tayet.local', '@u-abcdefghij23:tayet.local', '@a-bbbbbbbbbbbb:tayet.local'],
  })

  it('protocol-shaped ids under `participants` pass', () => {
    expect(findProtocolLeaks(group('Ana, Bruno'))).toEqual([])
  })

  it('a protocol-shaped display name in the same channel still fires, on `name` only', () => {
    const leaks = findProtocolLeaks(group('Ana, @bruno:tayet.local'))
    expect(leaks.length).toBeGreaterThan(0)
    expect([...new Set(leaks.map((l) => l.path))]).toEqual(['$.name'])
  })

  it('an object inside `participants` is walked with no key: nothing inside it is exempt', () => {
    expect(findProtocolLeaks({ participants: [{ name: '@bruno:tayet.local' }] }).length).toBeGreaterThan(0)
  })
})

// Names written by people (a conversation's name and topic, a person's name, the agent's own name): the id shapes
// and the two internal account identifiers; a person's name also the custody account's. The vocabulary of the
// full set does not apply there; the gates' set (PROTOCOL_PATTERNS) is unchanged.
describe('the sets for names written by people', () => {
  const scan = (v: string, set: readonly { name: string; re: RegExp }[]): string[] => findProtocolLeaks(v, new Set(), set).map((l) => l.pattern)

  it.each(['Verificação de contas', 'escrow-team', 'decrypt', 'cofre'])('the conversation set does not flag: %s', (name) => {
    expect(scan(name, CONVERSATION_NAME_PATTERNS)).toEqual([])
  })

  it('the person set flags `cofre`; the rest of the vocabulary passes there too', () => {
    expect(scan('cofre', PERSON_NAME_PATTERNS)).toEqual(['custody-identity'])
    for (const name of ['Verificação de contas', 'escrow-team', 'decrypt']) expect(scan(name, PERSON_NAME_PATTERNS)).toEqual([])
  })

  it.each([
    ['@alice:tayet.local', 'mxid'],
    ['u-abcdefghij23', 'opaque-localpart'],
    ['a-abcdefghij23', 'agent-localpart'],
  ])('both sets flag %s', (name, pattern) => {
    expect(scan(name, CONVERSATION_NAME_PATTERNS)).toEqual([pattern])
    expect(scan(name, PERSON_NAME_PATTERNS)).toEqual([pattern])
  })

  it('the person set is the conversation set plus custody-identity; both are derived from the existing patterns', () => {
    expect(PERSON_NAME_PATTERNS.map((p) => p.name)).toEqual([...CONVERSATION_NAME_PATTERNS.map((p) => p.name), 'custody-identity'])
    for (const p of CONVERSATION_NAME_PATTERNS) expect([...ID_SHAPE_PATTERNS, ...PROTOCOL_PATTERNS]).toContain(p)
  })

  it('the gates are unchanged: PROTOCOL_PATTERNS still flags `verify`', () => {
    expect(scan('Verificação de contas', PROTOCOL_PATTERNS)).toContain('verify')
  })
})
