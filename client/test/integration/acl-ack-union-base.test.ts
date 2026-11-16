// @vitest-environment jsdom
import { describe, it, expect, afterAll, afterEach } from 'vitest'
import type { MatrixClient } from 'matrix-js-sdk'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import type { AclTelemetry, DomainEvent, OpaqueSession } from '../../src/acl'
import { HOMESERVER, synapseReachable, mintToken, whoami, whoamiDevice } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { mintOidcSession } from '../support/mint-oidc'
import { killSessions } from '../support/synapse-admin'
import { until } from '../support/until'

// ── A escrita do conjunto reconhecido não apaga entradas (ADR-063, adendo; PLANO §8.31). ─────────
// O acknowledgeAccess faz read-union-write na account data (ADR-018 §4). Antes, a base da união era o
// cache do sync (getAccountData), que logo depois de um reconnect do MESMO device pode vir do cache de
// resposta do /sync do Synapse (sync_response_cache_duration, §8.23) e não ter reconhecimentos já
// gravados. A base passa a ser o conjunto em memória da sessão (cache do boot ∪ leitura do servidor ∪
// ecos ∪ próprias escritas), com as escritas serializadas e coalescidas, e a leitura do servidor no
// boot passa a ser incondicional. Três casos, vermelhos antes da correção:
//  a) mecanismo 2: reconnect com cache velho; o dispensar logo depois grava menos que o servidor tem;
//  b) caminho (A): boot sem candidato (a leitura do servidor não rodava) e um acesso novo depois;
//  c) caminho (B): dois dispensar seguidos → dois PUT concorrentes; last-write-wins apagava um.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const KEY = 'io.tayet.acknowledged_devices'
// Mesma senha do registerUser (escrow-harness.ts) que o freshUsers usa.
const PASSWORD = 'gatepass123'

type NewAccess = Extract<DomainEvent, { t: 'account.newAccess' }>
const isNewAccess = (e: DomainEvent, deviceId: string): e is NewAccess =>
  e.t === 'account.newAccess' && String(e.device.id) === deviceId

// O cache velho, determinístico. O cache de resposta do /sync do Synapse é por device, e em Node o
// store do rust-crypto é de memória: reconectar o MESMO device diverge a identidade (ADR-062 D2). A
// sessão "recarregada" é então outro device, e o sync INICIAL dela chega sem a chave do conjunto: o
// instantâneo anterior ao reconhecimento que o cache serviria. O sync incremental e o GET da leitura
// do boot passam intactos (o servidor tem o conjunto). Só o primeiro sync sem `since` é alterado.
function staleInitialSync(): { restore: () => void; stripped: () => number } {
  const real = globalThis.fetch
  let stripped = 0
  let done = false
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await real(...args)
    const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url
    if (done || !url.includes('/_matrix/client/v3/sync') || url.includes('since=') || res.status !== 200) return res
    done = true
    const body = (await res.json()) as { account_data?: { events?: Array<{ type: string }> } }
    const events = body.account_data?.events ?? []
    const kept = events.filter((e) => e.type !== KEY)
    stripped = events.length - kept.length
    if (body.account_data) body.account_data.events = kept
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { restore: () => (globalThis.fetch = real), stripped: () => stripped }
}

// Cópia do servidor, observação externa (não pela sessão sob teste).
async function serverSet(token: string, mxid: string): Promise<Set<string>> {
  const res = await fetch(
    `${HOMESERVER}/_matrix/client/v3/user/${encodeURIComponent(mxid)}/account_data/${KEY}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (res.status !== 200) return new Set()
  const body = (await res.json()) as { devices?: unknown }
  return new Set(Array.isArray(body.devices) ? body.devices.filter((d): d is string => typeof d === 'string') : [])
}

// O conteúdo do cache do sync da sessão, no instante da chamada (para provar a precondição "cache velho").
function cachedSet(gw: MatrixGateway): Set<string> {
  const client = (gw as unknown as { client: MatrixClient | undefined }).client
  const content = client?.getAccountData(KEY as never)?.getContent() as { devices?: unknown } | undefined
  return new Set(Array.isArray(content?.devices) ? (content.devices as string[]) : [])
}

describe.skipIf(!SYNAPSE)('o dispensar não apaga reconhecimentos já feitos (ADR-063, adendo)', () => {
  const names: string[] = []
  const gateways: MatrixGateway[] = []

  let restore: (() => void) | undefined
  afterEach(async () => {
    restore?.()
    restore = undefined
    for (const gw of gateways.splice(0)) await gw.disconnect().catch(() => {})
  })
  afterAll(() => {
    for (const n of names) killSessions(n)
  })

  function gateway(events: DomainEvent[], onEvent?: (e: DomainEvent, gw: MatrixGateway) => void): MatrixGateway {
    const gw = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    gw.subscribe((e) => {
      events.push(e)
      onEvent?.(e, gw)
    })
    gateways.push(gw)
    return gw
  }

  async function user(prefix: string) {
    const [u] = await freshUsers([prefix])
    names.push(u.name)
    return { name: u.name, token: u.token, mxid: await whoami(u.token) }
  }

  it('a) cache velho no boot: o dispensar logo depois não grava menos que o servidor tem', async () => {
    const u = await user('aba')
    const t2 = await mintToken(u.name)
    const t3 = await mintToken(u.name)
    const [d2, d3] = [await whoamiDevice(t2), await whoamiDevice(t3)]

    // Primeira sessão: reconhece D2 e espera o servidor refletir.
    const ev1: DomainEvent[] = []
    const g1 = gateway(ev1)
    await g1.connect(u.token as unknown as OpaqueSession)
    const n2 = await until('aviso de D2', () => ev1.find((e) => isNewAccess(e, d2)))
    g1.acknowledgeAccess(n2.access)
    await until('D2 no servidor', async () => ((await serverSet(u.token, u.mxid)).has(d2) ? true : undefined))

    // A sessão "recarregada", com o sync inicial velho. D3 é anunciado (depois da leitura do boot,
    // ADR-063) e dispensado no mesmo tick do anúncio.
    const stale = staleInitialSync()
    restore = stale.restore
    let staleAtDismiss: boolean | undefined
    const ev2: DomainEvent[] = []
    const g2 = gateway(ev2, (e, gw) => {
      if (!isNewAccess(e, d3)) return
      staleAtDismiss = !cachedSet(gw).has(d2)
      gw.acknowledgeAccess(e.access)
    })
    await g2.connect((await mintToken(u.name)) as unknown as OpaqueSession)
    await until('D3 no servidor', async () => ((await serverSet(u.token, u.mxid)).has(d3) ? true : undefined))
    await new Promise((r) => setTimeout(r, 1_000)) // deixa assentar uma eventual escrita seguinte

    expect(stale.stripped(), 'precondição: o sync inicial trazia o conjunto').toBe(1)
    expect(staleAtDismiss, 'precondição: cache do sync sem D2 no instante do dispensar').toBe(true)
    expect([...(await serverSet(u.token, u.mxid))].sort()).toEqual([d2, d3].sort())
  })

  it('b) caminho (A): boot sem candidato e um acesso novo depois; a entrada já gravada sobrevive', async () => {
    const u = await user('abb')
    const x = await mintOidcSession(u.name, PASSWORD)
    const dx = x.deviceId

    // Reconhece X; depois encerra X (o MAS apaga o device) e a primeira sessão: a entrada de X fica no
    // conjunto, sem device vivo que a torne candidata.
    const ev1: DomainEvent[] = []
    const g1 = gateway(ev1)
    await g1.connect(u.token as unknown as OpaqueSession)
    const nx = await until('aviso de X', () => ev1.find((e) => isNewAccess(e, dx)))
    g1.acknowledgeAccess(nx.access)
    await until('X no servidor', async () => ((await serverSet(u.token, u.mxid)).has(dx) ? true : undefined))
    await g1.disconnect()
    killSessions(u.name)

    // Sessão nova, sync inicial velho, nenhum outro device: sem candidato no boot. Um acesso Y
    // aparece depois e é dispensado no mesmo tick do anúncio.
    const t2 = await mintToken(u.name)
    const stale = staleInitialSync()
    restore = stale.restore
    const ev2: DomainEvent[] = []
    const g2 = gateway(ev2, (e, gw) => {
      if (e.t === 'account.newAccess') gw.acknowledgeAccess(e.access)
    })
    await g2.connect(t2 as unknown as OpaqueSession)
    expect(ev2.filter((e) => e.t === 'account.newAccess'), 'precondição: nada a anunciar no boot').toEqual([])
    const ty = await mintToken(u.name)
    const dy = await whoamiDevice(ty)
    await until('aviso de Y', () => ev2.find((e) => isNewAccess(e, dy)))
    await until('Y no servidor', async () => ((await serverSet(t2, u.mxid)).has(dy) ? true : undefined))
    await new Promise((r) => setTimeout(r, 1_000))

    expect(stale.stripped(), 'precondição: o sync inicial trazia o conjunto').toBe(1)
    expect([...(await serverSet(t2, u.mxid))].sort()).toEqual([dx, dy].sort())
  })

  it('c) caminho (B): dois dispensar seguidos gravam as duas entradas', async () => {
    const u = await user('abc')
    const t2 = await mintToken(u.name)
    const t3 = await mintToken(u.name)
    const [d2, d3] = [await whoamiDevice(t2), await whoamiDevice(t3)]

    const ev: DomainEvent[] = []
    const g = gateway(ev)
    await g.connect(u.token as unknown as OpaqueSession)
    const n2 = await until('aviso de D2', () => ev.find((e) => isNewAccess(e, d2)))
    const n3 = await until('aviso de D3', () => ev.find((e) => isNewAccess(e, d3)))
    g.acknowledgeAccess(n2.access)
    g.acknowledgeAccess(n3.access)

    // Espera o servidor ter alguma das duas, e então o eco das duas escritas assentar.
    await until('alguma escrita no servidor', async () => ((await serverSet(u.token, u.mxid)).size > 0 ? true : undefined))
    await until('as duas entradas no servidor', async () => {
      const s = await serverSet(u.token, u.mxid)
      return s.has(d2) && s.has(d3) ? true : undefined
    }, { timeoutMs: 15_000 }).catch(() => undefined)
    expect([...(await serverSet(u.token, u.mxid))].sort()).toEqual([d2, d3].sort())
  })
})

