// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createAcl } from '../../src/acl'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import { encryptedBirthState } from '../../src/acl/internal/custody'
import type { Acl, ChannelId, UserId } from '../../src/acl'
import { HOMESERVER, synapseReachable, whoami, createUnnamedRoom } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { registerUser } from '../support/escrow-harness'
import { mintOidcSession } from '../support/mint-oidc'
import { adminScopeReachable, allowCrossSigningReplacementWithoutUia, killSessions, mintAdminToken } from '../support/synapse-admin'
import { fabricatedSubscription, pushServiceReachable, startPushReceiver, type PushReceiver } from '../support/push-subscription'
import { until } from '../support/until'
import { ESCROW_URL } from '../support/stack-env'

// Stack gate of PR 3 of the push track (ADR-117 dec. 2 and 6): the ACL's marked room rules and this access's
// subscription, against the dev-stack's homeserver and push service.
//
// 1. A direct conversation, a group and a private channel made by the product: on the server, the marked rule exists
//    with `direct` and `group` on the first two, for both people, and not on the channel.
// 2. A conversation made before the ACL connects gets its rule on connect (the sweep).
// 3. convertToChannel: the rule goes, on both sides.
// 4. enable with a subscription made here, pointing at a receiver in this process: one subscription on the server,
//    with the expected fields; a message in the direct conversation reaches the receiver, one in the private channel
//    does not (proven by order and count: the channel's message is sent first). enable again: still one.
// 5. disable: the subscription goes, and the next message does not arrive.
// 6. signOut: the subscription goes (the session is a plain token here, with no revocation: the removal is the ACL's).
// 7. The whole access reset (A7): two accesses of one account, each with its subscription; one resets to `done`
//    (admin-scope window, the stack's escrow revoking the others for real); within 30 s only its subscription is left.
// Fresh users per run (#32); skips without the stack (issue #7).

const UP = synapseReachable() && pushServiceReachable()
const ADMIN_SCOPE = UP && adminScopeReachable()
const MARKER = { type: 'io.tayet.conversation', state_key: '', content: { kind: 'direct' } }
const sessions: Array<Pick<Acl, 'disconnect'>> = []

function session(): Acl {
  const acl = createAcl({ mode: 'strict', telemetry: { untranslated: () => {} }, serverUrl: HOMESERVER })
  sessions.push(acl)
  return acl
}
const connect = (acl: Acl, token: string) => acl.connect(token as Parameters<Acl['connect']>[0])

async function api(token: string, method: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3${path}`, { method, headers: { Authorization: `Bearer ${token}` } })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> }
}

// The marker's value on the person's rule for the room; null without a rule; 'unmarked' for a rule without it.
async function markOn(token: string, roomId: string): Promise<unknown> {
  const { status, body } = await api(token, 'GET', `/pushrules/global/room/${encodeURIComponent(roomId)}`)
  if (status === 404) return null
  if (status !== 200) throw new Error(`push rule read -> ${status}`)
  const tweak = (body.actions as unknown[]).find((a) => (a as { set_tweak?: string }).set_tweak === 'io.tayet.push')
  return tweak ? (tweak as { value: unknown }).value : 'unmarked'
}
const markIs = (token: string, roomId: string, want: unknown, label: string) =>
  until(label, async () => ((await markOn(token, roomId)) === want ? true : undefined), { timeoutMs: 30_000 })

type Pusher = { kind: string; app_id: string; pushkey: string; app_display_name: string; device_display_name: string; lang: string; data: Record<string, unknown> }
async function pushers(token: string): Promise<Pusher[]> {
  const { status, body } = await api(token, 'GET', '/pushers')
  if (status !== 200) throw new Error(`pushers read -> ${status}`)
  return body.pushers as Pusher[]
}

const channelOf = (acl: Acl, id: ChannelId) => async () => (await acl.getChannels()).find((c) => c.id === id)
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!UP)('device notifications and marked room rules: ACL ↔ real stack (ADR-117)', () => {
  let receiver: PushReceiver

  beforeAll(async () => {
    receiver = await startPushReceiver()
  })
  afterAll(async () => {
    await receiver?.close()
  })
  afterEach(async () => {
    for (const acl of sessions.splice(0)) await acl.disconnect().catch(() => {})
  })

  it('1 and 3: direct and group carry the marked rule on both sides, a private channel does not; a converted group loses it', async () => {
    const [a, b, c] = await freshUsers(['pra', 'prb', 'prc'])
    const mxidB = await whoami(b.token)
    const mxidC = await whoami(c.token)
    const alice = session()
    const bob = session()
    await connect(alice, a.token)
    await connect(bob, b.token)
    const dm = await alice.openDirectMessage(mxidB as UserId)
    const group = await alice.openGroupConversation([mxidB, mxidC] as UserId[])
    const channel = await alice.createChannel({ name: 'Push rules channel', kind: 'private', members: [mxidB as UserId] })
    for (const id of [dm, group, channel]) await until('B is in the room', channelOf(bob, id))

    await markIs(a.token, String(dm), 'direct', 'A: direct rule')
    await markIs(b.token, String(dm), 'direct', 'B: direct rule')
    await markIs(a.token, String(group), 'group', 'A: group rule')
    await markIs(b.token, String(group), 'group', 'B: group rule')
    await settle(1_500)
    expect(await markOn(a.token, String(channel))).toBeNull()
    expect(await markOn(b.token, String(channel))).toBeNull()

    await alice.convertToChannel(group, 'Converted')
    await markIs(a.token, String(group), null, 'A: the converted group lost its rule')
    await markIs(b.token, String(group), null, 'B: the converted group lost its rule')
  }, 240_000)

  it('2: a conversation made before the ACL connects gets its rule on connect', async () => {
    const [d, e] = await freshUsers(['prd', 'pre'])
    const mxidE = await whoami(e.token)
    const room = await createUnnamedRoom(d.token, { invite: [mxidE], initialState: [...encryptedBirthState(), MARKER] })
    expect(await markOn(d.token, room)).toBeNull()
    const dee = session()
    await connect(dee, d.token)
    await markIs(d.token, room, 'direct', 'the sweep wrote the rule')
  }, 180_000)

  it('4, 5 and 6: enable, a message per kind of room, enable again, disable, and signOut', async () => {
    const [p, q] = await freshUsers(['prp', 'prq'])
    const mxidQ = await whoami(q.token)
    const pat = session()
    const quinn = session()
    await connect(pat, p.token)
    await connect(quinn, q.token)
    const dm = await pat.openDirectMessage(mxidQ as UserId)
    const channel = await pat.createChannel({ name: 'Push quiet channel', kind: 'private', members: [mxidQ as UserId] })
    for (const id of [dm, channel]) await until('Q is in the room', channelOf(quinn, id))
    await markIs(p.token, String(dm), 'direct', 'P: direct rule')

    // 4. enable: one subscription with the expected fields.
    receiver.arrivals.length = 0
    const sub = fabricatedSubscription(receiver.endpoint('p'))
    await pat.enableDeviceNotifications(sub)
    const listed = await pushers(p.token)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      kind: 'http',
      app_id: 'io.tayet.web',
      pushkey: sub.keys.p256dh,
      app_display_name: 'Tayet',
      device_display_name: 'Tayet',
      lang: 'en',
      data: { url: 'http://push:8095/_matrix/push/v1/notify', endpoint: sub.endpoint, auth: sub.keys.auth },
    })
    // The channel's message first: had it been pushed, it would be the first arrival and the count would be two.
    await quinn.sendMessage(channel, { kind: 'text', text: 'quiet' })
    await quinn.sendMessage(dm, { kind: 'text', text: 'loud' })
    await until('the direct message reached the receiver', async () => (receiver.arrivals.length > 0 ? true : undefined), { timeoutMs: 20_000 })
    await settle(2_000)
    expect(receiver.arrivals).toEqual(['/sub/p'])

    await pat.enableDeviceNotifications(sub)
    expect(await pushers(p.token)).toHaveLength(1)

    // 5. disable: gone, and the next message does not arrive (by order: enable again, and only the later one comes).
    await pat.disableDeviceNotifications()
    expect(await pushers(p.token)).toEqual([])
    receiver.arrivals.length = 0
    await quinn.sendMessage(dm, { kind: 'text', text: 'while off' })
    await settle(1_500)
    await pat.enableDeviceNotifications(sub)
    await quinn.sendMessage(dm, { kind: 'text', text: 'on again' })
    await until('the message after enabling again arrived', async () => (receiver.arrivals.length > 0 ? true : undefined), { timeoutMs: 20_000 })
    await settle(2_000)
    expect(receiver.arrivals).toEqual(['/sub/p'])

    // 6. signOut: the plain-token session is not revoked, so its token still reads the pushers.
    await pat.signOut()
    await until('signOut removed the subscription', async () => ((await pushers(p.token)).length === 0 ? true : undefined), { timeoutMs: 10_000 })
  }, 240_000)

  it.skipIf(!ADMIN_SCOPE)(
    '7: the whole access reset leaves only the subscription of the access that reset (A7)',
    async () => {
      const suffix = `${process.pid}${Math.floor(Math.random() * 1e6)}`
      const user = `prr${suffix}`
      registerUser(user)
      const token1 = (await mintOidcSession(user, 'gatepass123')).accessToken
      const token2 = (await mintOidcSession(user, 'gatepass123')).accessToken
      const mxid = await whoami(token1)
      // The stack's escrow, not a spawned one: its revocation of the other accesses is the act under test.
      const prevEscrow = process.env.TAYET_ESCROW_URL
      process.env.TAYET_ESCROW_URL = ESCROW_URL
      const device1 = new MatrixGateway({ mode: 'strict', telemetry: { untranslated: () => {} }, serverUrl: HOMESERVER })
      const device2 = new MatrixGateway({ mode: 'strict', telemetry: { untranslated: () => {} }, serverUrl: HOMESERVER })
      sessions.push(device1, device2)
      try {
        await device1.connect(token1 as Parameters<Acl['connect']>[0])
        await device2.connect(token2 as Parameters<Acl['connect']>[0])
        await until('custody and backup in place', async () =>
          (await fetch(`${HOMESERVER}/_matrix/client/v3/room_keys/version`, { headers: { Authorization: `Bearer ${token1}` } })).status === 200
            ? true
            : undefined,
        )
        const sub1 = fabricatedSubscription(receiver.endpoint('r1'))
        const sub2 = fabricatedSubscription(receiver.endpoint('r2'))
        await device1.enableDeviceNotifications(sub1)
        await device2.enableDeviceNotifications(sub2)
        expect((await pushers(token1)).map((x) => x.pushkey).sort()).toEqual([sub1.keys.p256dh, sub2.keys.p256dh].sort())

        await allowCrossSigningReplacementWithoutUia(mintAdminToken(user), mxid)
        const started = Date.now()
        const out = await device1.resetAccess()
        expect(out.t).toBe('done')
        await until(
          'only the resetting access keeps its subscription',
          async () => {
            const keys = (await pushers(token1)).map((x) => x.pushkey)
            return keys.length === 1 && keys[0] === sub1.keys.p256dh ? true : undefined
          },
          { timeoutMs: 30_000, pollMs: 500 },
        )
        console.info(`[push] reset: one subscription left ${Date.now() - started} ms after resetAccess began`)
      } finally {
        for (const d of [device1, device2]) {
          const at = sessions.indexOf(d)
          if (at >= 0) sessions.splice(at, 1)
          await d.disconnect().catch(() => {})
        }
        killSessions(user)
        if (prevEscrow === undefined) delete process.env.TAYET_ESCROW_URL
        else process.env.TAYET_ESCROW_URL = prevEscrow
      }
    },
    240_000,
  )
})
