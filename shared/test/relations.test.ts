import { describe, it, expect } from 'vitest'
import { relationsOf, type Ctx } from '../src/internal'
import type { AclTelemetry } from '../src'

// relationsOf resolves a thread root to its STABLE id, the same way as a reply target: an own root
// sent in this session is known by its txn, and the open thread is matched by that id.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ROOT_REAL_ID = '$root:tayet.local'
const OWN_ROOT_TXN = 'txn-own-root'

const base: Ctx = { mode: 'strict', telemetry: noopTelemetry, isDm: () => false, myUserId: '@me:tayet.local' }
const threadReply = { 'm.relates_to': { rel_type: 'm.thread', event_id: ROOT_REAL_ID } }

describe('relationsOf — threadParent', () => {
  it('returns the stable id when the context resolves one', () => {
    const ctx: Ctx = { ...base, stableIdFor: (id) => (id === ROOT_REAL_ID ? OWN_ROOT_TXN : id) }
    expect(relationsOf(threadReply, ctx).threadParent).toBe(OWN_ROOT_TXN)
  })

  it('returns the event id when the context has no resolver', () => {
    expect(relationsOf(threadReply, base).threadParent).toBe(ROOT_REAL_ID)
  })
})
