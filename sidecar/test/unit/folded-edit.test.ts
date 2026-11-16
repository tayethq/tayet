import { describe, it, expect, vi } from 'vitest'
import { ClientEvent, MatrixEvent, RoomEvent, type IEvent } from 'matrix-js-sdk'
import {
  buildCommandsContent,
  buildCommandsEditContent,
  buildPanelContent,
  buildPanelEditContent,
  COMMANDS_REL_TYPE,
  PANEL_REL_TYPE,
} from '@tayet/shared/internal'
import { createReadFacade, type ReadClient } from '../../src/core/read'
import type { ApiEvent } from '../../src/api/contract'

// PLANO-AGENTES §0.3.23 item 9 (closes §0.3.21 item 13): the edit of a folded message — a panel, a commands
// manifest — by the agent itself or by another agent never becomes `message.edited`. Covered: panel and
// manifest, own and another agent's, an edit that decrypts and one that does not, a target the room holds
// and one read from the server (whose relation type travels in clear). No stack: a fake client over real
// SDK events. A plain text edit by its author still applies (guard).

const ME = '@a-aaaaaaaaaaaa:tayet.local'
const OTHER = '@a-cccccccccccc:tayet.local'
const ALICE = '@alice:tayet.local'
const ROOM_ID = '!room:tayet.local'
const CREATE_ID = '$create:tayet.local'
const TARGET_ID = '$target:tayet.local'

type Kind = 'panel' | 'commands'
const REL: Record<Kind, string> = { panel: PANEL_REL_TYPE, commands: COMMANDS_REL_TYPE }

const originalContent = (kind: Kind): Record<string, unknown> =>
  kind === 'panel' ? buildPanelContent('Estado: ok', undefined, 'Deploy', CREATE_ID) : buildCommandsContent([{ name: 'deploy', description: 'Publica' }], CREATE_ID)
const editContent = (kind: Kind): Record<string, unknown> =>
  kind === 'panel'
    ? buildPanelEditContent({ text: 'Estado: falhou', title: 'Deploy' }, TARGET_ID)
    : buildCommandsEditContent({ commands: [{ name: 'status', description: 'Mostra o estado' }] }, TARGET_ID)

let n = 0
const nextId = (): string => `$e${(n += 1)}:tayet.local`
const encryptedWire = (relates: unknown): Record<string, unknown> => ({ algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'opaque', 'm.relates_to': relates })

// The target as the server returns it: encrypted, the relation to the creation event in clear.
const targetRaw = (kind: Kind, sender: string): Partial<IEvent> => ({
  event_id: TARGET_ID,
  room_id: ROOM_ID,
  sender,
  type: 'm.room.encrypted',
  origin_server_ts: 500,
  content: encryptedWire({ rel_type: REL[kind], event_id: CREATE_ID }),
})
// What the SDK does on a decryption (a private setter of MatrixEvent).
const decrypted = (ev: MatrixEvent, content: Record<string, unknown>): void =>
  (ev as unknown as { setClearData(r: unknown): void }).setClearData({ clearEvent: { type: 'm.room.message', content } })
// The target as the room holds it: decrypted.
const targetInRoom = (kind: Kind, sender: string): MatrixEvent => {
  const ev = new MatrixEvent(targetRaw(kind, sender))
  decrypted(ev, originalContent(kind))
  return ev
}

// The edit as it arrives live: encrypted (the replace relation in clear), decrypted or settled as a failure.
function liveEdit(kind: Kind, sender: string, decrypts: boolean): MatrixEvent {
  const content = editContent(kind)
  const ev = new MatrixEvent({
    event_id: nextId(),
    room_id: ROOM_ID,
    sender,
    type: 'm.room.encrypted',
    origin_server_ts: 2000 + n,
    content: encryptedWire(content['m.relates_to']),
  })
  if (decrypts) {
    decrypted(ev, content)
  } else {
    const failing = ev as unknown as { setClearDataForDecryptionFailure(reason: string): void; _decryptionFailureReason: string | null }
    failing.setClearDataForDecryptionFailure('no key')
    failing._decryptionFailureReason = 'UNKNOWN_ERROR'
  }
  return ev
}

type Handler = (...args: unknown[]) => void

function harness(target: { kind: Kind; sender: string } | 'text', holds: boolean) {
  const inRoom = target === 'text' ? new MatrixEvent({ event_id: TARGET_ID, room_id: ROOM_ID, sender: ALICE, type: 'm.room.message', origin_server_ts: 500, content: { msgtype: 'm.text', body: 'original' } }) : targetInRoom(target.kind, target.sender)
  const fetched: Partial<IEvent> = target === 'text' ? (inRoom.event) : targetRaw(target.kind, target.sender)
  const room = {
    roomId: ROOM_ID,
    getMyMembership: () => 'join',
    getMembers: () => [],
    getMember: () => null,
    findEventById: (id: string) => (holds && id === TARGET_ID ? inRoom : undefined),
    getThread: () => null,
    getLiveTimeline: () => ({ getEvents: () => [], getPaginationToken: () => 'older' }),
    relations: { getChildEventsForEvent: () => undefined },
    currentState: { getStateEvents: () => null },
  }
  const handlers = new Map<string, Handler[]>()
  const client = {
    getUserId: () => ME,
    getRooms: () => [room],
    getRoom: () => room,
    getAccountData: () => undefined,
    getProfileInfo: () => Promise.resolve({}),
    decryptEventIfNeeded: async () => {},
    createMessagesRequest: () => Promise.resolve({ chunk: [], end: undefined }),
    relations: () => Promise.resolve({ events: [], nextBatch: null }),
    fetchRoomEvent: vi.fn(async (_roomId: string, id: string) => (id === TARGET_ID ? fetched : Promise.reject(new Error('M_NOT_FOUND')))),
    timestampToEvent: () => Promise.resolve({ event_id: TARGET_ID, origin_server_ts: 500 }),
    http: { authedRequest: () => Promise.resolve({}) },
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    off: () => {},
  } as unknown as ReadClient
  const logs: Record<string, unknown>[] = []
  const facade = createReadFacade(client, (line) => logs.push(line))
  const fire = (name: string, ...args: unknown[]): void => {
    for (const h of handlers.get(name) ?? []) h(...args)
  }
  fire(ClientEvent.Sync, 'PREPARED')
  const events: ApiEvent[] = []
  facade.subscribe((e) => events.push(e))
  const timeline = (ev: MatrixEvent): void => fire(RoomEvent.Timeline, ev, room, false, false, { liveEvent: true })
  return { events, logs, timeline }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('sidecar live edit — a folded message’s edit is never message.edited', () => {
  const cases: [Kind, string, boolean, boolean, string][] = []
  for (const kind of ['panel', 'commands'] as const)
    for (const [who, sender] of [['own', ME], ['another agent’s', OTHER]] as const)
      for (const decrypts of [true, false])
        for (const holds of [true, false]) cases.push([kind, who, decrypts, holds, sender])

  it.each(cases)('%s, %s, decrypts=%s, target in the room=%s', async (kind, _who, decrypts, holds, sender) => {
    const { events, timeline } = harness({ kind, sender }, holds)
    timeline(liveEdit(kind, sender, decrypts))
    await settle()
    expect(events).toEqual([])
  })

  it('a text edit by its author still applies (guard)', async () => {
    for (const holds of [true, false]) {
      const { events, timeline } = harness('text', holds)
      timeline(
        new MatrixEvent({
          event_id: nextId(),
          room_id: ROOM_ID,
          sender: ALICE,
          type: 'm.room.message',
          origin_server_ts: 3000,
          content: { msgtype: 'm.text', body: '* fixed', 'm.new_content': { msgtype: 'm.text', body: 'fixed' }, 'm.relates_to': { rel_type: 'm.replace', event_id: TARGET_ID } },
        }),
      )
      await settle()
      expect(events.map((e) => e.type)).toEqual(['message.edited'])
    }
  })
})
