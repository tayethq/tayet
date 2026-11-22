import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry } from '../../src/acl'
import { HOMESERVER, mintToken, synapseReachable, whoami } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { until } from '../support/until'

// The account's preferences across two devices of the same person: two ACL connections on one fresh
// account (A and B). A new account reads {} with and without `fresh`; what A writes, B reads straight
// from the server; a third device that connects after the write sees it as soon as connect resolves (the
// synced cache already holds the account's data then); Automatic reads back as {}; and a field this
// client does not know survives a write. Auto-skip without the stack.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const KEY = 'io.tayet.preferences'

async function connect(token: string): Promise<Acl> {
  const acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
  await acl.connect(token as Parameters<Acl['connect']>[0])
  return acl
}

describe.skipIf(!SYNAPSE)('account preferences on two devices of the same person', () => {
  let a: Acl
  let b: Acl
  let name: string
  let token: string
  let path: string

  const raw = async (init?: RequestInit): Promise<Response> =>
    fetch(`${HOMESERVER}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })

  beforeAll(async () => {
    const [user] = await freshUsers(['prf'])
    name = user.name
    token = user.token
    path = `/_matrix/client/v3/user/${encodeURIComponent(await whoami(token))}/account_data/${KEY}`
    a = await connect(token)
    b = await connect(await mintToken(name))
  }, 240_000)

  afterAll(async () => {
    await a?.disconnect()
    await b?.disconnect()
  })

  it('a new account reads {} with and without fresh', async () => {
    expect(await a.getAccountPreferences()).toEqual({})
    expect(await a.getAccountPreferences({ fresh: true })).toEqual({})
    expect(await b.getAccountPreferences({ fresh: true })).toEqual({})
    expect((await raw()).status).toBe(404)
  })

  it('A writes en, B reads en; a device that connects afterwards sees it right after connect', async () => {
    await a.setAccountPreferences({ language: 'en' })
    expect(await b.getAccountPreferences({ fresh: true })).toEqual({ language: 'en' })
    await until('B sync carries the key', async () => ((await b.getAccountPreferences()).language === 'en' ? true : undefined))
    const c = await connect(await mintToken(name))
    try {
      expect(await c.getAccountPreferences()).toEqual({ language: 'en' })
    } finally {
      await c.disconnect()
    }
  }, 120_000)

  it('A writes Automatic, B reads {}', async () => {
    await a.setAccountPreferences({ language: '' })
    expect(await b.getAccountPreferences({ fresh: true })).toEqual({})
    expect(await (await raw()).json()).toEqual({})
  })

  it('a field this client does not know survives a write', async () => {
    expect((await raw({ method: 'PUT', body: JSON.stringify({ language: 'pt-BR', density: 'compact' }) })).ok).toBe(true)
    await until('A sync carries the stored field', async () =>
      (await a.getAccountPreferences()).language === 'pt-BR' ? true : undefined,
    )
    await a.setAccountPreferences({ language: 'en' })
    expect(await (await raw()).json()).toEqual({ language: 'en', density: 'compact' })
    expect(await b.getAccountPreferences({ fresh: true })).toEqual({ language: 'en' })
  }, 120_000)
})
