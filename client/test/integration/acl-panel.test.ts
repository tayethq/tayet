import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { MatrixClient } from 'matrix-js-sdk'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, AgentPanel, ChannelId, DomainEvent, MessageId } from '../../src/acl'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import { createRoom, getEvent, HOMESERVER, invite, join, sendText, synapseReachable, whoami } from '../support/synapse'
import { mintOidcSession } from '../support/mint-oidc'
import { ESCROW_URL } from '../support/stack-env'
import { freshUsers, type FreshUser } from '../support/fresh-users'
import { PANEL_REL_TYPE, buildPanelContent, buildPanelEditContent } from '@tayet/shared/internal'
import type { RichDoc } from '@tayet/shared'
import { FOLD_RULES } from '../../src/acl/internal/fold-rules'

// ADR-091 (Proposto) dec. 12, A3-5 — the pinned panel read by the client against the real server, both
// sides proved (PLANO-AGENTES §0.3.18 item 6). An ENCRYPTED conversation with a person and an agent
// account created by the escrow (`POST /v1/agents`, as the product does); the agent writes its panel by
// the protocol, encrypted by its own client, with the shared builders (the sidecar writes it only in
// A3-6). The person's ACL:
//   1. reads the panel by listPanels (title, body, instant);
//   2. the agent edits → panels.changed with the new content; no line, no unread;
//   3. an edit forged by another member (accepted by the server) changes nothing;
//   4. a second person joins: no panel until the agent's next edit, then the panel;
//   5. the agent clears → the list is empty.
// The `a-` account is deleted at the end. Auto-skip without the stack (issue #7); fileParallelism:false
// serializes the gates.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const rand = (): string => Math.random().toString(36).slice(2, 10)
const RICH: RichDoc = [{ t: 'p', children: [{ t: 'text', text: 'Três itens, ' }, { t: 'strong', children: [{ t: 'text', text: '1 aguardando' }] }] }]

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

describe.skipIf(!SYNAPSE)('pinned panel — the client reads it (ADR-091 dec. 12, A3-5)', () => {
  let alice: string
  let person: FreshUser
  let second: FreshUser
  let agent: { userId: string; token: string } | undefined
  let viewer: { gw: MatrixGateway; client: MatrixClient }
  let agentSide: { gw: MatrixGateway; client: MatrixClient }
  let secondAcl: Acl
  const viewerEvents: DomainEvent[] = []
  const secondEvents: DomainEvent[] = []
  let roomId: string
  let channelId: ChannelId
  let panelId: string

  const escrow = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${ESCROW_URL}/v1/agents${path}`, {
      method,
      headers: { Authorization: `Bearer ${alice}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  const changes = (events: DomainEvent[]): AgentPanel[][] => events.flatMap((e) => (e.t === 'panels.changed' ? [e.panels] : []))
  const lineIds = (events: DomainEvent[]): string[] =>
    events.flatMap((e) => (e.t === 'message.received' || e.t === 'message.edited' ? [e.message.id as unknown as string] : []))
  const barrier = async (events: DomainEvent[]): Promise<void> => {
    const id = await sendText(agent!.token, roomId, `barreira ${rand()}`)
    await until(() => events.find((e) => e.t === 'message.received' && e.message.id === (id as unknown as MessageId)))
  }

  beforeAll(async () => {
    alice = (await mintOidcSession('alice', 'alicepass123')).accessToken
    ;[person, second] = await freshUsers(['pnlp', 'pnls'])
    const res = await escrow('POST', '', { name: `Painel ${rand()}` })
    if (res.status !== 201) throw new Error(`escrow POST /v1/agents -> ${res.status}`)
    agent = (await res.json()) as { userId: string; token: string }

    viewer = await gatewayFor(person.token, viewerEvents)
    agentSide = await gatewayFor(agent.token, [])
    roomId = await createRoom(person.token, {
      name: `tayet-panel-${process.pid}-${rand()}`,
      initialState: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }],
    })
    await invite(person.token, roomId, agent.userId)
    await join(agent.token, roomId)
    channelId = roomId as unknown as ChannelId
    await until(() => (viewer.client.getRoom(roomId)?.getMember(agent!.userId)?.membership === 'join' ? true : undefined))
    await until(() => (agentSide.client.getRoom(roomId)?.getMyMembership() === 'join' ? true : undefined))
    // The fold rules are in place before anything that could count.
    for (const { ruleId } of FOLD_RULES) await until(() => overrideRule(person.token, ruleId), 60_000)
  }, 300_000)

  afterAll(async () => {
    await viewer?.gw.disconnect().catch(() => undefined)
    await agentSide?.gw.disconnect().catch(() => undefined)
    await secondAcl?.disconnect().catch(() => undefined)
    // The `a-` account created here goes: a live agent would pollute the People list.
    if (agent !== undefined) await escrow('DELETE', `/${encodeURIComponent(agent.userId)}`)
  }, 60_000)

  it('1–2. the person reads the panel; the agent’s edit arrives as panels.changed — no line, no unread', async () => {
    const createId = await until(() => agentSide.client.getRoom(roomId)?.currentState.getStateEvents('m.room.create', '')?.getId() ?? undefined)
    panelId = await sendRaw(agentSide.client, roomId, buildPanelContent('Três itens, 1 aguardando', RICH, 'Produção de hoje', createId))
    // The server took it encrypted, its relation type in clear on the envelope.
    const raw = await getEvent(person.token, roomId, panelId)
    expect(raw.type).toBe('m.room.encrypted')
    expect(raw.content['m.relates_to']).toEqual({ rel_type: PANEL_REL_TYPE, event_id: createId })

    const first = await until(async () => {
      const list = await viewer.gw.listPanels(channelId)
      return list.length > 0 ? list : changes(viewerEvents).at(-1)?.length ? changes(viewerEvents).at(-1) : undefined
    })
    expect(first).toEqual([{ agent: agent!.userId, title: 'Produção de hoje', text: 'Três itens, 1 aguardando', rich: RICH, updatedAt: raw.origin_server_ts }])

    const before = changes(viewerEvents).length
    const editId = await sendRaw(agentSide.client, roomId, buildPanelEditContent({ text: 'Quatro itens', title: 'Produção de hoje' }, panelId))
    const edited = await until(() => changes(viewerEvents).slice(before).find((l) => l[0]?.text === 'Quatro itens'))
    expect(edited).toEqual([{ agent: agent!.userId, title: 'Produção de hoje', text: 'Quatro itens', updatedAt: (await getEvent(person.token, roomId, editId)).origin_server_ts }])

    // A barrier from the agent: once it is here, every earlier event was seen. No line for the panel or
    // its edit, and the unread count is the barrier alone.
    await barrier(viewerEvents)
    expect(lineIds(viewerEvents)).not.toContain(panelId)
    expect(lineIds(viewerEvents)).not.toContain(editId)
    const page = await viewer.gw.getTimeline(channelId)
    expect(page.items.map((m) => m.id as unknown as string)).not.toContain(panelId)
    const count = await until(async () => {
      const ch = (await viewer.gw.getChannels()).find((c) => c.id === channelId)
      return ch && ch.unread.count >= 1 ? ch.unread.count : undefined
    })
    expect(count).toBe(1)
  }, 300_000)

  it('3. an edit forged by another member, accepted by the server, changes nothing', async () => {
    const before = changes(viewerEvents).length
    const forgedId = await sendRaw(viewer.client, roomId, buildPanelEditContent({ text: 'forjado', title: 'Forjado' }, panelId))
    expect((await getEvent(person.token, roomId, forgedId)).type).toBe('m.room.encrypted')
    await barrier(viewerEvents)
    // Give the reload that the forged event triggered time to land before reading.
    await new Promise((r) => setTimeout(r, 2_000))
    expect(changes(viewerEvents).slice(before)).toEqual([])
    expect((await viewer.gw.listPanels(channelId)).map((p) => p.text)).toEqual(['Quatro itens'])
  }, 300_000)

  it('4. a second person joins: no panel until the agent’s next edit, then the panel', async () => {
    secondAcl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    secondAcl.subscribe((e) => secondEvents.push(e))
    await secondAcl.connect(second.token as Parameters<Acl['connect']>[0])
    const secondId = await whoami(second.token)
    await invite(person.token, roomId, secondId)
    await join(second.token, roomId)
    await until(() => (agentSide.client.getRoom(roomId)?.getMember(secondId)?.membership === 'join' ? true : undefined))
    await until(() => secondEvents.find((e) => (e.t === 'channel.added' || e.t === 'channel.changed') && ('channel' in e ? e.channel.id === channelId : false)))
    await barrier(secondEvents)
    expect(await secondAcl.listPanels(channelId)).toEqual([])

    await sendRaw(agentSide.client, roomId, buildPanelEditContent({ text: 'Cinco itens', title: 'Produção de hoje' }, panelId))
    const seen = await until(() => changes(secondEvents).find((l) => l[0]?.text === 'Cinco itens'))
    expect(seen.map((p) => p.agent as unknown as string)).toEqual([agent!.userId])
    expect((await secondAcl.listPanels(channelId)).map((p) => p.text)).toEqual(['Cinco itens'])
  }, 300_000)

  it('5. the agent clears the panel → the list is empty', async () => {
    await sendRaw(agentSide.client, roomId, buildPanelEditContent({ cleared: true }, panelId))
    await until(() => (changes(viewerEvents).at(-1)?.length === 0 ? true : undefined))
    await until(() => (changes(secondEvents).at(-1)?.length === 0 ? true : undefined))
    expect(await viewer.gw.listPanels(channelId)).toEqual([])
    expect(await secondAcl.listPanels(channelId)).toEqual([])
  }, 300_000)
})

describe('ACL panel (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
