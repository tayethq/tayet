import { describe, it, expect } from 'vitest'
import { mintToken, TokenDeviceRaceError, type Introspection, type TokenFx } from './support/synapse'

// Decision of the token-activation probe/mint (PLANO-GATES §8.10, M2 device race) against fake
// effects — no stack, no docker, no real clock.

const tok = (n: number) => `mct_${String(n).repeat(30).slice(0, 30)}_crc${String(n).padStart(3, '0')}`

interface Fake {
  fx: TokenFx
  mints: () => number
  introspections: () => number
  warnings: string[]
}

// whoami: one status per call, the last one repeating. introspect: one active flag per call.
function fake(whoami: number[], introspection: boolean[]): Fake {
  let clock = 0
  let mintCount = 0
  let introCount = 0
  let whoamiCount = 0
  const warnings: string[] = []
  const fx: TokenFx = {
    fetch: () => {
      const status = whoami[Math.min(whoamiCount++, whoami.length - 1)] ?? 200
      const errcode = status === 401 ? 'M_UNKNOWN_TOKEN' : status === 429 ? 'M_LIMIT_EXCEEDED' : 'M_UNKNOWN'
      const body = status === 200 ? { user_id: '@u:tayet.local' } : { errcode }
      return Promise.resolve(new Response(JSON.stringify(body), { status }))
    },
    introspect: (): Promise<Introspection> => {
      const active = introspection[Math.min(introCount++, introspection.length - 1)] ?? false
      return Promise.resolve({ status: 200, active })
    },
    exec: () => `Compatibility token issued: ${tok(++mintCount)}`,
    now: () => clock,
    sleep: (ms) => {
      clock += ms
      return Promise.resolve()
    },
    warn: (line) => warnings.push(line),
  }
  return { fx, mints: () => mintCount, introspections: () => introCount, warnings }
}

describe('token activation probe — M2 device race (§8.10)', () => {
  it('(i) whoami 200 at first: zero introspection, zero re-mint', async () => {
    const f = fake([200], [])
    await expect(mintToken('u', f.fx)).resolves.toBe(tok(1))
    expect(f.introspections()).toBe(0)
    expect(f.mints()).toBe(1)
    expect(f.warnings).toEqual([])
  })

  it('(ii) 401 + MAS active: exactly one re-mint, one log line, returns the second token', async () => {
    const f = fake([401, 200], [true])
    await expect(mintToken('u', f.fx)).resolves.toBe(tok(2))
    expect(f.mints()).toBe(2)
    expect(f.introspections()).toBe(1)
    expect(f.warnings).toEqual([`[m2-device-race] re-mint for u (token mct_…${tok(1).slice(-6)})`])
    expect(f.warnings.join('')).not.toContain(tok(1))
  })

  it('(iii) signature twice: throws with both occurrences, exactly two mints, no token in clear', async () => {
    const f = fake([401], [true, true])
    const err = await mintToken('u', f.fx).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TokenDeviceRaceError)
    const message = (err as Error).message
    expect(message).toContain('(1)')
    expect(message).toContain('(2)')
    expect(message).toContain(`mct_…${tok(1).slice(-6)}`)
    expect(message).toContain(`mct_…${tok(2).slice(-6)}`)
    expect(message).not.toContain(tok(1))
    expect(message).not.toContain(tok(2))
    expect(f.mints()).toBe(2)
    expect(f.warnings).toHaveLength(1)
  })

  it('(iv) 401 + MAS inactive: no re-mint, the poll goes on until whoami accepts', async () => {
    const f = fake([401, 401, 200], [false])
    await expect(mintToken('u', f.fx)).resolves.toBe(tok(1))
    expect(f.mints()).toBe(1)
    expect(f.introspections()).toBe(1)
    expect(f.warnings).toEqual([])
  })

  it('(v) 401 + MAS inactive to the end: budget overflow carries both introspections', async () => {
    const f = fake([401], [false])
    const err = await mintToken('u', f.fx).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(TokenDeviceRaceError)
    const message = (err as Error).message
    expect(message).toMatch(/^token-activation probe: token not active after \d+ms/)
    expect(message).toContain('first 401: MAS introspection HTTP 200 active=false')
    expect(message).toContain('at budget: MAS introspection HTTP 200 active=false')
    expect(message).not.toContain(tok(1))
    expect(f.mints()).toBe(1)
    expect(f.introspections()).toBe(2)
  })

  it('(vi) 429 then 200 with MAS active: zero introspection, zero re-mint, zero warn', async () => {
    const f = fake([429, 200], [true])
    await expect(mintToken('u', f.fx)).resolves.toBe(tok(1))
    expect(f.introspections()).toBe(0)
    expect(f.mints()).toBe(1)
    expect(f.warnings).toEqual([])
  })

  it('(vii) 503 then 401 with MAS active: one introspection, one re-mint, one race line', async () => {
    const f = fake([503, 401, 200], [true])
    await expect(mintToken('u', f.fx)).resolves.toBe(tok(2))
    expect(f.introspections()).toBe(1)
    expect(f.mints()).toBe(2)
    expect(f.warnings).toEqual([`[m2-device-race] re-mint for u (token mct_…${tok(1).slice(-6)})`])
  })
})
