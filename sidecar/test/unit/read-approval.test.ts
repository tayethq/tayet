import { describe, it, expect, vi } from 'vitest'
import { ClientEvent, MatrixEvent, RoomEvent, type IEvent } from 'matrix-js-sdk'
import { createReadSide, type ReadClient } from '../../src/core/read'
import { conversationToken, personToken } from '../../src/api/ids'
import type { ApiEvent } from '../../src/api/contract'

// ADR-091 (A3-3): the read side's projection of an approval card — the request in `text`/`rich`, the
// options always; the state and the answer only on the agent's own card (through the bound view). An
// answer never becomes a line. `announce` reaches the listeners, held until the first one subscribes.
// No stack: a fake client over real SDK events.

const ME = '@a-aaaaaaaaaaaa:tayet.local'
const OTHER = '@a-bbbbbbbbbbbb:tayet.local'
const ALICE = '@alice:tayet.local'
const ROOM_ID = '!room:tayet.local'
const CONVERSATION = conversationToken(ROOM_ID, false)
const OPTIONS = [{ id: 'verify', label: 'Verificar', style: 'primary' }, { id: 'no', label: 'Não' }]

let n = 0
const card = (sender: string): Partial<IEvent> => {
  n += 1
  return {
    event_id: `$card${n}:tayet.local`,
    room_id: ROOM_ID,
    sender,
    type: 'm.room.message',
    origin_server_ts: 1000 + n,
    content: { msgtype: 'io.tayet.approval', body: 'Publicar?', format: 'org.matrix.custom.html', formatted_body: '<p><strong>Publicar?</strong></p>', 'io.tayet.approval': { options: OPTIONS } },
  }
}

function harness(chunk: Partial<IEvent>[] = []) {
  const room = {
    roomId: ROOM_ID,
    getMyMembership: () => 'join',
    getMembers: () => [],
    getMember: () => null,
    findEventById: () => undefined,
    getThread: () => null,
    getLiveTimeline: () => ({ getEvents: () => [], getPaginationToken: () => 'older' }),
    relations: { getChildEventsForEvent: () => undefined },
    currentState: { getStateEvents: () => null },
  }
  const handlers = new Map<string, Array<(...a: unknown[]) => void>>()
  const client = {
    getUserId: () => ME,
    getRooms: () => [room],
    getRoom: () => room,
    getAccountData: () => undefined,
    getProfileInfo: () => Promise.resolve({}),
    decryptEventIfNeeded: async () => {},
    createMessagesRequest: () => Promise.resolve({ chunk, end: undefined }),
    relations: () => Promise.resolve({ events: [], nextBatch: null }),
    fetchRoomEvent: () => Promise.reject(new Error('M_NOT_FOUND')),
    timestampToEvent: () => Promise.reject(new Error('M_NOT_FOUND')),
    http: { authedRequest: () => Promise.resolve({}) },
    on: (name: string, h: (...a: unknown[]) => void) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    off: () => {},
  } as unknown as ReadClient
  const side = createReadSide(client, () => {})
  const view = vi.fn((_room: string, _event: string, options: readonly { id: string; label: string }[], own: boolean) =>
    Promise.resolve(own ? { options: [...options], state: 'answered' as const, answer: { option: 'verify', by: personToken(ALICE), at: 7 } } : { options: [...options] }),
  )
  side.bindApprovals(view)
  const fire = (name: string, ...args: unknown[]): void => {
    for (const h of handlers.get(name) ?? []) h(...args)
  }
  fire(ClientEvent.Sync, 'PREPARED')
  const timeline = (ev: MatrixEvent): void => fire(RoomEvent.Timeline, ev, room, false, false, { liveEvent: true })
  return { side, view, timeline }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('read side — approval cards (A3-3)', () => {
  it('another agent’s card: the request in text/rich and the options, no state; the view is asked with own=false', async () => {
    const { side, view, timeline } = harness()
    const events: ApiEvent[] = []
    side.facade.subscribe((e) => events.push(e))
    timeline(new MatrixEvent(card(OTHER)))
    await settle()
    expect(events).toHaveLength(1)
    const e = events[0]
    if (e?.type !== 'message.received') throw new Error('expected message.received')
    expect(e.message.text).toBe('Publicar?')
    expect(e.message.rich).toEqual([{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'Publicar?' }] }] }])
    expect(e.message.approval).toEqual({ options: OPTIONS })
    expect(view.mock.calls[0]?.[3]).toBe(false)
  })

  it('the agent’s own card in a listing carries the state and the answer (person as a token)', async () => {
    const { side } = harness([card(ME)])
    const page = await side.facade.messages(CONVERSATION, {})
    expect(page.messages[0]?.approval).toEqual({ options: OPTIONS, state: 'answered', answer: { option: 'verify', by: personToken(ALICE), at: 7 } })
    expect(JSON.stringify(page)).not.toMatch(/@alice|\$card/)
  })

  it('an answer to a card is no line, read or not', async () => {
    const { side, timeline } = harness()
    const events: ApiEvent[] = []
    side.facade.subscribe((e) => events.push(e))
    timeline(
      new MatrixEvent({
        event_id: '$ans:tayet.local',
        room_id: ROOM_ID,
        sender: ALICE,
        type: 'm.room.message',
        origin_server_ts: 5000,
        content: { msgtype: 'io.tayet.approval.response', body: 'Verificar', 'io.tayet.approval.response': { option: 'verify' }, 'm.relates_to': { rel_type: 'io.tayet.response', event_id: '$card1:tayet.local' } },
      }),
    )
    await settle()
    expect(events).toEqual([])
  })

  it('announce: held until the first listener, then delivered in order; later ones go straight through', () => {
    const { side } = harness()
    const a: ApiEvent = { type: 'approval.answered', conversation: CONVERSATION, id: '1.000001', option: 'verify', by: 'UAAAAAAAAAA', at: 1 }
    const b: ApiEvent = { ...a, id: '1.000002' }
    side.announce(a)
    side.announce(b)
    const seen: ApiEvent[] = []
    side.facade.subscribe((e) => seen.push(e))
    side.announce({ ...a, id: '1.000003' })
    expect(seen.map((e) => (e.type === 'approval.answered' ? e.id : ''))).toEqual(['1.000001', '1.000002', '1.000003'])
  })
})
