import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { MatrixClient } from 'matrix-js-sdk'
import type { Acl, AclTelemetry, AgentCommand, ChannelId, DomainEvent, Message, MessageId, UserId } from '../../src/acl'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import { createRoom, getEvent, HOMESERVER, invite, join, sendText, synapseReachable } from '../support/synapse'
import { mintOidcSession } from '../support/mint-oidc'
import { ESCROW_URL } from '../support/stack-env'
import { freshUsers, type FreshUser } from '../support/fresh-users'
import { COMMANDS_REL_TYPE, buildCommandsContent, buildCommandsEditContent } from '@tayet/shared/internal'
import { FOLD_RULES } from '../../src/acl/internal/fold-rules'

// ADR-093 (Proposto), A4-1 — the agents' `/` commands read and sent by the client against the real server,
// both sides proved (PLANO-AGENTES §0.3.21). An ENCRYPTED conversation with a person and an agent account
// created by the escrow (`POST /v1/agents`, as the product does); the agent writes its manifest by the
// protocol, encrypted by its own client, with the shared builders (the sidecar writes it only in A4-2). The
// person's ACL:
//   1. reads the new manifest by listCommands;
//   2. the agent edits → commands.changed with the new list; no line, no unread;
//   3. the agent clears → the list is empty;
//   4. the person sends with SendOpts.command → the agent's side reads Message.command and its mention.
// The `a-` account is deleted at the end. Auto-skip without the stack (issue #7); fileParallelism:false
// serializes the gates.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const rand = (): string => Math.random().toString(36).slice(2, 10)

async function until<T>(get: () => T | undefined | Promise<T | undefined>, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function overrideRule(token: string, ruleId: string): Promise<unknown> {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/pushrules/global/override/${encodeURIComponent(ruleId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return res.ok ? res.json() : undefined
}

// A gateway of our own (not the barrel): the test reaches its SDK client to write by the protocol —
// encrypted in an encrypted conversation — what no barrel verb writes.
async function gatewayFor(token: string, events: DomainEvent[]): Promise<{ gw: MatrixGateway; client: MatrixClient }> {
  const gw = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER }, { searchBackfill: false })
  gw.subscribe((e) => events.push(e))
  await gw.connect(token as Parameters<Acl['connect']>[0])
  return { gw, client: (gw as unknown as { client: MatrixClient }).client }
}

const sendRaw = async (client: MatrixClient, roomId: string, content: Record<string, unknown>): Promise<string> =>
  (await client.sendMessage(roomId, content as never)).event_id

describe.skipIf(!SYNAPSE)('agent commands — the client reads and sends them (ADR-093, A4-1)', () => {
  let alice: string
  let person: FreshUser
  let agent: { userId: string; token: string } | undefined
  let viewer: { gw: MatrixGateway; client: MatrixClient }
  let agentSide: { gw: MatrixGateway; client: MatrixClient }
  const viewerEvents: DomainEvent[] = []
  const agentEvents: DomainEvent[] = []
  let roomId: string
  let channelId: ChannelId
  let manifestId: string

  const escrow = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${ESCROW_URL}/v1/agents${path}`, {
      method,
      headers: { Authorization: `Bearer ${alice}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  const changes = (events: DomainEvent[]): AgentCommand[][] => events.flatMap((e) => (e.t === 'commands.changed' ? [e.commands] : []))
  const lineIds = (events: DomainEvent[]): string[] =>
    events.flatMap((e) => (e.t === 'message.received' || e.t === 'message.edited' ? [e.message.id as unknown as string] : []))
  const barrier = async (events: DomainEvent[]): Promise<void> => {
    const id = await sendText(agent!.token, roomId, `barreira ${rand()}`)
    await until(() => events.find((e) => e.t === 'message.received' && e.message.id === (id as unknown as MessageId)))
  }

  beforeAll(async () => {
    alice = (await mintOidcSession('alice', 'alicepass123')).accessToken
    ;[person] = await freshUsers(['cmdp'])
    const res = await escrow('POST', '', { name: `Comandos ${rand()}` })
    if (res.status !== 201) throw new Error(`escrow POST /v1/agents -> ${res.status}`)
    agent = (await res.json()) as { userId: string; token: string }

    viewer = await gatewayFor(person.token, viewerEvents)
    agentSide = await gatewayFor(agent.token, agentEvents)
    roomId = await createRoom(person.token, {
      name: `tayet-commands-${process.pid}-${rand()}`,
      initialState: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }],
    })
    await invite(person.token, roomId, agent.userId)
    await join(agent.token, roomId)
    channelId = roomId as unknown as ChannelId
    await until(() => (viewer.client.getRoom(roomId)?.getMember(agent!.userId)?.membership === 'join' ? true : undefined))
    await until(() => (agentSide.client.getRoom(roomId)?.getMyMembership() === 'join' ? true : undefined))
    // The fold rules (three since A4-1) are in place before anything that could count.
    for (const { ruleId } of FOLD_RULES) await until(() => overrideRule(person.token, ruleId), 60_000)
  }, 300_000)

  afterAll(async () => {
    await viewer?.gw.disconnect().catch(() => undefined)
    await agentSide?.gw.disconnect().catch(() => undefined)
    // The `a-` account created here goes: a live agent would pollute the People list.
    if (agent !== undefined) await escrow('DELETE', `/${encodeURIComponent(agent.userId)}`)
  }, 60_000)

  it('1. a new manifest → listCommands', async () => {
    const createId = await until(() => agentSide.client.getRoom(roomId)?.currentState.getStateEvents('m.room.create', '')?.getId() ?? undefined)
    manifestId = await sendRaw(
      agentSide.client,
      roomId,
      buildCommandsContent([{ name: 'status', description: 'Mostra o estado' }, { name: 'deploy', description: 'Publica', hint: '<ambiente>' }], createId),
    )
    // The server took it encrypted, its relation type in clear on the envelope.
    const raw = await getEvent(person.token, roomId, manifestId)
    expect(raw.type).toBe('m.room.encrypted')
    expect(raw.content['m.relates_to']).toEqual({ rel_type: COMMANDS_REL_TYPE, event_id: createId })

    const first = await until(async () => {
      const list = await viewer.gw.listCommands(channelId)
      return list.length > 0 ? list : changes(viewerEvents).at(-1)?.length ? changes(viewerEvents).at(-1) : undefined
    })
    expect(first).toEqual([
      { agent: agent!.userId, name: 'deploy', description: 'Publica', hint: '<ambiente>' },
      { agent: agent!.userId, name: 'status', description: 'Mostra o estado' },
    ])
  }, 300_000)

  it('2. the agent edits → commands.changed; no line, no unread', async () => {
    const before = changes(viewerEvents).length
    const editId = await sendRaw(
      agentSide.client,
      roomId,
      buildCommandsEditContent({ commands: [{ name: 'deploy', description: 'Publica' }, { name: 'rollback', description: 'Desfaz' }] }, manifestId),
    )
    const edited = await until(() => changes(viewerEvents).slice(before).find((l) => l.some((c) => c.name === 'rollback')))
    expect(edited.map((c) => c.name)).toEqual(['deploy', 'rollback'])

    // A barrier from the agent: once it is here, every earlier event was seen. No line for the manifest or
    // its edit, and the unread count is the barrier alone.
    await barrier(viewerEvents)
    expect(lineIds(viewerEvents)).not.toContain(manifestId)
    expect(lineIds(viewerEvents)).not.toContain(editId)
    const page = await viewer.gw.getTimeline(channelId)
    expect(page.items.map((m) => m.id as unknown as string)).not.toContain(manifestId)
    const count = await until(async () => {
      const ch = (await viewer.gw.getChannels()).find((c) => c.id === channelId)
      return ch && ch.unread.count >= 1 ? ch.unread.count : undefined
    })
    expect(count).toBe(1)
  }, 300_000)

  it('3. the agent clears → the list is empty', async () => {
    await sendRaw(agentSide.client, roomId, buildCommandsEditContent({ cleared: true }, manifestId))
    await until(() => (changes(viewerEvents).at(-1)?.length === 0 ? true : undefined))
    expect(await viewer.gw.listCommands(channelId)).toEqual([])
  }, 300_000)

  it('4. the person sends with SendOpts.command → the agent’s side reads Message.command and the mention', async () => {
    const agentId = agent!.userId as unknown as UserId
    const sentId = await viewer.gw.sendMessage(channelId, { kind: 'text', text: '/deploy produção' }, { command: { agent: agentId, name: 'deploy' } })
    // The sender's own echo carries the command.
    const own = await until(() =>
      viewerEvents.flatMap((e) => (e.t === 'message.received' && e.message.id === sentId ? [e.message] : [])).find((m) => m.command !== undefined),
    )
    expect(own.command).toEqual({ agent: agentId, name: 'deploy' })
    // The other end: decrypted, the command and the mention of the agent.
    const seen = await until<Message>(() =>
      agentEvents
        .flatMap((e) => (e.t === 'message.received' || e.t === 'message.edited' ? [e.message] : []))
        .find((m) => m.body.kind === 'text' && m.body.text === '/deploy produção'),
    )
    expect(seen.command).toEqual({ agent: agentId, name: 'deploy' })
    expect(seen.mentions).toEqual([agentId])
    expect(seen.mentionsMe).toBe(true)
  }, 300_000)
})

describe('ACL commands (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
