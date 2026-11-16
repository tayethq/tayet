import { describe, it, expect } from 'vitest'
import { MatrixEvent } from 'matrix-js-sdk'
import {
  COMMANDS_BLOCK,
  COMMANDS_MANIFEST_MAX_BYTES,
  COMMANDS_MAX,
  COMMANDS_MSGTYPE,
  COMMANDS_REL_TYPE,
  COMMAND_DESCRIPTION_MAX,
  COMMAND_HINT_MAX,
  COMMAND_MARKER,
  PANEL_REL_TYPE,
  RESPONSE_REL_TYPE,
  buildCommandsContent,
  buildCommandsEditContent,
  buildTextContent,
  commandDescriptionOf,
  commandHintOf,
  commandNameOf,
  editToMessage,
  eventToMessage,
  foldedKind,
  readCommandMarker,
  readCommandsBlock,
  startsWithCommand,
  type Ctx,
} from '../src/internal'
import type { AclTelemetry, RichDoc, UserId } from '../src'

// ADR-093 (Proposto), A4-1 (PLANO-AGENTES §0.3.21 items 1–4, 7–8): the commands manifest's block read
// tolerant, the command marker, the builders of a manifest and of its edits (the clear included), the
// text send with a command in its three forms, the fold of the manifest, and Message.command.

const AGENT = '@a-bbbbbbbbbbbb:tayet.local'
const AGENT_ID = AGENT as unknown as UserId
const BOB = '@bob:tayet.local'
const BOB_ID = BOB as unknown as UserId
const ME = '@me:tayet.local'
const ROOM_ID = '!room:tayet.local'
const CREATE_ID = '$create:tayet.local'
const MANIFEST_ID = '$manifest:tayet.local'
const ROOT_ID = '$root:tayet.local'
const TARGET_ID = '$target:tayet.local'
const RICH: RichDoc = [{ t: 'p', children: [{ t: 'text', text: '/deploy prod' }] }]
const wire = (content: unknown): string => JSON.stringify(content)

const manifest = (block?: unknown): Record<string, unknown> => ({
  msgtype: COMMANDS_MSGTYPE,
  body: '/deploy — Publica',
  ...(block !== undefined && { [COMMANDS_BLOCK]: block }),
})
const cmd = (name: string, description = 'Faz algo', hint?: unknown): Record<string, unknown> => ({
  name,
  description,
  ...(hint !== undefined && { hint }),
})

describe('the limits', () => {
  it('name: lower ASCII, digits, _ and -, first char a letter or digit, 1 to 32, no slash', () => {
    for (const ok of ['a', 'deploy', 'run-tests', 'x_1', '9lives', 'a'.repeat(32)]) expect(commandNameOf(ok)).toBe(ok)
    for (const bad of ['', '/deploy', 'Deploy', '-x', '_x', 'a'.repeat(33), 'implantação', 'dep loy', ' deploy', 7, null]) {
      expect(commandNameOf(bad)).toBeUndefined()
    }
  })

  it('description: 1 to 100 code points after trim, one line', () => {
    expect(commandDescriptionOf('  Publica  ')).toBe('Publica')
    expect(commandDescriptionOf('é'.repeat(COMMAND_DESCRIPTION_MAX))).toBe('é'.repeat(COMMAND_DESCRIPTION_MAX))
    for (const bad of ['', '   ', 'x'.repeat(COMMAND_DESCRIPTION_MAX + 1), 'duas\nlinhas', 'sep arador', 3, undefined]) {
      expect(commandDescriptionOf(bad)).toBeUndefined()
    }
  })

  it('hint: absent or blank is empty, up to 60 code points, one line', () => {
    expect(commandHintOf(undefined)).toBe('')
    expect(commandHintOf('  ')).toBe('')
    expect(commandHintOf(' <ambiente> ')).toBe('<ambiente>')
    expect(commandHintOf('🙂'.repeat(COMMAND_HINT_MAX))).toBe('🙂'.repeat(COMMAND_HINT_MAX))
    for (const bad of ['x'.repeat(COMMAND_HINT_MAX + 1), 'a\rb', null, 5]) expect(commandHintOf(bad)).toBeUndefined()
  })

  it('25 commands and 8 KiB', () => {
    expect(COMMANDS_MAX).toBe(25)
    expect(COMMANDS_MANIFEST_MAX_BYTES).toBe(8192)
  })
})

describe('readCommandsBlock', () => {
  it('reads the commands in order, with the optional hint', () => {
    expect(readCommandsBlock(manifest({ commands: [cmd('deploy', 'Publica', '<ambiente>'), cmd('status', 'Mostra o estado')] }))).toEqual({
      commands: [
        { name: 'deploy', description: 'Publica', hint: '<ambiente>' },
        { name: 'status', description: 'Mostra o estado' },
      ],
      cleared: false,
    })
  })

  it('tolerant: an entry outside the rule is dropped, the rest stays', () => {
    const block = {
      commands: [cmd('/deploy'), cmd('ok'), cmd('Bad'), cmd('nodesc', ''), cmd('longhint', 'x', 'h'.repeat(61)), 'str', null, { name: 'nodesc2' }, cmd('fine', 'd', '')],
    }
    expect(readCommandsBlock(manifest(block))?.commands).toEqual([
      { name: 'ok', description: 'Faz algo' },
      { name: 'fine', description: 'd' },
    ])
  })

  it('a repeated name keeps the first', () => {
    expect(readCommandsBlock(manifest({ commands: [cmd('a', 'primeiro'), cmd('b'), cmd('a', 'segundo')] }))?.commands).toEqual([
      { name: 'a', description: 'primeiro' },
      { name: 'b', description: 'Faz algo' },
    ])
  })

  it('keeps the first 25 valid ones', () => {
    const commands = Array.from({ length: 30 }, (_, i) => cmd(`c${i}`))
    commands.splice(3, 0, cmd('INVALID'))
    const read = readCommandsBlock(manifest({ commands }))?.commands ?? []
    expect(read).toHaveLength(25)
    expect(read[0]?.name).toBe('c0')
    expect(read[24]?.name).toBe('c24')
  })

  it('the clear: no commands', () => {
    expect(readCommandsBlock(manifest({ cleared: true, commands: [cmd('a')] }))).toEqual({ commands: [], cleared: true })
    // Only `true` clears.
    expect(readCommandsBlock(manifest({ cleared: 1, commands: [cmd('a')] }))?.cleared).toBe(false)
  })

  it('no block, or commands that is not a list: a manifest with no commands', () => {
    expect(readCommandsBlock(manifest())).toEqual({ commands: [], cleared: false })
    expect(readCommandsBlock(manifest({ commands: 'deploy' }))).toEqual({ commands: [], cleared: false })
  })

  it('malformed: a block that is not an object, or content that is not a manifest → undefined', () => {
    for (const block of ['x', 7, null, [cmd('a')], true]) expect(readCommandsBlock(manifest(block))).toBeUndefined()
    expect(readCommandsBlock({ msgtype: 'm.text', body: 'x', [COMMANDS_BLOCK]: { commands: [cmd('a')] } })).toBeUndefined()
  })
})

describe('readCommandMarker and startsWithCommand', () => {
  it('the marker, raw', () => {
    expect(readCommandMarker({ [COMMAND_MARKER]: { name: 'deploy', to: AGENT } })).toEqual({ name: 'deploy', to: AGENT })
    for (const marker of [undefined, 'deploy', { name: 'Deploy', to: AGENT }, { name: 'deploy' }, { name: 'deploy', to: '' }, { to: AGENT }]) {
      expect(readCommandMarker({ [COMMAND_MARKER]: marker })).toBeUndefined()
    }
  })

  it('"/name" followed by the end or whitespace', () => {
    expect(startsWithCommand('/deploy', 'deploy')).toBe(true)
    expect(startsWithCommand('/deploy prod', 'deploy')).toBe(true)
    expect(startsWithCommand('/deploy\nprod', 'deploy')).toBe(true)
    expect(startsWithCommand('/deployx', 'deploy')).toBe(false)
    expect(startsWithCommand(' /deploy', 'deploy')).toBe(false)
    expect(startsWithCommand('deploy', 'deploy')).toBe(false)
  })
})

describe('buildCommandsContent / buildCommandsEditContent', () => {
  const commands = [
    { name: 'deploy', description: 'Publica', hint: '<ambiente>' },
    { name: 'status', description: 'Mostra o estado' },
  ]

  it('the manifest: its type, one fallback line per command, the block, the relation to the creation event last, no mentions', () => {
    expect(wire(buildCommandsContent(commands, CREATE_ID))).toBe(
      wire({
        msgtype: COMMANDS_MSGTYPE,
        body: '/deploy — Publica\n/status — Mostra o estado',
        [COMMANDS_BLOCK]: { commands: [{ name: 'deploy', description: 'Publica', hint: '<ambiente>' }, { name: 'status', description: 'Mostra o estado' }] },
        'm.relates_to': { rel_type: COMMANDS_REL_TYPE, event_id: CREATE_ID },
      }),
    )
  })

  it('the edit: starred fallback, the new content with the block, the replace relation last', () => {
    expect(wire(buildCommandsEditContent({ commands: [commands[1]!] }, MANIFEST_ID))).toBe(
      wire({
        msgtype: COMMANDS_MSGTYPE,
        body: '* /status — Mostra o estado',
        'm.new_content': { msgtype: COMMANDS_MSGTYPE, body: '/status — Mostra o estado', [COMMANDS_BLOCK]: { commands: [{ name: 'status', description: 'Mostra o estado' }] } },
        'm.relates_to': { rel_type: 'm.replace', event_id: MANIFEST_ID },
      }),
    )
  })

  it('the clear: the mark and an empty body', () => {
    expect(wire(buildCommandsEditContent({ cleared: true }, MANIFEST_ID))).toBe(
      wire({
        msgtype: COMMANDS_MSGTYPE,
        body: '* ',
        'm.new_content': { msgtype: COMMANDS_MSGTYPE, body: '', [COMMANDS_BLOCK]: { cleared: true } },
        'm.relates_to': { rel_type: 'm.replace', event_id: MANIFEST_ID },
      }),
    )
  })

  it('round-trips through the reader', () => {
    expect(readCommandsBlock(buildCommandsContent(commands, CREATE_ID))).toEqual({ commands, cleared: false })
    const edit = buildCommandsEditContent({ cleared: true }, MANIFEST_ID)
    expect(readCommandsBlock(edit['m.new_content'])).toEqual({ commands: [], cleared: true })
    expect(JSON.stringify(buildCommandsContent(commands, CREATE_ID))).not.toContain('m.mentions')
  })
})

describe('buildTextContent with a command', () => {
  const command = { name: 'deploy', agent: AGENT_ID }

  it('no relation: the marker, then the agent in the mentions', () => {
    expect(wire(buildTextContent('/deploy prod', undefined, undefined, undefined, command))).toBe(
      wire({ msgtype: 'm.text', body: '/deploy prod', [COMMAND_MARKER]: { name: 'deploy', to: AGENT }, 'm.mentions': { user_ids: [AGENT] } }),
    )
  })

  it('thread: the relation stays last; the agent is added after the existing mentions', () => {
    expect(wire(buildTextContent('/deploy', undefined, [BOB_ID], { thread: ROOT_ID }, command))).toBe(
      wire({
        msgtype: 'm.text',
        body: '/deploy',
        [COMMAND_MARKER]: { name: 'deploy', to: AGENT },
        'm.mentions': { user_ids: [BOB, AGENT] },
        'm.relates_to': { rel_type: 'm.thread', event_id: ROOT_ID },
      }),
    )
  })

  it('reply, rich: the agent already mentioned is not repeated; the relation stays last', () => {
    const content = buildTextContent('/deploy prod', RICH, [AGENT_ID], { replyTo: TARGET_ID }, command) as Record<string, unknown>
    expect(Object.keys(content)).toEqual(['msgtype', 'body', 'format', 'formatted_body', COMMAND_MARKER, 'm.mentions', 'm.relates_to'])
    expect(content['m.mentions']).toEqual({ user_ids: [AGENT] })
    expect(content['m.relates_to']).toEqual({ 'm.in_reply_to': { event_id: TARGET_ID } })
  })

  it('without a command the shape is unchanged', () => {
    expect(wire(buildTextContent('oi', undefined, [BOB_ID]))).toBe(wire({ msgtype: 'm.text', body: 'oi', 'm.mentions': { user_ids: [BOB] } }))
  })
})

const ev = (content: Record<string, unknown>, extra: Record<string, unknown> = {}): MatrixEvent =>
  new MatrixEvent({ event_id: '$ev', room_id: ROOM_ID, sender: ME, type: 'm.room.message', origin_server_ts: 1000, content, ...extra })

describe('foldedKind with the manifest', () => {
  it('the relation type in clear, then the type of the content or of the edit’s new content', () => {
    expect(foldedKind(ev(buildCommandsContent([], CREATE_ID)))).toBe('commands')
    expect(foldedKind(ev(buildCommandsEditContent({ cleared: true }, MANIFEST_ID)))).toBe('commands')
    expect(foldedKind(ev({ msgtype: COMMANDS_MSGTYPE, body: '' }))).toBe('commands')
    // The others are unchanged.
    expect(foldedKind(ev({ msgtype: 'x', body: '', 'm.relates_to': { rel_type: PANEL_REL_TYPE, event_id: CREATE_ID } }))).toBe('panel')
    expect(foldedKind(ev({ msgtype: 'x', body: '', 'm.relates_to': { rel_type: RESPONSE_REL_TYPE, event_id: '$c' } }))).toBe('response')
    expect(foldedKind(ev({ msgtype: 'm.text', body: '/deploy' }))).toBeUndefined()
  })

  it('a manifest is never a line', () => {
    expect(eventToMessage(ev(buildCommandsContent([{ name: 'a', description: 'b' }], CREATE_ID), { sender: AGENT }), ctx)).toBeNull()
  })
})

const telemetry: AclTelemetry = { untranslated: () => {} }
const ctx: Ctx = { mode: 'strict', telemetry, isDm: () => false, myUserId: ME }

describe('Message.command', () => {
  const sent = (text: string, mentions: UserId[] | undefined, command: { name: string; agent: UserId }, rel?: { thread: string }) =>
    ev(buildTextContent(text, undefined, mentions, rel, command) as Record<string, unknown>)

  it('closes: the marker names an agent, the agent is in the mentions, the text starts with "/name"', () => {
    const msg = eventToMessage(sent('/deploy prod', undefined, { name: 'deploy', agent: AGENT_ID }), ctx)
    expect(msg?.command).toEqual({ agent: AGENT, name: 'deploy' })
    expect(msg?.mentions).toEqual([AGENT])
  })

  it('in a thread too', () => {
    expect(eventToMessage(sent('/deploy', undefined, { name: 'deploy', agent: AGENT_ID }, { thread: ROOT_ID }), ctx)?.command).toEqual({ agent: AGENT, name: 'deploy' })
  })

  it('a marker whose agent is not in the mentions: no command', () => {
    const content = { msgtype: 'm.text', body: '/deploy', [COMMAND_MARKER]: { name: 'deploy', to: AGENT }, 'm.mentions': { user_ids: [BOB] } }
    const msg = eventToMessage(ev(content), ctx)
    expect(msg).not.toBeNull()
    expect(msg && 'command' in msg).toBe(false)
  })

  it('a marker naming someone who is not an agent: no command', () => {
    const content = { msgtype: 'm.text', body: '/deploy', [COMMAND_MARKER]: { name: 'deploy', to: BOB }, 'm.mentions': { user_ids: [BOB] } }
    expect(eventToMessage(ev(content), ctx)?.command).toBeUndefined()
  })

  it('text without the prefix: no command', () => {
    for (const body of ['deploy prod', '/deployx', 'oi /deploy']) {
      const content = { msgtype: 'm.text', body, [COMMAND_MARKER]: { name: 'deploy', to: AGENT }, 'm.mentions': { user_ids: [AGENT] } }
      expect(eventToMessage(ev(content), ctx)?.command).toBeUndefined()
    }
  })

  it('an edit that keeps the prefix keeps the command; one that takes it away loses it', () => {
    const original = sent('/deploy prod', undefined, { name: 'deploy', agent: AGENT_ID })
    const edit = (body: string): MatrixEvent =>
      new MatrixEvent({
        event_id: '$edit',
        room_id: ROOM_ID,
        sender: ME,
        type: 'm.room.message',
        origin_server_ts: 2000,
        content: {
          msgtype: 'm.text',
          body: `* ${body}`,
          'm.new_content': { msgtype: 'm.text', body },
          'm.relates_to': { rel_type: 'm.replace', event_id: '$ev' },
        },
      })
    expect(editToMessage(edit('/deploy staging'), '$ev', ctx, original).command).toEqual({ agent: AGENT, name: 'deploy' })
    expect(editToMessage(edit('deploy staging'), '$ev', ctx, original).command).toBeUndefined()
    // Without the original the rule cannot close.
    expect(editToMessage(edit('/deploy staging'), '$ev', ctx).command).toBeUndefined()
    // The same edit applied on the event (the room's view): the text shown is the edit's.
    const replaced = sent('/deploy prod', undefined, { name: 'deploy', agent: AGENT_ID })
    replaced.makeReplaced(edit('sem comando'))
    expect(eventToMessage(replaced, ctx)?.command).toBeUndefined()
  })

  // PLANO-AGENTES §0.3.23 item 4: a message whose sender is an agent is never a command, original or edit.
  const OTHER_AGENT = '@a-cccccccccccc:tayet.local'
  const fromAgent = (): MatrixEvent => {
    const e = sent('/deploy prod', undefined, { name: 'deploy', agent: AGENT_ID })
    return new MatrixEvent({ ...e.event, sender: OTHER_AGENT })
  }
  const agentEdit = (sender: string): MatrixEvent =>
    new MatrixEvent({
      event_id: '$edit2',
      room_id: ROOM_ID,
      sender,
      type: 'm.room.message',
      origin_server_ts: 2000,
      content: {
        msgtype: 'm.text',
        body: '* /deploy staging',
        'm.new_content': { msgtype: 'm.text', body: '/deploy staging' },
        'm.relates_to': { rel_type: 'm.replace', event_id: '$ev' },
      },
    })

  it('an agent sender: no command on the original, even when the rest closes', () => {
    const msg = eventToMessage(fromAgent(), ctx)
    expect(msg).not.toBeNull()
    expect(msg && 'command' in msg).toBe(false)
    expect(msg?.mentions).toEqual([AGENT])
    // The agent the marker names, sending to itself, neither.
    const self = sent('/deploy', undefined, { name: 'deploy', agent: AGENT_ID })
    expect(eventToMessage(new MatrixEvent({ ...self.event, sender: AGENT }), ctx)?.command).toBeUndefined()
  })

  it('an agent sender: no command on the edit', () => {
    const msg = editToMessage(agentEdit(OTHER_AGENT), '$ev', ctx, fromAgent())
    expect('command' in msg).toBe(false)
    // An edit by an agent of a person's command (never applied by a caller) neither.
    expect(editToMessage(agentEdit(OTHER_AGENT), '$ev', ctx, sent('/deploy prod', undefined, { name: 'deploy', agent: AGENT_ID })).command).toBeUndefined()
    // The person's own edit still carries it.
    expect(editToMessage(agentEdit(ME), '$ev', ctx, sent('/deploy prod', undefined, { name: 'deploy', agent: AGENT_ID })).command).toEqual({ agent: AGENT, name: 'deploy' })
  })
})
