import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, ChannelId, DomainEvent } from '../../src/acl'
import { HOMESERVER, synapseReachable, whoami, invite, leave, findOwnEvent } from '../support/synapse'
import { registerUser } from '../support/escrow-harness'
import { mintOidcSession } from '../support/mint-oidc'
import { until } from '../support/until'

// ── Gate do INVARIANTE (PR-5 do track CRIPTO-COBERTURA — a prova viva da ADR-057) ──────────
// Automatiza a repro original de Jul/2026 (3 repros manuais, Contexto da ADR-057) contra a
// stack real COM o agente de custódia de pé: a janela do device zumbi — store local morto sem
// logout, device segue alvo do fan-out, backup nunca recebe a sessão — que tornava a mensagem
// irrecuperável para sempre. Com a cadeia inteira do track (dec. 2/3: cofre no nascimento;
// PR-2/3: depósito; dec. 6: recovery consulta a custódia e importa o delta), o acesso novo
// DECRIPTA. O assert central deste arquivo é o vínculo de Conformidade da ADR-057.
//
// No mesmo mundo, o veredito definitivo (dec. 7) é provado nos dois sentidos:
//  - nunca um `lost` FALSO para a mensagem coberta (nem na janela pré-import);
//  - um `lost` VERDADEIRO para o controle negativo — evento de sessão fora do endereçamento
//    de B (norma 1: sala em que B entrou depois do nascimento da sessão), com consulta feita.
//
// Escrow da DEV-STACK (não spawnado): o depósito vem do agente `cofre` real — é a cadeia de
// produção inteira, não um harness. Usuários frescos por run (causa-raiz #32); auto-skip sem a
// stack (issue #7). OIDC headless para os tokens (idioma do gate C2): a recovery usa o MESMO
// token para Matrix e escrow.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ESCROW = process.env.TAYET_ESCROW_URL ?? 'http://localhost:8090'

const authed = (token: string): { headers: { Authorization: string } } => ({
  headers: { Authorization: `Bearer ${token}` },
})

async function withRetry<T>(fn: () => Promise<T>, attempts = 20): Promise<T> {
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

async function membership(token: string, roomId: string, userId: string): Promise<string | null> {
  const res = await fetch(
    `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(userId)}`,
    authed(token),
  )
  if (res.status !== 200) return null
  return ((await res.json()) as { membership?: string }).membership ?? null
}

// F5: o retrieve filtra por `requester ∈ endereçados` — a MESMA consulta que a recovery da
// dec. 6 faz. Aqui é a âncora determinística do gate: o depósito do agente aconteceu E o
// requester está endereçado.
async function retrievedSessionIds(token: string): Promise<string[]> {
  const res = await fetch(`${ESCROW}/v1/sessions`, authed(token))
  if (res.status !== 200) throw new Error(`retrieve -> ${res.status}`)
  const { sessions } = (await res.json()) as { sessions: Array<{ session_id?: string }> }
  return sessions.map((s) => s.session_id ?? '')
}

// session_id do envelope cifrado NA WIRE (o que a ACL nunca deixa cruzar). ADR-010: sendMessage
// devolve o id ESTÁVEL (txn para envios próprios) — a resolução passa por findOwnEvent.
async function sessionIdOf(token: string, roomId: string, domainMessageId: string): Promise<string> {
  const ev = await findOwnEvent(token, roomId, domainMessageId)
  const content = ev.content as { algorithm?: string; session_id?: string }
  expect(content.algorithm).toBe('m.megolm.v1.aes-sha2')
  expect(typeof content.session_id).toBe('string')
  return content.session_id!
}

const backupReady = (token: string) => async (): Promise<true | undefined> => {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/room_keys/version`, authed(token))
  return res.status === 200 ? true : undefined
}

const MSG1 = 'mensagem um do invariante'
const MSGX = 'sessao fora do enderecamento de B'

describe.skipIf(!SYNAPSE)('gate do invariante — device zumbi + acesso novo decripta (ADR-057, prova viva)', () => {
  const suffix = `${process.pid}${Math.floor(Math.random() * 1e6)}`
  const userA = `iva${suffix}`
  const userB = `ivb${suffix}`

  let prevEnv: string | undefined
  let tokenA: string
  let tokenB1: string
  let mxidB: string
  let alice: Acl
  let bob2: Acl | undefined
  let channelId: ChannelId
  let roomIdRaw: string
  let deadRoomId: ChannelId
  let deadRoomRaw: string
  let session1: string
  let sessionX: string
  const bob2Events: DomainEvent[] = []
  // Todo grau `unavailable` observado para a msg coberta, através de TODOS os polls do B2 —
  // o insumo do assert "nunca lost falso" (a janela pré-import inclusa).
  const observedGrades = new Set<string>()

  beforeAll(async () => {
    // O canal de config da recovery é o env (PF-2 item 4) — apontado para o escrow da
    // DEV-STACK (o que o agente alimenta), setado ANTES de qualquer connect e restaurado no
    // teardown (as demais suítes rodam SEM escrow, por construção).
    prevEnv = process.env.TAYET_ESCROW_URL
    process.env.TAYET_ESCROW_URL = ESCROW

    registerUser(userA)
    registerUser(userB)
    tokenA = (await mintOidcSession(userA, 'gatepass123')).accessToken
    tokenB1 = (await mintOidcSession(userB, 'gatepass123')).accessToken
    mxidB = await whoami(tokenB1)

    // ── B1: o device REAL que vira zumbi. Vive o bastante para bootstrapar (4S + backup +
    // depósito do segredo no escrow — é ISSO que a recovery do B2 vai adotar) e publicar
    // device keys + OTKs. Depois MORRE sem logout: o store (em memória) é descartado, o
    // device fica no servidor como alvo do fan-out — a janela anônima da repro.
    const bob1 = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await bob1.connect(tokenB1 as Parameters<Acl['connect']>[0])
    await until('beforeAll: bootstrap de B1 assentou (backup no servidor)', backupReady(tokenB1))
    await until('beforeAll: segredo de B custodiado no escrow', async () => {
      const res = await fetch(`${ESCROW}/v1/secret`, authed(tokenB1))
      return res.status === 200 ? true : undefined
    })
    await bob1.disconnect() // sem logout: o device B1 permanece — zumbi por construção

    // ── A: o remetente. Cria a sala cifrada PELA ACL (o caminho da PR-4 convida o cofre).
    alice = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await alice.connect(tokenA as Parameters<Acl['connect']>[0])

    channelId = await withRetry(() => alice.createChannel({ name: `inv-${suffix}`, kind: 'private' }))
    roomIdRaw = String(channelId)
    await invite(tokenA, roomIdRaw, mxidB)
    // B endereçado ANTES do nascimento da sessão (membro `invite` basta — C1/norma 1).
    await until('beforeAll: membership invite de B visível', async () =>
      (await membership(tokenA, roomIdRaw, mxidB)) === 'invite' ? true : undefined,
    )

    // ADR-058: sendMessage rejects for a channel the session does not know yet; wait for it.
    await until(
      'beforeAll: canal conhecido de A antes do envio',
      async () => ((await alice.getChannels()).some((c) => c.id === channelId) ? true : undefined),
      {
        snapshot: async () => {
          const chs = await alice.getChannels()
          return `known=${chs.length} hasChannelId=${chs.some((c) => c.id === channelId)}`
        },
      },
    )
    const messageId = await alice.sendMessage(channelId, { kind: 'text', text: MSG1 })
    session1 = await sessionIdOf(tokenA, roomIdRaw, String(messageId))
    // Âncora determinística: o agente depositou E B está endereçado — a consulta do B2 não
    // pode correr antes do material existir (um `lost` falso por corrida seria erro DESTE
    // harness, não do produto).
    await until(
      'beforeAll: sessão da msg1 custodiada e endereçada a B',
      async () => ((await retrievedSessionIds(tokenB1)).includes(session1) ? true : undefined),
      { timeoutMs: 240_000 },
    )

    // ── Controle negativo, criado ANTES do acesso novo: sala cifrada SEM B. A sessão nasce
    // fora do endereçamento de B (F5 — fato de nascimento); B entra DEPOIS (norma 1: histórico
    // pré-entrada começa na entrada — decisão, não bug).
    deadRoomId = await withRetry(() => alice.createChannel({ name: `inv-neg-${suffix}`, kind: 'private' }))
    deadRoomRaw = String(deadRoomId)
    await until(
      'beforeAll: controle negativo conhecido de A antes do envio',
      async () => ((await alice.getChannels()).some((c) => c.id === deadRoomId) ? true : undefined),
      {
        snapshot: async () => {
          const chs = await alice.getChannels()
          return `known=${chs.length} hasChannelId=${chs.some((c) => c.id === deadRoomId)}`
        },
      },
    )
    const msgXId = await alice.sendMessage(deadRoomId, { kind: 'text', text: MSGX })
    sessionX = await sessionIdOf(tokenA, deadRoomRaw, String(msgXId))
    await until(
      'beforeAll: sessão do controle negativo custodiada (endereçada a A, não a B)',
      async () => ((await retrievedSessionIds(tokenA)).includes(sessionX) ? true : undefined),
      { timeoutMs: 240_000 },
    )
    // F5 vivo: o retrieve de B NÃO devolve a sessão da sala sem B.
    expect(await retrievedSessionIds(tokenB1)).not.toContain(sessionX)
  }, 600_000)

  afterAll(async () => {
    for (const [token, room] of [
      [tokenA, roomIdRaw],
      [tokenA, deadRoomRaw],
    ] as const) {
      try {
        if (token && room) await leave(token, room)
      } catch {
        /* best-effort */
      }
    }
    for (const acl of [alice, bob2]) {
      try {
        await acl?.disconnect()
      } catch {
        /* best-effort */
      }
    }
    if (prevEnv === undefined) delete process.env.TAYET_ESCROW_URL
    else process.env.TAYET_ESCROW_URL = prevEnv
  }, 60_000)

  it(
    'INVARIANTE (ADR-057, Conformidade): mensagem endereçada a B na janela zumbi DECRIPTA no acesso novo — e nunca gradua lost falso',
    async () => {
      // ── B2: ACESSO NOVO — device virgem + o fluxo REAL de recovery da ACL (escrow 4S →
      // restore do backup → consulta à custódia da dec. 6 → import). Nada é injetado: o que
      // decripta aqui é a cadeia de produção inteira.
      const tokenB2 = (await mintOidcSession(userB, 'gatepass123')).accessToken
      bob2 = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
      await bob2.connect(tokenB2 as Parameters<Acl['connect']>[0])
      bob2.subscribe((e) => bob2Events.push(e))

      // Auto-join do convite pendente (ADR-044) traz a sala coberta para o B2.
      await until('assert: canal coberto visível no B2', async () =>
        (await bob2!.getChannels()).some((c) => c.id === channelId) ? true : undefined,
      )

      // O assert central do track: a mensagem enviada enquanto o ÚNICO device de B era um
      // zumbi (store morto, sem logout, backup jamais alcançado) é decriptável pelo acesso
      // futuro autorizado de B — o invariante da ADR-057, palavra a palavra. No caminho,
      // TODO grau transitório observado é registrado: a janela pré-import jamais pode
      // afirmar perda (dec. 7 — veredito exige consulta, e a consulta REFUTA esta sessão).
      await until(
        'assert: msg1 decripta no acesso novo (o invariante da ADR-057)',
        async () => {
          const page = await bob2!.getTimeline(channelId)
          for (const m of page.items) {
            if (m.body.kind === 'unavailable') observedGrades.add(m.body.arrival)
            if (m.body.kind === 'text' && m.body.text === MSG1) return true
          }
          return undefined
        },
        { timeoutMs: 240_000, snapshot: () => `graus observados: [${[...observedGrades].join(',')}]` },
      )

      // Nunca um veredito falso na janela: pré-import o conjunto da consulta não existia
      // (sem consulta, sem veredito) e pós-import a sessão VEio — 'lost' é impossível nos
      // dois lados, e o que se observa transitório é awaited/stalled.
      expect(observedGrades.has('lost'), `graus observados: [${[...observedGrades].join(',')}]`).toBe(false)
    },
    420_000,
  )

  it(
    'controle negativo (dec. 7): sessão fora do endereçamento de B não decripta e, com consulta feita, grada lost',
    async () => {
      expect(bob2, 'roda após o assert do invariante (a consulta já aconteceu)').toBeDefined()
      // B entra na sala DEPOIS do nascimento da sessão — o servidor marca a membership no
      // evento (leave) e o reason cai na família stalled (norma 1); com a consulta desta
      // sessão de uso feita e a sessão ausente do import, o grau assenta em 'lost'.
      await invite(tokenA, deadRoomRaw, mxidB)
      await until('controle: canal do controle negativo visível no B2 (auto-join)', async () =>
        (await bob2!.getChannels()).some((c) => c.id === deadRoomId) ? true : undefined,
      )

      const body = await until(
        'controle: msgX assenta em unavailable/lost',
        async () => {
          const page = await bob2!.getTimeline(deadRoomId)
          // Nunca decripta: se o texto aparecer, a custódia vazou material fora do
          // endereçamento — falha imediata, não timeout.
          expect(page.items.some((m) => m.body.kind === 'text' && m.body.text === MSGX)).toBe(false)
          const placeholder = page.items.find((m) => m.body.kind === 'unavailable')
          return placeholder && placeholder.body.kind === 'unavailable' && placeholder.body.arrival === 'lost'
            ? placeholder.body
            : undefined
        },
        { timeoutMs: 120_000 },
      )
      expect(body).toEqual({ kind: 'unavailable', arrival: 'lost' })
    },
    240_000,
  )
})

describe('gate do invariante (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
