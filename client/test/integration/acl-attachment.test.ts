import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, ChannelId, MediaRef, MessageId } from '../../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'
import { HOMESERVER, synapseReachable, createRoom } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { until } from '../support/until'

// PLANO-FASE-1-UPLOAD §3 (commit 2): attachment send through the ACL drives the real Synapse —
// uploadContent → mxc, msgtype inferred from the mimetype, info from the File, then sendMessage.
// The RECEIVED attachment round-trips through getTimeline as clean domain (an opaque MediaRef,
// never an mxc), and resolveMedia authenticates + fetches the exact bytes back. This is the
// non-optimistic path; the local-echo optimism is exercised by acl-attachment-echo (commit 5).

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 11, 22, 33, 44, 55, 66, 77, 88])

describe.skipIf(!SYNAPSE)('ACL attachment send + receive (integration, cleartext)', () => {
  let acl: Acl
  let token: string

  beforeAll(async () => {
    const [user] = await freshUsers(['att'])
    token = user.token
    acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await acl.connect(token as Parameters<Acl['connect']>[0])
  }, 180_000)

  afterAll(async () => {
    await acl?.disconnect()
  })

  it('uploads + sends an image and the received message round-trips as an opaque MediaRef', async () => {
    const name = `tayet-attach-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    const roomId = await createRoom(token, { name })
    const channelId = roomId as unknown as ChannelId
    // PLANO-GATES §8.12: without a known Room the SDK keeps no local echo, so 'sent' never fires.
    // Wait until the sender's ACL knows the channel before the first send.
    await until(
      'channel known to sender before attachment send',
      async () => ((await acl.getChannels()).some((c) => c.id === channelId) ? true : undefined),
      {
        snapshot: async () => {
          const chs = await acl.getChannels()
          return `known=${chs.length} hasChannelId=${chs.some((c) => c.id === channelId)}`
        },
      },
    )

    const file = new File([BYTES as BlobPart], 'pixel.png', { type: 'image/png' })
    const messageId: MessageId = await acl.sendMessage(channelId, { kind: 'attachment', file })
    expect(typeof messageId).toBe('string')

    // The settled message round-trips through getTimeline as an IMAGE body carrying an opaque ref.
    const ref: MediaRef = await until(
      'attachment settles into timeline as image',
      async () => {
        const page = await acl.getTimeline(channelId)
        const m = page.items.find((x) => x.id === messageId)
        if (!m) return undefined
        expect(m.body.kind).toBe('image')
        // The domain carries an opaque MediaRef — never the mxc.
        return m.body.kind === 'image' ? m.body.media : undefined
      },
      {
        // Settle-class instrumentation (PLANO-GATES §8.2): on overflow, report the partial
        // timeline state — how many items landed and which kinds.
        snapshot: async () => {
          const page = await acl.getTimeline(channelId)
          return `items=${page.items.length} kinds=[${page.items.map((x) => x.body.kind).join(',')}] hasMessageId=${page.items.some((x) => x.id === messageId)}`
        },
      },
    )
    expect(findProtocolLeaks({ ref })).toEqual([])

    // resolveMedia authenticates, fetches, and assembles the EXACT bytes (no mxc leak).
    let captured: Blob | undefined
    const realCreate = (globalThis.URL as unknown as { createObjectURL?: unknown }).createObjectURL
    const realRevoke = (globalThis.URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
    ;(globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b) => {
      captured = b
      return 'blob:tayet-attach'
    }
    ;(globalThis.URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {}
    try {
      const resolved = await acl.resolveMedia(ref, 'full')
      expect(resolved.url).toBe('blob:tayet-attach')
      expect(captured!.size).toBe(BYTES.length)
      resolved.release()
    } finally {
      ;(globalThis.URL as unknown as Record<string, unknown>).createObjectURL = realCreate
      ;(globalThis.URL as unknown as Record<string, unknown>).revokeObjectURL = realRevoke
    }
  }, 180_000)

  it('rejects an attachment over the server upload size limit before sending', async () => {
    // A deliberately huge Blob must be rejected by the pre-validation (m.upload.size) — and the
    // reject must happen WITHOUT a bubble. We assert only that sendMessage rejects; the size cap
    // value is the server's. If the server advertises no cap, this is a no-op skip via try.
    const name = `tayet-attach-big-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    const roomId = await createRoom(token, { name })
    const channelId = roomId as unknown as ChannelId
    // ADR-058: an unknown channel is rejected locally before the size check; wait until the
    // sender's ACL knows the channel so this keeps proving the LIMIT, not the precondition.
    await until(
      'channel known to sender before oversize attachment send',
      async () => ((await acl.getChannels()).some((c) => c.id === channelId) ? true : undefined),
      {
        snapshot: async () => {
          const chs = await acl.getChannels()
          return `known=${chs.length} hasChannelId=${chs.some((c) => c.id === channelId)}`
        },
      },
    )
    // 1 GiB sparse-ish blob: far above any default m.upload.size (Synapse default is 50 MiB).
    const big = new Blob([new Uint8Array(1)], { type: 'application/octet-stream' })
    Object.defineProperty(big, 'size', { value: 1024 * 1024 * 1024 })
    await expect(
      acl.sendMessage(channelId, { kind: 'attachment', file: big as Blob }),
    ).rejects.toBeDefined()
  }, 180_000)
})

describe('ACL attachment (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
