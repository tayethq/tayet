import { describe, it, expect, vi } from 'vitest'
import type { Ctx } from '@tayet/shared/internal'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry } from '../src/acl'

// ADR-075: a page that brings an event already redacted drops its entry from the search index. Before,
// translateAll only upserted, so the old entry outlived the redaction and getMessage kept returning it
// (§8.52, §0 item 2.6). No stack: the gateway gets a fake index, and translateAll is driven directly.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ROOM_ID = '!room:tayet.local'
const ctx: Ctx = { mode: 'strict', telemetry: noopTelemetry, isDm: () => false, myUserId: '@me:tayet.local' }

function fakeEvent(id: string, opts: { type?: string; redacted: boolean }) {
  return {
    getType: () => opts.type ?? 'm.room.message',
    isRedacted: () => opts.redacted,
    isDecryptionFailure: () => false,
    getContent: () => ({}),
    getId: () => id,
    getRoomId: () => ROOM_ID,
  }
}

describe('translateAll drops redacted page items from the search index (ADR-075)', () => {
  it('a redacted event on the page is removed by its id; other untranslated events are not', () => {
    const search = { upsert: vi.fn(), remove: vi.fn() }
    const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
    ;(gateway as unknown as { search: unknown }).search = search
    const translateAll = (gateway as unknown as { translateAll: (evs: unknown[], c: Ctx) => unknown[] })
      .translateAll.bind(gateway)

    const items = translateAll(
      [fakeEvent('$gone:tayet.local', { redacted: true }), fakeEvent('$member:tayet.local', { type: 'm.room.member', redacted: false })],
      ctx,
    )

    expect(items).toEqual([])
    expect(search.remove).toHaveBeenCalledTimes(1)
    expect(search.remove).toHaveBeenCalledWith('$gone:tayet.local')
    expect(search.upsert).toHaveBeenCalledWith([])
  })
})
