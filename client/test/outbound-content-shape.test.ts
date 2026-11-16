import { describe, it, expect, vi } from 'vitest'
import { MatrixEvent } from 'matrix-js-sdk'
import { APPROVAL_BLOCK, APPROVAL_MSGTYPE } from '@tayet/shared/internal'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry, ChannelId, MessageId, RichDoc, UserId } from '../src/acl'

// Outbound content SHAPE, pinned (PLANO-AGENTES §0.3.4 adjudicação 9, S-a2). Every send path of the
// gateway — plain/rich text, mentions, thread, reply, attachment in clear and encrypted, edit, reaction —
// is captured at the fake SDK client and compared as `JSON.stringify` of the content (key order
// included) against a literal written here, plus the SDK method called and the position of its
// arguments. Written BEFORE the builders moved to @tayet/shared/internal and left untouched after:
// the extraction is proven behaviour-neutral by this file staying byte-identical. Unit harness in the
// shape of reply-envelope / own-send-receipt (fake client injected), so it runs in CI without a stack;
// mention, thread and reaction otherwise only had integration coverage (acl-mention-outbound,
// acl-threads, acl-reactions).

// The attachment cipher mints a fresh random key per call; a fixed envelope makes the encrypted
// content comparable to a literal. Only encryptAttachment is replaced — the gateway is not touched.
const ENVELOPE = {
  v: 'v2',
  key: { kty: 'oct', key_ops: ['encrypt', 'decrypt'], alg: 'A256CTR', k: 'test-key', ext: true },
  iv: 'test-iv',
  hashes: { sha256: 'test-sha' },
}
const CIPHERTEXT = new Uint8Array([9, 9, 9])
vi.mock('@tayet/shared/internal/attachment-crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tayet/shared/internal/attachment-crypto')>()),
  encryptAttachment: vi.fn(async () => ({ ciphertext: CIPHERTEXT, info: ENVELOPE })),
}))

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:tayet.local'
const BOB = '@bob:tayet.local'
const ROOM_ID = '!room:tayet.local'
const CHANNEL = ROOM_ID as unknown as ChannelId
const ROOT_ID = '$root:tayet.local'
const TARGET_ID = '$target:tayet.local'
const TXN = 'txn-new'
const MXC = 'mxc://tayet.local/upload'

const mid = (s: string): MessageId => s as unknown as MessageId
const uid = (s: string): UserId => s as unknown as UserId

// A received message from someone else — the surface locate/eventToMessage/relationsOf touch (same
// shape as edit-rollback's fake). Reply, edit and reaction all target it.
const targetEvent = {
  getType: () => 'm.room.message',
  isRedacted: () => false,
  isDecryptionFailure: () => false,
  getContent: () => ({ msgtype: 'm.text', body: 'before' }),
  getOriginalContent: () => ({ msgtype: 'm.text', body: 'before' }),
  getId: () => TARGET_ID,
  getTxnId: () => undefined,
  getSender: () => BOB,
  getRoomId: () => ROOM_ID,
  getTs: () => 1000,
  replacingEventDate: () => undefined,
  getServerAggregatedRelation: () => undefined,
  getRelation: () => null,
  status: null,
}
const rootEvent = { ...targetEvent, getId: () => ROOT_ID }
// ADR-091 (A3-2): an agent's approval card, the target of an answer.
const CARD_ID = '$card:tayet.local'
const cardEvent = new MatrixEvent({
  event_id: CARD_ID,
  room_id: ROOM_ID,
  sender: '@a-abcdefghijkm:tayet.local',
  type: 'm.room.message',
  origin_server_ts: 1000,
  content: { msgtype: APPROVAL_MSGTYPE, body: 'Publicar?', [APPROVAL_BLOCK]: { options: [{ id: 'approve', label: 'Aprovar', style: 'primary' }] } },
})

type Call = [method: string, ...args: unknown[]]

function harness(opts: { encrypted?: boolean } = {}) {
  const room = {
    // PLANO-AGENTES §0.3.11: the translator asks kindOf for every author; the gateway looks for the
    // organization channel by alias — this room is not it.
    getCanonicalAlias: () => null,
    roomId: ROOM_ID,
    getMyMembership: () => 'join',
    findEventById: (id: string) => (id === TARGET_ID ? targetEvent : id === ROOT_ID ? rootEvent : id === CARD_ID ? cardEvent : undefined),
    getLiveTimeline: () => ({ getEvents: () => [rootEvent, targetEvent] }),
    getThread: (id: string) => (id === ROOT_ID ? { id: ROOT_ID } : undefined),
    createThread: () => undefined,
    relations: { getChildEventsForEvent: () => undefined },
    hasEncryptionStateEvent: () => opts.encrypted === true,
  }
  const calls: Call[] = []
  const fakeClient = {
    getRooms: () => [room],
    getRoom: (id: string) => (id === ROOM_ID ? room : null),
    getUserId: () => ME,
    getAccountData: () => undefined,
    getMediaConfig: async () => ({}),
    makeTxnId: () => TXN,
    // The card's aggregator reads its answers in the background (approval-state.ts): none here.
    fetchRelations: async () => ({ chunk: [] }),
    getEventMapper: () => (raw: never) => new MatrixEvent(raw),
    decryptEventIfNeeded: async () => {},
    uploadContent: async (...args: unknown[]) => {
      calls.push(['uploadContent', ...args])
      return { content_uri: MXC }
    },
    sendMessage: async (...args: unknown[]) => {
      calls.push(['sendMessage', ...args])
      return { event_id: '$sent:tayet.local' }
    },
    sendTextMessage: async (...args: unknown[]) => {
      calls.push(['sendTextMessage', ...args])
      return { event_id: '$sent:tayet.local' }
    },
    sendEvent: async (...args: unknown[]) => {
      calls.push(['sendEvent', ...args])
      return { event_id: '$sent:tayet.local' }
    },
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  return { gateway, calls }
}

// The one send call of a case (uploads are checked separately).
function sendCall(calls: Call[]): Call {
  const sends = calls.filter(([m]) => m !== 'uploadContent')
  expect(sends).toHaveLength(1)
  return sends[0]!
}

const RICH: RichDoc = [{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'hi' }] }] }]
const png = () => new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' })
const pdf = () => new File([new Uint8Array([1, 2, 3, 4])], 'notes.pdf', { type: 'application/pdf' })

describe('outbound content shape (S-a2, pinned before extraction)', () => {
  describe('text', () => {
    it('1. plain text → sendTextMessage(roomId, body, txnId), no content object', async () => {
      const { gateway, calls } = harness()
      await gateway.sendMessage(CHANNEL, { kind: 'text', text: 'hello' })
      expect(calls).toEqual([['sendTextMessage', ROOM_ID, 'hello', TXN]])
    })

    it('2. rich text without relation → sendMessage(roomId, content, txnId)', async () => {
      const { gateway, calls } = harness()
      await gateway.sendMessage(CHANNEL, { kind: 'text', text: 'hi', rich: RICH })
      const [method, roomId, content, txnId, ...rest] = sendCall(calls)
      expect([method, roomId, txnId, rest]).toEqual(['sendMessage', ROOM_ID, TXN, []])
      expect(JSON.stringify(content)).toBe(
        '{"msgtype":"m.text","body":"hi","format":"org.matrix.custom.html","formatted_body":"<p><strong>hi</strong></p>"}',
      )
    })

    it('3a. mention without relation → m.mentions.user_ids, sendMessage(roomId, content, txnId)', async () => {
      const { gateway, calls } = harness()
      await gateway.sendMessage(CHANNEL, { kind: 'text', text: 'hey Bob' }, { mentions: [uid(BOB)] })
      const [method, roomId, content, txnId, ...rest] = sendCall(calls)
      expect([method, roomId, txnId, rest]).toEqual(['sendMessage', ROOM_ID, TXN, []])
      expect(JSON.stringify(content)).toBe(
        '{"msgtype":"m.text","body":"hey Bob","m.mentions":{"user_ids":["@bob:tayet.local"]}}',
      )
    })

    it('3b. mention + thread → sendMessage(roomId, threadRootId, content, txnId)', async () => {
      const { gateway, calls } = harness()
      await gateway.sendMessage(CHANNEL, { kind: 'text', text: 'hey Bob' }, { mentions: [uid(BOB)], thread: mid(ROOT_ID) })
      const [method, roomId, threadId, content, txnId, ...rest] = sendCall(calls)
      expect([method, roomId, threadId, txnId, rest]).toEqual(['sendMessage', ROOM_ID, ROOT_ID, TXN, []])
      expect(JSON.stringify(content)).toBe(
        '{"msgtype":"m.text","body":"hey Bob","m.mentions":{"user_ids":["@bob:tayet.local"]},' +
          '"m.relates_to":{"rel_type":"m.thread","event_id":"$root:tayet.local"}}',
      )
    })

    it('3c. mention + reply → sendMessage(roomId, content, txnId)', async () => {
      const { gateway, calls } = harness()
      await gateway.sendMessage(CHANNEL, { kind: 'text', text: 'hey Bob' }, { mentions: [uid(BOB)], replyTo: mid(TARGET_ID) })
      const [method, roomId, content, txnId, ...rest] = sendCall(calls)
      expect([method, roomId, txnId, rest]).toEqual(['sendMessage', ROOM_ID, TXN, []])
      expect(JSON.stringify(content)).toBe(
        '{"msgtype":"m.text","body":"hey Bob","m.mentions":{"user_ids":["@bob:tayet.local"]},' +
          '"m.relates_to":{"m.in_reply_to":{"event_id":"$target:tayet.local"}}}',
      )
    })

    it('3d. an empty mentions list omits m.mentions (plain text stays on sendTextMessage)', async () => {
      const { gateway, calls } = harness()
      await gateway.sendMessage(CHANNEL, { kind: 'text', text: 'hello' }, { mentions: [] })
      expect(calls).toEqual([['sendTextMessage', ROOM_ID, 'hello', TXN]])
    })

    it('4a. thread (plain text) → sendMessage(roomId, threadRootId, content, txnId)', async () => {
      const { gateway, calls } = harness()
      await gateway.sendMessage(CHANNEL, { kind: 'text', text: 'in thread' }, { thread: mid(ROOT_ID) })
      const [method, roomId, threadId, content, txnId, ...rest] = sendCall(calls)
      expect([method, roomId, threadId, txnId, rest]).toEqual(['sendMessage', ROOM_ID, ROOT_ID, TXN, []])
      expect(JSON.stringify(content)).toBe(
        '{"msgtype":"m.text","body":"in thread","m.relates_to":{"rel_type":"m.thread","event_id":"$root:tayet.local"}}',
      )
    })

    it('4b. thread (rich text) → the rich fragment precedes the relation', async () => {
      const { gateway, calls } = harness()
      await gateway.sendMessage(CHANNEL, { kind: 'text', text: 'hi', rich: RICH }, { thread: mid(ROOT_ID) })
      const [method, roomId, threadId, content, txnId, ...rest] = sendCall(calls)
      expect([method, roomId, threadId, txnId, rest]).toEqual(['sendMessage', ROOM_ID, ROOT_ID, TXN, []])
      expect(JSON.stringify(content)).toBe(
        '{"msgtype":"m.text","body":"hi","format":"org.matrix.custom.html","formatted_body":"<p><strong>hi</strong></p>",' +
          '"m.relates_to":{"rel_type":"m.thread","event_id":"$root:tayet.local"}}',
      )
    })

    it('5. reply → sendMessage(roomId, content, txnId), exact envelope', async () => {
      const { gateway, calls } = harness()
      await gateway.sendMessage(CHANNEL, { kind: 'text', text: 'a reply' }, { replyTo: mid(TARGET_ID) })
      const [method, roomId, content, txnId, ...rest] = sendCall(calls)
      expect([method, roomId, txnId, rest]).toEqual(['sendMessage', ROOM_ID, TXN, []])
      expect(JSON.stringify(content)).toBe(
        '{"msgtype":"m.text","body":"a reply","m.relates_to":{"m.in_reply_to":{"event_id":"$target:tayet.local"}}}',
      )
    })
  })

  describe('6. attachment', () => {
    it('6a. in clear → upload(file, {name, type}), then sendMessage(roomId, content, txnId) with url', async () => {
      const { gateway, calls } = harness()
      const file = png()
      await gateway.sendMessage(CHANNEL, { kind: 'attachment', file })
      expect(calls[0]).toEqual(['uploadContent', file, { name: 'a.png', type: 'image/png' }])
      const [method, roomId, content, txnId, ...rest] = sendCall(calls)
      expect([method, roomId, txnId, rest]).toEqual(['sendMessage', ROOM_ID, TXN, []])
      expect(JSON.stringify(content)).toBe(
        '{"msgtype":"m.image","body":"a.png","url":"mxc://tayet.local/upload","info":{"mimetype":"image/png","size":3}}',
      )
    })

    it('6b. in clear, non-image, in a thread → m.file, relation last, sendMessage(roomId, threadRootId, content, txnId)', async () => {
      const { gateway, calls } = harness()
      await gateway.sendMessage(CHANNEL, { kind: 'attachment', file: pdf() }, { thread: mid(ROOT_ID) })
      const [method, roomId, threadId, content, txnId, ...rest] = sendCall(calls)
      expect([method, roomId, threadId, txnId, rest]).toEqual(['sendMessage', ROOM_ID, ROOT_ID, TXN, []])
      expect(JSON.stringify(content)).toBe(
        '{"msgtype":"m.file","body":"notes.pdf","url":"mxc://tayet.local/upload","info":{"mimetype":"application/pdf","size":4},' +
          '"m.relates_to":{"rel_type":"m.thread","event_id":"$root:tayet.local"}}',
      )
    })

    it('6c. encrypted → upload(ciphertext, opaque), content carries file (envelope + url) instead of url', async () => {
      const { gateway, calls } = harness({ encrypted: true })
      await gateway.sendMessage(CHANNEL, { kind: 'attachment', file: png() })
      expect(calls[0]).toEqual(['uploadContent', CIPHERTEXT, { includeFilename: false, type: 'application/octet-stream' }])
      const [method, roomId, content, txnId, ...rest] = sendCall(calls)
      expect([method, roomId, txnId, rest]).toEqual(['sendMessage', ROOM_ID, TXN, []])
      expect(JSON.stringify(content)).toBe(
        '{"msgtype":"m.image","body":"a.png","file":{"v":"v2","key":{"kty":"oct","key_ops":["encrypt","decrypt"],' +
          '"alg":"A256CTR","k":"test-key","ext":true},"iv":"test-iv","hashes":{"sha256":"test-sha"},' +
          '"url":"mxc://tayet.local/upload"},"info":{"mimetype":"image/png","size":3}}',
      )
    })

    it('6d. encrypted, in a thread → relation last, sendMessage(roomId, threadRootId, content, txnId)', async () => {
      const { gateway, calls } = harness({ encrypted: true })
      await gateway.sendMessage(CHANNEL, { kind: 'attachment', file: png() }, { thread: mid(ROOT_ID) })
      const [method, roomId, threadId, content, txnId, ...rest] = sendCall(calls)
      expect([method, roomId, threadId, txnId, rest]).toEqual(['sendMessage', ROOM_ID, ROOT_ID, TXN, []])
      expect(JSON.stringify(content)).toBe(
        '{"msgtype":"m.image","body":"a.png","file":{"v":"v2","key":{"kty":"oct","key_ops":["encrypt","decrypt"],' +
          '"alg":"A256CTR","k":"test-key","ext":true},"iv":"test-iv","hashes":{"sha256":"test-sha"},' +
          '"url":"mxc://tayet.local/upload"},"info":{"mimetype":"image/png","size":3},' +
          '"m.relates_to":{"rel_type":"m.thread","event_id":"$root:tayet.local"}}',
      )
    })
  })

  describe('7. edit', () => {
    it('7a. plain → sendMessage(roomId, content) with "* " body, m.new_content and m.replace', async () => {
      const { gateway, calls } = harness()
      await gateway.editMessage(mid(TARGET_ID), { kind: 'text', text: 'after' })
      const [method, roomId, content, ...rest] = sendCall(calls)
      expect([method, roomId, rest]).toEqual(['sendMessage', ROOM_ID, []])
      expect(JSON.stringify(content)).toBe(
        '{"msgtype":"m.text","body":"* after","m.new_content":{"msgtype":"m.text","body":"after"},' +
          '"m.relates_to":{"rel_type":"m.replace","event_id":"$target:tayet.local"}}',
      )
    })

    it('7b. rich → the formatted body lives only inside m.new_content', async () => {
      const { gateway, calls } = harness()
      await gateway.editMessage(mid(TARGET_ID), { kind: 'text', text: 'hi', rich: RICH })
      const [method, roomId, content, ...rest] = sendCall(calls)
      expect([method, roomId, rest]).toEqual(['sendMessage', ROOM_ID, []])
      expect(JSON.stringify(content)).toBe(
        '{"msgtype":"m.text","body":"* hi","m.new_content":{"msgtype":"m.text","body":"hi","format":"org.matrix.custom.html",' +
          '"formatted_body":"<p><strong>hi</strong></p>"},"m.relates_to":{"rel_type":"m.replace","event_id":"$target:tayet.local"}}',
      )
    })
  })

  it('8. reaction → sendEvent(roomId, m.reaction, content) with an m.annotation relation', async () => {
    const { gateway, calls } = harness()
    await gateway.react(mid(TARGET_ID), '👍')
    const [method, roomId, eventType, content, ...rest] = sendCall(calls)
    expect([method, roomId, eventType, rest]).toEqual(['sendEvent', ROOM_ID, 'm.reaction', []])
    expect(JSON.stringify(content)).toBe(
      '{"m.relates_to":{"rel_type":"m.annotation","event_id":"$target:tayet.local","key":"👍"}}',
    )
  })

  describe('9. approval answer (ADR-091, A3-2)', () => {
    const ANSWER =
      '{"msgtype":"io.tayet.approval.response","body":"Aprovar","io.tayet.approval.response":{"option":"approve"},"m.relates_to":{"rel_type":"io.tayet.response","event_id":"$card:tayet.local"}}'

    it('9a. in clear → sendEvent(roomId, m.room.message, content, txnId): answer type, label as body, option block, relation last', async () => {
      const { gateway, calls } = harness()
      await gateway.answerApproval(mid(CARD_ID), 'approve')
      const [method, roomId, eventType, content, ...rest] = sendCall(calls)
      expect([method, roomId, eventType, rest]).toEqual(['sendEvent', ROOM_ID, 'm.room.message', [TXN]])
      expect(JSON.stringify(content)).toBe(ANSWER)
    })

    it('9b. encrypted → the same content, the relation at the top level (the SDK’s cipher lifts it into the envelope in clear; with stack: acl-approval)', async () => {
      const { gateway, calls } = harness({ encrypted: true })
      await gateway.answerApproval(mid(CARD_ID), 'approve')
      const [method, roomId, eventType, content, ...rest] = sendCall(calls)
      expect([method, roomId, eventType, rest]).toEqual(['sendEvent', ROOM_ID, 'm.room.message', [TXN]])
      expect(JSON.stringify(content)).toBe(ANSWER)
      expect(Object.keys(content as object).at(-1)).toBe('m.relates_to')
    })
  })
})
