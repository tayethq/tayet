import { describe, it, expect } from 'vitest'
import type { Message, User, UserId } from '../../src/acl'
import { resolveAuthor } from '../../src/ui/author'

// PLANO-AGENTES §0.3.11: the one author resolution of the UI — member map, else the portrait at the
// event (`authorAt`), else the surface's fallback. The agent mark follows `agent`, colour → 'areia'.

const uid = (s: string): UserId => s as unknown as UserId
const AGENT = uid('@a-abcdefghijkl:tayet.local')
const ALICE = uid('@alice:tayet.local')
const FALLBACK = 'Alguém'

const agent: User = { id: AGENT, displayName: 'Revisor', kind: 'agent', agentColor: 'malva' }
const alice: User = { id: ALICE, displayName: 'Alice Souza', kind: 'member' }
const of = (author: UserId, authorAt?: Message['authorAt']): Pick<Message, 'author' | 'authorAt'> => ({
  author,
  ...(authorAt && { authorAt }),
})

describe('resolveAuthor (PLANO-AGENTES §0.3.11)', () => {
  it('the current member map wins over the portrait', () => {
    expect(resolveAuthor(of(ALICE, { name: 'Alice antiga', agent: false }), { [ALICE]: alice }, FALLBACK)).toEqual({
      name: 'Alice Souza',
      user: alice,
    })
    // The map's agent colour, not the portrait's.
    expect(resolveAuthor(of(AGENT, { name: 'Velho', agent: true, color: 'ocre' }), { [AGENT]: agent }, FALLBACK)).toEqual({
      name: 'Revisor',
      agentColor: 'malva',
      user: agent,
    })
  })

  it('a person out of the map with a portrait → the portrait name, no mark', () => {
    expect(resolveAuthor(of(ALICE, { name: 'Alice Souza', agent: false }), {}, FALLBACK)).toEqual({ name: 'Alice Souza' })
    // A portrait without a name → the fallback, never the id.
    expect(resolveAuthor(of(ALICE, { agent: false }), {}, FALLBACK)).toEqual({ name: FALLBACK })
  })

  it('an agent out of the map → name and the mark (portrait colour, else areia)', () => {
    expect(resolveAuthor(of(AGENT, { name: 'Revisor', agent: true, color: 'malva' }), {}, FALLBACK)).toEqual({
      name: 'Revisor',
      agentColor: 'malva',
    })
    expect(resolveAuthor(of(AGENT, { agent: true }), {}, FALLBACK)).toEqual({ name: FALLBACK, agentColor: 'areia' })
  })

  it('no portrait (an older search entry) → the fallback', () => {
    expect(resolveAuthor(of(AGENT), {}, FALLBACK)).toEqual({ name: FALLBACK })
  })
})
