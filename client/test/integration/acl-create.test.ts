import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { admitToOrg } from '../support/org-membership'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, ChannelId, DomainEvent, UserId } from '../../src/acl'
import { HOMESERVER, synapseReachable, mintToken, whoami } from '../support/synapse'
import { registerUser } from '../support/escrow-harness'

// Gate de integração da fatia U3 (criar canal / abrir DM) — a VARIÁVEL NOVEL é o seam S1: a UI
// seleciona a sala recém-criada on-`channel.added`, NÃO selecionando o id imediatamente. Achado vivo
// (medido contra matrix-js-sdk 41.6.0, §8.U3): ao contrário da premissa original, `getMembers(id)`
// RESOLVE logo após createChannel/openDirectMessage (a sala já está no store quando o verbo resolve).
// Por isso o select-on-added é DEFENSIVO (race-robust), não corretivo: o que provamos aqui é o sinal
// do qual a UI depende — o `channel.added` casado pelo id retornado dispara — E que getMembers
// resolve com a criadora (a seleção on-added nunca encontra sala ausente). (A reconciliação completa
// e o ciclo de vida estão em acl-membership.test.ts; aqui isolamos S1 + idempotência de DM.)
// Auto-skip sem a stack (issue #7); fileParallelism:false serializa os gates.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

async function until<T>(get: () => T | undefined | Promise<T | undefined>, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 100))
  }
}

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

describe.skipIf(!SYNAPSE)('gate criação/DM — seam S1 + idempotência (ADR-029, Track U/U3)', () => {
  const suffix = `${process.pid}${Math.floor(Math.random() * 1e6)}`
  const aliceName = `u3a${suffix}`
  const bobName = `u3b${suffix}`

  let aliceAcl: Acl
  let aliceToken: string
  let bobId: UserId
  const aliceEvents: DomainEvent[] = []

  beforeAll(async () => {
    for (const u of [aliceName, bobName]) registerUser(u)
    aliceToken = await mintToken(aliceName)
    const bobToken = await mintToken(bobName)
    bobId = (await whoami(bobToken)) as unknown as UserId
    await admitToOrg(aliceToken, bobToken) // Role deriva de kind (ADR-083 dec. 4).

    aliceAcl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await aliceAcl.connect(aliceToken as Parameters<Acl['connect']>[0])
    aliceAcl.subscribe((e) => aliceEvents.push(e))
  }, 240_000)

  afterAll(async () => {
    await aliceAcl?.disconnect()
  })

  it(
    'createChannel: channel.added casa o id retornado e getMembers resolve (base viva de S1)',
    async () => {
      const id = (await withRetry(() =>
        aliceAcl.createChannel({ name: `u3-s1-${suffix}`, kind: 'private' }),
      )) as ChannelId

      // O sinal do qual a UI depende: o channel.added casado pelo ID estável (retornado pelo verbo)
      // — é nele que o select-on-added arma a seleção. Casa por id, não por nome (o m.room.name pode
      // sincar depois; o nome no evento pode ser placeholder — ver acl-membership.test.ts).
      const added = await until(() =>
        aliceEvents.find(
          (e): e is Extract<DomainEvent, { t: 'channel.added' }> =>
            e.t === 'channel.added' && e.channel.id === id,
        ),
      )
      expect(added.channel.kind).toBe('private')

      // Pós-added: getMembers RESOLVE com a criadora já presente — confirma que a seleção on-added nunca
      // encontra sala ausente. (NB: isto mede o instante PÓS-`channel.added`, não o verbo-resolve; a medição
      // do momento verbo-resolve foi exploratória — §8.U3 — e não está isolada aqui.) O papel pode ser
      // 'member' agora (m.room.power_levels sinca depois); reconcilia para 'admin' (PL 100) via until.
      const postAdded = await aliceAcl.getMembers(id)
      expect(postAdded.length).toBeGreaterThanOrEqual(1)
      await until(async () => {
        const ms = await aliceAcl.getMembers(id)
        return ms.some((m) => m.role === 'admin') ? ms : undefined
      })
    },
    240_000,
  )

  // ADR-045: cifragem derivada da visibilidade. Par positivo/negativo provado NO FIO (fetch cru do
  // /state/m.room.encryption com o token do CRIADOR — member-gated, §8.ORG-1 item 2 — não pela API do
  // SDK): public NASCE em claro (404, sem estado de cifra), private nasce com Megolm.
  async function readEncryptionState(roomIdRaw: string): Promise<Response> {
    return fetch(
      `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomIdRaw)}/state/m.room.encryption/`,
      { headers: { Authorization: `Bearer ${aliceToken}` } },
    )
  }

  it('createChannel({ kind: public }) nasce EM CLARO — sem m.room.encryption (ADR-045)', async () => {
    const id = (await withRetry(() =>
      aliceAcl.createChannel({ name: `u3-pub-${suffix}`, kind: 'public' }),
    )) as ChannelId
    const res = await readEncryptionState(id as unknown as string)
    expect(res.status).toBe(404)
  }, 240_000)

  it('createChannel({ kind: private }) nasce com Megolm — m.room.encryption presente (ADR-045)', async () => {
    const id = (await withRetry(() =>
      aliceAcl.createChannel({ name: `u3-priv-${suffix}`, kind: 'private' }),
    )) as ChannelId
    const res = await readEncryptionState(id as unknown as string)
    expect(res.ok).toBe(true)
    expect(((await res.json()) as { algorithm?: string }).algorithm).toBe('m.megolm.v1.aes-sha2')
  }, 240_000)

  it('openDirectMessage é idempotente: mesmo ChannelId, sem duplicar canal', async () => {
    const dm1 = await withRetry(() => aliceAcl.openDirectMessage(bobId))
    const dm2 = await withRetry(() => aliceAcl.openDirectMessage(bobId))
    expect(dm2).toBe(dm1)

    await until(() =>
      aliceEvents.find((e) => e.t === 'channel.added' && e.channel.id === dm1),
    )
    const dms = (await aliceAcl.getChannels()).filter((c) => c.id === dm1)
    expect(dms.length).toBe(1)
    expect(dms[0]!.kind).toBe('dm')
  }, 240_000)

  // PLANO-PRESENCA §8.6 item 2: o guard rejeita ANTES de qualquer escrita. A testemunha é no fio
  // (fetch cru do account data com o token da própria alice, mesmo idioma do readEncryptionState):
  // o m.direct dela permanece sem entrada-self — nada foi criado antes do throw.
  it('openDirectMessage(self) rejeita e o m.direct permanece sem entrada-self', async () => {
    const aliceId = await whoami(aliceToken)
    await expect(aliceAcl.openDirectMessage(aliceId as unknown as UserId)).rejects.toThrow(
      'Cannot open a direct message with yourself',
    )
    const res = await fetch(
      `${HOMESERVER}/_matrix/client/v3/user/${encodeURIComponent(aliceId)}/account_data/m.direct`,
      { headers: { Authorization: `Bearer ${aliceToken}` } },
    )
    if (res.ok) {
      // O teste anterior pode já ter escrito a entrada do bob — o que NÃO pode existir é a self.
      const content = (await res.json()) as Record<string, unknown>
      expect(Object.keys(content)).not.toContain(aliceId)
    } else {
      // Nunca escrito nesta conta — igualmente sem entrada-self.
      expect(res.status).toBe(404)
    }
  }, 240_000)
})
