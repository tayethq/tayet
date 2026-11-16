import { describe, it, expect } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { presenceToDomain } from '@tayet/shared/internal'
import type { AclTelemetry, DomainEvent, UserId } from '../src/acl'
import { findProtocolLeaks, findProtocolLeaksInText, PROTOCOL_PATTERNS } from '@tayet/shared/leak-scan'

// Presence seam (ADR-056), unit side — no Synapse. Three surfaces:
//  1. presenceToDomain: the 1:1 translation with unknown collapsing to 'offline'.
//  2. The REAL listener's diff semantics, exercised in the fake-client idiom of
//     auto-join-invite.test.ts: wireEvents on a recording fake, then drive the captured
//     per-EDU handler directly. Absence ≡ 'offline', so a first offline EDU is invisible.
//  3. The leak-scan's new teeth: the two protocol strings are caught (positive) while the
//     product vocabulary stays free (negative — a false positive would kill data-presence
//     and the plain labels).

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ALICE = '@alice:server'

describe('presenceToDomain (ADR-056)', () => {
  it('maps the three known protocol values 1:1', () => {
    expect(presenceToDomain('online')).toBe('online')
    expect(presenceToDomain('unavailable')).toBe('away')
    expect(presenceToDomain('offline')).toBe('offline')
  })

  it('collapses unknown values to offline (no fourth state)', () => {
    expect(presenceToDomain('busy')).toBe('offline')
    expect(presenceToDomain('')).toBe('offline')
  })
})

// Wire the real listener set onto a recording fake client and return the presence handler —
// the exact closure production registers (same discipline as the ADR-044 invite listener).
function harness(): {
  gateway: MatrixGateway
  firePresence: (userId: string, presence: string) => void
  events: DomainEvent[]
} {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const fakeClient = {
    on: (e: unknown, h: (...args: unknown[]) => void) => handlers.set(String(e), h),
    off: () => {},
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  ;(gateway as unknown as { wireEvents: (c: unknown) => void }).wireEvents(fakeClient)
  const onPresence = handlers.get('User.lastPresenceTs')
  if (!onPresence) throw new Error('presence listener not wired')
  const events: DomainEvent[] = []
  gateway.subscribe((e) => {
    if (e.t === 'user.presence') events.push(e)
  })
  // The SDK re-emit hands (event, user); the handler only reads the user snapshot.
  const firePresence = (userId: string, presence: string): void =>
    onPresence(undefined, { userId, presence })
  return { gateway, firePresence, events }
}

describe('presence listener diff semantics (ADR-056 dec. 3)', () => {
  it('same value twice → a single emission', () => {
    const { firePresence, events } = harness()
    firePresence(ALICE, 'online')
    firePresence(ALICE, 'online')
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ t: 'user.presence', user: ALICE, presence: 'online' })
  })

  it('a first offline EDU emits nothing (absence ≡ offline: nothing observable changed)', () => {
    const { firePresence, events } = harness()
    firePresence(ALICE, 'offline')
    expect(events).toHaveLength(0)
  })

  it('online → away → offline emits three, in order, with no protocol leak', () => {
    const { firePresence, events } = harness()
    firePresence(ALICE, 'online')
    firePresence(ALICE, 'unavailable')
    firePresence(ALICE, 'offline')
    expect(events.map((e) => (e.t === 'user.presence' ? e.presence : e.t))).toEqual([
      'online',
      'away',
      'offline',
    ])
    for (const e of events) expect(findProtocolLeaks(e)).toEqual([])
  })

  it('getPresence: never-seen user → offline; follows the map after an EDU', () => {
    const { gateway, firePresence } = harness()
    expect(gateway.getPresence(ALICE as UserId)).toBe('offline')
    firePresence(ALICE, 'online')
    expect(gateway.getPresence(ALICE as UserId)).toBe('online')
  })
})

describe('leak-scan presence teeth (ADR-056 norm 3)', () => {
  it('POSITIVE: the protocol event type and the sync knob are caught', () => {
    const leaks1 = findProtocolLeaksInText('content of type m.presence crossed')
    expect(leaks1.map((l) => l.pattern)).toContain('m-presence')
    const leaks2 = findProtocolLeaksInText('sync?set_presence=offline knob leaked')
    expect(leaks2.map((l) => l.pattern)).toContain('set-presence')
    // Structural walk too — a domain object carrying the strings is equally caught.
    expect(findProtocolLeaks({ note: 'm.presence' }).map((l) => l.pattern)).toContain('m-presence')
    expect(findProtocolLeaks({ note: 'set_presence' }).map((l) => l.pattern)).toContain('set-presence')
  })

  it('NEGATIVE: product vocabulary matches NO pattern (false positive would kill the copy)', () => {
    for (const product of ['presence', 'data-presence', 'Ausente', 'Online', 'away']) {
      for (const { name, re } of PROTOCOL_PATTERNS) {
        expect(re.test(product), `pattern ${name} must not match product word "${product}"`).toBe(false)
      }
      expect(findProtocolLeaksInText(product)).toEqual([])
    }
  })
})
