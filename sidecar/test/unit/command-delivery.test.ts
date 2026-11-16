import { describe, it, expect, vi } from 'vitest'
import { ClientEvent, MatrixEvent, MatrixEventEvent, RoomEvent, type IEvent } from 'matrix-js-sdk'
import { buildTextContent } from '@tayet/shared/internal'
import type { UserId } from '@tayet/shared'
import { createReadSide, type ReadClient } from '../../src/core/read'
import { conversationToken } from '../../src/api/ids'
import type { ApiEvent, ApiMessage } from '../../src/api/contract'

// PLANO-AGENTES §0.3.23 items 1–6 (ADR-093, A4-2b): the command a message carries for THIS agent, live
// (`message.received`, `mention`, the late decryption) and in the history. No stack: a fake client over real
// SDK events; the declared set is the read side's port (`bindCommands`).

const ME = '@a-aaaaaaaaaaaa:tayet.local'
const OTHER = '@a-cccccccccccc:tayet.local'
const ALICE = '@alice:tayet.local'
const BOB = '@bob:tayet.local'
const ROOM_ID = '!room:tayet.local'
const CONVERSATION = conversationToken(ROOM_ID, false)
const uid = (s: string): UserId => s as unknown as UserId

let n = 0
const raw = (sender: string, content: Record<string, unknown>, extra: Partial<IEvent> = {}): Partial<IEvent> => {
  n += 1
  return { event_id: `$c${n}:tayet.local`, room_id: ROOM_ID, sender, type: 'm.room.message', origin_server_ts: 1000 + n, content, ...extra }
}
// A person's command, as the client sends it (ADR-093 dec. 7).
const commandContent = (text: string, name: string, agent = ME, mentions?: string[]): Record<string, unknown> =>
  buildTextContent(text, undefined, mentions?.map(uid), undefined, { name, agent: uid(agent) })

type Handler = (...args: unknown[]) => void

function harness(opts: { declared?: string[] | 'unbound'; chunk?: Partial<IEvent>[]; held?: MatrixEvent[] } = {}) {
  const held = opts.held ?? []
  const room = {
    roomId: ROOM_ID,
    getMyMembership: () => 'join',
    getMembers: () => [],
    getMember: () => null,
    findEventById: (id: string) => held.find((e) => e.getId() === id),
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
    createMessagesRequest: () => Promise.resolve({ chunk: opts.chunk ?? [], end: undefined }),
    relations: () => Promise.resolve({ events: [], nextBatch: null }),
    fetchRoomEvent: vi.fn(async () => Promise.reject(new Error('M_NOT_FOUND'))),
    timestampToEvent: () => Promise.reject(new Error('M_NOT_FOUND')),
    http: { authedRequest: () => Promise.resolve({}) },
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    off: () => {},
  } as unknown as ReadClient
  const logs: Record<string, unknown>[] = []
  const side = createReadSide(client, (line) => logs.push(line))
  const declared = opts.declared ?? ['deploy', 'status']
  if (declared !== 'unbound') side.bindCommands((name) => declared.includes(name))
  const fire = (name: string, ...args: unknown[]): void => {
    for (const h of handlers.get(name) ?? []) h(...args)
  }
  fire(ClientEvent.Sync, 'PREPARED')
  const events: ApiEvent[] = []
  side.facade.subscribe((e) => events.push(e))
  const timeline = (ev: MatrixEvent): void => fire(RoomEvent.Timeline, ev, room, false, false, { liveEvent: true })
  return { side, events, logs, timeline }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}
const kinds = (events: ApiEvent[]): string[] => events.map((e) => e.type)
const messagesOf = (events: ApiEvent[]): ApiMessage[] => events.flatMap((e) => ('message' in e ? [e.message] : []))
const commandLines = (logs: Record<string, unknown>[]) => logs.filter((l) => l.evt === 'command-unknown')

async function live(content: Record<string, unknown>, sender = ALICE, opts: Parameters<typeof harness>[0] = {}) {
  const h = harness(opts)
  h.timeline(new MatrixEvent(raw(sender, content)))
  await settle()
  return h
}

describe('command delivery — live', () => {
  it('a person’s declared command for this agent: message.received and mention carry { name, args }', async () => {
    const { events, logs } = await live(commandContent('/deploy produção', 'deploy'))
    expect(kinds(events)).toEqual(['message.received', 'mention'])
    for (const m of messagesOf(events)) {
      expect(m.command).toEqual({ name: 'deploy', args: 'produção' })
      expect(m.text).toBe('/deploy produção')
    }
    expect(commandLines(logs)).toEqual([])
  })

  it('args: empty with no argument; leading whitespace removed, the rest kept (spaces, line breaks)', async () => {
    const args = async (text: string) => messagesOf((await live(commandContent(text, 'deploy'))).events)[0]?.command?.args
    expect(await args('/deploy')).toBe('')
    expect(await args('/deploy    a  b  ')).toBe('a  b  ')
    expect(await args('/deploy\nlinha 1\nlinha 2')).toBe('linha 1\nlinha 2')
    expect(await args('/deploy \t ')).toBe('')
  })

  it('another agent’s command: a plain mention when this agent is mentioned too, nothing at all otherwise', async () => {
    const both = await live(commandContent('/deploy x', 'deploy', OTHER, [ME]))
    expect(kinds(both.events)).toEqual(['message.received', 'mention'])
    expect(messagesOf(both.events).every((m) => m.command === undefined)).toBe(true)
    const only = await live(commandContent('/deploy x', 'deploy', OTHER))
    expect(kinds(only.events)).toEqual(['message.received'])
    expect(messagesOf(only.events)[0]?.command).toBeUndefined()
    // Neither logs command-unknown: the command is not this agent's.
    expect(commandLines([...both.logs, ...only.logs])).toEqual([])
  })

  it('a name outside the declared set: a plain mention and one command-unknown line, without the name', async () => {
    const { events, logs } = await live(commandContent('/rollback já', 'rollback'))
    expect(kinds(events)).toEqual(['message.received', 'mention'])
    expect(messagesOf(events).every((m) => m.command === undefined)).toBe(true)
    expect(commandLines(logs).length).toBeGreaterThan(0)
    for (const line of commandLines(logs)) expect(line).toEqual({ evt: 'command-unknown' })
    expect(JSON.stringify(logs)).not.toContain('rollback')
  })

  it('an empty set: never a command', async () => {
    const { events } = await live(commandContent('/deploy', 'deploy'), ALICE, { declared: [] })
    expect(kinds(events)).toEqual(['message.received', 'mention'])
    expect(messagesOf(events).every((m) => m.command === undefined)).toBe(true)
  })

  it('no commands core bound: never a command, and no log line', async () => {
    const { events, logs } = await live(commandContent('/deploy', 'deploy'), ALICE, { declared: 'unbound' })
    expect(kinds(events)).toEqual(['message.received', 'mention'])
    expect(messagesOf(events).every((m) => m.command === undefined)).toBe(true)
    expect(commandLines(logs)).toEqual([])
  })

  it('this agent outside the mentions (a forged marker): no command', async () => {
    const content = { ...commandContent('/deploy', 'deploy'), 'm.mentions': { user_ids: [BOB] } }
    const { events } = await live(content)
    expect(kinds(events)).toEqual(['message.received'])
    expect(messagesOf(events)[0]?.command).toBeUndefined()
  })

  it('an agent author: a plain mention, never a command', async () => {
    const { events, logs } = await live(commandContent('/deploy', 'deploy'), OTHER)
    expect(kinds(events)).toEqual(['message.received', 'mention'])
    expect(messagesOf(events).every((m) => m.command === undefined)).toBe(true)
    expect(commandLines(logs)).toEqual([])
  })

  it('an edit of a command (keeping the prefix): message.edited without command', async () => {
    const original = new MatrixEvent(raw(ALICE, commandContent('/deploy prod', 'deploy')))
    const { events, timeline } = harness({ held: [original] })
    timeline(
      new MatrixEvent(
        raw(ALICE, {
          msgtype: 'm.text',
          body: '* /deploy staging',
          'm.new_content': { msgtype: 'm.text', body: '/deploy staging', 'm.mentions': { user_ids: [ME] } },
          'm.mentions': {},
          'm.relates_to': { rel_type: 'm.replace', event_id: original.getId() },
        }),
      ),
    )
    await settle()
    expect(kinds(events)).toEqual(['message.edited'])
    expect(messagesOf(events)[0]?.text).toBe('/deploy staging')
    expect(messagesOf(events)[0]?.command).toBeUndefined()
  })

  it('the late decryption: the readable version carries the command, on message.edited and mention', async () => {
    const { events, timeline } = harness()
    const ev = new MatrixEvent({ ...raw(ALICE, { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'opaque' }), type: 'm.room.encrypted' })
    const internals = ev as unknown as {
      setClearDataForDecryptionFailure(reason: string): void
      setClearData(r: unknown): void
      _decryptionFailureReason: string | null
    }
    internals.setClearDataForDecryptionFailure('no key')
    internals._decryptionFailureReason = 'UNKNOWN_ERROR'
    timeline(ev)
    await settle()
    expect(kinds(events)).toEqual(['message.received'])
    expect(messagesOf(events)[0]?.unavailable).toBe(true)

    internals.setClearData({ clearEvent: { type: 'm.room.message', content: commandContent('/status agora', 'status') } })
    internals._decryptionFailureReason = null
    ev.emit(MatrixEventEvent.Decrypted, ev)
    await settle()
    expect(kinds(events)).toEqual(['message.received', 'message.edited', 'mention'])
    for (const m of messagesOf(events).slice(1)) expect(m.command).toEqual({ name: 'status', args: 'agora' })
  })
})

describe('command delivery — history', () => {
  it('a listing carries the command of a message the agent did not see live; an edited one does not', async () => {
    const plain = raw(ALICE, commandContent('/deploy prod', 'deploy'))
    const edited = raw(ALICE, commandContent('/status', 'status'))
    edited.unsigned = {
      'm.relations': {
        'm.replace': raw(ALICE, {
          msgtype: 'm.text',
          body: '* /status já',
          'm.new_content': { msgtype: 'm.text', body: '/status já' },
          'm.relates_to': { rel_type: 'm.replace', event_id: edited.event_id },
        }),
      },
    }
    const unknown = raw(ALICE, commandContent('/rollback', 'rollback'))
    const { side, logs } = harness({ chunk: [unknown, edited, plain] })
    const page = await side.facade.messages(CONVERSATION, {})
    expect(page.messages.map((m) => [m.text, m.command])).toEqual([
      ['/rollback', undefined],
      ['/status já', undefined],
      ['/deploy prod', { name: 'deploy', args: 'prod' }],
    ])
    expect(commandLines(logs)).toEqual([{ evt: 'command-unknown' }])
  })
})
