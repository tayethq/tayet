import { describe, it, expect } from 'vitest'
import { CLIENT_SECRET } from '../support/escrow-harness'
import { freshUsers } from '../support/fresh-users'
import { introspectionNote, introspectToken, synapseReachable } from '../support/synapse'

// Direct MAS introspection — the M2 device-race discriminator (PLANO-GATES §8.10) against the live
// stack: a fresh token is active at MAS, an invented one is not, and the diagnostic text never
// carries the full token nor the introspection client's secret.

const SYNAPSE = synapseReachable()

const inventedToken = (): string => {
  const alnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const pick = (n: number) =>
    Array.from(globalThis.crypto.getRandomValues(new Uint8Array(n)), (b) => alnum[b % alnum.length]).join('')
  return `mct_${pick(30)}_${pick(6)}`
}

describe.skipIf(!SYNAPSE)('MAS direct introspection (M2 device race, §8.10)', () => {
  it('freshly minted token: active at MAS', async () => {
    const [u] = await freshUsers(['tin'])
    expect(await introspectToken(u.token)).toEqual({ status: 200, active: true })
  })

  it('invented token: inactive at MAS', async () => {
    expect(await introspectToken(inventedToken())).toEqual({ status: 200, active: false })
  })

  it('diagnostic text: neither the full token nor the secret', async () => {
    const [u] = await freshUsers(['tis'])
    const fake = inventedToken()
    for (const token of [u.token, fake]) {
      const note = introspectionNote(token, await introspectToken(token))
      expect(note).toContain(`mct_…${token.slice(-6)}`)
      expect(note).not.toContain(token)
      expect(note).not.toContain(CLIENT_SECRET)
    }
  })
})

describe('MAS direct introspection (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
