import { describe, it, expect } from 'vitest'
import { MatrixError, Method } from 'matrix-js-sdk'
import { PREFERENCES_KEY, readPreferences, writePreferences } from '../src/acl/internal/preferences'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import * as barrel from '../src/acl'
import type { AclTelemetry } from '../src/acl'

// The account's preferences (language): the pure read/write helpers, the two gateway verbs against a
// fake client (when they ask the server, what they write), and the surface invariant that the
// account-data key never crosses the barrel.

describe('readPreferences', () => {
  it('reads a non-empty string language', () => {
    expect(readPreferences({ language: 'en' })).toEqual({ language: 'en' })
  })

  it('absent or malformed content is no preference', () => {
    for (const content of [undefined, null, 'en', 3, [], {}, { language: '' }, { language: 7 }, { language: null }]) {
      expect(readPreferences(content)).toEqual({})
    }
  })

  it('the value is opaque: an unknown language passes through', () => {
    expect(readPreferences({ language: 'fr-CA' })).toEqual({ language: 'fr-CA' })
  })
})

describe('writePreferences', () => {
  it('sets the language and keeps unknown fields', () => {
    expect(writePreferences({ density: 'compact', language: 'pt-BR' }, { language: 'en' })).toEqual({
      density: 'compact',
      language: 'en',
    })
  })

  it("'' or undefined removes the language; the other fields stay", () => {
    expect(writePreferences({ density: 'compact', language: 'en' }, { language: '' })).toEqual({ density: 'compact' })
    expect(writePreferences({ language: 'en' }, { language: undefined })).toEqual({})
  })

  it('a patch without the key leaves the language as it is', () => {
    expect(writePreferences({ language: 'en' }, {})).toEqual({ language: 'en' })
  })

  it('absent or malformed content starts from nothing', () => {
    for (const content of [undefined, null, 'x', [1]]) {
      expect(writePreferences(content, { language: 'en' })).toEqual({ language: 'en' })
    }
  })
})

describe('getAccountPreferences / setAccountPreferences (gateway)', () => {
  const noopTelemetry: AclTelemetry = { untranslated: () => {} }
  const path = `/user/${encodeURIComponent('@u:tayet.local')}/account_data/${encodeURIComponent(PREFERENCES_KEY)}`
  const notFound = () => new MatrixError({ errcode: 'M_NOT_FOUND', error: 'Account data not found' }, 404)

  // `cached`: what the synced cache shows for the key; `server`: what the endpoint holds (undefined = 404).
  function gatewayWith(opts: { cached?: unknown; server?: unknown; fail?: 'get' | 'put' }) {
    const requests: Array<{ method: unknown; path: string; content?: unknown }> = []
    let server = opts.server
    const fakeClient = {
      getUserId: () => '@u:tayet.local',
      getAccountData: (type: string) =>
        type === PREFERENCES_KEY && opts.cached !== undefined ? { getContent: () => opts.cached } : undefined,
      http: {
        authedRequest: async (method: unknown, p: string, _q: unknown, content?: unknown) => {
          requests.push({ method, path: p, ...(content !== undefined && { content }) })
          if (method === Method.Get) {
            if (opts.fail === 'get') throw new Error('network')
            if (server === undefined) throw notFound()
            return server
          }
          if (opts.fail === 'put') throw new Error('network')
          server = content
          return {}
        },
      },
    }
    const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
    ;(gateway as unknown as { client: unknown }).client = fakeClient
    return { gateway, requests, server: () => server }
  }

  it('no key in the cache and no `fresh`: {} with no request', async () => {
    const { gateway, requests } = gatewayWith({ server: { language: 'en' } })
    expect(await gateway.getAccountPreferences()).toEqual({})
    expect(requests).toEqual([])
  })

  it('a key in the cache: reads the server, not the cache', async () => {
    const { gateway, requests } = gatewayWith({ cached: { language: 'pt-BR' }, server: { language: 'en' } })
    expect(await gateway.getAccountPreferences()).toEqual({ language: 'en' })
    expect(requests).toEqual([{ method: Method.Get, path }])
  })

  it('`fresh`: reads the server even with no key in the cache', async () => {
    const { gateway, requests } = gatewayWith({ server: { language: 'en' } })
    expect(await gateway.getAccountPreferences({ fresh: true })).toEqual({ language: 'en' })
    expect(requests).toEqual([{ method: Method.Get, path }])
  })

  it('an account with no preferences on the server reads {}', async () => {
    const { gateway } = gatewayWith({})
    expect(await gateway.getAccountPreferences({ fresh: true })).toEqual({})
  })

  it('any other failure rejects', async () => {
    const { gateway } = gatewayWith({ cached: {}, fail: 'get' })
    await expect(gateway.getAccountPreferences()).rejects.toThrow('network')
  })

  it('write with the key in the cache: reads the server, merges, writes', async () => {
    const { gateway, requests, server } = gatewayWith({
      cached: { language: 'pt-BR' },
      server: { language: 'pt-BR', density: 'compact' },
    })
    await gateway.setAccountPreferences({ language: 'en' })
    expect(requests.map((r) => r.method)).toEqual([Method.Get, Method.Put])
    expect(server()).toEqual({ language: 'en', density: 'compact' })
  })

  it('write with no key in the cache: the patch alone, no read', async () => {
    const { gateway, requests, server } = gatewayWith({})
    await gateway.setAccountPreferences({ language: 'en' })
    expect(requests).toEqual([{ method: Method.Put, path, content: { language: 'en' } }])
    expect(server()).toEqual({ language: 'en' })
  })

  it("Automatic ('') removes the language", async () => {
    const { gateway, server } = gatewayWith({ cached: { language: 'en' }, server: { language: 'en' } })
    await gateway.setAccountPreferences({ language: '' })
    expect(server()).toEqual({})
  })

  it('a failed read or write rejects', async () => {
    await expect(gatewayWith({ cached: {}, fail: 'get' }).gateway.setAccountPreferences({ language: 'en' })).rejects.toThrow()
    await expect(gatewayWith({ fail: 'put' }).gateway.setAccountPreferences({ language: 'en' })).rejects.toThrow()
  })
})

describe('the preferences key never crosses the barrel (surface invariant)', () => {
  it('is not reachable from any barrel export', () => {
    expect(PREFERENCES_KEY).toBe('io.tayet.preferences')
    expect(Object.keys(barrel).some((n) => n.includes(PREFERENCES_KEY) || /PREFERENCES_KEY/i.test(n))).toBe(false)
    const runtimeValues = Object.values(barrel).filter((v) => typeof v === 'string') as string[]
    expect(runtimeValues).not.toContain(PREFERENCES_KEY)
  })
})
