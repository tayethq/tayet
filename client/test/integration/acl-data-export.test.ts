import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, ChannelId, DataExportPart, DomainEvent, MessageId, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { readExportManifest } from '@tayet/shared'
import { HOMESERVER, synapseReachable, whoami, invite, join, setDisplayName } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { until } from '../support/until'

// ADR-096, PLANO-EXPORT-DADOS §0.3.5: the person's export against the real stack — an encrypted
// conversation and a public channel where the person sends, edits, deletes, sends files, answers in
// threads, replies, mentions and reacts; a third conversation she leaves and a fourth she archives. The
// export is checked against the format's reader and against what was sent. The walk filtered by the person
// (H1), the first entry (H2) and both redaction shapes (H5) close here.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const FILE_BYTES = new TextEncoder().encode('export bytes — the file the person sent\n')

type Item = Record<string, unknown> & { type: string; id: string }

describe.skipIf(!SYNAPSE)('exportMyData (integration)', () => {
  let me: Acl
  let other: Acl
  let meToken: string
  let otherToken: string
  let meMxid: string
  let otherMxid: string
  const meEvents: DomainEvent[] = []
  const tag = `exp${process.pid}${Math.floor(Math.random() * 1e5)}`

  beforeAll(async () => {
    const [meUser, otherUser] = await freshUsers(['exm', 'exo'])
    meToken = meUser.token
    otherToken = otherUser.token
    meMxid = await whoami(meToken)
    otherMxid = await whoami(otherToken)
    // Names in the conversations' state: the export takes a mention's name from there (A5).
    await setDisplayName(meToken, meMxid, 'Export Me')
    await setDisplayName(otherToken, otherMxid, 'Export Other')
    me = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    other = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await me.connect(meToken as Parameters<Acl['connect']>[0])
    await other.connect(otherToken as Parameters<Acl['connect']>[0])
    me.subscribe((e) => meEvents.push(e))
  }, 180_000)

  afterAll(async () => {
    await me?.disconnect()
    await other?.disconnect()
  })

  // The stack rate-limits sends and room creation; wait what the server says and repeat.
  async function retrying<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await work()
      } catch (err) {
        const e = err as { name?: string; data?: { retry_after_ms?: number } }
        const limited = e.name === 'RateLimitedError' || e.data?.retry_after_ms !== undefined
        if (!limited || attempt >= 10) throw err
        await new Promise((r) => setTimeout(r, (e.data?.retry_after_ms ?? 2_000) + 200))
      }
    }
  }

  async function createChannel(kind: 'private' | 'public', label: string): Promise<{ ch: ChannelId; name: string }> {
    const name = `${tag}-${label}`
    const ch = await retrying(() => me.createChannel({ name, kind }))
    await until(`${label} known`, async () => ((await me.getChannels()).some((c) => c.id === ch) ? true : undefined))
    return { ch, name }
  }

  async function send(ch: ChannelId, body: Parameters<Acl['sendMessage']>[1], opts?: Parameters<Acl['sendMessage']>[2]): Promise<MessageId> {
    const id = await retrying(() => me.sendMessage(ch, body, opts))
    await until('sent', () => meEvents.find((e) => e.t === 'message.status' && e.messageId === id && e.status === 'sent'))
    return id
  }

  // Another person's message as this session sees it (its id here is the event id).
  async function theirs(ch: ChannelId, text: string): Promise<MessageId> {
    await retrying(() => other.sendMessage(ch, { kind: 'text', text }))
    const ev = await until(`their "${text}" received`, () =>
      meEvents.find(
        (e): e is Extract<DomainEvent, { t: 'message.received' }> =>
          e.t === 'message.received' && e.message.channelId === ch && e.message.body.kind === 'text' && e.message.body.text === text,
      ),
    )
    return ev.message.id
  }

  // What the person does in one conversation; returns the texts the export must and must not hold.
  async function scenario(ch: ChannelId, label: string, otherUser: UserId) {
    const t = (s: string) => `${tag} ${label} ${s}`
    const plain = await send(ch, { kind: 'text', text: t('plain') })
    const edited = await send(ch, { kind: 'text', text: t('v0') })
    await retrying(() => me.editMessage(edited, { kind: 'text', text: t('v1') }))
    await retrying(() => me.editMessage(edited, { kind: 'text', text: t('v2') }))
    const doomed = await send(ch, { kind: 'text', text: t('doomed v0') })
    await retrying(() => me.editMessage(doomed, { kind: 'text', text: t('doomed v1') }))
    await retrying(() => me.deleteMessage(doomed))
    await send(ch, { kind: 'attachment', file: new File([FILE_BYTES as BlobPart], 'notes.txt', { type: 'text/plain' }) })
    const doomedFile = await send(ch, { kind: 'attachment', file: new File([FILE_BYTES as BlobPart], 'gone.txt', { type: 'text/plain' }) })
    await retrying(() => me.deleteMessage(doomedFile))
    await send(ch, { kind: 'text', text: t('in own thread') }, { thread: plain })
    const theirRoot = await theirs(ch, t('their root'))
    await send(ch, { kind: 'text', text: t('in their thread') }, { thread: theirRoot })
    const theirMsg = await theirs(ch, t('their message'))
    await send(ch, { kind: 'text', text: t('reply to theirs') }, { replyTo: theirMsg })
    await send(ch, { kind: 'text', text: t('hello Export Other') }, { mentions: [otherUser] })
    await retrying(() => me.react(theirMsg, '👍'))
    return {
      present: [t('plain'), t('v2'), t('in own thread'), t('in their thread'), t('reply to theirs'), t('hello Export Other')],
      absent: [t('v0'), t('v1'), t('doomed v0'), t('doomed v1'), t('their root'), t('their message'), 'gone.txt'],
    }
  }

  it('exports the person’s own data, in the format, with nothing of anyone else', async () => {
    const otherUser = (await other.currentUser()).id

    const enc = await createChannel('private', 'cifrada')
    await invite(meToken, enc.ch as unknown as string, otherMxid)
    await join(otherToken, enc.ch as unknown as string)
    const pub = await createChannel('public', 'publica')
    await join(otherToken, pub.ch as unknown as string)
    for (const ch of [enc.ch, pub.ch]) {
      await until('other is in', async () => ((await other.getChannels()).some((c) => c.id === ch) ? true : undefined))
    }

    const encTexts = await scenario(enc.ch, 'cifrada', otherUser)
    const pubTexts = await scenario(pub.ch, 'publica', otherUser)

    const left = await createChannel('private', 'saida')
    await send(left.ch, { kind: 'text', text: `${tag} left behind` })
    await retrying(() => me.leaveChannel(left.ch))
    await until('left gone', async () => ((await me.getChannels()).some((c) => c.id === left.ch) ? undefined : true))

    const archived = await createChannel('private', 'arquivada')
    await send(archived.ch, { kind: 'text', text: `${tag} archived hello` })
    await retrying(() => me.archiveChannel(archived.ch))
    await until('archived listed', async () => ((await me.getArchivedChannels()).some((c) => c.id === archived.ch) ? true : undefined))

    // H1 by the wire: the filtered walk brings only the person's events, entries and redactions with them.
    for (const ch of [enc.ch, pub.ch]) {
      const url = `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(ch as unknown as string)}/messages?dir=b&limit=100&filter=${encodeURIComponent(JSON.stringify({ senders: [meMxid] }))}`
      const res = (await (await fetch(url, { headers: { Authorization: `Bearer ${meToken}` } })).json()) as { chunk: Array<{ sender: string; type: string }> }
      expect(res.chunk.length).toBeGreaterThan(0)
      expect(res.chunk.every((e) => e.sender === meMxid)).toBe(true)
      expect(res.chunk.some((e) => e.type === 'm.room.member')).toBe(true)
      expect(res.chunk.some((e) => e.type === 'm.room.redaction')).toBe(true)
    }

    const parts: DataExportPart[] = []
    for await (const part of me.exportMyData({ readme: 'Export test README.', unnamedAccess: 'Unnamed access' })) parts.push(part)

    const files = new Map(parts.flatMap((p) => (p.t === 'file' ? [[p.path, p.content] as const] : [])))
    const attachments = new Map(parts.flatMap((p) => (p.t === 'attachment' ? [[p.path, p.data] as const] : [])))
    const manifest = readExportManifest(files.get('manifest.json')!)
    const done = parts.at(-1)
    expect(done?.t).toBe('done')
    if (done?.t !== 'done') throw new Error('no done part')
    expect(done.totals).toEqual(manifest.totals)

    // Conversations: the two scenarios and the archived one; never the one she left (the session may also
    // be in the organization channel, which is not part of this scenario).
    const byName = new Map(manifest.conversations.map((c) => [c.name, c]))
    expect(byName.has(left.name)).toBe(false)
    expect(byName.get(archived.name)).toMatchObject({ kind: 'private', messages: 1, deleted: 0, gaps: 0 })
    expect(byName.get(pub.name)?.kind).toBe('public')
    expect(byName.get(enc.name)?.kind).toBe('private')

    const otherEntry = manifest.people.find((p) => p.name === 'Export Other')
    expect(otherEntry).toBeDefined()

    for (const [conv, texts] of [
      [byName.get(enc.name)!, encTexts],
      [byName.get(pub.name)!, pubTexts],
    ] as const) {
      // H2: the first entry is known.
      expect(conv.joinedAt).toBeDefined()
      // 7 messages (plain, edited, file, two thread answers, reply, mention); 2 deleted (the edited one with
      // its edits, the file); 1 attachment obtained.
      expect(conv).toMatchObject({ messages: 7, deleted: 2, attachments: 1, gaps: 0 })
      const file = JSON.parse(files.get(conv.file)!) as { items: Item[] }
      const items = file.items
      const byText = (s: string) => items.find((i) => i.type === 'message' && i.text === s)
      for (const s of texts.present) expect(byText(s), s).toBeDefined()
      for (const s of texts.absent) expect(files.get(conv.file)).not.toContain(s)
      expect(items.filter((i) => i.type === 'deleted')).toHaveLength(2)

      const plain = byText(texts.present[0]!)!
      expect(byText(texts.present[1]!)!.editedAt).toBeDefined()
      expect(byText(texts.present[2]!)).toMatchObject({ inThread: true, threadRoot: plain.id, isReply: false })
      const inTheirs = byText(texts.present[3]!)!
      expect(inTheirs).toMatchObject({ inThread: true })
      expect(inTheirs).not.toHaveProperty('threadRoot')
      const reply = byText(texts.present[4]!)!
      expect(reply).toMatchObject({ isReply: true })
      expect(reply).not.toHaveProperty('replyTo')
      expect(byText(texts.present[5]!)).toMatchObject({ mentions: [otherEntry!.id] })

      // The file: same bytes as sent; the deleted file left nothing behind.
      const withFile = items.find((i) => (i.attachment as { name?: string } | undefined)?.name === 'notes.txt')!
      const path = (withFile.attachment as { file: string }).file
      const bytes = new Uint8Array(await attachments.get(path)!.arrayBuffer())
      expect([...bytes]).toEqual([...FILE_BYTES])
      expect([...attachments.keys()].filter((p) => p.startsWith(`attachments/${conv.id}/`))).toEqual([path])
    }

    // Nothing of protocol and nothing of the other person anywhere.
    for (const [path, content] of files) {
      expect(findProtocolLeaksInText(path)).toEqual([])
      expect(findProtocolLeaksInText(content)).toEqual([])
      for (const s of ['their root', 'their message', 'left behind', meMxid, otherMxid, enc.ch as unknown as string]) expect(content).not.toContain(s)
    }
    for (const path of attachments.keys()) expect(findProtocolLeaksInText(path)).toEqual([])
  }, 900_000)

  it('aborting rejects with the reason and lets the export go', async () => {
    const reason = new Error('cancelled in the test')
    const ctl = new AbortController()
    const it_ = me.exportMyData({ readme: 'r', unnamedAccess: 'u', signal: ctl.signal })[Symbol.asyncIterator]()
    const first = await it_.next()
    expect(first.value).toMatchObject({ t: 'progress', done: 0 })
    const next = it_.next()
    ctl.abort(reason)
    await expect(next).rejects.toBe(reason)
  }, 120_000)
})

describe('exportMyData (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(true).toBe(true)
  })
})
