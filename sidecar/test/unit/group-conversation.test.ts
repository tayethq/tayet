import { describe, it, expect, afterEach } from 'vitest'
import { createReadFacade, type ReadClient } from '../../src/core/read'
import { conversationToken } from '../../src/api/ids'
import { slackEventsOf } from '../../src/api/slack/events'
import { slackConversation } from '../../src/api/slack/translate'
import { ALICE, BOB, BOT, GROUP, ME, call, createWorld, idLeaks, message, refusal, startSlack, type SlackHarness } from '../support/slack-world'

// ADR-094 (Proposto) dec. 12 — PR-1 (PLANO-CONVERSAS §8.1): a group conversation in the sidecar. The native
// read gives `kind: 'group'`, the name without '#', and a token with the channel prefix that stays the same
// when the marker turns into a channel; the Slack layer gives `mpim` (list filter, `is_mpim`, `channel_type`)
// and `conversations.open` with two or more people stays refused. No stack.

const AGENT = '@a-aaaaaaaaaaaa:tayet.local'
const ROOM_ID = '!group:tayet.local'
const MARKER = 'io.tayet.conversation'

interface FakeMember {
  userId: string
  rawDisplayName: string
  membership: string
  getMxcAvatarUrl: () => undefined
}

function groupClient() {
  const member = (userId: string, rawDisplayName: string): FakeMember => ({ userId, rawDisplayName, membership: 'join', getMxcAvatarUrl: () => undefined })
  const members = [member(AGENT, 'Relatórios'), member('@bob:tayet.local', 'Bob'), member('@alice:tayet.local', 'Alice'), member('@cofre:tayet.local', 'cofre')]
  const state: Record<string, unknown> = { [MARKER]: { getContent: () => ({ kind: 'group' }) } }
  const room = {
    roomId: ROOM_ID,
    name: 'Alice and 2 others',
    myUserId: AGENT,
    getMyMembership: () => 'join',
    getJoinRule: () => 'invite',
    getCanonicalAlias: () => null,
    getMembers: () => members,
    getJoinedMembers: () => members,
    getMember: (id: string) => members.find((m) => m.userId === id) ?? null,
    getJoinedMemberCount: () => members.length,
    hasEncryptionStateEvent: () => true,
    currentState: { getStateEvents: (type: string, key: string) => (key === '' ? (state[type] ?? null) : null) },
  }
  const client = {
    getUserId: () => AGENT,
    getRooms: () => [room],
    getRoom: (id: string) => (id === ROOM_ID ? room : null),
    getAccountData: () => undefined,
    on: () => {},
    off: () => {},
  } as unknown as ReadClient
  const toChannel = (name: string): void => {
    state[MARKER] = { getContent: () => ({ kind: 'channel' }) }
    state['m.room.name'] = { getContent: () => ({ name }) }
  }
  return { client, toChannel }
}

describe('native read — a group conversation (ADR-094 dec. 4 and 12)', () => {
  it('kind group, name of the people without "#", a C… token equal before and after the marker turns channel', () => {
    const { client, toChannel } = groupClient()
    const read = createReadFacade(client, () => {})
    const token = conversationToken(ROOM_ID, false)
    expect(token).toMatch(/^C/)
    const list = read.conversations({})
    expect(list.conversations).toHaveLength(1)
    expect(list.conversations[0]).toMatchObject({ id: token, kind: 'group', name: 'Alice, Bob' })
    expect(idLeaks(list)).toEqual([])

    toChannel('projeto')
    const after = read.conversation(token)
    expect(after).toMatchObject({ id: token, kind: 'private', name: 'projeto' })
    expect(read.conversations({}).conversations.map((c) => c.id)).toEqual([token])
  })
})

describe('Slack layer — a group conversation is an mpim (ADR-094 dec. 12)', () => {
  let h: SlackHarness | undefined
  afterEach(async () => {
    await h?.close()
    h = undefined
  })

  it('slackConversation: is_mpim, not a channel, is_group stays false, private', () => {
    expect(slackConversation(GROUP)).toMatchObject({ id: GROUP.id, name: GROUP.name, is_mpim: true, is_channel: false, is_group: false, is_im: false, is_private: true })
  })

  it('conversations.list: types=mpim returns the group; the other types leave it out', async () => {
    h = await startSlack({ world: createWorld({ group: true }) })
    const mpim = await call(h.client(), 'conversations.list', { types: 'mpim' })
    expect(idLeaks(mpim)).toEqual([])
    expect(mpim.channels).toEqual([expect.objectContaining({ id: GROUP.id, is_mpim: true, is_channel: false, is_group: false, is_private: true, num_members: 3 })])
    const rest = await call(h.client(), 'conversations.list', { types: 'public_channel,private_channel,im' })
    expect((rest.channels as Array<{ id: string }>).map((c) => c.id)).not.toContain(GROUP.id)
    expect(await call(h.client(), 'conversations.info', { channel: GROUP.id })).toMatchObject({ channel: { id: GROUP.id, is_mpim: true } })
  })

  it('conversations.open with two or more people stays invalid_arguments', async () => {
    h = await startSlack({ world: createWorld({ group: true }) })
    expect(await refusal(h.client(), 'conversations.open', { users: `${ALICE.id},${BOB.id}` })).toBe('invalid_arguments')
  })

  it('a message in the group reaches the app with channel_type mpim', () => {
    const world = createWorld({ group: true })
    const view = { me: ME.id, text: (m: { text: string }) => m.text, reaction: (e: string) => e, base: null }
    const entry = { id: '1-1', at: 1_731_000_000_000, event: { type: 'message.received', conversation: GROUP.id, message: message({ id: '1731000000.000100', conversation: GROUP.id, text: 'oi' }) } }
    const [event] = slackEventsOf(entry as never, ME, BOT, view, world.read)
    expect(event).toMatchObject({ type: 'message', channel: GROUP.id, channel_type: 'mpim' })
  })
})
