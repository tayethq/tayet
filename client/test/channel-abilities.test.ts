import { describe, expect, it } from 'vitest'
import { EventType, MatrixEvent, Room } from 'matrix-js-sdk'
import { brandChannelId } from '@tayet/shared/internal'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry, ChannelAbilities } from '../src/acl'

// ADR-115 (Proposto): getChannelAbilities, one yes or no per verb of the management screen, read off the
// room state the SDK holds. The rooms are the SDK's own Room and RoomState, fed the state the server
// writes at creation (Synapse's presets: name, topic and the archive flag at 50 through state_default,
// power levels at 100, kick at 50, invite at 0 in a private channel and 50 in a public one), so the
// answers come from the SDK's real checks and not from a fake of them.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const DOMAIN = 'tayet.local'
const ME = `@u-operadorxyz2:${DOMAIN}`
const CREATOR = `@u-criadoraxyz2:${DOMAIN}`

const NONE: ChannelAbilities = {
  rename: false,
  editTopic: false,
  addPeople: false,
  removePeople: false,
  setRoles: false,
  archive: false,
}

let seq = 0
const state = (roomId: string, type: string, content: Record<string, unknown>, stateKey = '', sender = CREATOR) =>
  new MatrixEvent({
    type,
    state_key: stateKey,
    content,
    sender,
    room_id: roomId,
    event_id: `$e${++seq}`,
    origin_server_ts: seq,
  })

interface RoomSpec {
  roomId: string
  kind: 'public' | 'private'
  myLevel: number
  myMembership?: 'join' | 'invite' | 'leave'
  marker?: 'group' | 'channel'
}

function makeRoom(client: unknown, spec: RoomSpec): Room {
  const room = new Room(spec.roomId, client as never, ME)
  const users: Record<string, number> = { [CREATOR]: 100 }
  if (spec.myLevel > 0) users[ME] = spec.myLevel
  const events = [
    state(spec.roomId, EventType.RoomCreate, { creator: CREATOR, room_version: '10' }),
    state(spec.roomId, EventType.RoomMember, { membership: 'join' }, CREATOR, CREATOR),
    state(spec.roomId, EventType.RoomMember, { membership: spec.myMembership ?? 'join' }, ME, ME),
    state(spec.roomId, EventType.RoomJoinRules, { join_rule: spec.kind === 'public' ? 'public' : 'invite' }),
    state(spec.roomId, EventType.RoomPowerLevels, {
      users,
      users_default: 0,
      events: {
        'm.room.name': 50,
        'm.room.power_levels': 100,
        'm.room.history_visibility': 100,
        'm.room.canonical_alias': 50,
        'm.room.avatar': 50,
        'm.room.tombstone': 100,
        'm.room.server_acl': 100,
        'm.room.encryption': 100,
      },
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: spec.kind === 'public' ? 50 : 0,
    }),
  ]
  if (spec.marker) events.push(state(spec.roomId, 'io.tayet.conversation', { kind: spec.marker }))
  room.currentState.setStateEvents(events)
  room.updateMyMembership(spec.myMembership ?? 'join')
  return room
}

function harness(specs: RoomSpec[], direct: Record<string, string[]> = {}) {
  const rooms: Room[] = []
  const client = {
    getUserId: () => ME,
    getRooms: () => rooms,
    getRoom: (id: string) => rooms.find((r) => r.roomId === id) ?? null,
    getAccountData: (type: string) =>
      type === EventType.Direct ? new MatrixEvent({ type, content: direct }) : undefined,
    getDomain: () => DOMAIN,
    isGuest: () => false,
    supportsThreads: () => false,
    getEventMapper: () => (raw: Record<string, unknown>) => new MatrixEvent(raw),
  }
  for (const spec of specs) rooms.push(makeRoom(client, spec))
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = client
  return { gateway, abilities: (roomId: string) => gateway.getChannelAbilities(brandChannelId(roomId)) }
}

describe('ADR-115 dec. 1 — getChannelAbilities', () => {
  it('the creator (level 100) may do all six', () => {
    const { abilities } = harness([{ roomId: `!c:${DOMAIN}`, kind: 'private', myLevel: 100 }])
    expect(abilities(`!c:${DOMAIN}`)).toEqual({
      rename: true,
      editTopic: true,
      addPeople: true,
      removePeople: true,
      setRoles: true,
      archive: true,
    })
  })

  it('a promoted admin (level 50) does everything but change roles (ADR-026 addendum)', () => {
    const { abilities } = harness([{ roomId: `!c:${DOMAIN}`, kind: 'public', myLevel: 50 }])
    expect(abilities(`!c:${DOMAIN}`)).toEqual({
      rename: true,
      editTopic: true,
      addPeople: true,
      removePeople: true,
      setRoles: false,
      archive: true,
    })
  })

  it('an ordinary member of a public channel may do nothing', () => {
    const { abilities } = harness([{ roomId: `!c:${DOMAIN}`, kind: 'public', myLevel: 0 }])
    expect(abilities(`!c:${DOMAIN}`)).toEqual(NONE)
  })

  it('an ordinary member of a private channel may add people, and only that', () => {
    const { abilities } = harness([{ roomId: `!c:${DOMAIN}`, kind: 'private', myLevel: 0 }])
    expect(abilities(`!c:${DOMAIN}`)).toEqual({ ...NONE, addPeople: true })
  })

  it('a guest who created the channel manages it: the answer is the level, not the kind (ADR-083 dec. 4 is the label)', () => {
    // A guest is read off #all; without #all in the store the session reads as a guest (ADR-083 dec. 3).
    const { gateway, abilities } = harness([{ roomId: `!c:${DOMAIN}`, kind: 'private', myLevel: 100 }])
    expect((gateway as unknown as { kindOf: (mxid: string) => string }).kindOf(ME)).toBe('guest')
    expect(abilities(`!c:${DOMAIN}`)).toEqual({
      rename: true,
      editTopic: true,
      addPeople: true,
      removePeople: true,
      setRoles: true,
      archive: true,
    })
  })

  it('a group conversation answers nothing, even to its creator (ADR-094 dec. 13)', () => {
    const { abilities } = harness([{ roomId: `!g:${DOMAIN}`, kind: 'private', myLevel: 100, marker: 'group' }])
    expect(abilities(`!g:${DOMAIN}`)).toEqual(NONE)
  })

  it('a group turned into a channel answers again', () => {
    const { abilities } = harness([{ roomId: `!g:${DOMAIN}`, kind: 'private', myLevel: 100, marker: 'channel' }])
    expect(abilities(`!g:${DOMAIN}`).setRoles).toBe(true)
  })

  it('a direct conversation answers nothing', () => {
    const { abilities } = harness([{ roomId: `!d:${DOMAIN}`, kind: 'private', myLevel: 100 }], { [CREATOR]: [`!d:${DOMAIN}`] })
    expect(abilities(`!d:${DOMAIN}`)).toEqual(NONE)
  })

  it('a channel the session is not in answers nothing: unknown, invited or left', () => {
    const { abilities } = harness([
      { roomId: `!i:${DOMAIN}`, kind: 'private', myLevel: 100, myMembership: 'invite' },
      { roomId: `!l:${DOMAIN}`, kind: 'private', myLevel: 100, myMembership: 'leave' },
    ])
    expect(abilities(`!unknown:${DOMAIN}`)).toEqual(NONE)
    expect(abilities(`!i:${DOMAIN}`)).toEqual(NONE)
    expect(abilities(`!l:${DOMAIN}`)).toEqual(NONE)
  })

  it('answers nothing before connect, without throwing', () => {
    const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
    expect(gateway.getChannelAbilities(brandChannelId(`!c:${DOMAIN}`))).toEqual(NONE)
  })
})
