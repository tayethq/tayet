import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import { CUSTODY_RECONSULT_MAX } from '../../src/acl/internal/custody'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, ChannelId, DomainEvent } from '../../src/acl'
import { HOMESERVER, synapseReachable, whoami, invite, leave, findOwnEvent } from '../support/synapse'
import { registerUser } from '../support/escrow-harness'
import { mintOidcSession } from '../support/mint-oidc'
import { until } from '../support/until'

// ── Gate da re-consulta à custódia (ADR-077, issue #241) ───────────────────────────────────
// Um acesso novo nasce num pass cold cuja consulta à custódia chega ANTES do depósito do agente:
// a mensagem fica `unavailable` ('awaited'), e antes do ADR-077 ficava assim até um reload. Aqui
// ela tem de virar legível SEM reload, pela re-consulta com backoff (dec. 2) — o stream entrega
// o upgrade como message.edited — em ≤ 30 s.
//
// Sem irmão vivo (o primeiro device do alvo sai com signOut antes do envio — "Sair deste
// navegador", ADR-062 D1): o backup não tem a sessão, a custódia é o único canal (o caso da
// revogação pelo admin, `conversation.spec` passo 11).
//
// Como o agente atrasado é simulado: o depósito do agente é REAL e o gate espera por ele antes de
// o acesso novo conectar; o atraso é imposto do lado do device — um hook de fetch (padrão do gate
// da terceira janela) remove a sessão da resposta de GET /v1/sessions DESTE device até um instante
// de liberação (+7 s depois de a mensagem aparecer `unavailable`, entre a 2ª volta em +6 s e a 3ª
// em +14 s). Do ponto de vista do device, é o agente depositando em +7 s. Segurar o container do
// agente não daria o instante (o loop do agente não é controlável por run) e atrasaria as outras
// suítes que dividem a `spike`.
//
// Escrow da DEV-STACK (o que o agente `cofre` alimenta). Usuários novos por run; tokens OIDC
// headless. Auto-skip sem a stack (#7).

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ESCROW = process.env.TAYET_ESCROW_URL ?? 'http://localhost:8090'
const RELEASE_AFTER_MS = 7_000
const RECONSULT_BUDGET_MS = 30_000

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

function authorizationOf(init?: RequestInit): string | undefined {
  const h = init?.headers
  if (!h) return undefined
  if (h instanceof Headers) return h.get('Authorization') ?? undefined
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === 'authorization')?.[1]
  return (h as Record<string, string>)['Authorization'] ?? (h as Record<string, string>)['authorization']
}

const MSG = 'mensagem antes do depósito do agente'

describe.skipIf(!SYNAPSE)('re-consulta à custódia com backoff — legível sem reload em ≤ 30 s (ADR-077)', () => {
  const suffix = `${process.pid}${Math.floor(Math.random() * 1e6)}`
  const userT = `rct${suffix}` // o alvo: re-login sem irmão vivo
  const userS = `rcs${suffix}` // o remetente

  let prevEnv: string | undefined
  const realFetch = globalThis.fetch
  let tokenS: string
  let tokenB2: string
  let sender: Acl | undefined
  let b2: MatrixGateway | undefined
  let channelId: ChannelId
  let roomIdRaw: string
  let sessionId: string

  // Estado do hook do device b2 sobre GET /v1/sessions.
  let releaseAt = Number.POSITIVE_INFINITY
  const consults: Array<{ at: number; hidden: boolean }> = []

  async function realSessionIds(token: string): Promise<string[]> {
    const res = await realFetch(`${ESCROW}/v1/sessions`, authed(token))
    if (res.status !== 200) throw new Error(`retrieve -> ${res.status}`)
    const { sessions } = (await res.json()) as { sessions: Array<{ session_id?: string }> }
    return sessions.map((s) => s.session_id ?? '')
  }

  async function realBackedUp(token: string): Promise<string[]> {
    const v = await realFetch(`${HOMESERVER}/_matrix/client/v3/room_keys/version`, authed(token))
    if (v.status === 404) return []
    const { version } = (await v.json()) as { version: string }
    const res = await realFetch(`${HOMESERVER}/_matrix/client/v3/room_keys/keys?version=${version}`, authed(token))
    const { rooms } = (await res.json()) as { rooms: Record<string, { sessions: Record<string, unknown> }> }
    return Object.values(rooms).flatMap((r) => Object.keys(r.sessions))
  }

  beforeAll(async () => {
    prevEnv = process.env.TAYET_ESCROW_URL
    process.env.TAYET_ESCROW_URL = ESCROW

    registerUser(userT)
    registerUser(userS)
    tokenS = (await mintOidcSession(userS, 'gatepass123')).accessToken
    const tokenB1 = (await mintOidcSession(userT, 'gatepass123')).accessToken
    tokenB2 = (await mintOidcSession(userT, 'gatepass123')).accessToken

    // ── b1: o primeiro login do alvo cria o mundo (4S + backup) e SAI antes do envio.
    const b1 = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await b1.connect(tokenB1 as Parameters<Acl['connect']>[0])
    await until('beforeAll: b1 criou o backup (mundo materializado)', async () => {
      const res = await realFetch(`${HOMESERVER}/_matrix/client/v3/room_keys/version`, authed(tokenB1))
      return res.status === 200 ? true : undefined
    })

    // ── O remetente cria a sala cifrada PELA ACL (cofre no nascimento) com o alvo endereçado.
    sender = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await sender.connect(tokenS as Parameters<Acl['connect']>[0])
    channelId = await withRetry(() => sender!.createChannel({ name: `rc-${suffix}`, kind: 'private' }))
    roomIdRaw = String(channelId)
    await invite(tokenS, roomIdRaw, await whoami(tokenB1))
    await until('beforeAll: b1 entrou no canal (auto-join)', async () =>
      (await b1.getChannels()).some((c) => c.id === channelId) ? true : undefined,
    )
    // "Sair deste navegador": nenhum device vivo do alvo recebe a chave da mensagem.
    await b1.signOut()

    const messageId = await sender.sendMessage(channelId, { kind: 'text', text: MSG })
    const ev = await findOwnEvent(tokenS, roomIdRaw, String(messageId))
    sessionId = (ev.content as { session_id: string }).session_id
    // O depósito real do agente — esperado ANTES de b2 conectar (o atraso é imposto no device).
    await until(
      'beforeAll: sessão da mensagem custodiada e endereçada ao alvo',
      async () => ((await realSessionIds(tokenB2)).includes(sessionId) ? true : undefined),
      { timeoutMs: 240_000 },
    )
    expect(await realBackedUp(tokenB2), 'sem irmão vivo: a sessão NÃO está no backup').not.toContain(sessionId)

    // ── Hook de b2: GET /v1/sessions sem a sessão até `releaseAt` (o agente "deposita" ali).
    const bearerB2 = `Bearer ${tokenB2}`
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const res = await realFetch(input, init)
      if (authorizationOf(init) !== bearerB2 || !url.startsWith(`${ESCROW}/v1/sessions`)) return res
      const hidden = Date.now() < releaseAt
      consults.push({ at: Date.now(), hidden })
      if (!hidden || res.status !== 200) return res
      const body = (await res.json()) as { sessions: Array<{ session_id?: string }> }
      const sessions = body.sessions.filter((s) => s.session_id !== sessionId)
      return new Response(JSON.stringify({ ...body, sessions }), { status: 200, headers: res.headers })
    }) as typeof fetch
  }, 600_000)

  afterAll(async () => {
    globalThis.fetch = realFetch
    try {
      if (roomIdRaw) await leave(tokenS, roomIdRaw)
    } catch {
      /* best-effort */
    }
    for (const acl of [b2, sender]) {
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
    'cold após re-login: a mensagem fica awaited e vira legível sem reload pela re-consulta, em ≤ 30 s',
    async () => {
      b2 = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
      const events: DomainEvent[] = []
      b2.subscribe((e) => events.push(e))
      await b2.connect(tokenB2 as Parameters<Acl['connect']>[0])
      await until('b2: canal visível (auto-join do convite)', async () =>
        (await b2!.getChannels()).some((c) => c.id === channelId) ? true : undefined,
      )
      // O pass cold consultou (sem a sessão): é o #241 — antes do ADR-077, fim da linha.
      await until('b2: consulta do pass cold aconteceu', async () => (consults.length >= 1 ? true : undefined), {
        timeoutMs: 120_000,
      })

      // A UI vê a mensagem: `unavailable`, grau transitório (nunca o lost falso-definitivo do §0).
      const page = await b2.getTimeline(channelId)
      const placeholder = page.items.find((m) => m.body.kind === 'unavailable')
      expect(placeholder, `página: ${JSON.stringify(page.items.map((m) => m.body))}`).toBeDefined()
      expect(placeholder!.body).not.toEqual({ kind: 'unavailable', arrival: 'lost' })
      const t0 = Date.now()
      releaseAt = t0 + RELEASE_AFTER_MS
      const consultsBefore = consults.length

      // SEM reload: nenhum getTimeline a partir daqui — o upgrade tem de chegar pelo stream.
      const upgraded = await until(
        'b2: message.edited com o texto (re-consulta importou e re-decifrou)',
        async () =>
          events.find(
            (e) =>
              e.t === 'message.edited' &&
              e.message.id === placeholder!.id &&
              e.message.body.kind === 'text' &&
              e.message.body.text === MSG,
          ),
        {
          timeoutMs: RECONSULT_BUDGET_MS + 15_000,
          snapshot: async () => `consults=${JSON.stringify(consults.map((c) => ({ dt: c.at - t0, hidden: c.hidden })))}`,
        },
      )
      const elapsed = Date.now() - t0
      expect(upgraded).toBeDefined()
      expect(elapsed, `upgrade em ${elapsed} ms`).toBeLessThanOrEqual(RECONSULT_BUDGET_MS)

      // GETs do device a /v1/sessions: o pass + as voltas (escondidas até +7 s, a que importa depois).
      const rounds = consults.slice(consultsBefore)
      const dump = JSON.stringify(consults.map((c) => ({ dt: c.at - t0, hidden: c.hidden })))
      expect(rounds.filter((c) => c.hidden).length, `voltas antes do depósito: ${dump}`).toBeGreaterThanOrEqual(1)
      expect(rounds.some((c) => !c.hidden), `uma volta depois do depósito: ${dump}`).toBe(true)
      expect(rounds.length, `teto por sessão: ${dump}`).toBeLessThanOrEqual(CUSTODY_RECONSULT_MAX)
      // Nenhum veredito lost no caminho.
      expect(
        events.some((e) => e.t === 'message.edited' && e.message.body.kind === 'unavailable' && e.message.body.arrival === 'lost'),
      ).toBe(false)
      process.stderr.write(`[acl-custody-reconsult] upgrade +${elapsed} ms; consults ${dump}\n`)

      // Resolvida: nenhuma volta nova depois do import.
      const settled = consults.length
      await new Promise((r) => setTimeout(r, 20_000))
      expect(consults.length, `nenhuma volta após o import: ${JSON.stringify(consults)}`).toBe(settled)

      // Teardown como parte do assert (PLANO-GATES §8.10).
      await b2.disconnect()
      b2 = undefined
    },
    600_000,
  )
})

describe('gate da re-consulta à custódia (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
