// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, DomainEvent, ChannelId, UserId, MessageId } from '../../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'
import { HOMESERVER, synapseReachable, whoami, createRoom, invite, join, leave, findOwnEvent } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'

// ── Gate de menção OUTBOUND (ADR-037 M2a) — fecha o loop com o inbound M1. ──────────────────
// A envia pelo barrel com `mentions: [B]` (UserId opaco); a ACL resolve UserId→mxid AQUI e emite
// `m.mentions: { user_ids }` no conteúdo. Prova nas DUAS pontas: (1) B recebe a mensagem com
// mentionsMe === true e findProtocolLeaks limpo (nenhum mxid/m.mentions no objeto de domínio);
// (2) o evento na wire tem `m.mentions.user_ids` exato (fail-closed); (3) controle sem menção →
// mentionsMe === false. Sala NÃO-cifrada (createRoom) — o caminho de emissão/push é idêntico ao
// cifrado (8.N3 do PLANO-MENCAO). Auto-skip sem a stack (#7).

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

describe.skipIf(!SYNAPSE)('gate menção outbound — SendOpts.mentions → m.mentions.user_ids (ADR-037 M2a)', () => {
  let aToken: string
  let bToken: string
  let bMxid: string
  let alice: Acl
  let bob: Acl
  let channelId: ChannelId
  let bobUserId: UserId
  let roomId: string
  const bobEvents: DomainEvent[] = []

  beforeAll(async () => {
    const [aUser, bUser] = await freshUsers(['moa', 'mob'])
    aToken = aUser.token
    bToken = bUser.token
    bMxid = await whoami(bToken)

    // A (a remetente) envia pelo barrel; B (a destinatária) avalia a push-rule e coleta o stream.
    alice = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    bob = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await alice.connect(aToken as Parameters<Acl['connect']>[0])
    await bob.connect(bToken as Parameters<Acl['connect']>[0])
    bob.subscribe((e) => bobEvents.push(e))

    // Sala NÃO-cifrada via o harness cru; B é convidado e entra.
    roomId = await createRoom(aToken, { name: `tayet-mention-out-${process.pid}-${Math.floor(Math.random() * 1e6)}` })
    await invite(aToken, roomId, bMxid)
    await join(bToken, roomId)

    // A vê o canal aparecer no stream (channelId de domínio) e descobre o UserId opaco de B via
    // getMembers — exatamente como o @-picker do M2b fará (a UI nunca digita um mxid). Casa o
    // channel.added pelo id da SALA convidada (roomId), não posicionalmente: o join de sessão do
    // canal da org (ADR-045) tornou "um channel.added ambiente pode chegar a qualquer momento" um
    // invariante — o primeiro evento pode ser o canal da org, não esta sala.
    const added = await until(() =>
      bobEvents.find(
        (e): e is Extract<DomainEvent, { t: 'channel.added' }> =>
          e.t === 'channel.added' && (e.channel.id as unknown as string) === roomId,
      ),
    )
    channelId = added.channel.id
    const members = await alice.getMembers(channelId)
    const bobMember = members.find((m) => (m.user.id as unknown as string) === bMxid)
    if (!bobMember) throw new Error('B não encontrado em getMembers')
    bobUserId = bobMember.user.id
  }, 180_000)

  afterAll(async () => {
    try {
      await leave(bToken, roomId)
      await leave(aToken, roomId)
    } catch {
      /* best-effort */
    }
    await alice?.disconnect()
    await bob?.disconnect()
  })

  it('A envia com mentions: [B] → B recebe mentionsMe === true (sem vazar protocolo)', async () => {
    const text = 'oi, dá uma olhada nisso por favor'
    const messageId: MessageId = await alice.sendMessage(channelId, { kind: 'text', text }, { mentions: [bobUserId] })

    const received = await until(() =>
      bobEvents.find(
        (e): e is Extract<DomainEvent, { t: 'message.received' }> =>
          e.t === 'message.received' && e.message.body.kind === 'text' && e.message.body.text === text,
      ),
    )
    expect(received.message.mentionsMe).toBe(true)
    expect(received.message.mine).toBe(false)
    // P1: nenhum mxid/m.mentions no objeto de domínio que cruzou o barrel.
    expect(findProtocolLeaks(received)).toEqual([])

    // Wire fail-closed: o evento que A emitiu carrega EXATAMENTE m.mentions.user_ids === [bMxid].
    const raw = await findOwnEvent(aToken, roomId, messageId as unknown as string)
    expect((raw.content['m.mentions'] as { user_ids: string[] }).user_ids).toEqual([bMxid])
  }, 180_000)

  it('controle: A envia sem mentions → B vê mentionsMe === false', async () => {
    const text = 'mensagem normal sem menção (outbound)'
    await alice.sendMessage(channelId, { kind: 'text', text })

    const received = await until(() =>
      bobEvents.find(
        (e): e is Extract<DomainEvent, { t: 'message.received' }> =>
          e.t === 'message.received' && e.message.body.kind === 'text' && e.message.body.text === text,
      ),
    )
    expect(received.message.mentionsMe).toBe(false)
  }, 180_000)
})

describe('gate menção outbound (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
