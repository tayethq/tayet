import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebClient } from '@slack/web-api'
import { ESCROW_URL, HS_URL, mintOidcSession, stackUp, startWellKnown, until } from '../support/stack'
import { evt, startSidecar, type SidecarProcess } from '../support/sidecar-process'
import { startHuman, type Human } from '../support/human'
import { conversationToken, serverNameOf } from '../../src/api/ids'
import type { ApiConversation, ApiConversationList } from '../../src/api/contract'

// ADR-094 (Proposto) dec. 12 — PR-1 against the stack (PLANO-CONVERSAS §8.1). The operator (alice) creates,
// outside the product, an encrypted room with the group marker in its initial state, inviting bob and her own
// agent (the product never adds an agent to a group, dec. 7; the operator's invite is the known limit). The
// native API gives `kind: 'group'` with the channel-prefix token, and the Slack layer gives `is_mpim: true`.
// One createRoom; one `a-` account per run is left deactivated on the stack.

const STACK = stackUp()
const rand = (): string => Math.random().toString(36).slice(2, 8)

describe.skipIf(!STACK)('sidecar ↔ stack: a group conversation born outside the product (ADR-094, C1)', () => {
  let alice: string
  let agent: { userId: string; token: string; deviceId: string } | undefined
  let wellKnown: Awaited<ReturnType<typeof startWellKnown>>
  let store: string
  let person: Human
  let p: SidecarProcess | undefined
  let url = ''
  let local = ''

  const escrow = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${ESCROW_URL}/v1/agents${path}`, {
      method,
      headers: { Authorization: `Bearer ${alice}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

  beforeAll(async () => {
    alice = (await mintOidcSession('alice', 'alicepass123')).accessToken
    const res = await escrow('POST', '', { name: `Sidecar Group ${rand()}` })
    expect(res.status).toBe(201)
    agent = (await res.json()) as NonNullable<typeof agent>
    person = await startHuman(alice)
    wellKnown = await startWellKnown(HS_URL)
    store = await mkdtemp(join(tmpdir(), 'sidecar-group-it-'))
    p = startSidecar(['--server', wellKnown.url, '--token', agent.token, '--store', store])
    const line = await p.waitFor(evt('api-listening'), 90_000)
    url = line.url as string
    local = (await readFile(join(store, 'local.token'), 'utf8')).trim()
  }, 180_000)

  afterAll(async () => {
    await p?.stop()
    person?.stop()
    if (agent !== undefined) await escrow('DELETE', `/${encodeURIComponent(agent.userId)}`)
    await wellKnown?.close()
    if (store !== undefined) await rm(store, { recursive: true, force: true })
  }, 60_000)

  it('native kind group with a C… token; Slack conversations.list types=mpim → is_mpim', async () => {
    const bob = `@bob:${serverNameOf(person.userId)}`
    const room = await person.createEncryptedRoom([agent!.userId, bob], [{ type: 'io.tayet.conversation', state_key: '', content: { kind: 'group' } }])
    const token = conversationToken(room, false)
    expect(token).toMatch(/^C/)

    const get = async <T>(path: string): Promise<T> => {
      const r = await fetch(url + path, { headers: { authorization: `Bearer ${local}` } })
      expect(r.status, path).toBe(200)
      return (await r.json()) as T
    }
    const conversation = await until(
      async () => (await get<ApiConversationList>('/v1/conversations')).conversations.find((c) => c.id === token),
      90_000,
      'the group in the listing',
    )
    expect(conversation).toMatchObject<Partial<ApiConversation>>({ id: token, kind: 'group' })
    expect(conversation.name.startsWith('#')).toBe(false)
    expect(conversation.peer).toBeUndefined()
    expect(JSON.stringify(conversation)).not.toMatch(/[!@$][A-Za-z0-9]+:/)

    const slack = new WebClient(local, { slackApiUrl: `${url}/slack/api/`, retryConfig: { retries: 3, factor: 1, minTimeout: 100, maxTimeout: 1000 } })
    const mpim = (await slack.apiCall('conversations.list', { types: 'mpim' })) as unknown as { channels: Array<Record<string, unknown>> }
    expect(mpim.channels.find((c) => c.id === token)).toMatchObject({ id: token, is_mpim: true, is_channel: false, is_group: false, is_private: true })
    const others = (await slack.apiCall('conversations.list', { types: 'public_channel,private_channel,im' })) as unknown as { channels: Array<{ id: string }> }
    expect(others.channels.map((c) => c.id)).not.toContain(token)
  }, 150_000)
})
