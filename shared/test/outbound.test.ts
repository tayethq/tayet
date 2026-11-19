import { describe, it, expect } from 'vitest'
import {
  buildApprovalAnswerContent,
  buildApprovalContent,
  buildApprovalEditContent,
  buildAttachmentContent,
  buildEditContent,
  buildReactionContent,
  buildTextContent,
} from '../src/internal'
import type { RichDoc, UserId } from '../src'

// The outbound builders (S-a2), called directly. Same literals as the client's
// test/outbound-content-shape.test.ts, which pins what the gateway puts on the wire through these
// builders: JSON.stringify, key order included.

const BOB = '@bob:tayet.local' as unknown as UserId
const ROOT_ID = '$root:tayet.local'
const TARGET_ID = '$target:tayet.local'
const MXC = 'mxc://tayet.local/upload'
const RICH: RichDoc = [{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'hi' }] }] }]
const ENVELOPE = {
  v: 'v2',
  key: { kty: 'oct', key_ops: ['encrypt', 'decrypt'], alg: 'A256CTR', k: 'test-key', ext: true },
  iv: 'test-iv',
  hashes: { sha256: 'test-sha' },
}

const wire = (content: unknown): string => JSON.stringify(content)

describe('buildTextContent', () => {
  it('plain text: msgtype + body only', () => {
    expect(wire(buildTextContent('hello'))).toBe('{"msgtype":"m.text","body":"hello"}')
  })

  it('rich text without relation', () => {
    expect(wire(buildTextContent('hi', RICH))).toBe(
      '{"msgtype":"m.text","body":"hi","format":"org.matrix.custom.html","formatted_body":"<p><strong>hi</strong></p>"}',
    )
  })

  it('mention without relation', () => {
    expect(wire(buildTextContent('hey Bob', undefined, [BOB]))).toBe(
      '{"msgtype":"m.text","body":"hey Bob","m.mentions":{"user_ids":["@bob:tayet.local"]}}',
    )
  })

  it('mention + thread', () => {
    expect(wire(buildTextContent('hey Bob', undefined, [BOB], { thread: ROOT_ID }))).toBe(
      '{"msgtype":"m.text","body":"hey Bob","m.mentions":{"user_ids":["@bob:tayet.local"]},' +
        '"m.relates_to":{"rel_type":"m.thread","event_id":"$root:tayet.local"}}',
    )
  })

  it('mention + reply', () => {
    expect(wire(buildTextContent('hey Bob', undefined, [BOB], { replyTo: TARGET_ID }))).toBe(
      '{"msgtype":"m.text","body":"hey Bob","m.mentions":{"user_ids":["@bob:tayet.local"]},' +
        '"m.relates_to":{"m.in_reply_to":{"event_id":"$target:tayet.local"}}}',
    )
  })

  it('an empty mentions list omits m.mentions', () => {
    expect(wire(buildTextContent('hello', undefined, []))).toBe('{"msgtype":"m.text","body":"hello"}')
  })

  it('thread (plain text)', () => {
    expect(wire(buildTextContent('in thread', undefined, undefined, { thread: ROOT_ID }))).toBe(
      '{"msgtype":"m.text","body":"in thread","m.relates_to":{"rel_type":"m.thread","event_id":"$root:tayet.local"}}',
    )
  })

  it('thread (rich text): the rich fragment precedes the relation', () => {
    expect(wire(buildTextContent('hi', RICH, undefined, { thread: ROOT_ID }))).toBe(
      '{"msgtype":"m.text","body":"hi","format":"org.matrix.custom.html","formatted_body":"<p><strong>hi</strong></p>",' +
        '"m.relates_to":{"rel_type":"m.thread","event_id":"$root:tayet.local"}}',
    )
  })

  it('reply: exact envelope', () => {
    expect(wire(buildTextContent('a reply', undefined, undefined, { replyTo: TARGET_ID }))).toBe(
      '{"msgtype":"m.text","body":"a reply","m.relates_to":{"m.in_reply_to":{"event_id":"$target:tayet.local"}}}',
    )
  })
})

describe('buildAttachmentContent', () => {
  it('in clear', () => {
    expect(wire(buildAttachmentContent('m.image', 'a.png', 'image/png', 3, { url: MXC }))).toBe(
      '{"msgtype":"m.image","body":"a.png","url":"mxc://tayet.local/upload","info":{"mimetype":"image/png","size":3}}',
    )
  })

  it('in clear, non-image, in a thread: relation last', () => {
    expect(wire(buildAttachmentContent('m.file', 'notes.pdf', 'application/pdf', 4, { url: MXC }, ROOT_ID))).toBe(
      '{"msgtype":"m.file","body":"notes.pdf","url":"mxc://tayet.local/upload","info":{"mimetype":"application/pdf","size":4},' +
        '"m.relates_to":{"rel_type":"m.thread","event_id":"$root:tayet.local"}}',
    )
  })

  it('encrypted: file (envelope + url) instead of url', () => {
    expect(wire(buildAttachmentContent('m.image', 'a.png', 'image/png', 3, { encrypted: ENVELOPE, url: MXC }))).toBe(
      '{"msgtype":"m.image","body":"a.png","file":{"v":"v2","key":{"kty":"oct","key_ops":["encrypt","decrypt"],' +
        '"alg":"A256CTR","k":"test-key","ext":true},"iv":"test-iv","hashes":{"sha256":"test-sha"},' +
        '"url":"mxc://tayet.local/upload"},"info":{"mimetype":"image/png","size":3}}',
    )
  })

  it('encrypted, in a thread: relation last', () => {
    expect(
      wire(buildAttachmentContent('m.image', 'a.png', 'image/png', 3, { encrypted: ENVELOPE, url: MXC }, ROOT_ID)),
    ).toBe(
      '{"msgtype":"m.image","body":"a.png","file":{"v":"v2","key":{"kty":"oct","key_ops":["encrypt","decrypt"],' +
        '"alg":"A256CTR","k":"test-key","ext":true},"iv":"test-iv","hashes":{"sha256":"test-sha"},' +
        '"url":"mxc://tayet.local/upload"},"info":{"mimetype":"image/png","size":3},' +
        '"m.relates_to":{"rel_type":"m.thread","event_id":"$root:tayet.local"}}',
    )
  })
})

describe('buildEditContent', () => {
  it('plain: "* " body, m.new_content, m.replace', () => {
    expect(wire(buildEditContent('after', undefined, TARGET_ID))).toBe(
      '{"msgtype":"m.text","body":"* after","m.new_content":{"msgtype":"m.text","body":"after"},' +
        '"m.relates_to":{"rel_type":"m.replace","event_id":"$target:tayet.local"}}',
    )
  })

  it('rich: the formatted body lives only inside m.new_content', () => {
    expect(wire(buildEditContent('hi', RICH, TARGET_ID))).toBe(
      '{"msgtype":"m.text","body":"* hi","m.new_content":{"msgtype":"m.text","body":"hi","format":"org.matrix.custom.html",' +
        '"formatted_body":"<p><strong>hi</strong></p>"},"m.relates_to":{"rel_type":"m.replace","event_id":"$target:tayet.local"}}',
    )
  })
})

describe('buildReactionContent', () => {
  it('m.annotation relation keyed by the emoji', () => {
    expect(wire(buildReactionContent(TARGET_ID, '👍'))).toBe(
      '{"m.relates_to":{"rel_type":"m.annotation","event_id":"$target:tayet.local","key":"👍"}}',
    )
  })
})

describe('buildApprovalAnswerContent (ADR-091, A3-2)', () => {
  it('answer type, the label as fallback body, the option block, the relation to the card last', () => {
    expect(wire(buildApprovalAnswerContent(TARGET_ID, 'approve', 'Aprovar'))).toBe(
      '{"msgtype":"io.tayet.approval.response","body":"Aprovar","io.tayet.approval.response":{"option":"approve"},"m.relates_to":{"rel_type":"io.tayet.response","event_id":"$target:tayet.local"}}',
    )
  })

  it('round-trips through the reading side: the option the answer names, the card it answers', async () => {
    const { responseOption } = await import('../src/internal')
    const content = buildApprovalAnswerContent(TARGET_ID, 'reject', 'Rejeitar') as Record<string, unknown>
    expect(responseOption(content)).toBe('reject')
    expect(content['m.relates_to']).toEqual({ rel_type: 'io.tayet.response', event_id: TARGET_ID })
  })
})

describe('buildApprovalContent / buildApprovalEditContent (ADR-091, A3-3)', () => {
  const OPTIONS = [
    { id: 'approve', label: 'Aprovar', style: 'primary' as const },
    { id: 'reject', label: 'Rejeitar' },
  ]

  it('the card: its type, the plain body is ONLY the request, the options block, no relation', () => {
    expect(wire(buildApprovalContent('Publicar a 2.4?', undefined, OPTIONS))).toBe(
      '{"msgtype":"io.tayet.approval","body":"Publicar a 2.4?","io.tayet.approval":{"options":[{"id":"approve","label":"Aprovar","style":"primary"},{"id":"reject","label":"Rejeitar"}]}}',
    )
  })

  it('formatted request in the usual formatted body; mentions; thread relation last', () => {
    expect(wire(buildApprovalContent('hi', RICH, [{ id: 'ok', label: 'OK' }], [BOB], ROOT_ID))).toBe(
      '{"msgtype":"io.tayet.approval","body":"hi","format":"org.matrix.custom.html","formatted_body":"<p><strong>hi</strong></p>","io.tayet.approval":{"options":[{"id":"ok","label":"OK"}]},"m.mentions":{"user_ids":["@bob:tayet.local"]},"m.relates_to":{"rel_type":"m.thread","event_id":"$root:tayet.local"}}',
    )
  })

  it('the edit keeps the type and the block; the close adds the mark; the fallback is starred', () => {
    expect(wire(buildApprovalEditContent('Novo pedido', undefined, OPTIONS, false, TARGET_ID))).toBe(
      '{"msgtype":"io.tayet.approval","body":"* Novo pedido","m.new_content":{"msgtype":"io.tayet.approval","body":"Novo pedido","io.tayet.approval":{"options":[{"id":"approve","label":"Aprovar","style":"primary"},{"id":"reject","label":"Rejeitar"}]}},"m.relates_to":{"rel_type":"m.replace","event_id":"$target:tayet.local"}}',
    )
    const closed = buildApprovalEditContent('Novo pedido', undefined, OPTIONS, true, TARGET_ID)
    expect(closed['m.new_content']['io.tayet.approval']).toEqual({ options: OPTIONS, closed: true })
  })

  it('round-trips through the reading side: the options read back, the close is seen', async () => {
    const { readApprovalOptions, approvalClosed } = await import('../src/internal')
    const card = buildApprovalContent('x', undefined, OPTIONS) as Record<string, unknown>
    expect(readApprovalOptions(card)).toEqual(OPTIONS)
    expect(approvalClosed(card)).toBe(false)
    const edit = buildApprovalEditContent('x', undefined, OPTIONS, true, TARGET_ID)
    expect(approvalClosed(edit['m.new_content'] as Record<string, unknown>)).toBe(true)
  })
})

describe('buildApprovalContent / buildApprovalEditContent with `needed` (ADR-104)', () => {
  const OPTIONS = [
    { id: 'approve', label: 'Aprovar', style: 'primary' as const },
    { id: 'reject', label: 'Rejeitar' },
  ]

  it('without `needed` the card and the edit are byte for byte the ones of a plain card', () => {
    expect(wire(buildApprovalContent('hi', RICH, OPTIONS, [BOB], ROOT_ID, undefined))).toBe(wire(buildApprovalContent('hi', RICH, OPTIONS, [BOB], ROOT_ID)))
    expect(wire(buildApprovalEditContent('x', undefined, OPTIONS, true, TARGET_ID, undefined))).toBe(wire(buildApprovalEditContent('x', undefined, OPTIONS, true, TARGET_ID)))
  })

  it('the card carries `needed` beside the options, in the block', () => {
    expect(wire(buildApprovalContent('Publicar?', undefined, OPTIONS, undefined, undefined, 3))).toBe(
      '{"msgtype":"io.tayet.approval","body":"Publicar?","io.tayet.approval":{"options":[{"id":"approve","label":"Aprovar","style":"primary"},{"id":"reject","label":"Rejeitar"}],"needed":3}}',
    )
  })

  it('the edit and the close carry the original `needed`, and it reads back', async () => {
    const { readApprovalNeeded, approvalClosed } = await import('../src/internal')
    expect(wire(buildApprovalEditContent('Novo', undefined, OPTIONS, false, TARGET_ID, 3))).toBe(
      '{"msgtype":"io.tayet.approval","body":"* Novo","m.new_content":{"msgtype":"io.tayet.approval","body":"Novo","io.tayet.approval":{"options":[{"id":"approve","label":"Aprovar","style":"primary"},{"id":"reject","label":"Rejeitar"}],"needed":3}},"m.relates_to":{"rel_type":"m.replace","event_id":"$target:tayet.local"}}',
    )
    const closed = buildApprovalEditContent('Novo', undefined, OPTIONS, true, TARGET_ID, 3)
    expect(closed['m.new_content']['io.tayet.approval']).toEqual({ options: OPTIONS, needed: 3, closed: true })
    expect(approvalClosed(closed['m.new_content'] as Record<string, unknown>)).toBe(true)
    expect(readApprovalNeeded(buildApprovalContent('x', undefined, OPTIONS, undefined, undefined, 10) as Record<string, unknown>)).toBe(10)
  })
})
