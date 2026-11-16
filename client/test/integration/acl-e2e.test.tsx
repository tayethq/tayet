// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, DomainEvent, ChannelId, MessageId, RichDoc } from '../../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'
import { HOMESERVER, synapseReachable, whoami, invite, join, leave, getMessages } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { until as untilLabeled } from '../support/until'

// ── Gate de integração ACL↔Synapse CIFRADO (PLANO-FASE-2 §6.2) — asserts 1–5 e 7. ──────────
// Dois clientes MAS com rust-crypto contra a dev-stack, numa sala CIFRADA POR PADRÃO criada
// pela ACL (gateway.createChannel — Megolm no initial_state, nenhum parâmetro de cifra no
// barrel). Auto-skip sem a stack (PF-3 / issue #7).
//
// O assert 6 original ("device novo pós-envios → antigas unavailable") INVERTEU DE SINAL com o
// backup automático da fatia C2 — exatamente como a nota de fixture do PLANO-FASE-2 §8 previu.
// O teste foi REAPROVEITADO (não apagado, não duplicado) como assert positivo de recuperação no
// gate da C2: `acl-escrow-recovery.test.tsx` assert 2 (cold start decifra o histórico) carrega
// a linhagem; o assert 5 de lá (escrow indisponível → unavailable + upgrade) preserva a
// cobertura P4/DOM que vivia aqui. Esta suíte roda SEM escrow provisionado (env ausente), onde
// o comportamento da fatia A segue válido — e coberto pelos asserts que ficaram.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

const RICH: RichDoc = [
  { t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'negrito' }] }, { t: 'text', text: ' cifrado' }] },
]

// Crypto/protocol vocabulary that must never appear in a domain shape or the DOM (assert 7;
// complements the structural leak-scan).
const CRYPTO_TERMS = ['m.bad.encrypted', 'ciphertext', 'megolm', 'm.room.encrypted', 'unable to decrypt', 'session_id']
function assertNoCryptoVocab(value: unknown, label: string): void {
  const json = JSON.stringify(value).toLowerCase()
  for (const term of CRYPTO_TERMS) {
    expect(json, `${label} must not carry "${term}"`).not.toContain(term)
  }
}

async function until<T>(get: () => T | undefined | Promise<T | undefined>, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 60))
  }
}

describe.skipIf(!SYNAPSE)('gate E2E — sala cifrada criada pela ACL (7 asserts §6.2)', () => {
  let aliceToken: string
  let bobToken: string
  let alice: MatrixGateway
  let bob: Acl
  let channelId: ChannelId
  let roomIdRaw: string
  const aliceEvents: DomainEvent[] = []
  const bobEvents: DomainEvent[] = []

  // Set by the tests in order (vitest runs them sequentially within the file).
  let sentId: MessageId // alice's stable id of message 1 (her txn)
  let firstRealId: string // message 1 as bob sees it (the real event id)

  beforeAll(async () => {
    const [aliceUser, bobUser] = await freshUsers(['eea', 'eeb'])
    aliceToken = aliceUser.token
    bobToken = bobUser.token
    alice = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await alice.connect(aliceToken as Parameters<Acl['connect']>[0])
    alice.subscribe((e) => aliceEvents.push(e))
    bob = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await bob.connect(bobToken as Parameters<Acl['connect']>[0])
    bob.subscribe((e) => bobEvents.push(e))

    // Sala cifrada POR PADRÃO criada pela ACL (§4.4) — nenhum parâmetro de cifra. Honra o
    // rate limiter da stack compartilhada (mesmo padrão do helper rest(): retry em 429).
    channelId = await (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await alice.createChannel({ name: `tayet-e2e-${process.pid}-${Math.floor(Math.random() * 1e6)}`, kind: 'private' })
        } catch (err) {
          const retryAfter = (err as { data?: { retry_after_ms?: number } }).data?.retry_after_ms
          if (retryAfter === undefined || attempt >= 10) throw err
          await new Promise((r) => setTimeout(r, retryAfter + 200))
        }
      }
    })()
    roomIdRaw = channelId as unknown as string

    // Prova no wire que a sala JÁ NASCEU cifrada (estado Megolm presente).
    const stateRes = await fetch(
      `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomIdRaw)}/state/m.room.encryption/`,
      { headers: { Authorization: `Bearer ${aliceToken}` } },
    )
    expect(stateRes.ok).toBe(true)
    expect(((await stateRes.json()) as { algorithm?: string }).algorithm).toBe('m.megolm.v1.aes-sha2')

    const bobMxid = await whoami(bobToken)
    await invite(aliceToken, roomIdRaw, bobMxid)
    await join(bobToken, roomIdRaw)
    // ADR-058: sendMessage rejects for a channel the session does not know yet; wait for it.
    await untilLabeled(
      'channel known to alice before the first send',
      async () => ((await alice.getChannels()).some((c) => c.id === channelId) ? true : undefined),
      {
        snapshot: async () => {
          const chs = await alice.getChannels()
          return `known=${chs.length} hasChannelId=${chs.some((c) => c.id === channelId)}`
        },
      },
    )
  }, 180_000)

  afterAll(async () => {
    // Higiene best-effort: com usuários frescos por-run, a sala cifrada é órfã de qualquer forma
    // — o usuário do próximo run é outro e nunca sinca esta sala. O leave só mantém a lista de
    // salas do servidor enxuta; já não guarda contra o flood de UISI cross-suite que a alice
    // REUSADA causava (cada run cunhava um device novo na MESMA conta — a causa-raiz do #32).
    // Teardown jamais falha a suíte.
    try {
      await leave(bobToken, roomIdRaw)
      await leave(aliceToken, roomIdRaw)
    } catch {
      /* best-effort */
    }
    await alice?.disconnect()
    await bob?.disconnect()
  })

  it('1. echo sob cifra: pending instantâneo → sent com o MESMO MessageId (ADR-010)', async () => {
    sentId = await alice.sendMessage(channelId, { kind: 'text', text: 'cifrada um' })
    const pendingIdx = aliceEvents.findIndex(
      (e) =>
        e.t === 'message.received' &&
        e.message.id === sentId &&
        e.message.status === 'pending' &&
        e.message.body.kind === 'text' &&
        e.message.body.text === 'cifrada um',
    )
    expect(pendingIdx, 'pending echo with the stable id was emitted').toBeGreaterThanOrEqual(0)
    const sent = await until(() => {
      const i = aliceEvents.findIndex((e) => e.t === 'message.status' && e.messageId === sentId && e.status === 'sent')
      return i >= 0 ? i : undefined
    })
    expect(sent, 'anti-flicker: pending precede o sent sob o mesmo id').toBeGreaterThan(pendingIdx)
  }, 180_000)

  it('2. edição rica sob cifra: receptor recebe message.edited com o RichDoc íntegro (ADR-012)', async () => {
    // Bob primeiro recebe a mensagem original (decifrada) — o id dele é o event id real.
    const received = await until(() =>
      bobEvents.find(
        (e): e is Extract<DomainEvent, { t: 'message.received' }> =>
          e.t === 'message.received' && e.message.body.kind === 'text' && e.message.body.text === 'cifrada um',
      ),
    )
    firstRealId = received.message.id as unknown as string
    expect(received.message.body.kind).toBe('text')

    await alice.editMessage(sentId, { kind: 'text', text: 'cifrada editada', rich: RICH })
    const edited = await until(() =>
      bobEvents.find(
        (e): e is Extract<DomainEvent, { t: 'message.edited' }> =>
          e.t === 'message.edited' && e.message.body.kind === 'text' && e.message.body.text === 'cifrada editada',
      ),
    )
    expect(edited.message.id as unknown as string).toBe(firstRealId)
    if (edited.message.body.kind === 'text') expect(edited.message.body.rich).toEqual(RICH)
  }, 180_000)

  it('3. reply sob cifra: receptor recebe replyTo correto (ADR-011; relationsOf íntegro)', async () => {
    await alice.sendMessage(channelId, { kind: 'text', text: 'resposta cifrada' }, { replyTo: sentId })
    const reply = await until(() =>
      bobEvents.find(
        (e): e is Extract<DomainEvent, { t: 'message.received' }> =>
          e.t === 'message.received' && e.message.body.kind === 'text' && e.message.body.text === 'resposta cifrada',
      ),
    )
    expect(reply.message.replyTo as unknown as string).toBe(firstRealId)
    expect(reply.message.threadParent).toBeUndefined()
  }, 180_000)

  it('4. threads + reactions smoke sob cifra', async () => {
    await alice.sendMessage(channelId, { kind: 'text', text: 'na thread cifrada' }, { thread: sentId })
    const threaded = await until(() =>
      bobEvents.find(
        (e): e is Extract<DomainEvent, { t: 'message.received' }> =>
          e.t === 'message.received' && e.message.body.kind === 'text' && e.message.body.text === 'na thread cifrada',
      ),
    )
    expect(threaded.message.threadParent as unknown as string).toBe(firstRealId)

    await alice.react(sentId, '👍')
    const reacted = await until(() =>
      bobEvents.find(
        (e): e is Extract<DomainEvent, { t: 'reaction.changed' }> =>
          e.t === 'reaction.changed' &&
          (e.messageId as unknown as string) === firstRealId &&
          e.reactions.some((r) => r.emoji === '👍' && r.count >= 1),
      ),
    )
    expect(reacted.reactions.find((r) => r.emoji === '👍')).toBeDefined()
  }, 180_000)

  it('5. ciphertext no wire: mensagem, edição E reply são m.room.encrypted sem texto claro', async () => {
    const raw = await getMessages(aliceToken, roomIdRaw, 50)
    const encrypted = raw.filter((e) => e.type === 'm.room.encrypted')
    expect(encrypted.length).toBeGreaterThanOrEqual(4) // msg + edit + reply + thread reply

    type Relates = { rel_type?: string; is_falling_back?: boolean; 'm.in_reply_to'?: { event_id?: string } }
    const byRelation = (pred: (r: Relates | undefined) => boolean) =>
      encrypted.find((e) => pred(e.content['m.relates_to'] as Relates | undefined))

    const original = raw.find((e) => e.unsigned?.transaction_id === (sentId as unknown as string))
    const edit = byRelation((r) => r?.rel_type === 'm.replace')
    const reply = byRelation((r) => !r?.rel_type && !!r?.['m.in_reply_to']?.event_id)
    const thread = byRelation((r) => r?.rel_type === 'm.thread')

    for (const [label, ev] of Object.entries({ original, edit, reply, thread })) {
      expect(ev, `${label} found on the wire`).toBeDefined()
      expect(ev!.type, `${label} is encrypted on the wire`).toBe('m.room.encrypted')
      expect(ev!.content.ciphertext, `${label} carries ciphertext`).toBeTruthy()
      const json = JSON.stringify(ev!.content)
      for (const clear of ['cifrada um', 'cifrada editada', 'resposta cifrada', 'na thread cifrada', 'negrito']) {
        expect(json, `${label}: cleartext absent from raw content`).not.toContain(clear)
      }
    }
    // Builder manual intocado sob cifra (FIX 1 / PF-1 item 5): a relação de thread no ENVELOPE
    // é limpa — sem is_falling_back, sem m.in_reply_to injetado. A de reply é exatamente
    // m.in_reply_to, sem rel_type.
    const threadRel = thread!.content['m.relates_to'] as Relates
    expect(threadRel.is_falling_back).toBeUndefined()
    expect(threadRel['m.in_reply_to']).toBeUndefined()
    const replyRel = reply!.content['m.relates_to'] as Relates
    expect(replyRel.rel_type).toBeUndefined()
  }, 180_000)

  // (assert 6 — INVERTIDO pela fatia C2, nota de fixture do PLANO-FASE-2 §8: o corpo deste
  // teste vive agora, com sinal positivo, em acl-escrow-recovery.test.tsx assert 2; o modo
  // degradado — sem escrow alcançável → unavailable + upgrade — é o assert 5 de lá.)

  it('7. P1 no stream: nenhum DomainEvent carrega vocabulário de protocolo de cripto', () => {
    expect(aliceEvents.length).toBeGreaterThan(0)
    expect(bobEvents.length).toBeGreaterThan(0)
    for (const e of [...aliceEvents, ...bobEvents]) {
      expect(findProtocolLeaks(e)).toEqual([])
      assertNoCryptoVocab(e, 'stream event')
    }
  })
})

describe('gate E2E (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
