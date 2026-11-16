import { describe, it, expect, vi } from 'vitest'
import { EventStatus, MatrixEvent, RoomEvent } from 'matrix-js-sdk'
import { COMMAND_MARKER } from '@tayet/shared/internal'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry, ChannelId, DomainEvent, MessageId, UserId } from '../src/acl'

// ADR-093 (Proposto), A4-1 (PLANO-AGENTES §0.3.21 items 7–8): SendOpts.command — the content the gateway
// puts on the wire (the marker, the agent added to the mentions once, the relation last, in the three
// forms), the refusals before any effect, and the optimistic echo already carrying Message.command.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:tayet.local'
const AGENT = '@a-bbbbbbbbbbbb:tayet.local'
const BOB = '@bob:tayet.local'
const ROOM_ID = '!room:tayet.local'
const CHANNEL = ROOM_ID as unknown as ChannelId
const ROOT_ID = '$root:tayet.local'
const TARGET_ID = '$target:tayet.local'
const TXN = 'txn-cmd'
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const command = { agent: uid(AGENT), name: 'deploy' }

const other = {
  getType: () => 'm.room.message',
  isRedacted: () => false,
  isDecryptionFailure: () => false,
  getContent: () => ({ msgtype: 'm.text', body: 'antes' }),
  getOriginalContent: () => ({ msgtype: 'm.text', body: 'antes' }),
  getId: () => TARGET_ID,
  getTxnId: () => undefined,
  getSender: () => BOB,
  getRoomId: () => ROOM_ID,
  getTs: () => 1000,
  replacingEventDate: () => undefined,
  getServerAggregatedRelation: () => undefined,
  getRelation: () => null,
  status: null,
}
const root = { ...other, getId: () => ROOT_ID }

type Call = [method: string, ...args: unknown[]]
type Handler = (...args: never[]) => void

function harness() {
  const room = {
    getCanonicalAlias: () => null,
    roomId: ROOM_ID,
    getMyMembership: () => 'join',
    findEventById: (id: string) => (id === TARGET_ID ? other : id === ROOT_ID ? root : undefined),
    getLiveTimeline: () => ({ getEvents: () => [root, other] }),
    getThread: (id: string) => (id === ROOT_ID ? { id: ROOT_ID } : undefined),
    createThread: () => undefined,
    relations: { getChildEventsForEvent: () => undefined },
    hasEncryptionStateEvent: () => false,
    getMember: () => null,
  }
  const calls: Call[] = []
  const handlers = new Map<string, Handler[]>()
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
      return { event_id: '$sent:tayet.local' }
    }
  const client = {
    getRooms: () => [room],
    getRoom: (id: string) => (id === ROOM_ID ? room : null),
    getCrypto: () => ({}),
    getUserId: () => ME,
    getAccountData: () => undefined,
    makeTxnId: () => TXN,
    fetchRelations: async () => ({ chunk: [] }),
    getEventMapper: () => (raw: never) => new MatrixEvent(raw),
    decryptEventIfNeeded: async () => {},
    sendMessage: vi.fn(record('sendMessage')),
    sendTextMessage: vi.fn(record('sendTextMessage')),
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    off: () => {},
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  const g = gateway as unknown as { client: unknown; live: boolean; wireEvents(c: unknown): void }
  g.client = client
  g.wireEvents(client)
  g.live = true
  const events: DomainEvent[] = []
  gateway.subscribe((e) => events.push(e))
  const timeline = (ev: unknown): void => {
    for (const h of handlers.get(RoomEvent.Timeline as string) ?? []) (h as (...a: unknown[]) => void)(ev, room, false, false, { liveEvent: true })
  }
  return { gateway, calls, events, timeline, client }
}

const wire = (v: unknown): string => JSON.stringify(v)

describe('SendOpts.command — the content sent', () => {
  it('no relation: sendMessage (never the plain path) with the marker and the agent in the mentions', async () => {
    const h = harness()
    await h.gateway.sendMessage(CHANNEL, { kind: 'text', text: '/deploy prod' }, { command })
    expect(h.calls).toHaveLength(1)
    const [method, roomId, content, txn] = h.calls[0]!
    expect([method, roomId, txn]).toEqual(['sendMessage', ROOM_ID, TXN])
    expect(wire(content)).toBe(wire({ msgtype: 'm.text', body: '/deploy prod', [COMMAND_MARKER]: { name: 'deploy', to: AGENT }, 'm.mentions': { user_ids: [AGENT] } }))
  })

  it('thread: the relation last, the agent after the caller’s mentions, threadId passed', async () => {
    const h = harness()
    await h.gateway.sendMessage(CHANNEL, { kind: 'text', text: '/deploy' }, { command, thread: mid(ROOT_ID), mentions: [uid(BOB)] })
    const [method, roomId, threadId, content] = h.calls[0]!
    expect([method, roomId, threadId]).toEqual(['sendMessage', ROOM_ID, ROOT_ID])
    expect(wire(content)).toBe(
      wire({
        msgtype: 'm.text',
        body: '/deploy',
        [COMMAND_MARKER]: { name: 'deploy', to: AGENT },
        'm.mentions': { user_ids: [BOB, AGENT] },
        'm.relates_to': { rel_type: 'm.thread', event_id: ROOT_ID },
      }),
    )
  })

  it('reply: the agent already mentioned is not repeated; the reply envelope last', async () => {
    const h = harness()
    await h.gateway.sendMessage(CHANNEL, { kind: 'text', text: '/deploy x' }, { command, replyTo: mid(TARGET_ID), mentions: [uid(AGENT)] })
    const [, , content] = h.calls[0]!
    expect(wire(content)).toBe(
      wire({
        msgtype: 'm.text',
        body: '/deploy x',
        [COMMAND_MARKER]: { name: 'deploy', to: AGENT },
        'm.mentions': { user_ids: [AGENT] },
        'm.relates_to': { 'm.in_reply_to': { event_id: TARGET_ID } },
      }),
    )
  })
})

describe('SendOpts.command — refused before any effect', () => {
  const cases: Array<[string, Parameters<MatrixGateway['sendMessage']>[1], NonNullable<Parameters<MatrixGateway['sendMessage']>[2]>['command'], string]> = [
    ['a name outside the rule', { kind: 'text', text: '/Deploy' }, { agent: uid(AGENT), name: 'Deploy' }, 'invalid command name'],
    ['a name with the slash', { kind: 'text', text: '//deploy' }, { agent: uid(AGENT), name: '/deploy' }, 'invalid command name'],
    ['a text that does not start with /name', { kind: 'text', text: 'deploy prod' }, command, 'command text must start with /name'],
    ['/name glued to more text', { kind: 'text', text: '/deployprod' }, command, 'command text must start with /name'],
    ['a target that is not an agent', { kind: 'text', text: '/deploy' }, { agent: uid(BOB), name: 'deploy' }, 'command target is not an agent'],
    ['an attachment', { kind: 'attachment', file: new Blob(['x']) }, command, 'a command is sent as text only'],
  ]
  for (const [label, body, cmd, message] of cases) {
    it(label, async () => {
      const h = harness()
      await expect(h.gateway.sendMessage(CHANNEL, body, { command: cmd })).rejects.toThrow(message)
      expect(h.calls).toEqual([])
      expect(h.events.filter((e) => e.t === 'message.received')).toEqual([])
    })
  }
})

describe('SendOpts.command — the optimistic echo', () => {
  it('the pending echo already carries Message.command and the mention', async () => {
    const h = harness()
    await h.gateway.sendMessage(CHANNEL, { kind: 'text', text: '/deploy prod' }, { command })
    const content = h.calls[0]![2] as Record<string, unknown>
    // The SDK's local echo of that send: the same content, our txn, still pending.
    const echo = new MatrixEvent({ type: 'm.room.message', room_id: ROOM_ID, sender: ME, event_id: `~${TXN}`, origin_server_ts: 5000, content })
    echo.setTxnId(TXN)
    echo.setStatus(EventStatus.SENDING)
    h.timeline(echo)
    const received = h.events.flatMap((e) => (e.t === 'message.received' ? [e.message] : []))
    expect(received).toHaveLength(1)
    expect(received[0]!.status).toBe('pending')
    expect(received[0]!.command).toEqual({ agent: AGENT, name: 'deploy' })
    expect(received[0]!.mentions).toEqual([AGENT])
  })
})
