import { describe, it, expect } from 'vitest'
import type { Room } from 'matrix-js-sdk'
import { hasGroupMarker, isGroupConversation } from '../src/internal'
import type { Ctx } from '../src/internal'
import { GROUP_MAX_OTHERS, type AclTelemetry } from '../src'

// ADR-094 (Proposto) dec. 2 and 7 — PR-2 (PLANO-CONVERSAS §0.3.2 items 6 and 7). hasGroupMarker reads only
// the room's marker, with no context: the client's cheap pre-check before it builds one. A true there is not
// yet a group — isGroupConversation still rules out a DM and #all. GROUP_MAX_OTHERS is the domain limit.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const MARKER = 'io.tayet.conversation'

function fakeRoom(marker: unknown, alias: string | null = null): Room {
  return {
    roomId: '!r:server',
    getCanonicalAlias: () => alias,
    currentState: {
      getStateEvents: (type: string, key: string) =>
        type === MARKER && key === '' && marker !== undefined ? { getContent: () => marker } : null,
    },
  } as unknown as Room
}

const ctx = (isDm: boolean): Ctx => ({ mode: 'strict', telemetry: noopTelemetry, isDm: () => isDm, orgChannelAlias: '#all:server' })

describe('hasGroupMarker (ADR-094 dec. 2)', () => {
  it("only the exact { kind: 'group' } is true", () => {
    expect(hasGroupMarker(fakeRoom({ kind: 'group' }))).toBe(true)
  })

  it('absent, channel, malformed: false', () => {
    for (const marker of [undefined, { kind: 'channel' }, { kind: 'Group' }, { kind: ['group'] }, {}, null, 'group']) {
      expect(hasGroupMarker(fakeRoom(marker))).toBe(false)
    }
  })

  it('needs no context: a DM or #all with the marker is true here and false in isGroupConversation', () => {
    const dm = fakeRoom({ kind: 'group' })
    expect(hasGroupMarker(dm)).toBe(true)
    expect(isGroupConversation(dm, ctx(true))).toBe(false)
    const org = fakeRoom({ kind: 'group' }, '#all:server')
    expect(hasGroupMarker(org)).toBe(true)
    expect(isGroupConversation(org, ctx(false))).toBe(false)
    expect(isGroupConversation(fakeRoom({ kind: 'group' }), ctx(false))).toBe(true)
  })
})

describe('GROUP_MAX_OTHERS (ADR-094 dec. 7)', () => {
  it('8 others: 9 participants with whoever opens', () => {
    expect(GROUP_MAX_OTHERS).toBe(8)
  })
})
