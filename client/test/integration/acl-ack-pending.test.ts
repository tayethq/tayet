// @vitest-environment jsdom
import { describe, it, expect, afterAll, afterEach, beforeEach } from 'vitest'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import type { AclTelemetry, DomainEvent, OpaqueSession } from '../../src/acl'
import { HOMESERVER, synapseReachable, mintToken, whoami, whoamiDevice } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { killSessions } from '../support/synapse-admin'
import { until } from '../support/until'

// ── O dispensar sobrevive a um unload antes de o PUT sair (ADR-063, adendo 2; PLANO §8.38, T3). ─────
// Residual (4) do primeiro adendo: "um dispensar seguido de unload antes de a leitura do boot assentar
// ainda pode perder a escrita". Aqui o PUT do dispensar morre (abortado, como numa página que fecha), a
// sessão termina e o próximo boot da mesma conta, neste navegador, não pode anunciar o acesso dispensado
// e precisa gravá-lo no servidor. O boot é de outro device (em Node o store do rust-crypto é de memória:
// reconectar o MESMO device diverge a identidade, ADR-062 D2); a lista pendente é da conta, não do
// device, então o caso é o mesmo. O localStorage é o do jsdom, compartilhado pelo arquivo.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const KEY = 'io.tayet.acknowledged_devices'

type NewAccess = Extract<DomainEvent, { t: 'account.newAccess' }>
const isNewAccess = (e: DomainEvent, deviceId: string): e is NewAccess =>
  e.t === 'account.newAccess' && String(e.device.id) === deviceId

// Every PUT of the recognized set made with `token` dies before reaching the server (the page is gone).
// Scoped to that token. Answered here with a 503, not a network error: a network error makes the SDK
// retry for ~30 s (retryNetworkOperation), past the end of the file — the page that unloads never
// retries at all, and the server state is the same either way: it never got the write.
function abortSetWritesOf(token: string): { restore: () => void; aborted: () => number } {
  const real = globalThis.fetch
  let aborted = 0
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers)
    if (init?.method === 'PUT' && url.includes(`/account_data/${KEY}`) && headers.get('Authorization') === `Bearer ${token}`) {
      aborted++
      return new Response(JSON.stringify({ errcode: 'M_UNKNOWN', error: 'unloaded' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    }
    return real(...args)
  }
  return { restore: () => (globalThis.fetch = real), aborted: () => aborted }
}

async function serverSet(token: string, mxid: string): Promise<Set<string>> {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/user/${encodeURIComponent(mxid)}/account_data/${KEY}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status !== 200) return new Set()
  const body = (await res.json()) as { devices?: unknown }
  return new Set(Array.isArray(body.devices) ? body.devices.filter((d): d is string => typeof d === 'string') : [])
}

describe.skipIf(!SYNAPSE)('o dispensar sobrevive a um unload antes de o PUT sair (ADR-063, adendo 2)', () => {
  const names: string[] = []
  const gateways: MatrixGateway[] = []
  let restore: (() => void) | undefined
  beforeEach(() => localStorage.clear())
  afterEach(async () => {
    for (const gw of gateways.splice(0)) await gw.disconnect().catch(() => {})
    restore?.()
    restore = undefined
  })
  afterAll(() => {
    for (const n of names) killSessions(n)
  })

  function gateway(events: DomainEvent[]): MatrixGateway {
    const gw = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    gw.subscribe((e) => events.push(e))
    gateways.push(gw)
    return gw
  }

  it('o próximo boot não anuncia o dispensado e o servidor passa a tê-lo', async () => {
    const [u] = await freshUsers(['apd'])
    names.push(u.name)
    const mxid = await whoami(u.token)
    const d1 = await whoamiDevice(u.token)
    const t2 = await mintToken(u.name)
    const d2 = await whoamiDevice(t2)

    // Primeira sessão: D2 aparece, é dispensado, e o PUT morre.
    const abort = abortSetWritesOf(u.token)
    restore = abort.restore
    const ev1: DomainEvent[] = []
    const g1 = gateway(ev1)
    await g1.connect(u.token as unknown as OpaqueSession)
    const n2 = await until('aviso de D2', () => ev1.find((e) => isNewAccess(e, d2)))
    g1.acknowledgeAccess(n2.access)
    await until('o PUT do dispensar saiu e morreu', () => (abort.aborted() > 0 ? true : undefined))
    await g1.disconnect()
    gateways.splice(gateways.indexOf(g1), 1)
    expect((await serverSet(t2, mxid)).has(d2), 'precondição: a escrita se perdeu').toBe(false)

    // Próximo boot da conta neste navegador.
    const ev3: DomainEvent[] = []
    const g3 = gateway(ev3)
    await g3.connect((await mintToken(u.name)) as unknown as OpaqueSession)
    // D1 nunca foi reconhecido: o anúncio dele prova que o scan do boot rodou.
    await until('aviso de D1 (o scan do boot rodou)', () => ev3.find((e) => isNewAccess(e, d1)))
    await until('D2 no servidor', async () => ((await serverSet(t2, mxid)).has(d2) ? true : undefined), { timeoutMs: 20_000 })
    expect(ev3.filter((e) => isNewAccess(e, d2)), 'o dispensado não volta').toEqual([])
  })
})
