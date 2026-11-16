import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import { memorySearchDbNames, searchDbName } from '../../src/acl/internal/search-store'
import type { AclTelemetry, ChannelId, DomainEvent, MessageId, OpaqueSession, SearchHit } from '../../src/acl'
import { findProtocolLeaks, findProtocolLeaksInText, OPAQUE_ID_KEYS } from '@tayet/shared/leak-scan'
import { HOMESERVER, synapseReachable, createRoom, sendText, whoami, invite, join, leave, mintToken } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { adminScopeReachable, mintAdminToken, liftMessageRatelimit, killSessions, PROBE_USER } from '../support/synapse-admin'
import { until } from '../support/until'

// ADR-074 (PLANO-RELEASE-PUBLICA §8.44): the local search index against the dev-stack.
//  (i)   a message sent in an encrypted channel is found by searchMessages on the OTHER device once it
//        decrypts;
//  (ii)  getMessage of an id outside the 30-event window returns the translated Message (server path);
//  (iii) the backfill makes a channel with > 30 messages searchable within the budget, and search.state
//        goes preparing → false;
//  (iv)  signOut deletes the index (in Node, the memory store that stands in for IndexedDB).
// Skips cleanly with the stack down; TAYET_REQUIRE_STACK=1 makes a missing stack fatal (synapse.ts).
//
// Leak proof: the excerpt is scanned as free text; the hit structurally, with `channel` added to the
// opaque-id keys — a ChannelId, whose runtime value IS the protocol id (ADR-008 residual, the same
// reason `channelId`/`author` are opaque keys). The serialized hit minus those opaque ids is scanned as
// text too, so an unresolved media URI or a raw id in any other field still fails.

const SYNAPSE = synapseReachable()
// (ii)–(iv) send more messages than the window; the message rate limit of that user is lifted first
// (the acl-channel-count idiom), which needs the admin scope.
const ADMIN = SYNAPSE && adminScopeReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const OPTS = { mode: 'strict' as const, telemetry: noopTelemetry, serverUrl: HOMESERVER }
const asSession = (token: string): OpaqueSession => token as unknown as OpaqueSession
const HIT_OPAQUE_KEYS = new Set([...OPAQUE_ID_KEYS, 'channel'])

function assertNoLeak(hit: SearchHit): void {
  for (const part of [hit.excerpt.before, hit.excerpt.match, hit.excerpt.after]) {
    expect(findProtocolLeaksInText(part)).toEqual([])
  }
  expect(findProtocolLeaks(hit, HIT_OPAQUE_KEYS)).toEqual([])
  const withoutIds = JSON.stringify(hit, (k, v: unknown) => (HIT_OPAQUE_KEYS.has(k) ? '<id>' : v))
  expect(findProtocolLeaksInText(withoutIds)).toEqual([])
}

async function createPrivateChannel(gw: MatrixGateway, name: string): Promise<ChannelId> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await gw.createChannel({ name, kind: 'private' })
    } catch (err) {
      const retryAfter = (err as { data?: { retry_after_ms?: number } }).data?.retry_after_ms
      if (retryAfter === undefined || attempt >= 10) throw err
      await new Promise((r) => setTimeout(r, retryAfter + 200))
    }
  }
}

describe.skipIf(!SYNAPSE)('ACL search (integration, ADR-074)', () => {
  const nonce = `${process.pid}${Math.floor(Math.random() * 1e6)}`

  describe('(i) encrypted channel, other device', () => {
    let alice: MatrixGateway
    let bob: MatrixGateway
    let channelId: ChannelId
    let roomIdRaw: string
    let aliceToken: string
    let bobToken: string

    beforeAll(async () => {
      const [a, b] = await freshUsers(['sra', 'srb'])
      aliceToken = a.token
      bobToken = b.token
      alice = new MatrixGateway(OPTS)
      await alice.connect(asSession(aliceToken))
      bob = new MatrixGateway(OPTS)
      await bob.connect(asSession(bobToken))
      channelId = await createPrivateChannel(alice, `tayet-search-${nonce}`)
      roomIdRaw = channelId as unknown as string
      await invite(aliceToken, roomIdRaw, await whoami(bobToken))
      await join(bobToken, roomIdRaw)
      await until('channel known to alice before the send', async () =>
        (await alice.getChannels()).some((c) => c.id === channelId) ? true : undefined,
      )
    }, 180_000)

    afterAll(async () => {
      try {
        await leave(bobToken, roomIdRaw)
        await leave(aliceToken, roomIdRaw)
      } catch {
        /* best-effort */
      }
      await alice?.disconnect()
      await bob?.disconnect()
    })

    it('a decrypted message is found by the other device, accent- and case-insensitive', async () => {
      const text = `Reunião do coração ${nonce} na sala grande`
      await alice.sendMessage(channelId, { kind: 'text', text })
      const hits = await until(
        'bob finds the decrypted message',
        async () => {
          const h = await bob.searchMessages(`CORACAO ${nonce}`)
          return h.length > 0 ? h : undefined
        },
        { snapshot: async () => `hits=${(await bob.searchMessages(nonce)).length}` },
      )
      expect(hits).toHaveLength(1)
      const hit = hits[0]!
      expect(hit.channel).toBe(channelId)
      expect(hit.message.channelId).toBe(channelId)
      expect(hit.message.body).toEqual({ kind: 'text', text })
      expect(hit.message.mine).toBe(false)
      expect(hit.excerpt.match).toBe('coração')
      assertNoLeak(hit)
      // Narrowed to the channel, and to another channel → nothing.
      expect(await bob.searchMessages(`coracao ${nonce}`, { channel: channelId })).toHaveLength(1)
      expect(await bob.searchMessages(`coracao ${nonce}`, { channel: 'none' as unknown as ChannelId })).toEqual([])
      // AND: a term that is not there drops it; under 2 characters → [].
      expect(await bob.searchMessages(`coracao ${nonce} inexistente`)).toEqual([])
      expect(await bob.searchMessages('r')).toEqual([])
      // The sender's own message is indexed too, once it settled (by its real event id).
      const own = await until('alice finds her own message', async () => {
        const h = await alice.searchMessages(`coracao ${nonce}`)
        return h.length > 0 ? h : undefined
      })
      expect(own[0]!.message.mine).toBe(true)
    }, 180_000)
  })

  describe.skipIf(!ADMIN)('(ii)–(iv) a channel with more than 30 messages', () => {
    const TOTAL = 40
    let daveName: string
    let daveToken: string
    let roomIdRaw: string
    let channelId: ChannelId
    let firstEventId: string
    const text = (i: number): string => `bf ${nonce} item-${i}`

    beforeAll(async () => {
      const [d] = await freshUsers(['srd'])
      daveName = d.name
      daveToken = d.token
      const admin = mintAdminToken(PROBE_USER)
      try {
        await liftMessageRatelimit(admin, await whoami(daveToken))
      } finally {
        killSessions(PROBE_USER)
      }
      roomIdRaw = await createRoom(daveToken, { name: `tayet-search-bf-${nonce}` })
      channelId = roomIdRaw as unknown as ChannelId
      for (let i = 0; i < TOTAL; i++) {
        const id = await sendText(daveToken, roomIdRaw, text(i))
        if (i === 0) firstEventId = id
      }
    }, 180_000)

    afterAll(async () => {
      try {
        await leave(daveToken, roomIdRaw)
      } catch {
        /* best-effort */
      }
    })

    it('(ii) getMessage of an id outside the 30-event window returns the translated Message', async () => {
      // A second device without the backfill: the oldest message is not in its window nor its index.
      const gw = new MatrixGateway(OPTS, { searchBackfill: false })
      try {
        await gw.connect(asSession(await mintToken(daveName)))
        expect(await gw.searchMessages(`${nonce} item-0`)).toEqual([])
        const msg = await gw.getMessage(channelId, firstEventId as unknown as MessageId)
        expect(msg?.body).toEqual({ kind: 'text', text: text(0) })
        expect(msg?.channelId).toBe(channelId)
        expect(msg?.mine).toBe(true)
        expect(findProtocolLeaks(msg)).toEqual([])
        // An id that does not exist → undefined.
        expect(await gw.getMessage(channelId, '$doesnotexist' as unknown as MessageId)).toBeUndefined()
      } finally {
        await gw.disconnect()
      }
    }, 180_000)

    it('(iii) the backfill makes it searchable within the budget; search.state preparing → false', async () => {
      const gw = new MatrixGateway(OPTS)
      const states: Array<Extract<DomainEvent, { t: 'search.state' }>> = []
      gw.subscribe((e) => {
        if (e.t === 'search.state') states.push(e)
      })
      try {
        await gw.connect(asSession(daveToken))
        // The index's write transitions (addendum 2026-10-28) share the event and may come first, so
        // the backfill's own transition is preparing: true and, after it, preparing: false.
        const started = (): number => states.findIndex((s) => s.preparing)
        await until(
          'search.state goes preparing: true → false',
          () => (started() >= 0 && states.slice(started()).some((s) => !s.preparing) ? true : undefined),
          { timeoutMs: 170_000, snapshot: () => JSON.stringify(states) },
        )
        expect(states.at(-1)?.preparing).toBe(false)

        const hits = await gw.searchMessages(`${nonce} item-0`)
        expect(hits.map((h) => h.message.body)).toEqual([{ kind: 'text', text: text(0) }])
        assertNoLeak(hits[0]!)
        // Every message of the channel, newest first.
        const all = await gw.searchMessages(`bf ${nonce}`)
        expect(all).toHaveLength(TOTAL)
        expect(all[0]!.message.body).toEqual({ kind: 'text', text: text(TOTAL - 1) })
        // getMessage now answers from the index.
        const snap = await gw.getMessage(channelId, firstEventId as unknown as MessageId)
        expect(snap?.body).toEqual({ kind: 'text', text: text(0) })

        // (iv) signOut deletes the index of the account.
        const db = searchDbName(await whoami(daveToken))
        expect(memorySearchDbNames()).toContain(db)
        await gw.signOut()
        expect(memorySearchDbNames()).not.toContain(db)
      } finally {
        await gw.disconnect()
      }
    }, 180_000)
  })
})

describe('ACL search (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
