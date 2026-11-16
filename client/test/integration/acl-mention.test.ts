// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, DomainEvent } from '../../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'
import {
  HOMESERVER,
  synapseReachable,
  whoami,
  createRoom,
  invite,
  join,
  leave,
  sendMention,
  sendText,
} from '../support/synapse'
import { freshUsers } from '../support/fresh-users'

// ── Gate de menção inbound (ADR-037 addendum M1) — falsifica m.mentions end-to-end. ─────────
// B menciona A (m.mentions.user_ids com o mxid de A, abaixo do barrel). A ACL deriva mentionsMe da
// INTENÇÃO declarada nesse m.mentions (espelho inbound do M2), NÃO mais do tweak highlight da
// push-rule (que casava display name como substring). Sala NÃO-cifrada (createRoom private_chat):
// m.mentions vai cleartext e é lido direto do conteúdo — idêntico ao caminho cifrado pós-decrypt
// (avalia o evento decifrado); o teste E2EE×menção (timing decrypt) fica deferido. Auto-skip sem a
// stack (#7).

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

async function until<T>(get: () => T | undefined | Promise<T | undefined>, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 60))
  }
}

describe.skipIf(!SYNAPSE)('gate menção inbound — m.mentions → mentionsMe (ADR-037 addendum M1)', () => {
  let aToken: string
  let bToken: string
  let aMxid: string
  let alice: Acl
  let roomId: string
  const aliceEvents: DomainEvent[] = []

  beforeAll(async () => {
    const [aUser, bUser] = await freshUsers(['mna', 'mnb'])
    aToken = aUser.token
    bToken = bUser.token
    aMxid = await whoami(aToken)

    // A (a destinatária) é quem avalia a push-rule — conecta a ACL e coleta o stream.
    alice = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await alice.connect(aToken as Parameters<Acl['connect']>[0])
    alice.subscribe((e) => aliceEvents.push(e))

    // Sala NÃO-cifrada criada via o harness cru (A surfaça o canal); B é convidado e entra.
    roomId = await createRoom(aToken, { name: `tayet-mention-${process.pid}-${Math.floor(Math.random() * 1e6)}` })
    const bMxid = await whoami(bToken)
    await invite(aToken, roomId, bMxid)
    await join(bToken, roomId)

    // Garante que A já sincronizou (push-rules carregadas) antes dos envios de B: espera a SALA
    // convidada (roomId) aparecer no stream de A. Casa pelo id, não posicionalmente: o join de
    // sessão do canal da org (ADR-045) tornou "um channel.added ambiente pode chegar a qualquer
    // momento" um invariante — o primeiro evento pode ser o canal da org, não esta sala.
    await until(
      () =>
        aliceEvents.find((e) => e.t === 'channel.added' && (e.channel.id as unknown as string) === roomId) ??
        undefined,
    )
  }, 180_000)

  afterAll(async () => {
    try {
      await leave(bToken, roomId)
      await leave(aToken, roomId)
    } catch {
      /* best-effort */
    }
    await alice?.disconnect()
  })

  it('B menciona A (m.mentions) → A recebe a mensagem com mentionsMe === true', async () => {
    await sendMention(bToken, roomId, aMxid, 'oi @você, dá uma olhada nisso')
    const received = await until(() =>
      aliceEvents.find(
        (e): e is Extract<DomainEvent, { t: 'message.received' }> =>
          e.t === 'message.received' &&
          e.message.body.kind === 'text' &&
          e.message.body.text === 'oi @você, dá uma olhada nisso',
      ),
    )
    expect(received.message.mentionsMe).toBe(true)
    expect(received.message.mine).toBe(false)
  }, 180_000)

  it('controle: B envia sem menção → A vê mentionsMe === false', async () => {
    await sendText(bToken, roomId, 'mensagem normal sem menção')
    const received = await until(() =>
      aliceEvents.find(
        (e): e is Extract<DomainEvent, { t: 'message.received' }> =>
          e.t === 'message.received' &&
          e.message.body.kind === 'text' &&
          e.message.body.text === 'mensagem normal sem menção',
      ),
    )
    expect(received.message.mentionsMe).toBe(false)
  }, 180_000)

  it('P1: nenhum DomainEvent de A carrega vocabulário de protocolo (mentionsMe é booleano)', () => {
    expect(aliceEvents.length).toBeGreaterThan(0)
    for (const e of aliceEvents) expect(findProtocolLeaks(e)).toEqual([])
  })
})

describe('gate menção inbound (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
