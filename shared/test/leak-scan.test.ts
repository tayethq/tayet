import { describe, it, expect } from 'vitest'
import { findProtocolLeaks, findProtocolLeaksInText, ID_SHAPE_PATTERNS } from '../src/leak-scan'

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
