import { describe, it, expect, vi } from 'vitest'
import { RoomEvent, MatrixEventEvent, ThreadEvent } from 'matrix-js-sdk'
import { DecryptionFailureCode } from 'matrix-js-sdk/lib/crypto-api'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { CustodyReconsult } from '../src/acl/internal/key-recovery'
import { decryptAttachment, type EncryptedFile } from '@tayet/shared/internal/attachment-crypto'
import type { AclTelemetry, DomainEvent, ChannelId } from '../src/acl'
import { findProtocolLeaks, findProtocolLeaksInText, PROTOCOL_PATTERNS } from '@tayet/shared/leak-scan'

// Decrypt-cycle unit fixtures (PLANO-FASE-2 §4.3 / commit 8). A stateful fake encrypted event
// walks the REAL lifecycle verified in PF-1 item 2 (§9): RoomEvent.Timeline fires with the event
// still raw (m.room.encrypted, decrypting); MatrixEventEvent.Decrypted fires when the attempt
// SETTLES — success (clearEvent = real content) or failure (clearEvent = the SDK's
// 'm.bad.encrypted' stub, relations only on the wire envelope). This harness drives the
// gateway's captured listeners directly, so no Synapse/crypto stack is needed (runs in CI).
//
// Cases: (a) immediate success — NO placeholder flash; (b) settled failure → `unavailable`
// with relations from the wire and ZERO technical vocabulary in the emitted shape (P1, gate
// assert 7 in unit form); (c) late upgrade → message.edited with the real content under the
// SAME id; (d) a failed m.replace is silently dropped (P4); (e) attachment into an E2E room
// follows the CIPHER path — encrypt → opaque upload (no filename) → `file` envelope — with
// the optimistic echo intact. Case (e) is the REGISTERED INVERSION of fatia A's fail-closed
// (PLANO-FASE-2 §4.5): this slice closes issue #15 (ADR-016), same precedent as the fatia-C
// fixture note — an inversion of sign, not a regression.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:tayet.local'
const ROOM_ID = '!room:tayet.local'
const CHANNEL = ROOM_ID as unknown as ChannelId

type Handler = (...args: never[]) => void

interface FakeEncrypted {
  ev: Record<string, unknown>
  settleClear(content: Record<string, unknown>): void
  settleFailure(): void
  // ADR-077 dec. 3: each re-decryption the ACL asked of the SDK (attemptDecryption options).
  retries: unknown[]
}

// Mirrors the pinned SDK's observable surface across the decrypt lifecycle (PF-1 item 2):
//  - decrypting: getType() = m.room.encrypted, content = wire envelope, isBeingDecrypted true;
//  - failed:     getType() = m.room.message, content = the m.bad.encrypted stub (NO relation);
//  - clear:      getType() = m.room.message, content = the decrypted payload.
// The wire envelope always carries m.relates_to in cleartext (PF-1 item 3).
function fakeEncryptedEvent(opts: {
  id: string
  sender?: string
  wireRelates?: Record<string, unknown>
  // The SDK's settled failure code (ADR-057 dec. 7). Absent = the SDK gave no reason (null on
  // the real event) — the graduated discriminator must default to 'awaited'.
  failureReason?: DecryptionFailureCode
  // PR-5: a wire envelope with NO session_id (defensive case) — the 'lost' verdict then has no
  // discriminant and must never fire.
  omitSessionId?: boolean
}): FakeEncrypted {
  let phase: 'decrypting' | 'failed' | 'clear' = 'decrypting'
  let clearContent: Record<string, unknown> = {}
  const retries: unknown[] = []
  const wire: Record<string, unknown> = {
    algorithm: 'm.megolm.v1.aes-sha2',
    ciphertext: 'AwgAEnACgAkLmt6qF...',
    sender_key: 'senderkey456',
  }
  if (!opts.omitSessionId) wire['session_id'] = 'sessionid123'
  if (opts.wireRelates) wire['m.relates_to'] = opts.wireRelates
  const failedStub = { msgtype: 'm.bad.encrypted', body: '** Unable to decrypt: …Megolm… **' }
  const content = (): Record<string, unknown> =>
    phase === 'clear' ? clearContent : phase === 'failed' ? failedStub : wire
  const ev = {
    isEncrypted: () => true,
    isBeingDecrypted: () => phase === 'decrypting',
    shouldAttemptDecryption: () => false,
    isDecryptionFailure: () => phase === 'failed',
    // Mirrors MatrixEvent.decryptionFailureReason: a code only while the failure is settled.
    get decryptionFailureReason() {
      return phase === 'failed' ? (opts.failureReason ?? null) : null
    },
    getWireContent: () => wire,
    getType: () => (phase === 'decrypting' ? 'm.room.encrypted' : 'm.room.message'),
    getContent: content,
    getOriginalContent: content,
    isRedacted: () => false,
    getId: () => opts.id,
    getTxnId: () => undefined,
    getSender: () => opts.sender ?? '@other:tayet.local',
    getRoomId: () => ROOM_ID,
    getTs: () => 1000,
    replacingEventDate: () => undefined,
    getServerAggregatedRelation: () => undefined,
    getRelation: () => (wire['m.relates_to'] as object | undefined) ?? null,
    attemptDecryption: async (_backend: unknown, options: unknown) => {
      retries.push(options)
    },
    status: null,
  }
  return {
    ev,
    retries,
    settleClear: (c) => {
      phase = 'clear'
      clearContent = c
    },
    settleFailure: () => {
      phase = 'failed'
    },
  }
}

function harness(opts?: { mode?: 'strict' | 'lenient'; encryptedRoom?: boolean; maxUpload?: number }) {
  const targetEvent = {
    getType: () => 'm.room.message',
    isRedacted: () => false,
    isDecryptionFailure: () => false,
    getContent: () => ({ msgtype: 'm.text', body: 'the target' }),
    getOriginalContent: () => ({ msgtype: 'm.text', body: 'the target' }),
    getId: () => '$target:tayet.local',
    getTxnId: () => undefined,
    getSender: () => '@other:tayet.local',
    getRoomId: () => ROOM_ID,
    getTs: () => 500,
    replacingEventDate: () => undefined,
    getServerAggregatedRelation: () => undefined,
    status: null,
  }
  // Events the room's timeline holds besides the target (ADR-077: the re-decryption finds them here).
  const known = new Map<string, unknown>()
  const fakeRoom = {
    // PLANO-AGENTES §0.3.11: the translator asks kindOf for every author; the gateway looks for the
    // organization channel by alias — this room is not it.
    getCanonicalAlias: () => null,
    roomId: ROOM_ID,
    getMyMembership: () => 'join',
    findEventById: (id: string) => (id === '$target:tayet.local' ? targetEvent : known.get(id)),
    getThread: () => undefined,
    getLiveTimeline: () => ({ getEvents: () => [] }),
    relations: { getChildEventsForEvent: () => undefined },
    hasEncryptionStateEvent: () => opts?.encryptedRoom ?? true,
    on: (name: string, h: Handler) => roomHandlers.set(name, [...(roomHandlers.get(name) ?? []), h]),
    off: () => {},
  }
  const roomHandlers = new Map<string, Handler[]>()
  const handlers = new Map<string, Handler[]>()
  const uploadContent = vi.fn(async () => ({ content_uri: 'mxc://x/y' }))
  const sendMessage = vi.fn(async () => ({ event_id: '$sent' }))
  const fakeClient = {
    getRooms: () => [fakeRoom],
    getRoom: () => fakeRoom,
    getCrypto: () => ({}),
    getUserId: () => ME,
    getAccountData: () => undefined,
    makeTxnId: () => 'txn-1',
    getMediaConfig: async () =>
      opts?.maxUpload !== undefined ? { 'm.upload.size': opts.maxUpload } : {},
    uploadContent,
    sendMessage,
    on: (name: string, h: Handler) => {
      const list = handlers.get(name) ?? []
      list.push(h)
      handlers.set(name, list)
    },
    off: () => {},
  }
  const gateway = new MatrixGateway({
    mode: opts?.mode ?? 'strict',
    telemetry: noopTelemetry,
    serverUrl: 'http://x',
  })
  const g = gateway as unknown as { client: unknown; live: boolean; wireEvents(c: unknown): void; attachRoom(r: unknown): void }
  g.client = fakeClient
  g.wireEvents(fakeClient)
  g.live = true
  g.attachRoom(fakeRoom)
  const events: DomainEvent[] = []
  gateway.subscribe((e) => events.push(e))
  const fire = (name: string, ...args: unknown[]): void => {
    for (const h of handlers.get(name) ?? []) (h as (...a: unknown[]) => void)(...args)
  }
  const fireTimeline = (ev: unknown): void =>
    fire(RoomEvent.Timeline as string, ev, fakeRoom, false, false, { liveEvent: true })
  const fireDecrypted = (ev: unknown): void => fire(MatrixEventEvent.Decrypted as string, ev)
  // ThreadEvent.NewReply on the room (Thread.onEcho in the SDK), with the thread the reply belongs to.
  const fireNewReply = (ev: unknown, rootId: string): void => {
    const thread = { id: rootId, length: 1, replyToEvent: null, rootEvent: undefined, room: fakeRoom }
    for (const h of roomHandlers.get(ThreadEvent.NewReply as string) ?? []) (h as (...a: unknown[]) => void)(thread, ev)
  }
  const register = (ev: Record<string, unknown>): void => {
    known.set((ev['getId'] as () => string)(), ev)
  }
  return { gateway, events, fireTimeline, fireDecrypted, fireNewReply, uploadContent, sendMessage, register }
}

// No crypto/protocol vocabulary may survive into an emitted domain event (P1 — gate assert 7
// in unit form). Checked over the raw JSON, beyond the structural leak-scan.
function assertNoCryptoVocabulary(e: DomainEvent): void {
  const json = JSON.stringify(e)
  for (const term of ['m.bad.encrypted', 'ciphertext', 'session_id', 'sessionid123', 'megolm', 'olm', 'Unable to decrypt']) {
    expect(json.toLowerCase()).not.toContain(term.toLowerCase())
  }
}

describe('encrypted inbound pipeline — decrypt cycle (unit fixtures)', () => {
  it('does NOT emit from the raw m.room.encrypted; immediate success emits the real content once', () => {
    const { events, fireTimeline, fireDecrypted } = harness()
    const enc = fakeEncryptedEvent({ id: '$e1:tayet.local' })

    fireTimeline(enc.ev)
    expect(events, 'no placeholder flash while decrypting').toEqual([])

    enc.settleClear({ msgtype: 'm.text', body: 'olá cifrado' })
    fireDecrypted(enc.ev)

    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.t).toBe('message.received')
    if (e.t === 'message.received') {
      expect(e.message.body).toEqual({ kind: 'text', text: 'olá cifrado' })
      expect(e.message.id).toBe('$e1:tayet.local')
    }
  })

  it('settled failure emits `unavailable` (no payload) with relations from the WIRE envelope', () => {
    const { events, fireTimeline, fireDecrypted, fireNewReply } = harness()
    const enc = fakeEncryptedEvent({
      id: '$e2:tayet.local',
      wireRelates: { rel_type: 'm.thread', event_id: '$root:tayet.local' },
    })

    // A thread reply reaches the stream through ThreadEvent.NewReply only (#421 N6): the timeline leaves it
    // alone, NewReply defers it while it decrypts, and the settled failure emits it.
    fireTimeline(enc.ev)
    fireNewReply(enc.ev, '$root:tayet.local')
    enc.settleFailure()
    fireDecrypted(enc.ev)

    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.t).toBe('message.received')
    if (e.t === 'message.received') {
      // No reason from the SDK → the graduated discriminator defaults to 'awaited' (ADR-057
      // dec. 7); `arrival` is product grade, NOT a payload — nothing protocol crosses.
      expect(e.message.body).toEqual({ kind: 'unavailable', arrival: 'awaited' })
      expect(Object.keys(e.message.body)).toEqual(['kind', 'arrival']) // NO payload crosses (ADR-015)
      // The wire envelope's relation survives the failure: the placeholder lands in its thread.
      expect(e.message.threadParent).toBe('$root:tayet.local')
    }
    assertNoCryptoVocabulary(e)
    expect(findProtocolLeaks(e)).toEqual([])
  })

  it('late decrypt upgrades the `unavailable` via message.edited under the SAME id', () => {
    const { events, fireTimeline, fireDecrypted } = harness()
    const enc = fakeEncryptedEvent({ id: '$e3:tayet.local' })

    fireTimeline(enc.ev)
    enc.settleFailure()
    fireDecrypted(enc.ev)
    expect(events).toHaveLength(1)

    // The key arrives (backup/gossip) → the SDK re-emits Decrypted with the real content.
    enc.settleClear({ msgtype: 'm.text', body: 'agora legível' })
    fireDecrypted(enc.ev)

    expect(events).toHaveLength(2)
    const upgrade = events[1]!
    expect(upgrade.t).toBe('message.edited') // zero new mechanism — the UI already handles it
    if (upgrade.t === 'message.edited') {
      expect(upgrade.message.id).toBe('$e3:tayet.local') // SAME stable id: reconciles in place
      expect(upgrade.message.body).toEqual({ kind: 'text', text: 'agora legível' })
    }
    // A second success re-emit must NOT re-upgrade (the map entry was consumed).
    fireDecrypted(enc.ev)
    expect(events).toHaveLength(2)
  })

  it('a failed m.replace is silently dropped (P4) and applies as an edit on upgrade', () => {
    const { events, fireTimeline, fireDecrypted } = harness()
    const enc = fakeEncryptedEvent({
      id: '$e4:tayet.local',
      wireRelates: { rel_type: 'm.replace', event_id: '$target:tayet.local' },
    })

    fireTimeline(enc.ev)
    enc.settleFailure()
    fireDecrypted(enc.ev)
    // No phantom bubble for an unreadable edit: the target keeps its content.
    expect(events).toEqual([])

    enc.settleClear({
      msgtype: 'm.text',
      body: '* fixed',
      'm.new_content': { msgtype: 'm.text', body: 'fixed' },
      'm.relates_to': { rel_type: 'm.replace', event_id: '$target:tayet.local' },
    })
    fireDecrypted(enc.ev)
    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.t).toBe('message.edited')
    if (e.t === 'message.edited') {
      expect(e.message.id).toBe('$target:tayet.local')
      expect(e.message.body).toEqual({ kind: 'text', text: 'fixed' })
    }
  })

  // ── Case (e), INVERTED from fatia A (registered inversion — closes #15 / ADR-016). The two
  // fail-closed tests this block replaces asserted: strict → D3 throw before any echo/upload;
  // lenient → pending bubble → status 'failed' → reject, never uploading. With fatia B the
  // SAME sends now follow the cipher path end-to-end. ──────────────────────────────────────
  it('strict E2E room: attachment encrypts before upload — opaque ciphertext, file envelope, echo intact', async () => {
    const { gateway, events, uploadContent, sendMessage } = harness({ mode: 'strict', encryptedRoom: true })
    const plain = new TextEncoder().encode('fake png bytes for the cipher path')
    const id = await gateway.sendMessage(CHANNEL, {
      kind: 'attachment',
      file: new Blob([plain], { type: 'image/png' }),
      name: 'secret.png',
    })

    // Optimistic echo INTACT (ADR-010): pending with the LOCAL preview ref, emitted before the
    // upload, under the SAME stable id sendMessage returns (pending→sent never re-keys).
    const pending = events[0]!
    expect(pending.t).toBe('message.received')
    if (pending.t === 'message.received') {
      expect(pending.message.id).toBe(id)
      expect(pending.message.status).toBe('pending')
      expect(pending.message.body.kind).toBe('image')
    }

    // The repo got OPAQUE bytes: ciphertext ≠ plaintext, NO filename, octet-stream (PF-1 item 4).
    expect(uploadContent).toHaveBeenCalledOnce()
    const [uploaded, uploadOpts] = uploadContent.mock.calls[0] as unknown as [
      Uint8Array,
      Record<string, unknown>,
    ]
    expect(uploadOpts).toMatchObject({ includeFilename: false, type: 'application/octet-stream' })
    expect(uploadOpts.name).toBeUndefined()
    expect([...uploaded]).not.toEqual([...plain])

    // The event content carries `file` (envelope + the upload's mxc) INSTEAD of `url`; `info`
    // keeps the PLAINTEXT mimetype/size — all inside what Megolm encrypts (wire = gate assert 3).
    const content = (sendMessage.mock.calls[0] as unknown as unknown[])[1] as Record<string, unknown>
    expect(content.url).toBeUndefined()
    const file = content.file as EncryptedFile
    expect(file.url).toBe('mxc://x/y')
    expect(file.v).toBe('v2')
    expect(file.key.alg).toBe('A256CTR')
    expect(content.info).toEqual({ mimetype: 'image/png', size: plain.length })

    // Round-trip: the uploaded ciphertext + the sent envelope restore the EXACT bytes.
    const restored = await decryptAttachment(uploaded.slice().buffer as ArrayBuffer, file)
    expect(new Uint8Array(restored)).toEqual(plain)
  })

  it('lenient E2E room: the SAME cipher path (no fail-closed branch left)', async () => {
    const { gateway, uploadContent, sendMessage } = harness({ mode: 'lenient', encryptedRoom: true })
    await gateway.sendMessage(CHANNEL, { kind: 'attachment', file: new Blob(['x']), name: 'x.bin' })
    expect(uploadContent).toHaveBeenCalledOnce()
    expect(sendMessage).toHaveBeenCalledOnce()
    const content = (sendMessage.mock.calls[0] as unknown as unknown[])[1] as Record<string, unknown>
    expect(content.url).toBeUndefined()
    expect(content.file).toBeDefined()
  })

  it('size limit is checked BEFORE encrypting/uploading — no condemned bubble (§3.3 item 4)', async () => {
    const { gateway, events, uploadContent } = harness({
      mode: 'strict',
      encryptedRoom: true,
      maxUpload: 4,
    })
    await expect(
      gateway.sendMessage(CHANNEL, { kind: 'attachment', file: new Blob(['way too big']), name: 'big.bin' }),
    ).rejects.toThrow(/limit/)
    expect(events).toEqual([]) // rejected before any echo
    expect(uploadContent).not.toHaveBeenCalled()
  })

  it('cleartext room: the attachment path is untouched (upload + send still run)', async () => {
    const { gateway, uploadContent, sendMessage } = harness({ mode: 'strict', encryptedRoom: false })
    await gateway.sendMessage(CHANNEL, { kind: 'attachment', file: new Blob(['x']), name: 'x.png' })
    expect(uploadContent).toHaveBeenCalledOnce()
    expect(sendMessage).toHaveBeenCalledOnce()
  })

  // INVERTED from the fatia-A window (which rendered this as the generic `unavailable`,
  // PLANO-FASE-2 §4.5): with ADR-016 materialized, an inbound encrypted attachment translates
  // to a NORMAL image/file body behind an opaque MediaRef — the EncryptedFile envelope stays
  // ACL-internal (the leak-scan's envelope-key rule proves it never reaches the event).
  it('inbound encrypted ATTACHMENT translates to image with an opaque MediaRef (fatia B / ADR-016)', () => {
    const { events, fireTimeline, fireDecrypted } = harness()
    const enc = fakeEncryptedEvent({ id: '$e5:tayet.local' })
    fireTimeline(enc.ev)
    enc.settleClear({
      msgtype: 'm.image',
      body: 'secret.png',
      file: {
        url: 'mxc://tayet.local/abc',
        key: { kty: 'oct', alg: 'A256CTR', k: 'k', key_ops: ['encrypt', 'decrypt'], ext: true },
        iv: 'iv',
        hashes: { sha256: 'h' },
        v: 'v2',
      },
      info: { mimetype: 'image/png', size: 3 },
    })
    fireDecrypted(enc.ev)
    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.t).toBe('message.received')
    if (e.t === 'message.received') {
      expect(e.message.body.kind).toBe('image')
      if (e.message.body.kind === 'image') {
        // Opaque per-session token — never the mxc, never the envelope.
        expect(e.message.body.media as unknown as string).toMatch(/^mr_/)
        expect(e.message.body.alt).toBe('secret.png')
      }
    }
    assertNoCryptoVocabulary(e)
    expect(findProtocolLeaks(e)).toEqual([])
  })
})

// ADR-057 dec. 7 (PR-1 do track CRIPTO-COBERTURA): the graduated unavailability discriminator.
// Every SDK failure code lands on a product grade — 'awaited' ("pode ainda chegar") or
// 'stalled' ("não chega por este canal") — and the code itself NEVER crosses (dec. 8; the
// leak-scan below has teeth for the literals). The mapping is deny-list: anything unlisted,
// including a missing reason (covered in the pipeline describe above), defaults to 'awaited'.
describe('graduated unavailability discriminator (ADR-057 dec. 7)', () => {
  const cases: Array<[DecryptionFailureCode, 'awaited' | 'stalled']> = [
    // Key not yet received — the normal in-flight case; a live share may still land it.
    [DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID, 'awaited'],
    // A usable backup exists (or restore has not run yet) — this channel may still deliver.
    [DecryptionFailureCode.HISTORICAL_MESSAGE_WORKING_BACKUP, 'awaited'],
    [DecryptionFailureCode.HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED, 'awaited'],
    // Unclassified: declaring a channel dead requires evidence.
    [DecryptionFailureCode.UNKNOWN_ERROR, 'awaited'],
    // The sender declared withholding — a live share will not come.
    [DecryptionFailureCode.MEGOLM_KEY_WITHHELD, 'stalled'],
    [DecryptionFailureCode.MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE, 'stalled'],
    // Later ratchet index: Megolm never walks backwards.
    [DecryptionFailureCode.OLM_UNKNOWN_MESSAGE_INDEX, 'stalled'],
    // No backup on the server — the backup channel is exhausted (custody may still resolve
    // it in PR-5; 'stalled' is not a loss verdict).
    [DecryptionFailureCode.HISTORICAL_MESSAGE_NO_KEY_BACKUP, 'stalled'],
    // Outside the coverage invariant (ADR-057 norma 1).
    [DecryptionFailureCode.HISTORICAL_MESSAGE_USER_NOT_JOINED, 'stalled'],
    // Sender-trust refusals: policy, not latency.
    [DecryptionFailureCode.SENDER_IDENTITY_PREVIOUSLY_VERIFIED, 'stalled'],
    [DecryptionFailureCode.UNSIGNED_SENDER_DEVICE, 'stalled'],
    [DecryptionFailureCode.UNKNOWN_SENDER_DEVICE, 'stalled'],
  ]

  it.each(cases)('%s → %s (and the code never crosses)', (code, arrival) => {
    const { events, fireTimeline, fireDecrypted } = harness()
    const enc = fakeEncryptedEvent({ id: '$g1:tayet.local', failureReason: code })
    fireTimeline(enc.ev)
    enc.settleFailure()
    fireDecrypted(enc.ev)

    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.t).toBe('message.received')
    if (e.t === 'message.received') {
      expect(e.message.body).toEqual({ kind: 'unavailable', arrival })
    }
    assertNoCryptoVocabulary(e)
    expect(findProtocolLeaks(e)).toEqual([]) // includes the new decryption-failure-code teeth
  })
})

// ── Veredito definitivo 'lost' (ADR-057 dec. 6/7 — PR-5; ADR-077 dec. 4) ───────────────────
// Semântica unit-provada contra o MESMO harness do pipeline: o gateway injeta o conjunto de
// sessões importadas da consulta à custódia (custodyImportedSessions) e o teto da re-consulta
// (custodyReconsult.exhausted), e o translate discrimina. 'lost' EXIGE as três provas: consulta
// feita nesta sessão de uso, sessão ausente do import, re-consultas da sessão esgotadas. Qualquer
// elo faltando → o grau transitório fica.
describe('definitive lost verdict (ADR-057 dec. 6/7 — PR-5; ADR-077 dec. 4)', () => {
  type H = ReturnType<typeof harness> & {
    setConsulted: (ids: string[] | undefined) => void
    setExhausted: (ids: string[]) => void
  }
  const harnessWithCustody = (): H => {
    const h = harness()
    const g = h.gateway as unknown as {
      custodyImportedSessions?: Set<string>
      custodyReconsult?: Pick<CustodyReconsult, 'note' | 'exhausted'>
    }
    const exhausted = new Set<string>()
    g.custodyReconsult = { note: () => {}, exhausted: (id) => exhausted.has(id) }
    return Object.assign(h, {
      setConsulted: (ids: string[] | undefined) => {
        g.custodyImportedSessions = ids === undefined ? undefined : new Set(ids)
      },
      setExhausted: (ids: string[]) => {
        for (const id of ids) exhausted.add(id)
      },
    })
  }
  const settle = (h: H, opts: Parameters<typeof fakeEncryptedEvent>[0]) => {
    const enc = fakeEncryptedEvent(opts)
    h.fireTimeline(enc.ev)
    enc.settleFailure()
    h.fireDecrypted(enc.ev)
    const e = h.events[h.events.length - 1]!
    if (e.t !== 'message.received') throw new Error('expected message.received')
    return e.message.body
  }

  it('SEM consulta (boot sem recovery, ou consulta falhou) → stalled permanece stalled', () => {
    const h = harnessWithCustody()
    h.setConsulted(undefined)
    h.setExhausted(['sessionid123'])
    expect(settle(h, { id: '$l1:tayet.local', failureReason: DecryptionFailureCode.MEGOLM_KEY_WITHHELD })).toEqual({
      kind: 'unavailable',
      arrival: 'stalled',
    })
  })

  it('consulta feita + sessão AUSENTE do import, teto NÃO esgotado → stalled (o lost falso-definitivo do §0)', () => {
    const h = harnessWithCustody()
    h.setConsulted(['other-session'])
    expect(
      settle(h, { id: '$l0:tayet.local', failureReason: DecryptionFailureCode.HISTORICAL_MESSAGE_USER_NOT_JOINED }),
    ).toEqual({ kind: 'unavailable', arrival: 'stalled' })
  })

  it('consulta feita + sessão AUSENTE do import + teto esgotado → lost (e nada de protocolo cruza)', () => {
    const h = harnessWithCustody()
    h.setConsulted(['other-session'])
    h.setExhausted(['sessionid123'])
    const body = settle(h, {
      id: '$l2:tayet.local',
      failureReason: DecryptionFailureCode.HISTORICAL_MESSAGE_USER_NOT_JOINED,
    })
    expect(body).toEqual({ kind: 'unavailable', arrival: 'lost' })
    expect(Object.keys(body)).toEqual(['kind', 'arrival']) // veredito sem payload (dec. 8)
    const e = h.events[h.events.length - 1]!
    assertNoCryptoVocabulary(e)
    expect(findProtocolLeaks(e)).toEqual([])
  })

  it('consulta feita mas a sessão VEIO no import → stalled, não lost (o import é a refutação)', () => {
    const h = harnessWithCustody()
    h.setConsulted(['sessionid123'])
    h.setExhausted(['sessionid123'])
    expect(
      settle(h, { id: '$l3:tayet.local', failureReason: DecryptionFailureCode.OLM_UNKNOWN_MESSAGE_INDEX }),
    ).toEqual({ kind: 'unavailable', arrival: 'stalled' })
  })

  it('família awaited INTOCADA: consulta feita + sessão ausente + teto esgotado NÃO gradua awaited → lost', () => {
    const h = harnessWithCustody()
    h.setConsulted([])
    h.setExhausted(['sessionid123'])
    for (const reason of [
      DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID,
      DecryptionFailureCode.HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED,
      DecryptionFailureCode.UNKNOWN_ERROR,
    ]) {
      expect(settle(h, { id: `$l4-${reason}:tayet.local`, failureReason: reason })).toEqual({
        kind: 'unavailable',
        arrival: 'awaited',
      })
    }
  })

  it('wire sem session_id → sem discriminante, sem veredito: stalled fica', () => {
    const h = harnessWithCustody()
    h.setConsulted([])
    h.setExhausted(['sessionid123'])
    expect(
      settle(h, {
        id: '$l5:tayet.local',
        failureReason: DecryptionFailureCode.MEGOLM_KEY_WITHHELD,
        omitSessionId: true,
      }),
    ).toEqual({ kind: 'unavailable', arrival: 'stalled' })
  })
})

// ADR-077 (revisa ADR-061 D1): todo evento não decifrável — 'awaited' E 'stalled', cold inclusive —
// avisa a sua sessão Megolm; a re-consulta agenda, consulta, re-decifra e, esgotado o teto, o grau
// honesto sai como message.edited. Aqui o agendador real é plugado no gateway como no
// startKeyRecovery (mesmas portas), com a consulta fingida.
describe('custody re-consult wiring in the gateway (ADR-077)', () => {
  type G = {
    custodyImportedSessions?: Set<string>
    custodyReconsult?: Pick<CustodyReconsult, 'note' | 'exhausted'>
    undecryptableOf(ids: ReadonlySet<string>): unknown[]
    retryDecryption(ids: ReadonlySet<string>): void
  }

  it('o hook avisa a sessão nos graus awaited e stalled; sem session_id, nada', () => {
    const h = harness()
    const g = h.gateway as unknown as G
    const noted: string[] = []
    g.custodyReconsult = { note: (id) => noted.push(id), exhausted: () => false }
    const settle = (opts: Parameters<typeof fakeEncryptedEvent>[0]) => {
      const enc = fakeEncryptedEvent(opts)
      h.fireTimeline(enc.ev)
      enc.settleFailure()
      h.fireDecrypted(enc.ev)
    }
    settle({ id: '$n1:tayet.local', failureReason: DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID })
    settle({ id: '$n2:tayet.local', failureReason: DecryptionFailureCode.HISTORICAL_MESSAGE_NO_KEY_BACKUP })
    settle({ id: '$n3:tayet.local' }) // sem reason → awaited
    settle({ id: '$n4:tayet.local', failureReason: DecryptionFailureCode.MEGOLM_KEY_WITHHELD, omitSessionId: true })
    expect(noted).toEqual(['sessionid123', 'sessionid123', 'sessionid123'])
  })

  const wired = (failureReason?: DecryptionFailureCode) => {
    const h = harness()
    const g = h.gateway as unknown as G
    g.custodyImportedSessions = new Set() // o pass cold consultou: o depósito ainda não tinha chegado
    let consults = 0
    let deposit: string[] = []
    g.custodyReconsult = new CustodyReconsult({
      consult: async () => {
        consults += 1
        for (const id of deposit) g.custodyImportedSessions!.add(id)
      },
      imported: (id) => g.custodyImportedSessions?.has(id) === true,
      pending: (id) => g.undecryptableOf(new Set([id])).length > 0,
      retryDecryption: (ids) => g.retryDecryption(new Set(ids)),
    })
    const enc = fakeEncryptedEvent({ id: '$rc:tayet.local', failureReason })
    h.register(enc.ev)
    h.fireTimeline(enc.ev)
    enc.settleFailure()
    h.fireDecrypted(enc.ev)
    return {
      h,
      enc,
      consults: () => consults,
      depositNow: (ids: string[]) => {
        deposit = ids
      },
    }
  }

  it('teto esgotado (stalled): re-decifra a cada volta e, na re-falha da 4ª, emite o grau honesto (lost)', async () => {
    vi.useFakeTimers()
    try {
      const w = wired(DecryptionFailureCode.HISTORICAL_MESSAGE_USER_NOT_JOINED)
      expect(w.h.events).toHaveLength(1)
      const first = w.h.events[0]!
      expect(first.t === 'message.received' && first.message.body).toEqual({ kind: 'unavailable', arrival: 'stalled' })
      for (const [round, wait] of [2_000, 4_000, 8_000].entries()) {
        await vi.advanceTimersByTimeAsync(wait)
        expect(w.consults()).toBe(round + 1)
        expect(w.enc.retries).toHaveLength(round + 1)
        w.h.fireDecrypted(w.enc.ev) // re-falha antes do teto: "Waiting for message…" fica, nada emitido
        expect(w.h.events).toHaveLength(1)
      }
      await vi.advanceTimersByTimeAsync(16_000)
      expect(w.consults()).toBe(4)
      expect(w.enc.retries).toEqual(Array(4).fill({ isRetry: true }))
      w.h.fireDecrypted(w.enc.ev)
      expect(w.h.events).toHaveLength(2)
      const last = w.h.events[1]!
      expect(last.t).toBe('message.edited')
      if (last.t === 'message.edited') {
        expect(last.message.id).toBe(first.t === 'message.received' ? first.message.id : undefined)
        expect(last.message.body).toEqual({ kind: 'unavailable', arrival: 'lost' })
        assertNoCryptoVocabulary(last)
      }
      await vi.advanceTimersByTimeAsync(120_000)
      expect(w.consults()).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('teto esgotado (awaited): re-consulta e re-decifra até o teto, mas o grau fica awaited — nada emitido', async () => {
    vi.useFakeTimers()
    try {
      const w = wired()
      const first = w.h.events[0]!
      expect(first.t === 'message.received' && first.message.body).toEqual({ kind: 'unavailable', arrival: 'awaited' })
      for (const wait of [2_000, 4_000, 8_000, 16_000]) {
        await vi.advanceTimersByTimeAsync(wait)
        w.h.fireDecrypted(w.enc.ev)
      }
      expect(w.consults()).toBe(4)
      expect(w.enc.retries).toHaveLength(4)
      expect(w.h.events).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(w.consults()).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('depósito tardio: a volta que importa re-decifra, o evento sobe via message.edited, sem mais voltas', async () => {
    vi.useFakeTimers()
    try {
      const w = wired()
      await vi.advanceTimersByTimeAsync(2_000)
      w.depositNow(['sessionid123'])
      await vi.advanceTimersByTimeAsync(4_000)
      expect(w.consults()).toBe(2)
      expect(w.enc.retries).toHaveLength(2)
      w.enc.settleClear({ msgtype: 'm.text', body: 'chegou' })
      w.h.fireDecrypted(w.enc.ev)
      const last = w.h.events[w.h.events.length - 1]!
      expect(last.t === 'message.edited' && last.message.body).toEqual({ kind: 'text', text: 'chegou' })
      await vi.advanceTimersByTimeAsync(120_000)
      expect(w.consults()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

// Leak-scan teeth for the new vocabulary (ADR-057 dec. 8, padrão ADR-056 norma 3): the
// failure-code literals and the decrypt* stem are protocol; the graduated product words are
// not — a false positive there would kill the barrel field and the placeholder copy.
describe('leak-scan decryption teeth (ADR-057 dec. 8)', () => {
  it('POSITIVE: failure-code literals and the decrypt* stem are caught', () => {
    for (const s of [
      'MEGOLM_UNKNOWN_INBOUND_SESSION_ID',
      'OLM_UNKNOWN_MESSAGE_INDEX',
      'HISTORICAL_MESSAGE_NO_KEY_BACKUP',
      'SENDER_IDENTITY_PREVIOUSLY_VERIFIED',
      'UNSIGNED_SENDER_DEVICE',
      'UNKNOWN_SENDER_DEVICE',
      'UNKNOWN_ERROR',
    ]) {
      expect(
        findProtocolLeaksInText(`reason ${s} crossed`).map((l) => l.pattern),
        `failure code ${s} must be caught`,
      ).toContain('decryption-failure-code')
      // Structural walk too — a domain object carrying the literal is equally caught.
      expect(findProtocolLeaks({ note: s }).map((l) => l.pattern)).toContain('decryption-failure-code')
    }
    for (const s of ['decrypt', 'decrypted', 'decryption failure', 'decryptionFailureReason']) {
      expect(
        findProtocolLeaksInText(`cannot ${s} here`).map((l) => l.pattern),
        `stem "${s}" must be caught`,
      ).toContain('decrypt')
    }
  })

  it('NEGATIVE: the product grades and the graduated copy match NO pattern', () => {
    // 'lost' (PR-5): o veredito definitivo é palavra de PRODUTO — prendê-lo fora dos padrões é
    // o teste negativo que a fatia exige (um falso positivo mataria o grau no barrel).
    for (const product of ['awaited', 'stalled', 'lost', 'arrival', 'Waiting for message…', 'Message unavailable']) {
      for (const { name, re } of PROTOCOL_PATTERNS) {
        expect(re.test(product), `pattern ${name} must not match product word "${product}"`).toBe(false)
      }
      expect(findProtocolLeaksInText(product)).toEqual([])
    }
  })
})
