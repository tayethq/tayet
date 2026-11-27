import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { decrypt, makeSubscription, verifyVapid, type TestSubscription } from '../support/webpush.ts'
import { devStackVapidPublicKey, HS_URL, mintOidcSession, PUSH_NOTIFY_URL, registerUser, stackUp, until } from '../support/stack.ts'

// The whole path against the dev-stack: a disposable account registers an http pusher pointing at the
// push gateway, with a subscription made here and an endpoint on a receiver in this process (reached
// from the container as host.docker.internal); another account sends. What reaches the receiver is
// decrypted with the subscription's private key and its VAPID header checked against the dev-stack key.
// A "nothing arrives" case is proven by order: a case that must arrive follows it, and the first
// delivery has to be that one.

const UP = stackUp()
const PASSWORD = 'pushpass123'

interface Delivery {
  path: string
  headers: IncomingHttpHeaders
  payload: Record<string, unknown>
}

let receiver: Server
let receiverPort = 0
let receiverStatus = 201
let deliveries: Delivery[] = []
let sub: TestSubscription
let vapidPublic: string

interface Account {
  id: string
  token: string
}
let alice: Account // owns the pusher
let alice2: Account // a second access of the same account
let bob: Account // sends

// The local stack keeps the server's default rate limits; a 429 is waited out (up to 30 s).
async function api(acc: Account, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000
  let res: Response
  let text: string
  for (;;) {
    res = await fetch(`${HS_URL}/_matrix/client/v3${path}`, {
      method,
      headers: { authorization: `Bearer ${acc.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    text = await res.text()
    if (res.status !== 429 || Date.now() > deadline) break
    const wait = (JSON.parse(text) as { retry_after_ms?: number }).retry_after_ms ?? 1000
    await new Promise((r) => setTimeout(r, Math.min(wait + 100, 5_000)))
  }
  if (!res.ok) throw new Error(`${method} ${path.replace(/![^/]+/, '!room')} → ${res.status} ${text.slice(0, 200)}`)
  return (text ? JSON.parse(text) : {}) as Record<string, unknown>
}

function account(prefix: string): { username: string; login: () => Promise<Account> } {
  const username = `${prefix}${randomBytes(4).toString('hex')}`
  registerUser(username, PASSWORD)
  const login = async (): Promise<Account> => {
    const s = await mintOidcSession(username, PASSWORD)
    const who = await fetch(`${HS_URL}/_matrix/client/v3/account/whoami`, { headers: { authorization: `Bearer ${s.accessToken}` } })
    const { user_id } = (await who.json()) as { user_id: string }
    return { id: user_id, token: s.accessToken }
  }
  return { username, login }
}

const pushkeys = new Set<string>()
const rules = new Set<string>()

async function setPusher(endpoint: string, s: TestSubscription = sub): Promise<void> {
  await api(alice, 'POST', '/pushers/set', {
    kind: 'http',
    app_id: 'test.push.gateway',
    pushkey: s.p256dh,
    app_display_name: 'push test',
    device_display_name: 'push test',
    lang: 'en',
    data: { url: PUSH_NOTIFY_URL, endpoint, auth: s.auth },
  })
  pushkeys.add(s.p256dh)
}

const receiverEndpoint = (tag: string): string => `http://host.docker.internal:${receiverPort}/sub/${tag}`

async function pusherKeys(): Promise<string[]> {
  const { pushers } = (await api(alice, 'GET', '/pushers')) as { pushers: Array<{ pushkey: string }> }
  return pushers.map((p) => p.pushkey)
}

async function markRoom(roomId: string, value: 'direct' | 'group'): Promise<void> {
  await api(alice, 'PUT', `/pushrules/global/room/${encodeURIComponent(roomId)}`, {
    actions: ['notify', { set_tweak: 'io.tayet.push', value }],
  })
  rules.add(roomId)
}

async function roomWithBoth(opts: Record<string, unknown> = {}): Promise<string> {
  const { room_id } = (await api(bob, 'POST', '/createRoom', { preset: 'private_chat', invite: [alice.id], ...opts })) as { room_id: string }
  await api(alice, 'POST', `/join/${encodeURIComponent(room_id)}`, {})
  return room_id
}

let txn = 0
async function say(from: Account, roomId: string, content: Record<string, unknown>): Promise<string> {
  const { event_id } = (await api(from, 'PUT', `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/t${Date.now()}-${txn++}`, content)) as {
    event_id: string
  }
  return event_id
}

const firstDelivery = (): Promise<Delivery> => until(() => deliveries[0], 20_000, 'a delivery at the receiver')

describe.skipIf(!UP)('push gateway against the stack', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vapidPublic = devStackVapidPublicKey()
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        try {
          const payload = JSON.parse(decrypt(Buffer.concat(chunks), sub).toString()) as Record<string, unknown>
          deliveries.push({ path: req.url ?? '', headers: req.headers, payload })
        } catch (err) {
          deliveries.push({ path: req.url ?? '', headers: req.headers, payload: { undecryptable: String(err) } })
        }
        res.writeHead(receiverStatus).end()
      })
    })
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r))
    receiverPort = (receiver.address() as AddressInfo).port
    const a = account('pusha')
    const b = account('pushb')
    alice = await a.login()
    alice2 = await a.login()
    bob = await b.login()
    // A real display name: without one the server sends the account's local part, which never becomes the author.
    await api(bob, 'PUT', `/profile/${encodeURIComponent(bob.id)}/displayname`, { displayname: 'Bob Push' })
  }, 120_000)

  afterEach(async () => {
    for (const pushkey of pushkeys) {
      await api(alice, 'POST', '/pushers/set', { kind: null, app_id: 'test.push.gateway', pushkey })
    }
    pushkeys.clear()
    for (const roomId of rules) await api(alice, 'DELETE', `/pushrules/global/room/${encodeURIComponent(roomId)}`)
    rules.clear()
    expect(await pusherKeys()).toEqual([])
    deliveries = []
    receiverStatus = 201
    sub = makeSubscription()
  })

  afterAll(async () => {
    receiver?.closeAllConnections()
    await new Promise((r) => (receiver ? receiver.close(r) : r(undefined)))
  })

  beforeAll(() => {
    sub = makeSubscription()
  })

  it('1–2: a plain message in a two-person room does not arrive; with the direct mark it does', async () => {
    const room = await roomWithBoth()
    await setPusher(receiverEndpoint('direct'))
    const plain = await say(bob, room, { msgtype: 'm.text', body: 'no rule' })
    await markRoom(room, 'direct')
    const marked = await say(bob, room, { msgtype: 'm.text', body: 'with rule' })
    const d = await firstDelivery()
    expect(d.payload.message).not.toBe(plain)
    expect(d.payload).toEqual({ v: 1, kind: 'direct', invite: false, conversation: room, message: marked, author: 'Bob Push' })
    expect(d.path).toBe('/sub/direct')
    expect(d.headers['content-encoding']).toBe('aes128gcm')
    expect(d.headers.ttl).toBe('259200')
    const claims = verifyVapid(d.headers.authorization, vapidPublic)
    expect(claims.aud).toBe(`http://host.docker.internal:${receiverPort}`)
  })

  it('3: the group mark arrives as kind group', async () => {
    const room = await roomWithBoth()
    await setPusher(receiverEndpoint('group'))
    await markRoom(room, 'group')
    const ev = await say(bob, room, { msgtype: 'm.text', body: 'group' })
    const d = await firstDelivery()
    expect(d.payload).toMatchObject({ kind: 'group', invite: false, message: ev })
    expect(d.payload.body).toBeUndefined()
  })

  it('4: a mention in an unencrypted room arrives as kind channel, with its name and text', async () => {
    const room = await roomWithBoth({ name: 'Push channel' })
    await setPusher(receiverEndpoint('channel'))
    await say(bob, room, { msgtype: 'm.text', body: 'no mention' })
    const ev = await say(bob, room, { msgtype: 'm.text', body: 'hello you', 'm.mentions': { user_ids: [alice.id] } })
    const d = await firstDelivery()
    expect(d.payload).toMatchObject({ kind: 'channel', invite: false, message: ev, channelName: 'Push channel', body: { type: 'text', text: 'hello you' } })
  })

  it('5: an invite marked direct arrives; an invite with a room name does not', async () => {
    await setPusher(receiverEndpoint('invite'))
    await api(bob, 'POST', '/createRoom', { preset: 'private_chat', name: 'Named', invite: [alice.id] })
    const { room_id } = (await api(bob, 'POST', '/createRoom', { preset: 'trusted_private_chat', is_direct: true, invite: [alice.id] })) as {
      room_id: string
    }
    const d = await firstDelivery()
    expect(d.payload).toMatchObject({ kind: 'direct', invite: true, conversation: room_id })
    expect(d.payload.body).toBeUndefined()
  })

  it('6: a 410 from the push service deletes the pusher', async () => {
    const room = await roomWithBoth()
    await setPusher(receiverEndpoint('gone'))
    await markRoom(room, 'direct')
    receiverStatus = 410
    await say(bob, room, { msgtype: 'm.text', body: 'to a dead subscription' })
    await firstDelivery()
    await until(async () => ((await pusherKeys()).length === 0 ? true : undefined), 20_000, 'pusher deleted after 410')
    pushkeys.clear()
  })

  it('7: an endpoint outside the list deletes the pusher, and nothing is sent', async () => {
    const room = await roomWithBoth()
    await setPusher('https://push.example.org/sub/x')
    await markRoom(room, 'direct')
    await say(bob, room, { msgtype: 'm.text', body: 'to a foreign endpoint' })
    await until(async () => ((await pusherKeys()).length === 0 ? true : undefined), 20_000, 'pusher deleted for a foreign endpoint')
    pushkeys.clear()
    expect(deliveries).toEqual([])
  })

  it('8: a read on another access (a notification without an event) sends nothing', async () => {
    const room = await roomWithBoth()
    await markRoom(room, 'direct')
    const first = await say(bob, room, { msgtype: 'm.text', body: 'unread' })
    await setPusher(receiverEndpoint('read'))
    await api(alice2, 'POST', `/rooms/${encodeURIComponent(room)}/receipt/m.read/${encodeURIComponent(first)}`, {})
    // Room for the count-only notification to reach the gateway before the message that must arrive.
    await new Promise((r) => setTimeout(r, 2_000))
    const next = await say(bob, room, { msgtype: 'm.text', body: 'after the read' })
    const d = await firstDelivery()
    expect(d.payload.message).toBe(next)
  })

  it('10: a sender without a display name arrives with an empty author, never the account name', async () => {
    const c = account('pushc')
    const carol = await c.login()
    const { room_id } = (await api(carol, 'POST', '/createRoom', { preset: 'private_chat', invite: [alice.id] })) as { room_id: string }
    await api(alice, 'POST', `/join/${encodeURIComponent(room_id)}`, {})
    await setPusher(receiverEndpoint('nameless'))
    await markRoom(room_id, 'direct')
    const ev = await say(carol, room_id, { msgtype: 'm.text', body: 'from a nameless account' })
    const d = await firstDelivery()
    expect(d.payload).toMatchObject({ kind: 'direct', message: ev, author: '' })
    expect(JSON.stringify(d.payload)).not.toContain(c.username)
  })

  it('9: a message from an agent account carries agent: true, and not the account', async () => {
    const base32 = 'abcdefghijklmnopqrstuvwxyz234567'
    const localpart = `a-${Array.from(randomBytes(12), (b) => base32[b % 32]).join('')}`
    registerUser(localpart, PASSWORD)
    const s = await mintOidcSession(localpart, PASSWORD)
    const who = await fetch(`${HS_URL}/_matrix/client/v3/account/whoami`, { headers: { authorization: `Bearer ${s.accessToken}` } })
    const agent: Account = { id: ((await who.json()) as { user_id: string }).user_id, token: s.accessToken }
    // An agent has a display name (without one the author would be empty: case 10).
    await api(agent, 'PUT', `/profile/${encodeURIComponent(agent.id)}/displayname`, { displayname: 'Robot' })
    const { room_id } = (await api(agent, 'POST', '/createRoom', { preset: 'private_chat', invite: [alice.id] })) as { room_id: string }
    await api(alice, 'POST', `/join/${encodeURIComponent(room_id)}`, {})
    await setPusher(receiverEndpoint('agent'))
    await markRoom(room_id, 'direct')
    const ev = await say(agent, room_id, { msgtype: 'm.text', body: 'from an agent' })
    const d = await firstDelivery()
    expect(d.payload).toMatchObject({ kind: 'direct', message: ev, author: 'Robot', agent: true })
    expect(JSON.stringify(d.payload)).not.toContain(localpart)
    expect(JSON.stringify(d.payload)).not.toContain(agent.id)
  })
})
