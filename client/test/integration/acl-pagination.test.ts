import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, ChannelId } from '../../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'
import { HOMESERVER, synapseReachable, createRoom, sendText } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'

// Commit 11: scrollback over a real /messages backfill token. The first page exposes an opaque
// cursor; paginating with it returns a valid Page of clean domain (the live tail is NOT here).

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

async function until<T>(get: () => Promise<T | undefined>, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 120))
  }
}

describe.skipIf(!SYNAPSE)('ACL pagination (integration)', () => {
  let acl: Acl
  let token: string

  beforeAll(async () => {
    const [user] = await freshUsers(['pag'])
    token = user.token
    acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await acl.connect(token as Parameters<Acl['connect']>[0])
  }, 180_000)

  afterAll(async () => {
    await acl?.disconnect()
  })

  async function channelNamed(name: string): Promise<ChannelId> {
    return until(async () => {
      const chs = await acl.getChannels()
      return chs.find((c) => c.name === `#${name}`)?.id
    })
  }

  it('a room delivered whole offers no cursor: its first page already reaches the room start', async () => {
    const name = `tayet-whole-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    const roomId = await createRoom(token, { name })
    await sendText(token, roomId, 'first')
    await sendText(token, roomId, 'second')
    const channelId = await channelNamed(name)

    const first = await until(async () => {
      const page = await acl.getTimeline(channelId)
      return page.items.some((m) => m.body.kind === 'text' && m.body.text === 'second') ? page : undefined
    })
    expect(findProtocolLeaks(first.items)).toEqual([])
    expect(first.nextCursor).toBeUndefined()
  }, 180_000)

  it('a room past one sync page exposes an opaque cursor; the older page ends at the room start', async () => {
    const name = `tayet-page-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    // Filler state pushes the room's creation out of the sync timeline without the send rate limit.
    const initialState = Array.from({ length: 40 }, (_, i) => ({ type: 'tayet.filler', state_key: `${i}`, content: {} }))
    const roomId = await createRoom(token, { name, initialState })
    await sendText(token, roomId, 'second')
    const channelId = await channelNamed(name)

    const first = await until(async () => {
      const page = await acl.getTimeline(channelId)
      return page.items.some((m) => m.body.kind === 'text' && m.body.text === 'second') ? page : undefined
    })
    expect(first.nextCursor).toBeDefined()

    // Older state translates to nothing renderable, so items may be empty; the cursor is under test.
    let cursor = first.nextCursor
    for (let pages = 0; cursor && pages < 4; pages++) {
      const older = await acl.getTimeline(channelId, { cursor })
      expect(findProtocolLeaks(older.items)).toEqual([])
      cursor = older.nextCursor
    }
    expect(cursor).toBeUndefined()
  }, 180_000)
})

describe('ACL pagination (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
