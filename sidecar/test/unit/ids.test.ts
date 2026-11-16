import { describe, it, expect } from 'vitest'
import {
  botToken,
  conversationToken,
  CONVERSATION_TOKEN,
  eventSuffix,
  fileToken,
  messageTs,
  parseBound,
  parseTs,
  PERSON_TOKEN,
  personToken,
  serverNameOf,
  workspaceToken,
} from '../../src/api/ids'

// Opaque ids at the edge (ADR-087 dec. 4; PLANO-AGENTES §0.3.1 S4.1, P-S2). Fixed vectors: the values
// the §0 scratch computed with the same formula — a change here breaks agent↔agent stability.
describe('tokens', () => {
  it('fixed vectors (sha256 "<domain>:<raw>", base32, 10 chars)', () => {
    expect(conversationToken('!peiatLBbmbEqaUiqor:tayet.local', false)).toBe('CXXUURUO7E7')
    expect(personToken('@alice:tayet.local')).toBe('UW45NTU2UFO')
    expect(workspaceToken('tayet.local')).toBe('TJGDDXHWB66')
  })

  it('deterministic, prefixed, shaped; domains separated (C ≠ D of the same room)', () => {
    const room = '!abc:tayet.local'
    expect(conversationToken(room, false)).toBe(conversationToken(room, false))
    expect(conversationToken(room, false).slice(1)).not.toBe(conversationToken(room, true).slice(1))
    expect(conversationToken(room, true)).toMatch(/^D[A-Z2-7]{10}$/)
    expect(CONVERSATION_TOKEN.test(conversationToken(room, false))).toBe(true)
    expect(PERSON_TOKEN.test(personToken('@bob:x'))).toBe(true)
    expect(fileToken('mxc://x/y')).toMatch(/^F[A-Z2-7]{10}$/)
    // The same raw string in two domains never yields the same body.
    expect(personToken(room).slice(1)).not.toBe(conversationToken(room, false).slice(1))
  })

  it('the bot id is B + its own domain (§0.3.12 item 1): never the person token of the same account', () => {
    const agent = '@a-abcdefghijkl:tayet.local'
    expect(botToken(agent)).toMatch(/^B[A-Z2-7]{10}$/)
    expect(botToken(agent)).toBe(botToken(agent))
    expect(botToken(agent).slice(1)).not.toBe(personToken(agent).slice(1))
    expect(botToken(agent)).not.toMatch(/[!@:$.]/)
  })

  it('no protocol character survives', () => {
    for (const t of [conversationToken('!a:b.c', false), personToken('@a:b.c'), workspaceToken('b.c')]) {
      expect(t).not.toMatch(/[!@:$.]/)
    }
  })

  it('no collision in 100 000 people of one server', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100_000; i++) seen.add(personToken(`@u-${i}:tayet.local`))
    expect(seen.size).toBe(100_000)
  })

  it('the workspace is the server name of an mxid', () => {
    expect(serverNameOf('@a-abcdefghijkl:tayet.local')).toBe('tayet.local')
  })
})

describe('ts (P-S2)', () => {
  it('seconds . ms(3) + hash suffix(3); round-trips through parseTs', () => {
    expect(messageTs(1730900668362, '$abc')).toBe('1730900668.362516')
    expect(eventSuffix('$abc')).toBe('516')
    const p = parseTs('1730900668.362516')
    expect(p).toEqual({ ms: 1730900668362, suffix: '516', key: 1730900668362516n })
    expect(messageTs(1000, '$x').startsWith('1.000')).toBe(true)
  })

  it('malformed ts → null', () => {
    for (const v of ['', '1.2', '1730900668.36251', 'abc.123456', '$abc', '1730900668.3625160']) expect(parseTs(v)).toBeNull()
  })

  it('filter bounds accept a ts or seconds with up to 6 decimals', () => {
    expect(parseBound('1730900668')).toBe(1730900668000000n)
    expect(parseBound('1730900668.5')).toBe(1730900668500000n)
    expect(parseBound('1730900668.362516')).toBe(1730900668362516n)
    expect(parseBound('x')).toBeNull()
  })
})
