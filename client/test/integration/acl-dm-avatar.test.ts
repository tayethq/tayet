import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, DomainEvent, UserId } from '../../src/acl'
import { HOMESERVER, synapseReachable, whoami } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { until } from '../support/until'

// PLANO-PRESENCA §8.6 item 3 — prova viva do alargamento: numa DM A↔B, B trocar o PRÓPRIO
// avatar re-traduz o canal do lado de A (channel.changed da DM com peerAvatar fresco). Duas
// rodadas: a primeira prova peerAvatar PRESENTE; a segunda prova que ele MUDA (fresco, não
// memoizado). peerAvatar é opaco (OPAQUE_ID_KEYS) — comparado como string opaca, nunca parseado.
// Auto-skip sem a stack (issue #7).

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

// createRoom é rate-limitado (M_LIMIT_EXCEEDED) na stack compartilhada — honra retry_after_ms.
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

describe.skipIf(!SYNAPSE)('gate DM — peerAvatar fresco no member event do peer (§8.6 item 3)', () => {
  let aclA: Acl
  let aclB: Acl
  let bId: UserId
  const aEvents: DomainEvent[] = []

  beforeAll(async () => {
    const [a, b] = await freshUsers(['dva', 'dvb'])
    bId = (await whoami(b.token)) as unknown as UserId

    aclA = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await aclA.connect(a.token as Parameters<Acl['connect']>[0])
    aclA.subscribe((e) => aEvents.push(e))

    // B conectado com ACL: o lado invitee do ADR-044 (auto-join) — sem ele o join do B nunca
    // aterrissa e não há member event do peer para alargar.
    aclB = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await aclB.connect(b.token as Parameters<Acl['connect']>[0])
  }, 240_000)

  afterAll(async () => {
    await aclA?.disconnect()
    await aclB?.disconnect()
  })

  it(
    'B troca o próprio avatar → channel.changed da DM com peerAvatar presente e depois DIFERENTE',
    async () => {
      const dmId = await withRetry(() => aclA.openDirectMessage(bId))

      // Evidência no estouro (norma #153): só os TIPOS de evento vistos por A — nenhum payload.
      const snapshot = () => aEvents.map((e) => e.t).join(',')

      // Espera o JOIN do B aterrissar do lado de A (member.changed com role não-nulo): a partir
      // daqui, mudanças de perfil do B chegam como member events da sala.
      await until(
        'B join lands on A (member.changed, role != null)',
        () =>
          aEvents.find(
            (e) => e.t === 'member.changed' && e.channelId === dmId && e.user === bId && e.role !== null,
          ),
        { snapshot },
      )

      // Rodada 1: avatar novo → o alargamento re-traduz e o canal ganha peerAvatar.
      await aclB.setAvatar(new File([new Uint8Array([0x89, 1, 2, 3])], 'one.png', { type: 'image/png' }))
      const first = await until(
        'round 1: channel.changed with peerAvatar',
        () => {
          const e = aEvents.find(
            (ev): ev is Extract<DomainEvent, { t: 'channel.changed' }> =>
              ev.t === 'channel.changed' && ev.channel.id === dmId && ev.channel.peerAvatar !== undefined,
          )
          return e?.channel.peerAvatar
        },
        { snapshot },
      )

      // Rodada 2: TROCA de avatar → peerAvatar re-traduzido é outro ref opaco (fresco, não stale).
      await aclB.setAvatar(new File([new Uint8Array([0x89, 9, 8, 7])], 'two.png', { type: 'image/png' }))
      const second = await until(
        'round 2: channel.changed with DIFFERENT peerAvatar',
        () => {
          const e = aEvents.find(
            (ev): ev is Extract<DomainEvent, { t: 'channel.changed' }> =>
              ev.t === 'channel.changed' &&
              ev.channel.id === dmId &&
              ev.channel.peerAvatar !== undefined &&
              String(ev.channel.peerAvatar) !== String(first),
          )
          return e?.channel.peerAvatar
        },
        { snapshot },
      )
      expect(String(second)).not.toBe(String(first))
    },
    240_000,
  )
})

// Marcador sempre-presente para o arquivo nunca ser suíte vazia com a stack down.
describe('gate DM peerAvatar (availability)', () => {
  it(SYNAPSE ? 'stack reachable — integration ran' : 'stack down — integration skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
