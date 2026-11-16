import { describe, it, expect } from 'vitest'
import type { OutgoingBody, RichDoc } from '../src/acl'

// Contract guard for the closed OutgoingBody (PLANO-FASE-1-TRADUTORES §"Fechar OutgoingBody").
// The outbound contract has NO msgtype/kind-of-protocol field — the client never names a
// Matrix msgtype (P1 / ADR-007); the ACL infers it from the mimetype on send. This is a
// COMPILE-TIME assertion: `tsc --noEmit` (in `npm run check`) is the real gate. If a
// `msgtype` field is ever added to OutgoingBody, the excess-property error disappears and
// the @ts-expect-error directive itself becomes an "unused directive" error — turning the
// leak into a red build. The runtime `it()` only exists so vitest accepts the file.

// @ts-expect-error — `msgtype` não existe em OutgoingBody; se passar a existir, isto quebra.
const _noMsgtype: OutgoingBody = { kind: 'attachment', file: new Blob(), msgtype: 'm.image' }
void _noMsgtype

// The two legal shapes must still typecheck (positive control).
const _text: OutgoingBody = { kind: 'text', text: 'hi' }
const _attachment: OutgoingBody = { kind: 'attachment', file: new Blob(), name: 'a.png' }
void _text
void _attachment

// ADR-012: `rich` is ADDITIVE and OPTIONAL on the text variant. Plain text (no `rich`) must still
// typecheck unchanged (above); a text body WITH a RichDoc must typecheck too. The closed-union
// guard is unchanged — `rich` lives only on the text variant, not the attachment one.
const _doc: RichDoc = [{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'hi' }] }] }]
const _rich: OutgoingBody = { kind: 'text', text: 'hi', rich: _doc }
void _rich

// @ts-expect-error — `rich` is NOT a field on the attachment variant (closed union preserved).
const _noRichOnAttachment: OutgoingBody = { kind: 'attachment', file: new Blob(), rich: _doc }
void _noRichOnAttachment

describe('OutgoingBody contract', () => {
  it('admits exactly text and attachment (msgtype guard is compile-time)', () => {
    expect(_text.kind).toBe('text')
    expect(_attachment.kind).toBe('attachment')
  })

  it('accepts an optional RichDoc on the text variant (ADR-012, additive)', () => {
    expect(_rich.kind).toBe('text')
    expect((_rich as { rich?: RichDoc }).rich).toBe(_doc)
  })
})
