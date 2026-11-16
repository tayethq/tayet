import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, ChannelId, DomainEvent } from '../../src/acl'
import { HOMESERVER, synapseReachable, whoami, invite, leave, findOwnEvent } from '../support/synapse'
import { registerUser } from '../support/escrow-harness'
import { mintOidcSession } from '../support/mint-oidc'
import { until } from '../support/until'

// ── Gate da terceira janela de vencedor morto (ADR-061 D3) ─────────────────────────────────
// O device do primeiro login MORRE no meio do bootstrapSecretStorage do SDK: depois do 4S (chave
// default + cross-signing exportado) e antes do backup. Reprodução por TIMING, não por deleção
// posterior do backup: o gate observa o próprio tráfego do device d1 e o mata no primeiro
// request a `/room_keys/version` DEPOIS de d1 ter gravado a chave default do 4S — o início do
// resetKeyBackup, o último passo do bootstrap (o cross-signing já foi exportado para o 4S entre
// um e outro). Dali em diante nenhum request de d1 chega ao servidor (aba fechada), e d1 é
// desconectado.
//
// Asserts (ADR-061 D1/D2): o acesso novo d2 decifra a mensagem endereçada pela custódia (D1 — o
// backup ausente não impede a consulta), o backup passa a existir no servidor com a sessão
// dentro (D2 — claim no teto, sem UIA), e nenhum device.attention é emitido. Um terceiro acesso
// d3 decifra também, com o backup reconstruído no lugar.
//
// Escrow da DEV-STACK (o que o agente `cofre` alimenta), como no gate do invariante. Usuários
// novos por run; tokens OIDC headless (o escrow rejeita mct_). Auto-skip sem a stack (#7).

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

async function retrievedSessionIds(token: string): Promise<string[]> {
  const res = await fetch(`${ESCROW}/v1/sessions`, authed(token))
  if (res.status !== 200) throw new Error(`retrieve -> ${res.status}`)
  const { sessions } = (await res.json()) as { sessions: Array<{ session_id?: string }> }
  return sessions.map((s) => s.session_id ?? '')
}

async function backupVersion(token: string): Promise<string | undefined> {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/room_keys/version`, authed(token))
  if (res.status === 404) return undefined
  if (res.status !== 200) throw new Error(`room_keys/version -> ${res.status}`)
  return ((await res.json()) as { version: string }).version
}

async function accountDataStatus(token: string, mxid: string, type: string): Promise<number> {
  const url = `${HOMESERVER}/_matrix/client/v3/user/${encodeURIComponent(mxid)}/account_data/${type}`
  return (await fetch(url, authed(token))).status
}

// Sessões presentes no backup do servidor, na versão dada — o fato que prova o backup
// reconstruído e POPULADO (não só criado).
async function backedUpSessionIds(token: string, version: string): Promise<string[]> {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/room_keys/keys?version=${version}`, authed(token))
  if (res.status !== 200) throw new Error(`room_keys/keys -> ${res.status}`)
  const { rooms } = (await res.json()) as { rooms: Record<string, { sessions: Record<string, unknown> }> }
  return Object.values(rooms).flatMap((r) => Object.keys(r.sessions))
}

function authorizationOf(init?: RequestInit): string | undefined {
  const h = init?.headers
  if (!h) return undefined
  if (h instanceof Headers) return h.get('Authorization') ?? undefined
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === 'authorization')?.[1]
  return (h as Record<string, string>)['Authorization'] ?? (h as Record<string, string>)['authorization']
}

const MSG = 'mensagem na janela entre o 4S e o backup'

describe.skipIf(!SYNAPSE)('terceira janela de vencedor morto — 4S sem backup (ADR-061, prova por timing)', () => {
  const suffix = `${process.pid}${Math.floor(Math.random() * 1e6)}`
  const userT = `hbt${suffix}` // o alvo: o usuário cujo primeiro device morre
  const userS = `hbs${suffix}` // o remetente

  let prevEnv: string | undefined
  const realFetch = globalThis.fetch
  let tokenS: string
  let tokenD1: string
  let mxidT: string
  let sender: Acl | undefined
  let d1: MatrixGateway | undefined
  let wrote4SDefault = false
  let killedAt: string | undefined
  let channelId: ChannelId
  let roomIdRaw: string
  let sessionId: string

  beforeAll(async () => {
    prevEnv = process.env.TAYET_ESCROW_URL
    process.env.TAYET_ESCROW_URL = ESCROW

    registerUser(userT)
    registerUser(userS)
    tokenS = (await mintOidcSession(userS, 'gatepass123')).accessToken
    tokenD1 = (await mintOidcSession(userT, 'gatepass123')).accessToken
    mxidT = await whoami(tokenD1)

    // ── d1: o primeiro login, morto entre o 4S e o backup. O hook vê só o tráfego de d1 (pelo
    // token) e corta tudo a partir do primeiro request a /room_keys/version posterior ao PUT da
    // chave default do 4S (checagens de backup anteriores ao 4S passam).
    const bearerD1 = `Bearer ${tokenD1}`
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (authorizationOf(init) === bearerD1) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (init?.method === 'PUT' && url.includes('/account_data/m.secret_storage.default_key')) {
          wrote4SDefault = true
        }
        if (killedAt === undefined && wrote4SDefault && url.includes('/room_keys/version')) killedAt = url
        if (killedAt !== undefined) throw new TypeError('device morto (gate ADR-061)')
      }
      return realFetch(input, init)
    }) as typeof fetch
    d1 = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await d1.connect(tokenD1 as Parameters<Acl['connect']>[0])
    await until('beforeAll: d1 chegou ao último passo do bootstrap (início do backup)', async () =>
      killedAt !== undefined ? true : undefined,
    )
    await d1.disconnect()
    d1 = undefined
    globalThis.fetch = realFetch

    // O estado da janela, pelo servidor: 4S + cross-signing + segredo custodiado; backup NENHUM.
    expect(await accountDataStatus(tokenD1, mxidT, 'm.secret_storage.default_key')).toBe(200)
    expect(await accountDataStatus(tokenD1, mxidT, 'm.cross_signing.master')).toBe(200)
    expect((await fetch(`${ESCROW}/v1/secret`, authed(tokenD1))).status).toBe(200)
    expect(await backupVersion(tokenD1), 'nenhuma versão de backup após a morte de d1').toBeUndefined()

    // ── O remetente cria a sala cifrada PELA ACL (cofre no nascimento) com o alvo endereçado.
    sender = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await sender.connect(tokenS as Parameters<Acl['connect']>[0])
    channelId = await withRetry(() => sender!.createChannel({ name: `hb-${suffix}`, kind: 'private' }))
    roomIdRaw = String(channelId)
    await invite(tokenS, roomIdRaw, mxidT)
    await until(
      'beforeAll: canal conhecido do remetente antes do envio',
      async () => ((await sender!.getChannels()).some((c) => c.id === channelId) ? true : undefined),
    )
    const messageId = await sender.sendMessage(channelId, { kind: 'text', text: MSG })
    const ev = await findOwnEvent(tokenS, roomIdRaw, String(messageId))
    sessionId = (ev.content as { session_id: string }).session_id
    await until(
      'beforeAll: sessão da mensagem custodiada e endereçada ao alvo',
      async () => ((await retrievedSessionIds(tokenD1)).includes(sessionId) ? true : undefined),
      { timeoutMs: 240_000 },
    )
  }, 600_000)

  afterAll(async () => {
    globalThis.fetch = realFetch
    try {
      if (roomIdRaw) await leave(tokenS, roomIdRaw)
    } catch {
      /* best-effort */
    }
    for (const acl of [d1, sender]) {
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
    'acesso novo decifra pela custódia, o backup é reconstruído com a sessão, sem device.attention',
    async () => {
      const tokenD2 = (await mintOidcSession(userT, 'gatepass123')).accessToken
      const d2 = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
      const d2Events: DomainEvent[] = []
      d2.subscribe((e) => d2Events.push(e))
      await d2.connect(tokenD2 as Parameters<Acl['connect']>[0])

      await until('d2: canal visível (auto-join do convite)', async () =>
        (await d2.getChannels()).some((c) => c.id === channelId) ? true : undefined,
      )
      // D1: decifra pela custódia, sem esperar backup algum.
      await until(
        'd2: mensagem decifra (custódia consultada com backup ausente — ADR-061 D1)',
        async () => {
          const page = await d2.getTimeline(channelId)
          return page.items.some((m) => m.body.kind === 'text' && m.body.text === MSG) ? true : undefined
        },
        { timeoutMs: 240_000 },
      )

      // D2: no teto do claim, d2 cria o backup — e a sessão importada sobe para ele.
      const version = await until('d2: backup reconstruído no servidor (ADR-061 D2)', () => backupVersion(tokenD2))
      await until(
        'd2: a sessão da mensagem está no backup reconstruído',
        async () => ((await backedUpSessionIds(tokenD2, version)).includes(sessionId) ? true : undefined),
      )
      expect(
        d2Events.some((e) => e.t === 'device.attention'),
        'nenhum device.attention: a janela converge sem interação',
      ).toBe(false)

      // d3: acesso posterior, com o backup reconstruído no lugar — decifra também.
      const tokenD3 = (await mintOidcSession(userT, 'gatepass123')).accessToken
      const d3 = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
      const d3Events: DomainEvent[] = []
      d3.subscribe((e) => d3Events.push(e))
      await d3.connect(tokenD3 as Parameters<Acl['connect']>[0])
      await until('d3: canal visível', async () =>
        (await d3.getChannels()).some((c) => c.id === channelId) ? true : undefined,
      )
      await until(
        'd3: mensagem decifra com o backup reconstruído',
        async () => {
          const page = await d3.getTimeline(channelId)
          return page.items.some((m) => m.body.kind === 'text' && m.body.text === MSG) ? true : undefined
        },
        { timeoutMs: 240_000 },
      )
      expect(await backupVersion(tokenD3), 'd3 não recria o backup (a versão de d2 continua a corrente)').toBe(version)
      expect(d3Events.some((e) => e.t === 'device.attention')).toBe(false)

      // Teardown como parte do assert (PLANO-GATES §8.10): todo client desconecta aqui.
      await d2.disconnect()
      await d3.disconnect()
    },
    600_000,
  )
})

describe('gate da terceira janela (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
