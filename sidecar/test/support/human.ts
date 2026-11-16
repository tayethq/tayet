// The person of the sidecar's send integration (S-b2), molded on probe/human.mjs of P-S1
// (PLANO-AGENTES §0.3.3): matrix-js-sdk with rust crypto IN MEMORY, driven in-process. Own copy —
// nothing imported from client/ (cross-import gate). Records every message it can read, decrypted.
// NEVER logs token material; the SDK's logger is silenced. S-c2: every timeline event is recorded too
// (edits, reactions, redactions), and the person sends and downloads encrypted files — the cipher is
// the shared one (@tayet/shared/internal/attachment-crypto), the transport a plain authenticated fetch.
import * as sdk from 'matrix-js-sdk'
import { decryptAttachment, encryptAttachment, type EncryptedFile } from '@tayet/shared/internal/attachment-crypto'
import { buildApprovalAnswerContent, readCommandsBlock, readPanelBlock, type CommandsBlock, type PanelBlock } from '@tayet/shared/internal'
import { HS_URL, until } from './stack'

export interface Received {
  eventId: string
  sender: string
  body: unknown
  content: Record<string, unknown>
  relation: { rel_type?: string; event_id?: string } | null
  wireType: string
}

// A3-6: an agent's pinned panel as a person reads it — the anchor's relations (the conversation's creation
// event) filtered by the panel's relation type, forward and paged, the agent's own only; for each panel
// message its edits (forward), the agent's own. `shown`: the latest write's content when it decrypts, with
// its block (readPanelBlock). `messages`/`edits` count the agent's panel messages and edits on the server.
export interface AnchoredRead<B> {
  messages: number
  edits: number
  shown?: { body: unknown; block: B | undefined; at: number; eventId: string }
  // The bodies of every write that decrypted, in the server's order (originals, then edits).
  bodies: unknown[]
}
export type PanelRead = AnchoredRead<PanelBlock>
// A4-2a: the agent's commands manifest, read the same way over its relation type (readCommandsBlock).
export type CommandsRead = AnchoredRead<CommandsBlock>

// Any timeline event the person's client saw (decrypted when it could be).
export interface SeenEvent {
  eventId: string
  type: string
  sender: string
  content: Record<string, unknown>
  relation: { rel_type?: string; event_id?: string; key?: string } | null
  redacts?: string
}

export interface Human {
  userId: string
  // ADR-094 (PLANO-CONVERSAS §8.1): `extraState` adds initial state events (the group marker of a room born
  // outside the product).
  createEncryptedRoom(invite: string[], extraState?: { type: string; state_key: string; content: object }[]): Promise<string>
  waitForMembership(roomId: string, userId: string, membership: string, timeoutMs?: number): Promise<void>
  sendText(roomId: string, text: string): Promise<string>
  // S-c1: a text that mentions people (m.mentions), and an encrypted direct conversation (is_direct +
  // the person's m.direct), as the product creates them.
  sendMention(roomId: string, text: string, userIds: string[]): Promise<string>
  createDirect(userId: string): Promise<string>
  waitForMessage(pred: (m: Received) => boolean, timeoutMs?: number): Promise<Received>
  // S-c2.
  sendInThread(roomId: string, root: string, text: string): Promise<string>
  // S-f2: an edit of one's own message (m.replace with m.new_content), as the product sends it.
  editText(roomId: string, target: string, text: string): Promise<string>
  // A3-3: an answer to an approval card, as the client's answerApproval sends it (the shared builder).
  answerApproval(roomId: string, card: string, option: string, label: string): Promise<string>
  waitForEvent(pred: (e: SeenEvent) => boolean, timeoutMs?: number): Promise<SeenEvent>
  events(): SeenEvent[]
  sendEncryptedFile(roomId: string, name: string, mimetype: string, bytes: Uint8Array): Promise<string>
  downloadEncrypted(file: EncryptedFile): Promise<Uint8Array>
  // Operator 1 (PLANO-AGENTES §0.3.10): join a room one was invited to, invite someone, a public
  // channel as the product's createChannel makes it (PublicChat, born in the clear), and the
  // `invite` level of m.room.power_levels (read only).
  join(roomId: string): Promise<void>
  invite(roomId: string, userId: string): Promise<void>
  createPublicChannel(): Promise<string>
  inviteLevel(roomId: string): Promise<number | undefined>
  readPanel(roomId: string, agent: string): Promise<PanelRead>
  readCommands(roomId: string, agent: string): Promise<CommandsRead>
  // A4-2b: any message content as built by the shared builders (a command, a panel and its edit), and the
  // room's creation event (the anchor of a panel).
  sendContent(roomId: string, content: Record<string, unknown>): Promise<string>
  createEventOf(roomId: string): string | undefined
  stop(): void
}

// The stack's room-creation limit (rc_room_creation) is shared by every run of the day on `spike`, as
// are rc_joins and rc_invites (join/invite below) and the message limit (rc_message: every send below,
// issue #7 — three gate runs failed on a 429 of the person's send): a 429 is waited out with the
// server's retry_after_ms (+ 200 ms), never counted as a failure. Every write of the person goes through
// here, and this is the ONLY retry: the person's SDK scheduler never retries (startHuman), as the
// sidecar's (boot.ts). A 429 is a refusal — nothing was stored — so the next attempt cannot duplicate.
async function honouringLimit<T>(op: () => Promise<T>, deadlineMs = 120_000): Promise<T> {
  const end = Date.now() + deadlineMs
  for (;;) {
    try {
      return await op()
    } catch (err) {
      const e = err as { errcode?: string; data?: { retry_after_ms?: number } }
      const wait = (e.data?.retry_after_ms ?? 2_000) + 200
      if (e.errcode !== 'M_LIMIT_EXCEEDED' || Date.now() + wait > end) throw err
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

const noop = (): void => {}
const silent = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, getChild: (): unknown => silent }

export async function startHuman(token: string): Promise<Human> {
  const who = (await (
    await fetch(`${HS_URL}/_matrix/client/v3/account/whoami`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as { user_id: string; device_id: string }
  const client = sdk.createClient({
    baseUrl: HS_URL,
    userId: who.user_id,
    deviceId: who.device_id,
    accessToken: token,
    logger: silent as never,
    // createClient always installs a MatrixScheduler whose default retries a 429 up to 4 times and then
    // rejects; honouringLimit is the one owner of the retry instead (as boot.ts does for the agent).
    scheduler: new sdk.MatrixScheduler(() => -1),
  })
  await client.initRustCrypto({ useIndexedDB: false })

  const seen = new Map<string, Received>()
  const record = (ev: sdk.MatrixEvent): void => {
    if (ev.getType() !== 'm.room.message' || ev.isBeingDecrypted() || ev.isDecryptionFailure()) return
    const id = ev.getId()
    if (id === undefined || seen.has(id)) return
    seen.set(id, {
      eventId: id,
      sender: ev.getSender() ?? '',
      body: ev.getContent().body,
      content: ev.getContent(),
      relation: ev.getRelation(),
      wireType: ev.getWireType(),
    })
  }
  const all = new Map<string, SeenEvent>()
  const recordAny = (ev: sdk.MatrixEvent): void => {
    const id = ev.getId()
    if (id === undefined || !id.startsWith('$') || ev.isBeingDecrypted()) return
    const prev = all.get(id)
    // A decrypted version replaces the encrypted one.
    if (prev !== undefined && !(prev.type === 'm.room.encrypted' && ev.getType() !== 'm.room.encrypted')) return
    const redacts = (ev.event as { redacts?: unknown }).redacts ?? ev.getContent<{ redacts?: unknown }>().redacts
    all.set(id, {
      eventId: id,
      type: ev.getType(),
      sender: ev.getSender() ?? '',
      content: ev.getContent(),
      relation: ev.getRelation(),
      ...(typeof redacts === 'string' && { redacts }),
    })
  }
  client.on(sdk.RoomEvent.Timeline, (ev) => {
    record(ev)
    recordAny(ev)
  })
  client.on(sdk.MatrixEventEvent.Decrypted, (ev) => {
    record(ev)
    recordAny(ev)
  })

  const prepared = new Promise<void>((resolve) =>
    client.on(sdk.ClientEvent.Sync, (state) => {
      if (state === sdk.SyncState.Prepared) resolve()
    }),
  )
  await client.startClient({ initialSyncLimit: 10 })
  await prepared

  return {
    userId: who.user_id,
    async createEncryptedRoom(invite, extraState = []) {
      const r = await honouringLimit(() => client.createRoom({
        invite,
        preset: sdk.Preset.PrivateChat,
        initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }, ...extraState],
      }))
      await until(() => (client.getRoom(r.room_id) !== null ? true : undefined), 30_000, 'own room in the sync')
      return r.room_id
    },
    async waitForMembership(roomId, userId, membership, timeoutMs = 60_000) {
      await until(
        () => (client.getRoom(roomId)?.getMember(userId)?.membership === membership ? true : undefined),
        timeoutMs,
        `${membership} of the agent`,
      )
    },
    async sendText(roomId, text) {
      const r = await honouringLimit(() => client.sendTextMessage(roomId, text))
      return r.event_id
    },
    async sendMention(roomId, text, userIds) {
      const r = await honouringLimit(() => client.sendMessage(roomId, { msgtype: 'm.text', body: text, 'm.mentions': { user_ids: userIds } } as never))
      return r.event_id
    },
    async join(roomId) {
      await honouringLimit(() => client.joinRoom(roomId))
    },
    async invite(roomId, userId) {
      await honouringLimit(() => client.invite(roomId, userId))
    },
    async createPublicChannel() {
      const r = await honouringLimit(() => client.createRoom({ preset: sdk.Preset.PublicChat }))
      return r.room_id
    },
    async inviteLevel(roomId) {
      const content = (await client.getStateEvent(roomId, 'm.room.power_levels', '')) as { invite?: unknown }
      return typeof content.invite === 'number' ? content.invite : undefined
    },
    async createDirect(userId) {
      const r = await honouringLimit(() => client.createRoom({
        invite: [userId],
        is_direct: true,
        preset: sdk.Preset.TrustedPrivateChat,
        initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }],
      }))
      const direct: Record<string, string[]> = client.getAccountData(sdk.EventType.Direct as never)?.getContent<Record<string, string[]>>() ?? {}
      await honouringLimit(() => client.setAccountData(sdk.EventType.Direct as never, { ...direct, [userId]: [...(direct[userId] ?? []), r.room_id] } as never))
      await until(() => (client.getRoom(r.room_id) !== null ? true : undefined), 30_000, 'own DM in the sync')
      return r.room_id
    },
    waitForMessage(pred, timeoutMs = 60_000) {
      return until(() => [...seen.values()].find(pred), timeoutMs, 'a decrypted message')
    },
    async sendInThread(roomId, root, text) {
      const r = await honouringLimit(() => client.sendMessage(roomId, root, {
        msgtype: 'm.text',
        body: text,
        'm.relates_to': { rel_type: 'm.thread', event_id: root, is_falling_back: true, 'm.in_reply_to': { event_id: root } },
      } as never))
      return r.event_id
    },
    async answerApproval(roomId, card, option, label) {
      const r = await honouringLimit(() => client.sendEvent(roomId, sdk.EventType.RoomMessage, buildApprovalAnswerContent(card, option, label) as never))
      return r.event_id
    },
    async sendContent(roomId, content) {
      const r = await honouringLimit(() => client.sendEvent(roomId, sdk.EventType.RoomMessage, content as never))
      return r.event_id
    },
    createEventOf(roomId) {
      return client.getRoom(roomId)?.currentState.getStateEvents(sdk.EventType.RoomCreate, '')?.getId() ?? undefined
    },
    async editText(roomId, target, text) {
      const r = await honouringLimit(() => client.sendMessage(roomId, {
        msgtype: 'm.text',
        body: `* ${text}`,
        'm.new_content': { msgtype: 'm.text', body: text },
        'm.relates_to': { rel_type: 'm.replace', event_id: target },
      } as never))
      return r.event_id
    },
    waitForEvent(pred, timeoutMs = 60_000) {
      return until(() => [...all.values()].find(pred), timeoutMs, 'an event')
    },
    events() {
      return [...all.values()]
    },
    async sendEncryptedFile(roomId, name, mimetype, bytes) {
      // ADR-016, as the product sends it: the ciphertext goes up nameless and opaque.
      const { ciphertext, info } = await encryptAttachment(bytes)
      const up = await honouringLimit(() => client.uploadContent(ciphertext, { includeFilename: false, type: 'application/octet-stream' }))
      const r = await honouringLimit(() => client.sendMessage(roomId, {
        msgtype: 'm.file',
        body: name,
        file: { ...info, url: up.content_uri },
        info: { mimetype, size: bytes.byteLength },
      } as never))
      return r.event_id
    },
    async downloadEncrypted(file) {
      const m = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(file.url)
      if (m === null) throw new Error('not a media URI')
      const res = await fetch(`${HS_URL}/_matrix/client/v1/media/download/${encodeURIComponent(m[1]!)}/${encodeURIComponent(m[2]!)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(`download ${res.status}`)
      return new Uint8Array(await decryptAttachment(await res.arrayBuffer(), file))
    },
    readPanel: (roomId, agent) => readAnchored(roomId, agent, 'io.tayet.panel', readPanelBlock),
    readCommands: (roomId, agent) => readAnchored(roomId, agent, 'io.tayet.commands', readCommandsBlock),
    stop() {
      client.stopClient()
    },
  }

  async function readAnchored<B>(roomId: string, agent: string, relType: string, blockOf: (c: Record<string, unknown>) => B | undefined): Promise<AnchoredRead<B>> {
    const createId = client.getRoom(roomId)?.currentState.getStateEvents(sdk.EventType.RoomCreate, '')?.getId()
    // Not in this person's sync yet (she just joined): no panel to read so far.
    if (createId === undefined) return { messages: 0, edits: 0, bodies: [] }
    const mapper = client.getEventMapper()
    const relations = async (target: string, relType: string): Promise<sdk.MatrixEvent[]> => {
      const out: sdk.MatrixEvent[] = []
      let from: string | undefined
      for (;;) {
        const res = await client.fetchRelations(roomId, target, relType, null, { dir: sdk.Direction.Forward, ...(from !== undefined && { from }) })
        const events = res.chunk.map((raw) => mapper(raw))
        await Promise.all(events.map((ev) => client.decryptEventIfNeeded(ev).catch(() => undefined)))
        out.push(...events.filter((ev) => ev.getSender() === agent && !ev.isRedacted()))
        if (!res.next_batch) return out
        from = res.next_batch
      }
    }
    const ok = (ev: sdk.MatrixEvent): boolean => !ev.isDecryptionFailure() && ev.getType() === 'm.room.message'
    const read: AnchoredRead<B> = { messages: 0, edits: 0, bodies: [] }
    for (const panel of await relations(createId, relType)) {
      read.messages += 1
      if (ok(panel)) read.bodies.push(panel.getContent().body)
      const edits = await relations(panel.getId()!, 'm.replace')
      read.edits += edits.length
      for (const e of edits) if (ok(e)) read.bodies.push((e.getContent()['m.new_content'] as { body?: unknown } | undefined)?.body)
      const latest = edits.reduce<sdk.MatrixEvent | undefined>((a, e) => (a === undefined || e.getTs() >= a.getTs() ? e : a), undefined) ?? panel
      if (read.shown !== undefined && latest.getTs() < read.shown.at) continue
      if (!ok(latest)) {
        delete read.shown
        continue
      }
      const content = (latest === panel ? panel.getContent() : latest.getContent()['m.new_content']) as Record<string, unknown>
      read.shown = { body: content.body, block: blockOf(content), at: latest.getTs(), eventId: panel.getId()! }
    }
    return read
  }
}
