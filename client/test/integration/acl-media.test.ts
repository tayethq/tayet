import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, ChannelId, MediaRef, OpaqueSession } from '../../src/acl'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'
import {
  HOMESERVER,
  synapseReachable,
  createRoom,
  uploadMedia,
  sendImage,
} from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { mintOidcSession } from '../support/mint-oidc'

// Commit 10 / ADR-009: cleartext media resolves through the authenticated-download + blob path.
// resolveMedia uses URL.createObjectURL (a browser API absent in node) — we polyfill it to
// CAPTURE the assembled Blob, proving the authenticated fetch + assembly work end-to-end.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) // PNG-ish

async function until<T>(get: () => Promise<T | undefined>, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 120))
  }
}

describe.skipIf(!SYNAPSE)('ACL media resolution (integration, cleartext)', () => {
  let acl: Acl
  let token: string

  beforeAll(async () => {
    const [user] = await freshUsers(['med'])
    token = user.token
    acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await acl.connect(token as Parameters<Acl['connect']>[0])
  }, 180_000)

  afterAll(async () => {
    await acl?.disconnect()
  })

  it('resolveMedia authenticates, fetches, and assembles the bytes; never leaks the mxc', async () => {
    const name = `tayet-media-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    const roomId = await createRoom(token, { name })
    const mxc = await uploadMedia(token, BYTES, 'image/png', 'pixel.png')
    await sendImage(token, roomId, mxc, { name: 'pixel.png', mimetype: 'image/png', size: BYTES.length })

    const channelId: ChannelId = await until(async () => {
      const chs = await acl.getChannels()
      return chs.find((c) => c.name === `#${name}`)?.id
    })
    const ref: MediaRef = await until(async () => {
      const page = await acl.getTimeline(channelId)
      const img = page.items.find((m) => m.body.kind === 'image')
      // The domain carries an opaque MediaRef — NEVER the mxc.
      return img && img.body.kind === 'image' ? img.body.media : undefined
    })
    expect(findProtocolLeaks({ ref })).toEqual([]) // the ref is an opaque token, not an mxc

    // Polyfill the browser-only object-URL API to capture the assembled blob.
    let captured: Blob | undefined
    const realCreate = (globalThis.URL as unknown as { createObjectURL?: unknown }).createObjectURL
    const realRevoke = (globalThis.URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
    ;(globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b) => {
      captured = b
      return 'blob:tayet-test'
    }
    ;(globalThis.URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {}
    try {
      const resolved = await acl.resolveMedia(ref, 'full')
      expect(resolved.url).toBe('blob:tayet-test')
      expect(captured).toBeInstanceOf(Blob)
      expect(captured!.size).toBe(BYTES.length) // authenticated fetch returned the exact bytes
      resolved.release() // idempotent / no throw
    } finally {
      ;(globalThis.URL as unknown as Record<string, unknown>).createObjectURL = realCreate
      ;(globalThis.URL as unknown as Record<string, unknown>).revokeObjectURL = realRevoke
    }
  }, 180_000)
})

// PLANO-RELEASE-PUBLICA §8.21 (dogfood 2.1): the media download rides the SDK http-api, so an
// expired access token gets the same 401 M_UNKNOWN_TOKEN → refresh → retry as /sync. Real OIDC
// session (mat_/mar_, minted headless — same idiom as acl-session-revoked): the refresh is a REAL
// /oauth2/token round-trip against MAS. Only the FIRST media GET is answered with a synthetic 401
// (client-side fetch wrapper; the SDK resolves globalThis.fetch per request, fetch.js:49-52); the
// retry reaches the real Synapse with the refreshed token.
const MAS_URL = process.env.TAYET_MAS_URL ?? 'http://localhost:8080'
const CLIENT_ID = process.env.TAYET_SPA_CLIENT_ID ?? '000000000000000000000TAYET'
const PASSWORD = 'gatepass123' // same as registerUser (escrow-harness.ts), used by freshUsers

describe.skipIf(!SYNAPSE)('ACL media download under token refresh (integration)', () => {
  let gw: MatrixGateway | undefined
  const realFetch = globalThis.fetch

  // The OIDC renewer reads window.location.origin (oidc.ts) and oidc-client-ts keeps its state in
  // Web Storage. This file runs under Node (jsdom's cross-realm Blob mangles the assembled bytes
  // the first case asserts), so give the renewer just those browser globals, in memory.
  const g = globalThis as Record<string, unknown>
  const stubbed = ['window', 'localStorage', 'sessionStorage'].filter((k) => !(k in g))
  const memoryStorage = (): Storage => {
    const m = new Map<string, string>()
    return {
      get length() {
        return m.size
      },
      key: (i) => [...m.keys()][i] ?? null,
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, String(v)),
      removeItem: (k) => void m.delete(k),
      clear: () => m.clear(),
    }
  }
  beforeAll(() => {
    const fakes: Record<string, unknown> = {
      window: { location: { origin: 'http://localhost:5173' } },
      localStorage: memoryStorage(),
      sessionStorage: memoryStorage(),
    }
    for (const k of stubbed) g[k] = fakes[k]
  })
  afterAll(() => {
    for (const k of stubbed) delete g[k]
  })

  afterEach(async () => {
    globalThis.fetch = realFetch
    await gw?.disconnect().catch(() => {})
    gw = undefined
  })

  it('401 M_UNKNOWN_TOKEN on the media GET → one refresh → retry 200 → exact bytes, no error', async () => {
    const [u] = await freshUsers(['mrf'])
    const session = await mintOidcSession(u!.name, PASSWORD)
    const lost: number[] = []
    gw = new MatrixGateway({
      mode: 'strict',
      telemetry: noopTelemetry,
      serverUrl: HOMESERVER,
      onSessionLost: () => lost.push(Date.now()),
    })
    await gw.connect(
      JSON.stringify({
        kind: 'oidc',
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        issuer: `${MAS_URL.replace(/\/$/, '')}/`,
        clientId: CLIENT_ID,
        homeserverUrl: HOMESERVER,
        idTokenClaims: {},
      }) as unknown as OpaqueSession,
    )

    const name = `tayet-media-refresh-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    const roomId = await createRoom(session.accessToken, { name })
    const mxc = await uploadMedia(session.accessToken, BYTES, 'image/png', 'pixel.png')
    await sendImage(session.accessToken, roomId, mxc, { name: 'pixel.png', mimetype: 'image/png', size: BYTES.length })
    const g = gw
    const ref: MediaRef = await until(async () => {
      const page = await g.getTimeline(roomId as unknown as ChannelId).catch(() => undefined)
      const img = page?.items.find((m) => m.body.kind === 'image')
      return img && img.body.kind === 'image' ? img.body.media : undefined
    })

    // Wire: the first media download gets a synthetic expired-token 401; count refreshes and
    // record the bearer each download attempt carried.
    const bearers: string[] = []
    let refreshes = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/oauth2/token')) refreshes++
      if (url.includes('/_matrix/client/v1/media/download/')) {
        bearers.push(new Headers(init?.headers).get('Authorization') ?? '')
        if (bearers.length === 1) {
          return new Response(JSON.stringify({ errcode: 'M_UNKNOWN_TOKEN', error: 'expired', soft_logout: false }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          })
        }
      }
      return realFetch(input, init)
    }) as typeof fetch

    let captured: Blob | undefined
    const realCreate = (globalThis.URL as unknown as { createObjectURL?: unknown }).createObjectURL
    const realRevoke = (globalThis.URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
    ;(globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b) => {
      captured = b
      return 'blob:tayet-refresh'
    }
    ;(globalThis.URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {}
    try {
      const resolved = await gw.resolveMedia(ref, 'full')
      expect(resolved.url).toBe('blob:tayet-refresh')
      expect(new Uint8Array(await captured!.arrayBuffer())).toEqual(BYTES)
      resolved.release()
    } finally {
      ;(globalThis.URL as unknown as Record<string, unknown>).createObjectURL = realCreate
      ;(globalThis.URL as unknown as Record<string, unknown>).revokeObjectURL = realRevoke
    }

    expect(refreshes).toBe(1)
    expect(bearers).toHaveLength(2) // the 401 and exactly one retry
    expect(bearers[1]).not.toBe(bearers[0]) // the retry carried the refreshed token
    expect(lost).toEqual([]) // a renewable expiry is not a lost session
  }, 180_000)
})

describe('ACL media (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
