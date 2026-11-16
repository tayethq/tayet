import { afterEach, describe, expect, it, vi } from 'vitest'

// The stack namespace of the harness (test/support/stack-env.ts, PLANO-CI-INTEGRACAO §8.R2 fase 2b).
// With a clean env it must give the owner's spike, literally — the local flow does not change — and
// the e2e console expectations built from it must be the exact strings and patterns they were when
// they were literals. With the namespace env set, the values shift. No stack needed.

const STACK_VARS = [
  'TAYET_HS_URL',
  'TAYET_MAS_URL',
  'TAYET_ESCROW_URL',
  'TAYET_SPA_PORT',
  'TAYET_MAS_CONTAINER',
  'TAYET_MAS_CONFIG',
  'TAYET_AGENT_CONTAINER',
  'TAYET_AGENT_VOLUME',
  'TAYET_SPA_CLIENT_ID',
  'TAYET_SPA_REDIRECT',
  'TAYET_REQUIRE_STACK',
]

async function load() {
  vi.resetModules()
  return import('./support/stack-env')
}

function cleanEnv() {
  // stubEnv(undefined) deletes the variable for the test; unstubAllEnvs restores it after.
  for (const v of STACK_VARS) vi.stubEnv(v, undefined)
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('stack-env', () => {
  it('defaults to the spike, literally', async () => {
    cleanEnv()
    const env = await load()
    expect({ ...env, escapeRegExp: undefined, hostUrlPattern: undefined }).toEqual({
      HS_URL: 'http://localhost:8008',
      MAS_URL: 'http://localhost:8080',
      ESCROW_URL: 'http://localhost:8090',
      APP_URL: 'http://localhost:5173',
      MAS_CONTAINER: 'spike-mas-1',
      MAS_CONFIG: '/config/config.yaml',
      AGENT_CONTAINER: 'spike-agent-1',
      AGENT_VOLUME: 'spike_agentdata',
      SPA_CLIENT_ID: '000000000000000000000TAYET',
      SPA_REDIRECT: 'http://localhost:5173/',
      REQUIRE_STACK: false,
      escapeRegExp: undefined,
      hostUrlPattern: undefined,
    })
    // The pattern that replaced /^http:\/\/localhost:(8008|8080)\// in tab-lock and device-list-staleness.
    const hosts = env.hostUrlPattern(env.HS_URL, env.MAS_URL)
    expect(hosts.source).toBe('^(?:http:\\/\\/localhost:8008|http:\\/\\/localhost:8080)\\/')
    for (const u of ['http://localhost:8008/_matrix/client/v3/sync', 'http://localhost:8080/oauth2/token']) {
      expect(hosts.test(u), u).toBe(true)
    }
    for (const u of ['http://localhost:8090/v1/secret', 'http://localhost:18008/_matrix', 'http://localhost:5173/escrow/x']) {
      expect(hosts.test(u), u).toBe(false)
    }
  })

  it('keeps the e2e console expectations identical to the former literals', async () => {
    cleanEnv()
    await load()
    const c = await import('../e2e/support/console')
    expect(c.FIRST_LOGIN_404.map((r) => r.url)).toEqual([
      'http://localhost:8008/_matrix/client/v3/room_keys/version',
      'http://localhost:5173/escrow/v1/secret',
    ])
    expect(c.AFTER_REVOCATION_401.map((r) => r.url)).toEqual([
      'http://localhost:8008/_matrix/client/v3/sync',
      'http://localhost:8008/_matrix/client/v3/keys/upload',
      'http://localhost:8008/_matrix/client/v3/keys/query',
      'http://localhost:8008/_matrix/client/v3/room_keys/keys',
      'http://localhost:8080/oauth2/token',
      'http://localhost:5173/escrow/v1/sessions',
    ])
    expect(c.AFTER_RELOGIN_404[0]?.pattern?.source).toBe(
      /^http:\/\/localhost:8008\/_matrix\/client\/v3\/room_keys\/keys\/[^/?]+\/[^/?]+\?version=1$/.source,
    )
    expect(c.recognizedSet404(1)[0]?.pattern?.source).toBe(
      /^http:\/\/localhost:8008\/_matrix\/client\/v3\/user\/[^/?]+\/account_data\/io\.tayet\.acknowledged_devices$/.source,
    )
    expect(c.AFTER_REVOCATION_SDK_MESSAGES[1]?.text).toBe(
      'Failed to process outgoing request 0: M_UNKNOWN_TOKEN: MatrixError: [401] Token is not active (http://localhost:8008/_matrix/client/v3/keys/upload)',
    )
    expect(c.AFTER_REVOCATION_SDK_MESSAGES[2]?.text).toBe(
      'Backup: Error processing backup request for rust crypto-sdk M_UNKNOWN_TOKEN: MatrixError: [401] Token is not active (http://localhost:8008/_matrix/client/v3/room_keys/keys?version=1)',
    )
  })

  it('shifts with the namespace env', async () => {
    cleanEnv()
    vi.stubEnv('TAYET_SPA_PORT', '15173')
    vi.stubEnv('TAYET_HS_URL', 'http://localhost:18008')
    vi.stubEnv('TAYET_MAS_URL', 'http://localhost:18080')
    const env = await load()
    expect(env.APP_URL).toBe('http://localhost:15173')
    expect(env.SPA_REDIRECT).toBe('http://localhost:15173/')
    expect(env.HS_URL).toBe('http://localhost:18008')
    const hosts = env.hostUrlPattern(env.HS_URL, env.MAS_URL)
    expect(hosts.source).toBe('^(?:http:\\/\\/localhost:18008|http:\\/\\/localhost:18080)\\/')
    expect(hosts.test('http://localhost:18008/_matrix/client/v3/sync')).toBe(true)
    expect(hosts.test('http://localhost:8008/_matrix/client/v3/sync')).toBe(false)
    const c = await import('../e2e/support/console')
    expect(c.AFTER_RELOGIN_404[0]?.pattern?.test('http://localhost:18008/_matrix/client/v3/room_keys/keys/!r/s?version=1')).toBe(true)
    expect(c.AFTER_RELOGIN_404[0]?.pattern?.test('http://localhost:8008/_matrix/client/v3/room_keys/keys/!r/s?version=1')).toBe(false)
  })
})
