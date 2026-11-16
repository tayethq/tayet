import { describe, it, expect } from 'vitest'
import type { MessageBody } from '../src/acl'

// Contract guard for the closed MessageBody union — the `unavailable` variant (ADR-015 +
// ADR-057 dec. 7). Same idiom as outbound-contract.test.ts: COMPILE-TIME assertions where
// `tsc --noEmit` is the real gate; the runtime `it()` only exists so vitest accepts the file.
//
// ADR-015 item 1 as amended by ADR-057 dec. 7 (PR-1 do track CRIPTO-COBERTURA): `unavailable`
// carries EXACTLY the graduated product discriminator `arrival` — and still NO protocol
// payload: no failure reason, no session id, nothing. If a payload field is ever added, the
// excess-property errors below disappear and the @ts-expect-error directives become "unused
// directive" errors → red build.

// Positive control: the three product grades are legal.
const _awaited: MessageBody = { kind: 'unavailable', arrival: 'awaited' }
void _awaited
const _stalled: MessageBody = { kind: 'unavailable', arrival: 'stalled' }
void _stalled
// PR-5 (ADR-057 dec. 7): the definitive verdict EXISTS now — custody consulted and the session
// absent from the import. The @ts-expect-error that guarded this exact line since PR-1 existed
// to force a conscious removal at proof time; this is that removal.
const _lost: MessageBody = { kind: 'unavailable', arrival: 'lost' }
void _lost

// @ts-expect-error — `arrival` is REQUIRED (no implicit third state; tsc enumerates every
// construction site, same trade as Message.mine/mentionsMe).
const _bare: MessageBody = { kind: 'unavailable' }
void _bare

// @ts-expect-error — the product union stays CLOSED: no fourth grade without a new proof (the
// same guard that held 'lost' out until PR-5 delivered the custody consult).
const _noFourth: MessageBody = { kind: 'unavailable', arrival: 'expired' }
void _noFourth

// @ts-expect-error — no protocol payload: no failure reason.
const _noReason: MessageBody = { kind: 'unavailable', arrival: 'awaited', reason: 'olm session missing' }
void _noReason

// @ts-expect-error — no protocol payload: no session id — ON ANY GRADE. The 'lost' verdict is
// DERIVED from the session id inside the ACL (translate discriminates against the imported set)
// but the id itself dies there (dec. 8).
const _noSession: MessageBody = { kind: 'unavailable', arrival: 'lost', sessionId: 'abc' }
void _noSession

// @ts-expect-error — no protocol payload: not even the unsupported shape descriptor.
const _noShape: MessageBody = { kind: 'unavailable', arrival: 'awaited', shape: { eventType: 'x' } }
void _noShape

// The union stays CLOSED: a consumer switching on `kind` must handle the new case. This
// exhaustiveness probe fails to compile if a variant is left unhandled (the compile-time
// guard the PLANO requires of every consumer — renderers included, see Timeline.tsx).
function exhaustive(body: MessageBody): string {
  switch (body.kind) {
    case 'text':
      return body.text
    case 'approval':
      return body.text
    case 'image':
      return 'image'
    case 'file':
      return body.name
    case 'unsupported':
      return body.shape.eventType
    case 'unavailable':
      return body.arrival
  }
}

describe('MessageBody contract — unavailable (ADR-015 / ADR-057 dec. 7)', () => {
  it('admits exactly the three graduated variants (payload guards are compile-time)', () => {
    expect(_awaited.kind).toBe('unavailable')
    expect(Object.keys(_awaited)).toEqual(['kind', 'arrival'])
    expect(exhaustive(_awaited)).toBe('awaited')
    expect(exhaustive(_stalled)).toBe('stalled')
    expect(exhaustive(_lost)).toBe('lost')
  })
})
