import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RoomEvent } from 'matrix-js-sdk'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { encryptAttachment } from '@tayet/shared/internal/attachment-crypto'
import type { AclTelemetry, DomainEvent } from '../src/acl'
import type { MediaRef } from '@tayet/shared'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'

// Commit 5 (PLANO-FASE-2-MEDIA §3.2): the ENCRYPTED inbound path of resolveMedia, against
// fixtures — authenticated download (stubbed) → hash verify → decrypt (direct call under Node, the PF-2
// dispatch) → Blob with the PLAINTEXT mimetype → object URL; plus the revocation registry
// (release idempotent; disconnect sweeps) and the domain-clean rejection on tamper.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ROOM_ID = '!room:tayet.local'
type Handler = (...args: never[]) => void

function harness() {
  const fakeRoom = {
    getMyMembership: () => 'join',
    // PLANO-AGENTES §0.3.11: the translator asks kindOf for every author; the gateway looks for the
    // organization channel by alias — this room is not it.
    getCanonicalAlias: () => null,
    roomId: ROOM_ID,
    findEventById: () => undefined,
    getThread: () => undefined,
    getLiveTimeline: () => ({ getEvents: () => [] }),
    relations: { getChildEventsForEvent: () => undefined },
    hasEncryptionStateEvent: () => true,
  }
  const handlers = new Map<string, Handler[]>()
  const fakeClient = {
    getRooms: () => [fakeRoom],
    getRoom: () => fakeRoom,
    getUserId: () => '@me:tayet.local',
    getAccountData: () => undefined,
    getCrypto: () => undefined,
    stopClient: () => {},
    // The authenticated v1 download rides the SDK http-api (401→refresh→retry, §8.21).
    http: { authedRequest: (...args: unknown[]) => served(...args) },
    on: (name: string, h: Handler) => {
      const list = handlers.get(name) ?? []
      list.push(h)
      handlers.set(name, list)
    },
    off: () => {},
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  const g = gateway as unknown as { client: unknown; live: boolean; wireEvents(c: unknown): void }
  g.client = fakeClient
  g.wireEvents(fakeClient)
  g.live = true
  const events: DomainEvent[] = []
  gateway.subscribe((e) => events.push(e))
  const fireTimeline = (ev: unknown): void => {
    for (const h of handlers.get(RoomEvent.Timeline as string) ?? [])
      (h as (...a: unknown[]) => void)(ev, fakeRoom, false, false, { liveEvent: true })
  }
  return { gateway, events, fireTimeline }
}

// A SETTLED encrypted-attachment event as the pipeline sees it post-decrypt: clear type with
// the EncryptedFile envelope in `file` (the encrypted lifecycle itself is decrypt-cycle's job).
function attachmentEvent(content: Record<string, unknown>) {
  return {
    isEncrypted: () => false,
    isDecryptionFailure: () => false,
    isRedacted: () => false,
    getType: () => 'm.room.message',
    getContent: () => content,
    getOriginalContent: () => content,
    getId: () => '$att:tayet.local',
    getTxnId: () => undefined,
    getSender: () => '@other:tayet.local',
    getRoomId: () => ROOM_ID,
    getTs: () => 1000,
    replacingEventDate: () => undefined,
    getServerAggregatedRelation: () => undefined,
    getRelation: () => null,
    status: null,
  }
}

const PLAINTEXT = new TextEncoder().encode('decrypted image bytes \u{1F512}')

async function mintEncryptedRef(h: ReturnType<typeof harness>): Promise<{
  ref: MediaRef
  ciphertext: Uint8Array
}> {
  const { ciphertext, info } = await encryptAttachment(PLAINTEXT)
  h.fireTimeline(
    attachmentEvent({
      msgtype: 'm.image',
      body: 'pic.png',
      file: { ...info, url: 'mxc://tayet.local/abc' },
      info: { mimetype: 'image/png', size: PLAINTEXT.length },
    }),
  )
  const e = h.events.find((x) => x.t === 'message.received')
  expect(e).toBeDefined()
  if (e?.t !== 'message.received' || e.message.body.kind !== 'image') {
    throw new Error('expected an image body')
  }
  return { ref: e.message.body.media, ciphertext }
}

let createdUrls: Array<{ url: string; blob: Blob }>
let revoked: string[]
let served: (...args: unknown[]) => Promise<Blob>
const realCreate = URL.createObjectURL
const realRevoke = URL.revokeObjectURL

beforeEach(() => {
  createdUrls = []
  revoked = []
  let n = 0
  URL.createObjectURL = ((blob: Blob) => {
    const url = `blob:test-${++n}`
    createdUrls.push({ url, blob })
    return url
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = ((url: string) => {
    revoked.push(url)
  }) as typeof URL.revokeObjectURL
})

afterEach(() => {
  URL.createObjectURL = realCreate
  URL.revokeObjectURL = realRevoke
})

function stubDownload(bytes: Uint8Array): void {
  served = vi.fn(async () => new Blob([bytes.slice()]))
}

describe('resolveMedia — encrypted inbound (ADR-016)', () => {
  it('fetch → verify → decrypt → blob URL with the PLAINTEXT mimetype', async () => {
    const h = harness()
    const { ref, ciphertext } = await mintEncryptedRef(h)
    stubDownload(ciphertext)

    const resolved = await h.gateway.resolveMedia(ref)
    expect(resolved.url).toMatch(/^blob:/)
    const created = createdUrls.find((c) => c.url === resolved.url)!
    expect(created.blob.type).toBe('image/png')
    expect(new Uint8Array(await created.blob.arrayBuffer())).toEqual(PLAINTEXT)

    // release() revokes its own URL, idempotently.
    resolved.release()
    resolved.release()
    expect(revoked).toEqual([resolved.url])
  })

  it('tampered ciphertext → DOMAIN rejection, no cipher/protocol detail in the error', async () => {
    const h = harness()
    const { ref, ciphertext } = await mintEncryptedRef(h)
    const tampered = ciphertext.slice()
    tampered[0]! ^= 0xff
    stubDownload(tampered)

    const err = await h.gateway.resolveMedia(ref).then(
      () => {
        throw new Error('should have rejected')
      },
      (e: unknown) => e as Error,
    )
    expect(err.message).toBe('media unavailable')
    expect(findProtocolLeaksInText(err.message)).toEqual([])
    for (const term of ['sha256', 'hash', 'aes', 'ctr', 'cipher', 'decrypt', 'jwk']) {
      expect(err.message.toLowerCase()).not.toContain(term)
    }
    expect(createdUrls).toEqual([]) // never best-effort bytes
  })

  it('disconnect revokes every outstanding object URL (mirror of mediaByToken)', async () => {
    const h = harness()
    const { ref, ciphertext } = await mintEncryptedRef(h)
    stubDownload(ciphertext)

    const a = await h.gateway.resolveMedia(ref)
    const b = await h.gateway.resolveMedia(ref)
    expect(revoked).toEqual([])

    await h.gateway.disconnect()
    expect(new Set(revoked)).toEqual(new Set([a.url, b.url]))

    // A release() after the sweep must NOT double-revoke (registry membership guards it).
    a.release()
    expect(revoked.length).toBe(2)
  })
})
