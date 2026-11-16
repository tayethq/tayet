import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ESCROW_URL, HS_URL, mintOidcSession, stackUp, startWellKnown, until } from '../support/stack'
import { evt, startSidecar, type SidecarProcess } from '../support/sidecar-process'
import { startHuman, type Human } from '../support/human'
import { conversationToken, messageTs, personToken, serverNameOf, workspaceToken } from '../../src/api/ids'
import type { ApiConversationList, ApiMe, ApiMessageList } from '../../src/api/contract'

// S-c1 against the stack, through the local API of dist/cli.js (PLANO-AGENTES §0.3.6): alice creates
// an agent (/v1/agents), invites it to an encrypted room and to an encrypted DM; the agent reads
// through GET /v1/* and the SSE with opaque ids only. Then the history pages, the replay by
// Last-Event-ID (and resync from another epoch), operator 1 (PLANO-AGENTES §0.3.10: bob's invite is
// refused, alice's re-invite of the same room after the leave is joined), and the revocation (SSE
// agent.revoked, 503, 78). One `a-` account per run is left deactivated on the stack.

const STACK = stackUp()
const rand = (): string => Math.random().toString(36).slice(2, 8)
const REVOKE_CEILING_MS = 30_000

interface Frame {
  id?: string
  event?: string
  data?: Record<string, unknown>
}

function openEvents(url: string, token: string, lastEventId?: string) {
  const frames: Frame[] = []
  const ctrl = new AbortController()
  let ended = false
  const done = (async () => {
    const res = await fetch(`${url}/v1/events`, {
      headers: { authorization: `Bearer ${token}`, ...(lastEventId !== undefined ? { 'last-event-id': lastEventId } : {}) },
      signal: ctrl.signal,
    })
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ''
    for (;;) {
      const { value, done: end } = await reader.read()
      if (end) break
      buf += value
      let i
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const f: Frame = {}
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) f.id = line.slice(4)
          else if (line.startsWith('event: ')) f.event = line.slice(7)
          else if (line.startsWith('data: ')) f.data = JSON.parse(line.slice(6)) as Record<string, unknown>
        }
        if (f.event !== undefined) frames.push(f)
      }
    }
  })()
    .catch(() => {})
    .finally(() => (ended = true))
  return { frames, done, ended: () => ended, close: () => ctrl.abort() }
}

describe.skipIf(!STACK)('sidecar S-c1 ↔ stack: local read API and SSE (§0.3.6)', () => {
  let alice: string
  let agent: { userId: string; token: string; deviceId: string } | undefined
  let removed = false
  let wellKnown: Awaited<ReturnType<typeof startWellKnown>>
  let store: string
  let person: Human
  let p: SidecarProcess | undefined
  let url = ''
  let local = ''
  let room = ''
  let dm = ''
  let stream: ReturnType<typeof openEvents> | undefined

  const escrow = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${ESCROW_URL}/v1/agents${path}`, {
      method,
      headers: { Authorization: `Bearer ${alice}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(url + path, { headers: { authorization: `Bearer ${local}` } })
    expect(res.status, path).toBe(200)
    return (await res.json()) as T
  }

  beforeAll(async () => {
    alice = (await mintOidcSession('alice', 'alicepass123')).accessToken
    const res = await escrow('POST', '', { name: `Sidecar API ${rand()}` })
    expect(res.status).toBe(201)
    agent = (await res.json()) as NonNullable<typeof agent>
    person = await startHuman(alice)
    wellKnown = await startWellKnown(HS_URL)
    store = await mkdtemp(join(tmpdir(), 'sidecar-api-it-'))
    p = startSidecar(['--server', wellKnown.url, '--token', agent.token, '--store', store])
    const line = await p.waitFor(evt('api-listening'), 90_000)
    url = line.url as string
    local = (await readFile(join(store, 'local.token'), 'utf8')).trim()
  }, 180_000)

  afterAll(async () => {
    stream?.close()
    await p?.stop()
    person?.stop()
    if (agent !== undefined && !removed) await escrow('DELETE', `/${encodeURIComponent(agent.userId)}`)
    await wellKnown?.close()
    if (store !== undefined) await rm(store, { recursive: true, force: true })
  }, 60_000)

  it('1. GET /v1/me → U…/T… of the agent', async () => {
    const me = await get<ApiMe>('/v1/me')
    expect(me).toMatchObject({ id: personToken(agent!.userId), workspace: workspaceToken(serverNameOf(agent!.userId)), kind: 'agent' })
    expect(me.id).toMatch(/^U[A-Z2-7]{10}$/)
  }, 30_000)

  it('2. the person invites to a room and a DM → conversations shows a C… and a D…', async () => {
    room = await person.createEncryptedRoom([agent!.userId])
    dm = await person.createDirect(agent!.userId)
    const list = await until(
      async () => {
        const l = await get<ApiConversationList>('/v1/conversations')
        const ids = l.conversations.map((c) => c.id)
        return ids.includes(conversationToken(room, false)) && ids.includes(conversationToken(dm, true)) ? l : undefined
      },
      90_000,
      'both conversations in the listing',
    )
    expect(list.conversations.find((c) => c.id === conversationToken(room, false))).toMatchObject({ kind: 'private' })
    expect(list.conversations.find((c) => c.id === conversationToken(dm, true))).toMatchObject({ kind: 'dm', peer: personToken(person.userId) })
    expect(JSON.stringify(list)).not.toMatch(/[!@$][A-Za-z0-9]+:/)
  }, 120_000)

  it('3. the person mentions the agent → SSE message.received + mention, author U…, text decrypted', async () => {
    await person.waitForMembership(room, agent!.userId, 'join')
    stream = openEvents(url, local)
    await new Promise((r) => setTimeout(r, 500))
    const text = `agente, relatório ${rand()}?`
    const eventId = await person.sendMention(room, text, [agent!.userId])
    const mention = await until(() => stream!.frames.find((f) => f.event === 'mention' && (f.data?.message as { text?: string })?.text === text), 60_000, 'the mention')
    const received = stream.frames.find((f) => f.event === 'message.received' && (f.data?.message as { text?: string })?.text === text)!
    expect(received.data).toMatchObject({
      conversation: conversationToken(room, false),
      message: { author: personToken(person.userId), text, mentionsMe: true },
    })
    expect((received.data!.message as { id: string }).id).toMatch(/^\d+\.\d{6}$/)
    expect(stream.frames.indexOf(received)).toBeLessThan(stream.frames.indexOf(mention))
    // The id is the P-S2 ts of that event (the agent's view equals the server's instant).
    expect((received.data!.message as { id: string }).id.endsWith(messageTs(0, eventId).slice(-3))).toBe(true)
  }, 120_000)

  it('4. history pages: limit, cursor, oldest', async () => {
    const texts = [`h1 ${rand()}`, `h2 ${rand()}`, `h3 ${rand()}`]
    for (const t of texts) await person.sendText(room, t)
    const conv = conversationToken(room, false)
    await until(() => (stream!.frames.some((f) => (f.data?.message as { text?: string })?.text === texts[2]) ? true : undefined), 60_000, 'the 3 messages live')
    const first = await get<ApiMessageList>(`/v1/conversations/${conv}/messages?limit=2`)
    expect(first.messages.map((m) => m.text)).toEqual([texts[2], texts[1]])
    expect(first.next).toMatch(/^cur_/)
    const second = await get<ApiMessageList>(`/v1/conversations/${conv}/messages?limit=2&cursor=${first.next!}`)
    expect(second.messages[0]?.text).toBe(texts[0])
    const oldest = first.messages[1]!.id
    const after = await get<ApiMessageList>(`/v1/conversations/${conv}/messages?oldest=${oldest}`)
    expect(after.messages.map((m) => m.text)).toEqual([texts[2]])
    const bad = await fetch(`${url}/v1/conversations/${conv}/messages?cursor=cur_nope`, { headers: { authorization: `Bearer ${local}` } })
    expect(bad.status).toBe(400)
  }, 120_000)

  it('5. Last-Event-ID inside the ring replays; another epoch → resync', async () => {
    const live = stream!.frames.filter((f) => f.id !== undefined)
    const pivot = live[0]!
    const replay = openEvents(url, local, pivot.id)
    await until(() => (replay.frames.length >= live.length - 1 ? true : undefined), 15_000, 'the replay')
    expect(replay.frames.slice(0, live.length - 1).map((f) => f.id)).toEqual(live.slice(1).map((f) => f.id))
    replay.close()
    const epoch = pivot.id!.slice(0, pivot.id!.lastIndexOf('-'))
    const other = openEvents(url, local, `x${epoch}-1`)
    await until(() => (other.frames.length > 0 ? true : undefined), 15_000, 'the resync')
    expect(other.frames[0]).toMatchObject({ event: 'resync' })
    other.close()
  }, 60_000)

  // §0.3.10 item 2. bob is not the operator: his invite is refused by leaving. alice (the operator,
  // invited by bob to the same room) re-invites after the leave and the agent joins. One createRoom.
  it("5b. a non-operator's invite is refused (leave); the operator's re-invite after the leave joins", async () => {
    const bob = await startHuman((await mintOidcSession('bob', 'bobpass123')).accessToken)
    try {
      const theirs = await bob.createEncryptedRoom([agent!.userId, person.userId])
      // §0.3.12 item 9: the join lines name the conversation token, never the room id.
      const theirsConv = conversationToken(theirs, false)
      const refused = await p!.waitFor((l) => l.evt === 'invite-refused' && l.conversation === theirsConv, 60_000)
      expect(refused).toEqual({ evt: 'invite-refused', conversation: theirsConv, reason: 'not-operator' })
      await bob.waitForMembership(theirs, agent!.userId, 'leave')
      expect(p!.lines.some((l) => l.evt === 'joined' && l.conversation === theirsConv)).toBe(false)
      expect(p!.stdout()).not.toContain(bob.userId)
      expect(p!.stdout()).not.toContain(person.userId)

      await person.join(theirs)
      await person.invite(theirs, agent!.userId)
      await p!.waitFor((l) => l.evt === 'joined' && l.conversation === theirsConv, 90_000)
      await bob.waitForMembership(theirs, agent!.userId, 'join', 60_000)
      expect(p!.lines.filter((l) => l.evt === 'invite-refused' && l.conversation === theirsConv)).toHaveLength(1)

      // Read only (no change): the `invite` level of a private and a public channel as the product's
      // createChannel makes them (PrivateChat = the room of test 2; PublicChat, one createRoom).
      const privateInvite = await person.inviteLevel(room)
      const publicInvite = await person.inviteLevel(await person.createPublicChannel())
      console.log(`[sidecar-api-it] power_levels.invite: private ${String(privateInvite)}, public ${String(publicInvite)}`)
    } finally {
      bob.stop()
    }
  }, 240_000)

  it('6. revocation → SSE agent.revoked, 503, exit 78', async () => {
    // A poller on /v1/me from before the DELETE until the API is gone: 200s, then 503 revoked (from the
    // start of the revocation, while the store is wiped), then the connection refused (exit).
    const statuses: number[] = []
    let polling = true
    const poller = (async () => {
      while (polling) {
        const r = await fetch(`${url}/v1/me`, { headers: { authorization: `Bearer ${local}` } }).catch(() => null)
        if (r === null) break
        statuses.push(r.status)
        await r.arrayBuffer()
      }
    })()
    const t0 = Date.now()
    expect((await escrow('DELETE', `/${encodeURIComponent(agent!.userId)}`)).status).toBeLessThan(300)
    removed = true
    await until(() => (stream!.frames.some((f) => f.event === 'agent.revoked') ? true : undefined), REVOKE_CEILING_MS, 'agent.revoked')
    const code = await Promise.race([p!.exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), REVOKE_CEILING_MS))])
    polling = false
    await poller
    const n503 = statuses.filter((s) => s === 503).length
    console.log(`[sidecar-api-it] DELETE → exit ${String(code)} in ${Date.now() - t0} ms; poller: ${statuses.length} requests, ${n503} × 503 before the exit`)
    expect(code).toBe(78)
    expect(n503).toBeGreaterThan(0)
    const first503 = statuses.indexOf(503)
    expect(statuses.slice(first503).every((s) => s === 503)).toBe(true)
    expect(statuses.slice(0, first503).every((s) => s === 200)).toBe(true)
    expect(stream!.ended()).toBe(true)
  }, 90_000)
})
