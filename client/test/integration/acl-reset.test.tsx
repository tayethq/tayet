// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { render, act } from '@testing-library/react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import type { Acl, DomainEvent, Device } from '../../src/acl'
import { ResetAccessBanner } from '../../src/ui/components/ResetAccessBanner'
import { findProtocolLeaks, findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { HOMESERVER, synapseReachable, whoami, whoamiDevice } from '../support/synapse'
import { mintOidcSession } from '../support/mint-oidc'
import { spawnEscrow, readAudit, registerUser, type EscrowProcess } from '../support/escrow-harness'
import {
  mintAdminToken,
  allowCrossSigningReplacementWithoutUia,
  adminScopeReachable,
  killSessions,
} from '../support/synapse-admin'

// ── Gate de integração da fatia D3 (PLANO-FASE-2-D3 §5.2) — reset sob custódia. ──────────────
// Stack real + escrow REAL (infra C1). Usuário RECÉM-REGISTRADO por run (mundo virgem) que
// bootstrapa identidade/4S/escrow via ensureKeyRecovery; o reset opera sobre ele. Auto-skip sem a
// stack (PF-4 / issue #7); fileParallelism:false (vite.config) já serializa com o gate do escrow.
//
// CONVERGÊNCIA (ADR-020, via a′): a leg que EXIGE concluir o reset (asserts 2'/3/8 + cauda do 4)
// roda verde-real headless. O admin-escopo do Synapse — compat token user-attached com
// urn:synapse:admin:* mintado via mas-cli, abrindo a janela _allow_cross_signing_replacement_without_uia
// — pula o UIA do MSC3967 (confirmado pelos PF, PLANO-FASE-2-D3-ADMIN-GATE §8). Gated por
// it.skipIf(!SYNAPSE || !ADMIN_SCOPE). O resto do gate segue headless SEM admin: rotate-primeiro, o
// muro real do UIA (PF-2) na leg Trigger, o 412 do CAS, e P1 (barrel + DOM).
//
// Leg Trigger (§8.bis — janela FECHADA, sem admin): o sinal device.attention exige só o 401 real,
// NÃO a janela do admin (que é a convergência). O residual de C2 §8 obs. 5 — identidade PUBLICADA
// mas 4S irrecuperável (o "vencedor morto" antes de materializar o 4S) + segredo custodiado — força
// o RecoveryRunner em BACKGROUND a, no claim-after-timeout, chamar bootstrapWorld, cujo
// bootstrapCrossSigning({}) COLIDE com a identidade publicada → 401 do MSC3967 (verificado ao vivo:
// /keys/device_signing/upload → 401 + flows). ensureKeyRecovery classifica 'needs-user' (forma de
// erro, PF-2) e o runner emite device.attention ponta-a-ponta; a UI oferece o reset. Cripto REAL,
// zero bypass de auth — é a metade do assert 5 que destrava sem a janela do admin.

const SYNAPSE = synapseReachable()
// ADR-020 (via a′): o admin-escopo headless do Synapse DESTRAVOU o cross-signing reset. ADMIN_SCOPE
// é um probe AO VIVO (substitui o antigo UIA_HEADLESS=false): minta um compat token de prova com
// urn:synapse:admin:* via mas-cli e confirma que o Synapse o aceita num endpoint admin-only. true →
// a convergência roda contra cripto real; false (sem stack/sem admin) → auto-skip honesto.
const ADMIN_SCOPE = adminScopeReachable()

const noopTelemetry = { untranslated: () => {} }

async function until<T>(get: () => T | undefined | Promise<T | undefined>, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 120))
  }
}

const authed = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } })

// ADR-082 dec. 3: this gate proves the crypto convergence with an escrow spawned on the host, which
// cannot reach the MAS admin API (internal listener, no host port by decision). The revocation has
// its own proof: unit of the endpoint + the access-reset E2E, against the escrow of the stack.
function revokeOthersStubbed(gateway: MatrixGateway): void {
  const escrow = gateway['escrow']!
  gateway['escrow'] = { ...escrow, revokeOthers: async () => ({ kind: 'revoked' }) }
}
const backupReady = (token: string) => async (): Promise<true | undefined> =>
  (await fetch(`${HOMESERVER}/_matrix/client/v3/room_keys/version`, authed(token))).status === 200 ? true : undefined

describe.skipIf(!SYNAPSE)('gate D3 — reset sob custódia (§5.2)', () => {
  const suffix = `${process.pid}${Math.floor(Math.random() * 1e6)}`
  const userA = `d3a${suffix}`

  let escrow: EscrowProcess
  let storeDir: string
  let orgKeyB64: string
  let prevEnv: string | undefined
  let aliceToken: string
  let alice: MatrixGateway
  const instances: Array<Pick<Acl, 'disconnect'>> = []

  // The current escrow secret (base64) for userA — direct external observation.
  const currentSecret = async (): Promise<string | undefined> => {
    const res = await fetch(`${escrow.base}/v1/secret`, authed(aliceToken))
    return res.status === 200 ? ((await res.json()) as { secret: string }).secret : undefined
  }
  const currentEtag = async (): Promise<string | undefined> => {
    const res = await fetch(`${escrow.base}/v1/secret`, authed(aliceToken))
    return res.status === 200 ? (res.headers.get('etag') ?? undefined) : undefined
  }

  beforeAll(async () => {
    storeDir = await mkdtemp(pathJoin(tmpdir(), 'escrow-d3-gate-'))
    orgKeyB64 = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64')
    escrow = await spawnEscrow(storeDir, orgKeyB64)
    prevEnv = process.env.TAYET_ESCROW_URL
    process.env.TAYET_ESCROW_URL = escrow.base

    registerUser(userA)
    aliceToken = (await mintOidcSession(userA, 'gatepass123')).accessToken
    alice = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await alice.connect(aliceToken as Parameters<Acl['connect']>[0])
    instances.push(alice)
    // Mundo saudável: identidade + 4S + escrow já bootstrapados pelo ensureKeyRecovery em background.
    await until(backupReady(aliceToken))
    await until(currentSecret) // o segredo está custodiado
  }, 240_000)

  afterAll(async () => {
    for (const i of instances.splice(0)) {
      try {
        await i.disconnect()
      } catch {
        /* best-effort */
      }
    }
    await escrow?.kill()
    await rm(storeDir, { recursive: true, force: true }).catch(() => undefined)
    if (prevEnv === undefined) delete process.env.TAYET_ESCROW_URL
    else process.env.TAYET_ESCROW_URL = prevEnv
  }, 60_000)

  it('1. sem aprovação nada queima (ADR-082 dec. 1): a custódia fica intacta; e o etag divergente → 412', async () => {
    const before = await currentSecret()
    const beforeAudit = (await readAudit(storeDir)).length

    // Headless não há janela: a aprovação não vem, o verbo rejeita e o rotate nunca acontece. O
    // burn só existe com a aprovação em mãos.
    await expect(alice.resetAccess()).rejects.toThrow()

    const audit = (await readAudit(storeDir)).slice(beforeAudit)
    expect(audit.some((e) => e.verb === 'rotate')).toBe(false)
    expect(audit.some((e) => e.verb === 'revoke-others')).toBe(false)
    expect(await currentSecret()).toBe(before)

    // 412 do CAS: um rotate com If-Match velho (outro reset linearizou na frente) é rejeitado; o
    // storage fica intocado (simetria com o write-once do primeiro login — C2 §8 obs. 5).
    const stale = '"etag-que-nao-bate"'
    const res = await fetch(`${escrow.base}/v1/secret/rotate`, {
      method: 'POST',
      headers: { ...authed(aliceToken).headers, 'Content-Type': 'application/json', 'If-Match': stale },
      body: JSON.stringify({ secret: Buffer.from(new Uint8Array(32).fill(1)).toString('base64') }),
    })
    expect(res.status).toBe(412)
    expect(await currentSecret()).toBe(before) // intocado pelo CAS perdido
  }, 200_000)

  it('4/5. re-chamada sem aprovação NÃO cria mundo paralelo (custódia única, linearizada)', async () => {
    const createdBefore = (await readAudit(storeDir)).filter((e) => e.verb === 'put' && e.outcome === 'created').length
    await alice.resetAccess().catch(() => undefined)
    const createdAfter = (await readAudit(storeDir)).filter((e) => e.verb === 'put' && e.outcome === 'created').length
    expect(createdAfter).toBe(createdBefore) // re-execução jamais re-deposita (write-once)
    expect(await currentSecret()).toBeDefined() // a custódia continua exatamente uma
    // E há exatamente UM etag corrente (uma linha de verdade) — sem mundo paralelo.
    expect(await currentEtag()).toBeDefined()
  }, 200_000)

  it('6/7. P1: device.attention (barrel) e a copy de transição (DOM) passam o leak-scan; o id opaco nunca alcança a tela', () => {
    // Barrel: o membro device.attention carrega um Device cujo id é protocol-shaped (resíduo ADR-008,
    // chave opaca permitida); nada mais vaza. friendlyName é product copy limpa.
    const ev: DomainEvent = {
      t: 'device.attention',
      device: { id: '!spoofed:tayet.local' as Device['id'], friendlyName: 'Ana — Laptop', current: false },
    }
    expect(findProtocolLeaks(ev)).toEqual([])

    // DOM: a copy de transição e a oferta de reset passam o render-scan; a página de aprovação é do
    // MAS (fora do nosso DOM). O id opaco do Device nunca é renderizado (a copy é genérica).
    let container!: HTMLElement
    act(() => {
      container = render(<ResetAccessBanner present onReset={() => {}} />).container
    })
    expect(container.textContent ?? '').toContain('Esta sessão precisa de você')
    expect(container.innerHTML).not.toContain('!spoofed')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('Trigger (§8.bis). residual de C2 §8 obs. 5: o muro real do UIA em background → device.attention ponta-a-ponta → UI oferece o reset', async () => {
    // O sinal device.attention exige o 401, NÃO a janela do admin. Reproduz o "vencedor morto
    // pós-upload" contra cripto REAL, sem nenhum bypass de auth:
    //
    //   1. userT bootstrapa um mundo saudável (identidade publicada + 4S + segredo custodiado).
    //   2. O 4S vira IRRECUPERÁVEL: zera o ponteiro (m.secret_storage.default_key), o descritor da
    //      chave e os segredos de cross-signing cifrados (m.cross_signing.{master,self,user}). A
    //      identidade PÚBLICA segue em /keys (cross-signing keys são server-side, não account-data);
    //      o que some é a capacidade de recuperar as chaves PRIVADAS — o residual de C2 §8 obs. 5.
    //      O device desconecta: o vencedor morreu deixando identidade + custódia, sem 4S.
    //   3. Um device NOVO (store virgem) recupera: segredo presente + 4S ausente → após o
    //      claim-after-timeout o RecoveryRunner chama bootstrapWorld, cujo bootstrapCrossSigning({})
    //      COLIDE com a identidade publicada → 401 do MSC3967 → 'needs-user' → device.attention.
    const userT = `d3t${suffix}`
    registerUser(userT)
    const tToken1 = (await mintOidcSession(userT, 'gatepass123')).accessToken
    const tMxid = await whoami(tToken1)

    const winner = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await winner.connect(tToken1 as Parameters<Acl['connect']>[0])
    instances.push(winner)
    await until(backupReady(tToken1))
    await until(async () => {
      const res = await fetch(`${escrow.base}/v1/secret`, authed(tToken1))
      return res.status === 200 ? true : undefined
    })

    // O 4S vira irrecuperável (o "vencedor morto" antes de materializar/persistir o 4S). Lê o
    // default key id para zerar também o descritor, e apaga os segredos de cross-signing cifrados.
    const accountData = (type: string): string =>
      `${HOMESERVER}/_matrix/client/v3/user/${encodeURIComponent(tMxid)}/account_data/${type}`
    const defaultKey = (await (await fetch(accountData('m.secret_storage.default_key'), authed(tToken1))).json()) as {
      key?: string
    }
    const toClear = [
      'm.secret_storage.default_key',
      ...(defaultKey.key ? [`m.secret_storage.key.${defaultKey.key}`] : []),
      'm.cross_signing.master',
      'm.cross_signing.self_signing',
      'm.cross_signing.user_signing',
    ]
    for (const type of toClear) {
      await fetch(accountData(type), {
        method: 'PUT',
        headers: { ...authed(tToken1).headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    }
    await winner.disconnect()
    instances.splice(instances.indexOf(winner), 1)

    // Device novo (store virgem, device id distinto): o seu RecoveryRunner de background bate no
    // muro e emite device.attention — o login NUNCA esperou pela recuperação (§0.2 item 1).
    const tToken2 = (await mintOidcSession(userT, 'gatepass123')).accessToken
    const tDevice2 = await whoamiDevice(tToken2)
    const heir = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    const heirEvents: DomainEvent[] = []
    await heir.connect(tToken2 as Parameters<Acl['connect']>[0])
    instances.push(heir)
    heir.subscribe((e) => heirEvents.push(e))

    // device.attention emitido ponta-a-ponta contra o 401 REAL (claim-after-timeout ~15s + o 401).
    const attention = await until(
      () => heirEvents.find((e): e is Extract<DomainEvent, { t: 'device.attention' }> => e.t === 'device.attention'),
      120_000,
    )
    // O Device nomeia a sessão corrente (a herdeira), e P1: nenhum vocabulário de protocolo vaza.
    expect(attention.device.id as unknown as string).toBe(tDevice2)
    expect(findProtocolLeaks(attention)).toEqual([])

    // Consumo: como o useChat liga device.attention → attentionNeeded, a UI oferece o reset acionável
    // (distinto do account.newAccess passivo). A copy de transição é nossa e limpa; o id opaco não vaza.
    let container!: HTMLElement
    act(() => {
      container = render(<ResetAccessBanner present onReset={() => {}} />).container
    })
    expect(container.textContent ?? '').toContain('Esta sessão precisa de você')
    expect(container.textContent ?? '').toContain('Redefinir o acesso')
    expect(container.innerHTML).not.toContain(tDevice2)
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  }, 200_000)

  it.skipIf(!SYNAPSE || !ADMIN_SCOPE)(
    "2'/3/8 + cauda do 4. CONVERGÊNCIA (ADR-020 via a′): a janela do admin-escopo destrava o cross-signing reset → resetAccess completa SEM UIA, recria o 4S, e um segundo device adota o segredo novo do escrow",
    async () => {
      // d3* dedicado e descartável (independente do half-state de alice nos asserts 1/4/5): device1
      // bootstrapa um mundo saudável (master key + 4S + segredo custodiado) — exatamente o que se
      // substitui. Cripto REAL ponta-a-ponta; o único degrau que o admin-escopo cobre é o UIA do
      // MSC3967 na substituição da identidade (o caminho de geração/upload/recriação é o de produção).
      const userC = `d3c${suffix}`
      registerUser(userC)
      const cToken1 = (await mintOidcSession(userC, 'gatepass123')).accessToken
      const cMxid = await whoami(cToken1)
      const device1 = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
      await device1.connect(cToken1 as Parameters<Acl['connect']>[0])
      instances.push(device1)
      await until(backupReady(cToken1))
      const cSecret = async (token: string): Promise<string | undefined> => {
        const res = await fetch(`${escrow.base}/v1/secret`, authed(token))
        return res.status === 200 ? ((await res.json()) as { secret: string }).secret : undefined
      }
      const secretBefore = await until(() => cSecret(cToken1)) // o segredo custodiado ANTES do reset
      let device2Teardown: MatrixGateway | undefined

      try {
        // ADR-020 via a′: minta um admin compat token EFÊMERO e abre a janela do cross-signing reset
        // no d3* alvo (que tem master key). Sem isto, resetIdentity bate no 401 do MSC3967 (PF-2);
        // com a janela aberta, a substituição passa headless (PF-A/PF-B, PLANO-FASE-2-D3-ADMIN-GATE §8).
        const adminToken = mintAdminToken(userC)
        await allowCrossSigningReplacementWithoutUia(adminToken, cMxid)

        // (2'/8) resetAccess completa o reset SEM UIA → done; historyPreserved honesto (boolean).
        revokeOthersStubbed(device1)
        const out = await device1.resetAccess()
        expect(out.t).toBe('done')
        expect(typeof out.historyPreserved).toBe('boolean')

        // (3 / cauda do 4) rotate-primeiro + 4S recriado: a custódia foi rotacionada (segredo NOVO,
        // o velho queimado — burn otimista) e o key backup existe pós-reset (4S recriado a partir do
        // segredo novo).
        const secretAfter = await cSecret(cToken1)
        expect(secretAfter).toBeDefined()
        expect(secretAfter).not.toBe(secretBefore)
        expect(await backupReady(cToken1)()).toBe(true)

        // (cauda do 4 — "unlock" / segundo device adota o segredo novo) device2 (store virgem)
        // recupera o mundo recriado SEM precisar de reset: recheckKeyRecovery converge para noop/done
        // (cross-signing cacheado + backup ativo = unlock pós-reset), enxergando exatamente o segredo
        // NOVO. NENHUM device.attention é emitido — recuperação feliz (§8.bis nuance), distinta do
        // muro do UIA da leg Trigger.
        const cToken2 = (await mintOidcSession(userC, 'gatepass123')).accessToken
        const device2 = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
        device2Teardown = device2
        const d2Events: DomainEvent[] = []
        await device2.connect(cToken2 as Parameters<Acl['connect']>[0])
        instances.push(device2)
        device2.subscribe((e) => d2Events.push(e))
        const recovered = await until(async () => {
          const r = await device2.recheckKeyRecovery()
          return r === 'noop' || r === 'done' ? r : undefined
        })
        expect(['noop', 'done']).toContain(recovered)
        expect(d2Events.some((e) => e.t === 'device.attention')).toBe(false)
        expect(await cSecret(cToken2)).toBe(secretAfter) // device2 adota exatamente o segredo novo
      } finally {
        // Desconecta os devices do d3* ANTES do kill: com o client conectado, os laços de fundo do
        // SDK tempestam 401 "Token is not active" até o teardown (PLANO-GATES §8.9/§8.10).
        for (const d of [device1, device2Teardown]) {
          if (!d) continue
          const at = instances.indexOf(d)
          if (at >= 0) instances.splice(at, 1)
          try {
            await d.disconnect()
          } catch {
            /* best-effort */
          }
        }
        // Mata a sessão admin do d3* (o token efêmero morre junto); a janela auto-expira (~10 min,
        // reusável — PF-B §8.3), sem close explícito. O admin token NUNCA é reusado.
        killSessions(userC)
      }
    },
    240_000,
  )
})

// ADR-082 dec. 2 — o defeito da #279, reproduzido no mundo real: o master do 4S diverge da identidade
// do servidor, com a custódia íntegra (o que o rotate sem upload deixava). Um device novo não fica
// preso num `adopt` que nunca importa: o boot levanta a atenção, o reset retoma sem novo burn, e o
// acesso seguinte recupera sem reset.
describe.skipIf(!SYNAPSE || !ADMIN_SCOPE)('half-state converge de qualquer device (ADR-082 dec. 2)', () => {
  it('master do 4S ≠ servidor → device.attention no boot → resume sem rotate → acesso novo recupera', async () => {
    const suffix = `${process.pid}${Math.floor(Math.random() * 1e6)}`
    const user = `d3h${suffix}`
    const storeDir = await mkdtemp(pathJoin(tmpdir(), 'escrow-d3h-gate-'))
    const orgKey = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64')
    const escrow = await spawnEscrow(storeDir, orgKey)
    const prevEnv = process.env.TAYET_ESCROW_URL
    process.env.TAYET_ESCROW_URL = escrow.base
    const connected: MatrixGateway[] = []
    const newDevice = async (): Promise<{ gateway: MatrixGateway; events: DomainEvent[]; token: string }> => {
      const token = (await mintOidcSession(user, 'gatepass123')).accessToken
      const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
      const events: DomainEvent[] = []
      gateway.subscribe((e) => events.push(e))
      await gateway.connect(token as Parameters<Acl['connect']>[0])
      connected.push(gateway)
      return { gateway, events, token }
    }
    const secretOf = async (token: string): Promise<string | undefined> => {
      const res = await fetch(`${escrow.base}/v1/secret`, authed(token))
      return res.status === 200 ? ((await res.json()) as { secret: string }).secret : undefined
    }

    try {
      registerUser(user)
      const first = await newDevice()
      await until(backupReady(first.token))
      const secret = await until(() => secretOf(first.token))

      // O half-state: outro master no 4S, cifrado com o segredo em custódia.
      const client = first.gateway['client']!
      first.gateway['recoverySecret'] = Uint8Array.from(Buffer.from(secret, 'base64'))
      const otherSeed = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64').replace(/=+$/, '')
      await client.secretStorage.store('m.cross_signing.master', otherSeed)
      first.gateway['recoverySecret'] = undefined
      await first.gateway.disconnect()
      connected.splice(0)

      const stuck = await newDevice()
      await until(() => stuck.events.find((e) => e.t === 'device.attention'), 120_000)

      const audit = (await readAudit(storeDir)).length
      await allowCrossSigningReplacementWithoutUia(mintAdminToken(user), await whoami(stuck.token))
      revokeOthersStubbed(stuck.gateway)
      expect((await stuck.gateway.resetAccess()).t).toBe('done')
      expect((await readAudit(storeDir)).slice(audit).some((e) => e.verb === 'rotate')).toBe(false)
      expect(await secretOf(stuck.token)).toBe(secret) // sem novo burn
      await stuck.gateway.disconnect()
      connected.splice(0)

      const next = await newDevice()
      const recovered = await until(async () => {
        const r = await next.gateway.recheckKeyRecovery()
        return r === 'noop' || r === 'done' ? r : undefined
      })
      expect(['noop', 'done']).toContain(recovered)
      expect(next.events.some((e) => e.t === 'device.attention')).toBe(false)
    } finally {
      for (const g of connected) await g.disconnect().catch(() => undefined)
      killSessions(user)
      await escrow.kill()
      await rm(storeDir, { recursive: true, force: true }).catch(() => undefined)
      if (prevEnv === undefined) delete process.env.TAYET_ESCROW_URL
      else process.env.TAYET_ESCROW_URL = prevEnv
    }
  }, 240_000)
})

describe('gate D3 (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
  it('ADR-020: convergência gated por ADMIN_SCOPE real (não mais degrade fixo)', () => {
    // Invertido — era expect(UIA_HEADLESS).toBe(false) (degrade hard-coded). Agora a convergência
    // roda contra cripto real quando o admin-escopo headless (via a′) está alcançável; ADMIN_SCOPE
    // é um probe AO VIVO, não uma constante. Sem stack, o probe admin necessariamente também falha.
    expect(typeof ADMIN_SCOPE).toBe('boolean')
    if (!SYNAPSE) expect(ADMIN_SCOPE).toBe(false)
  })
})
