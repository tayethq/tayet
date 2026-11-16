import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, ChannelId, DomainEvent, UserId } from '../../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'
import { HOMESERVER, synapseReachable, mintToken, whoami, join } from '../support/synapse'
import { admitToOrg } from '../support/org-membership'
import { registerUser } from '../support/escrow-harness'
import { until } from '../support/until'

// Gate de integração da fatia de membership/canais (PLANO-MEMBERSHIP-CANAIS §V4 / ADR-026 — issue
// #7). Stack Synapse/MAS real, TOKEN DE USUÁRIO (admin de sala, não de servidor). A variável NOVEL
// é a tradução intenção→protocolo dos verbos congelados (§0.2) contra o servidor real: criar/editar/
// arquivar canal, membership, papel (com os guardrails de PL como REJEIÇÃO LEGÍTIMA) e DM idempotente
// — e o ciclo de vida no stream (channel.added/channel.removed). Usuários FRESCOS por run (register-
// user browserless) para um mundo virgem de m.direct/membership. Auto-skip sem a stack (issue #7);
// fileParallelism:false garante serialização com os demais gates.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

// Migração S3a (PLANO-GATES §8.8): a cópia local do `until` (sem label, mudo no estouro)
// virou o helper compartilhado do PR-B2. Budgets verbatim: timeout segue o default 150s
// (idêntico ao da cópia); o poll de 100ms da cópia vai EXPLÍCITO em cada call site (o
// default do helper é 120ms). Snapshots = o discriminador do M5 candidato (§8.6 item 2):
// "evento nunca chegou" vs "chegou com shape inesperado".
const POLL = { pollMs: 100 }

// Snapshot das esperas de member.changed: o que JÁ chegou no array do observador para o
// canal em questão (canal/user/role) — vazio = o evento nunca surgiu.
const memberChangedSeen = (events: DomainEvent[], channel: ChannelId) => () => {
  const seen = events
    .filter((e): e is Extract<DomainEvent, { t: 'member.changed' }> => e.t === 'member.changed' && e.channelId === channel)
    .map((e) => `${String(e.user)}:${String(e.role)}`)
  return `member.changed vistos para ${String(channel)}: [${seen.join(', ')}]`
}

// Snapshot das esperas baseadas em getMembers: os pares user/role (e state) atuais.
const membersNow = (acl: Acl, channel: ChannelId) => async () => {
  const ms = await acl.getMembers(channel)
  return `membros atuais: [${ms.map((m) => `${String(m.user.id)}:${String(m.role)}:${m.state}`).join(', ')}]`
}

// createRoom/setPowerLevel etc. são rate-limitados (M_LIMIT_EXCEEDED) na stack compartilhada — honra
// retry_after_ms, mesmo padrão do helper rest() e do gate e2e.
async function withRetry<T>(fn: () => Promise<T>, attempts = 12): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const retryAfter = (err as { data?: { retry_after_ms?: number } }).data?.retry_after_ms
      if (retryAfter === undefined || attempt >= attempts) throw err
      await new Promise((r) => setTimeout(r, retryAfter + 200))
    }
  }
}

describe.skipIf(!SYNAPSE)('gate membership/canais — verbos contra Synapse real (ADR-026)', () => {
  const suffix = `${process.pid}${Math.floor(Math.random() * 1e6)}`
  const aliceName = `mca${suffix}` // criadora/owner (PL 100)
  const bobName = `mcb${suffix}`
  const charlieName = `mcc${suffix}` // terceiro usuário (add/remove)

  let aliceAcl: Acl
  let bobAcl: Acl
  let aliceToken: string
  let bobToken: string
  let charlieToken: string
  let bobId: UserId
  let charlieId: UserId
  let aliceId: UserId
  const aliceEvents: DomainEvent[] = []
  const bobEvents: DomainEvent[] = []

  beforeAll(async () => {
    for (const u of [aliceName, bobName, charlieName]) registerUser(u)
    aliceToken = await mintToken(aliceName)
    bobToken = await mintToken(bobName)
    charlieToken = await mintToken(charlieName)
    await admitToOrg(aliceToken, bobToken, charlieToken) // Role deriva de kind (ADR-083 dec. 4).
    aliceId = (await whoami(aliceToken)) as unknown as UserId
    bobId = (await whoami(bobToken)) as unknown as UserId
    charlieId = (await whoami(charlieToken)) as unknown as UserId

    aliceAcl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await aliceAcl.connect(aliceToken as Parameters<Acl['connect']>[0])
    aliceAcl.subscribe((e) => aliceEvents.push(e))

    bobAcl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await bobAcl.connect(bobToken as Parameters<Acl['connect']>[0])
    bobAcl.subscribe((e) => bobEvents.push(e))
  }, 240_000)

  afterAll(async () => {
    await aliceAcl?.disconnect()
    await bobAcl?.disconnect()
  })

  it(
    'createChannel/add/remove/setRole/archive/leave/openDirectMessage — round-trip + stream limpo',
    async () => {
      // ── 1. createChannel (private, topic, convida bob) → channel.added com o Channel correto. ──
      const name = `mc-canal-${suffix}`
      const topic = 'tópico de teste'
      const ch = await withRetry(() =>
        aliceAcl.createChannel({ name, kind: 'private', topic, members: [bobId] }),
      )
      const rawCh = ch as unknown as string

      // O SINAL de ciclo de vida (channel.added) é casado pelo ID estável (retornado por
      // createChannel) — não pelo nome: MyMembership pode disparar quando a sala aparece, antes do
      // m.room.name sincronizar, então o nome do Channel no evento pode ser um placeholder. A
      // metadata (nome/tópico) é verificada à parte via getChannel (que reflete o estado já sincado).
      const added = await until(
        '1: channel.added for created channel on alice stream',
        () =>
          aliceEvents.find(
            (e): e is Extract<DomainEvent, { t: 'channel.added' }> => e.t === 'channel.added' && e.channel.id === ch,
          ),
        POLL,
      )
      expect(added.channel.kind).toBe('private')
      expect(added.channel.archived).toBeUndefined() // ausente = ativo
      expect(findProtocolLeaks(added)).toEqual([])
      const aliceView = await until(
        '1: getChannel reflects name+topic on alice',
        async () => {
          const c = await aliceAcl.getChannel(ch)
          return c.name === `#${name}` && c.topic === topic ? c : undefined
        },
        POLL,
      )
      expect(findProtocolLeaks(aliceView)).toEqual([])

      // bob recebe o convite: a membership dele (invite) chega como member.changed com role null.
      const bobInvited = await until(
        '1: member.changed (invite) for bob on alice stream',
        () => aliceEvents.find((e) => e.t === 'member.changed' && e.channelId === ch && e.user === bobId),
        { ...POLL, snapshot: memberChangedSeen(aliceEvents, ch) },
      )
      expect(findProtocolLeaks(bobInvited)).toEqual([])
      if (bobInvited.t === 'member.changed') expect(bobInvited.role).toBeNull()

      // bob entra (REST, lado do bob) → ele vê o canal nascer no PRÓPRIO stream (channel.added).
      await withRetry(() => join(bobToken, rawCh))
      const bobAdded = await until(
        '1: channel.added on bob stream after join',
        () =>
          bobEvents.find((e): e is Extract<DomainEvent, { t: 'channel.added' }> => e.t === 'channel.added' && e.channel.id === ch),
        POLL,
      )
      expect(findProtocolLeaks(bobAdded)).toEqual([])
      // E alice vê bob virar membro (role 'member', PL 0).
      await until(
        '1: member.changed bob→member on alice stream',
        () =>
          aliceEvents.find(
            (e) => e.t === 'member.changed' && e.channelId === ch && e.user === bobId && e.role === 'member',
          ),
        { ...POLL, snapshot: memberChangedSeen(aliceEvents, ch) },
      )

      // ── 2. addMember/removeMember (terceiro user) → member.changed com role correto. ──
      await withRetry(() => aliceAcl.addMember(ch, charlieId))

      // PR-B (§8.CONVITE): charlie is invited but has NO connected client, so ADR-044 auto-join does
      // NOT fire — this is the window where getMembers surfaces the pending invite as 'invited' (the
      // on-connect truth), with no protocol vocab crossing. (bob can't prove this: his connected ACL
      // client auto-joins the invite instantly, so alice never observes bob as 'invited'.)
      const pendingCharlie = await until(
        '2: getMembers surfaces charlie as invited',
        async () => {
          const ms = await aliceAcl.getMembers(ch)
          return ms.find((m) => m.user.id === charlieId && m.state === 'invited')
        },
        { ...POLL, snapshot: membersNow(aliceAcl, ch) },
      )
      expect(findProtocolLeaks(pendingCharlie)).toEqual([])

      await withRetry(() => join(charlieToken, rawCh))
      const charlieMember = await until(
        '2: member.changed charlie→member on alice stream',
        () =>
          aliceEvents.find(
            (e) => e.t === 'member.changed' && e.channelId === ch && e.user === charlieId && e.role === 'member',
          ),
        { ...POLL, snapshot: memberChangedSeen(aliceEvents, ch) },
      )
      expect(findProtocolLeaks(charlieMember)).toEqual([])

      // Self-heal (§8.CONVITE item 4): charlie's join flips him to 'active' via the SAME getMembers
      // re-fetch — no stream change. The roster converges without polling.
      await until(
        '2: getMembers surfaces charlie as active (self-heal)',
        async () => {
          const ms = await aliceAcl.getMembers(ch)
          return ms.find((m) => m.user.id === charlieId && m.state === 'active')
        },
        { ...POLL, snapshot: membersNow(aliceAcl, ch) },
      )

      await withRetry(() => aliceAcl.removeMember(ch, charlieId))
      await until(
        '2: member.changed charlie→null after remove',
        () =>
          aliceEvents.find(
            (e) => e.t === 'member.changed' && e.channelId === ch && e.user === charlieId && e.role === null,
          ),
        { ...POLL, snapshot: memberChangedSeen(aliceEvents, ch) },
      )

      // ── 3. setRole: alice (100) promove bob a admin (PL 50). ──
      await withRetry(() => aliceAcl.setRole(ch, bobId, 'admin'))
      await until(
        '3: getMembers reflects bob as admin',
        async () => {
          const members = await aliceAcl.getMembers(ch)
          const bob = members.find((m) => m.user.id === bobId)
          return bob?.role === 'admin' ? bob : undefined
        },
        { ...POLL, snapshot: membersNow(aliceAcl, ch) },
      )

      // Guardrail = REJEIÇÃO LEGÍTIMA: bob (admin/50) NÃO rebaixa a criadora (100). O teste afirma a
      // rejeição honesta — não a contorna (ADR-026 §0.2 aresta).
      await expect(bobAcl.setRole(ch, aliceId, 'member')).rejects.toThrow()

      // ── 4. archiveChannel → channel.removed; getChannel traz archived:true; getChannels não lista;
      //       membership de alice CONTINUA join (arquivar não é sair). ──
      await withRetry(() => aliceAcl.archiveChannel(ch))
      const removed = await until(
        '4: channel.removed after archive on alice stream',
        () => aliceEvents.find((e) => e.t === 'channel.removed' && e.channelId === ch),
        POLL,
      )
      expect(removed.t).toBe('channel.removed')
      const archivedChannel = await until(
        '4: getChannel reflects archived:true',
        async () => {
          const c = await aliceAcl.getChannel(ch)
          return c.archived === true ? c : undefined
        },
        POLL,
      )
      expect(findProtocolLeaks(archivedChannel)).toEqual([])
      const list = await aliceAcl.getChannels()
      expect(list.find((c) => c.id === ch)).toBeUndefined() // só-ativos
      // membership preservada: getChannel ainda resolve (a sala não foi esquecida).
      expect((await aliceAcl.getChannel(ch)).id).toBe(ch)

      // ── 4b. getArchivedChannels lista ch; unarchiveChannel → channel.added (só na transição, ADR-076
      //        dec. 2) com archived OMITIDO (dec. 6); ch volta aos ativos e sai dos arquivados. ──
      const archivedList = await aliceAcl.getArchivedChannels()
      expect(archivedList.find((c) => c.id === ch)?.archived).toBe(true)
      expect(findProtocolLeaks(archivedList)).toEqual([])

      const isAddedFor = (e: DomainEvent): e is Extract<DomainEvent, { t: 'channel.added' }> =>
        e.t === 'channel.added' && e.channel.id === ch
      const aliceMark = aliceEvents.length
      const bobMark = bobEvents.length
      await withRetry(() => aliceAcl.unarchiveChannel(ch))
      const unarchived = await until(
        '4b: channel.added after unarchive on alice stream',
        () => aliceEvents.slice(aliceMark).find(isAddedFor),
        POLL,
      )
      expect(unarchived.channel).not.toHaveProperty('archived')
      expect(findProtocolLeaks(unarchived.channel)).toEqual([])
      // bob (membro joinado) vê a mesma transição no PRÓPRIO stream.
      const bobUnarchived = await until(
        '4b: channel.added after unarchive on bob stream',
        () => bobEvents.slice(bobMark).find(isAddedFor),
        POLL,
      )
      expect(bobUnarchived.channel).not.toHaveProperty('archived')

      const activeAgain = await until(
        '4b: getChannels lists ch again',
        async () => (await aliceAcl.getChannels()).find((c) => c.id === ch),
        POLL,
      )
      expect(activeAgain).not.toHaveProperty('archived') // dec. 6: chave ausente, não undefined
      expect((await aliceAcl.getArchivedChannels()).find((c) => c.id === ch)).toBeUndefined()

      // Idempotência de transição: segundo unarchive (já ativo) NÃO emite outro channel.added. Fence
      // observável em vez de sleep: o sync é ordenado, então quando o channel.changed do tópico
      // posterior chega, qualquer efeito do segundo unarchive já foi processado.
      await withRetry(() => aliceAcl.unarchiveChannel(ch))
      const fenceTopic = `fence-${suffix}`
      await withRetry(() => aliceAcl.updateChannel(ch, { topic: fenceTopic }))
      await until(
        '4b: channel.changed (fence topic) on alice stream',
        () =>
          aliceEvents
            .slice(aliceMark)
            .find((e) => e.t === 'channel.changed' && e.channel.id === ch && e.channel.topic === fenceTopic),
        POLL,
      )
      expect(aliceEvents.slice(aliceMark).filter(isAddedFor)).toHaveLength(1)

      // ── 4c. só tópico (#245): updateChannel SEM nome → channel.changed com o tópico novo nos
      // streams de alice E de bob. Contrato ponta a ponta, NÃO discriminante: aqui o tópico também
      // pega carona no channel.changed de unread/receipt do mesmo sync (passa sem o fix); a prova
      // discriminante é test/topic-channel-changed.test.ts. ──
      const topicOnly = `so-topico-${suffix}`
      await withRetry(() => aliceAcl.updateChannel(ch, { topic: topicOnly }))
      const isTopicOnly = (e: DomainEvent): boolean =>
        e.t === 'channel.changed' && e.channel.id === ch && e.channel.topic === topicOnly
      await until('4c: channel.changed (topic only) on alice stream', () => aliceEvents.find(isTopicOnly), POLL)
      await until('4c: channel.changed (topic only) on bob stream', () => bobEvents.find(isTopicOnly), POLL)

      // ── 5. leaveChannel (canal à parte) → channel.removed; forget aplicado (getChannel rejeita). ──
      const ch2 = await withRetry(() =>
        aliceAcl.createChannel({ name: `mc-leave-${suffix}`, kind: 'private' }),
      )
      await until(
        '5: channel.added for second channel on alice stream',
        () => aliceEvents.find((e) => e.t === 'channel.added' && e.channel.id === ch2),
        POLL,
      )
      await withRetry(() => aliceAcl.leaveChannel(ch2))
      await until(
        '5: channel.removed after leave on alice stream',
        () => aliceEvents.find((e) => e.t === 'channel.removed' && e.channelId === ch2),
        POLL,
      )
      // forget: a sala saiu do room list → getChannel não a encontra mais.
      await expect(aliceAcl.getChannel(ch2)).rejects.toThrow()

      // ── 6. openDirectMessage(bob) duas vezes → MESMO ChannelId (idempotência); kind 'dm'. ──
      const dm1 = await withRetry(() => aliceAcl.openDirectMessage(bobId))
      const dm2 = await withRetry(() => aliceAcl.openDirectMessage(bobId))
      expect(dm2).toBe(dm1)
      const dmChannel = await until(
        '6: getChannel resolves DM with kind dm',
        async () => {
          const c = await aliceAcl.getChannel(dm1)
          return c.kind === 'dm' ? c : undefined
        },
        POLL,
      )
      expect(dmChannel.kind).toBe('dm')
      // PR-β seam: the DM carries the interlocutor as Channel.peer (m.direct inverse), and the
      // mxid-shaped peer stays inside the ADR-008 residual (the leak-scan skips it as opaque).
      expect(dmChannel.peer).toBe(bobId)
      expect(findProtocolLeaks(dmChannel)).toEqual([])

      // ── 7. β1b (ADR-044 window): DM name from the PEER MEMBER while the peer never joined. ──
      // charlie has NO connected ACL client (auto-join never fires → stays invited) and NO
      // profile — the discriminator: the SDK-calculated room name for a profileless invitee is
      // mxid-shaped ('@mcc…' after cleaning), so equality with the bare localpart is reachable
      // ONLY via the peer-member path (cleanDisplayName collapses the mxid to its localpart).
      const dmCharlie = await withRetry(() => aliceAcl.openDirectMessage(charlieId))
      const dmCharlieChannel = await until(
        '7: DM name equals charlie localpart via peer member',
        async () => {
          const c = await aliceAcl.getChannel(dmCharlie)
          return c.kind === 'dm' && c.name === charlieName ? c : undefined
        },
        POLL,
      )
      expect(dmCharlieChannel.peer).toBe(charlieId)
      expect(findProtocolLeaks(dmCharlieChannel)).toEqual([])
    },
    240_000,
  )
})

describe('ACL membership (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
