import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, DomainEvent, UserId } from '../../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'
import { HOMESERVER, synapseReachable, createRoom, invite, whoami, announcePresence } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'

// Presence seam, live half (ADR-056): drive a real presence EDU through /sync and assert the
// domain stream emits a clean user.presence + the map answers the point read. Mirrors the
// acl-stream harness (clean skip without the stack, generous until()). FRESH users on purpose:
// presence is GLOBAL per user, so the shared alice/bob would leak state between tests. The two
// must share a room — presence EDUs only route between users who do.
//
// NOT asserted: the online→offline transition by timeout (~30 s server grain = guaranteed
// flake; spike-measured 25–35 s). If observed in passing, it is recorded in the PLANO §8.1 as
// an observation, never an assertion.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

async function until<T>(get: () => T | undefined, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe.skipIf(!SYNAPSE)('ACL presence stream (integration, ADR-056)', () => {
  let acl: Acl // bob's client — the observer
  let aliceToken: string
  let aliceId: string
  const events: DomainEvent[] = []

  beforeAll(async () => {
    const [alice, bob] = await freshUsers(['pra', 'prb'])
    aliceToken = alice.token
    aliceId = await whoami(alice.token)
    const bobId = await whoami(bob.token)
    // Shared room BEFORE any stimulus. Bob is invited pre-connect; ADR-044 auto-joins it on his
    // first sync, so by the time the channel shows up in getChannels() the routing is in place.
    const roomId = await createRoom(alice.token, {
      name: `tayet-presence-${process.pid}-${Math.floor(Math.random() * 1e6)}`,
    })
    await invite(alice.token, roomId, bobId)
    acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await acl.connect(bob.token as Parameters<Acl['connect']>[0])
    acl.subscribe((e) => events.push(e))
    // Poll getChannels() (not one-shot) and match by id — the ambient org channel.added of
    // ADR-045 fires on every connect, so positional matching would be wrong.
    const start = Date.now()
    for (;;) {
      const channels = await acl.getChannels()
      if (channels.some((c) => (c.id as unknown as string) === roomId)) break
      if (Date.now() - start > 150_000) throw new Error('timed out waiting for shared room')
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 180_000)

  afterAll(async () => {
    await acl?.disconnect()
  })

  it('unknown user reads offline; a live announcement flows as clean user.presence', async () => {
    // 1. Before any stimulus: unknown ≡ offline. Alice has only made REST calls (createRoom /
    //    invite) — she never synced, so no EDU of hers exists yet.
    expect(acl.getPresence(aliceId as UserId)).toBe('offline')

    // 2. Alice announces online (one-shot sync). Filter by HER id: bob announces himself by
    //    syncing, so his own EDU also arrives on this stream — it must not satisfy the wait.
    await announcePresence(aliceToken, 'online')
    const ev = await until(() =>
      events.find(
        (e): e is Extract<DomainEvent, { t: 'user.presence' }> =>
          e.t === 'user.presence' && (e.user as unknown as string) === aliceId,
      ),
    )
    expect(ev.presence).toBe('online')
    expect(findProtocolLeaks(ev)).toEqual([])

    // 3. The point read now agrees with the stream.
    expect(acl.getPresence(aliceId as UserId)).toBe('online')
  }, 180_000)
})

describe.skipIf(!SYNAPSE)('ACL self-presence (integration, ADR-056 / PLANO §8.3)', () => {
  let acl: Acl
  let selfId: string
  const events: DomainEvent[] = []

  beforeAll(async () => {
    const [self] = await freshUsers(['prs'])
    selfId = await whoami(self.token)
    acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    // Subscribe BEFORE connect: the self snapshot is drained inside connect() (the synthetic
    // onPresence call right after Prepared), so a post-connect subscriber could miss it.
    acl.subscribe((e) => events.push(e))
    await acl.connect(self.token as Parameters<Acl['connect']>[0])
  }, 180_000)

  afterAll(async () => {
    await acl?.disconnect()
  })

  it('own presence flows with no external stimulus: syncing IS the announcement', async () => {
    // No second user, no announcePresence: the client's own /sync is the only stimulus. Pre-fix
    // this test FAILED — the EDU died on the raw self User startClient stores without a reEmitter
    // (client.js:531-532), so UserEvent.LastPresenceTs never reached the client-level handler.
    // The witness PR-1 lacked; failure recorded in PLANO §8.3.
    await until(() => (acl.getPresence(selfId as UserId) === 'online' ? true : undefined))
    const ev = await until(() =>
      events.find(
        (e): e is Extract<DomainEvent, { t: 'user.presence' }> =>
          e.t === 'user.presence' && (e.user as unknown as string) === selfId,
      ),
    )
    expect(ev.presence).toBe('online')
    expect(findProtocolLeaks(ev)).toEqual([])
  }, 180_000)
})

describe.skipIf(!SYNAPSE)('ACL pre-connect presence snapshot (integration, ADR-056 / PLANO §8.3)', () => {
  let acl: Acl
  let announcerId: string
  const events: DomainEvent[] = []

  beforeAll(async () => {
    const [watcher, announcer] = await freshUsers(['prw', 'prn'])
    announcerId = await whoami(announcer.token)
    const watcherId = await whoami(watcher.token)
    // Shared room BEFORE any stimulus (presence EDUs only route between users who share one);
    // the watcher is invited pre-connect and ADR-044 auto-joins it on the first sync.
    const roomId = await createRoom(announcer.token, {
      name: `tayet-presence-snap-${process.pid}-${Math.floor(Math.random() * 1e6)}`,
    })
    await invite(announcer.token, roomId, watcherId)
    acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    acl.subscribe((e) => events.push(e))
    // Announce IMMEDIATELY before connect: the one-shot online expires in ~30 s (measured), so
    // the connect must land inside that window — no re-announcement after connect, on purpose.
    await announcePresence(announcer.token, 'online')
    await acl.connect(watcher.token as Parameters<Acl['connect']>[0])
  }, 180_000)

  afterAll(async () => {
    await acl?.disconnect()
  })

  it('presence announced BEFORE connect reaches the map with no post-connect stimulus', async () => {
    // Formalizes what the PR-3 diagnosis observed live: the initial-sync presence snapshot (plus
    // the EDUs of the first incremental syncs after auto-join) is enough — nobody announces
    // again after the watcher connects.
    await until(() => (acl.getPresence(announcerId as UserId) === 'online' ? true : undefined))
    const ev = await until(() =>
      events.find(
        (e): e is Extract<DomainEvent, { t: 'user.presence' }> =>
          e.t === 'user.presence' && (e.user as unknown as string) === announcerId,
      ),
    )
    expect(ev.presence).toBe('online')
    expect(findProtocolLeaks(ev)).toEqual([])
  }, 180_000)
})

describe('ACL presence (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
