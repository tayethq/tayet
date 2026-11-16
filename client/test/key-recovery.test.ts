import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  consultCustody,
  CustodyReconsult,
  ensureKeyRecovery,
  RecoveryRunner,
  CLAIM_AFTER_ATTEMPTS,
  type BackupStep,
  type RecoveryPorts,
  type RecoveryCrypto,
  type CustodyConsult,
} from '../src/acl/internal/key-recovery'
import { createEscrowClient } from '../src/acl/internal/escrow-client'
import { CUSTODY_RECONSULT_DELAYS_MS, CUSTODY_RECONSULT_MAX } from '../src/acl/internal/custody'
import { createEscrowFake } from './support/escrow-fake'

// ── ensureKeyRecovery + RecoveryRunner (PLANO-FASE-2-ESCROW-C2 §3.2/§3.3 / commit 5) ───────
// Unit contra fakes: crypto estrutural (ports) + escrow in-memory (§0.2 item 4). Provam:
// idempotência (segunda chamada = no-op, zero acesso ao escrow), política de indisponibilidade
// (retry, nunca exceção), corrida 409→adoção (um 201 + um 409, MESMO segredo), higiene do
// segredo (holder limpo em todo desfecho) e o runner (backoff, parada, cancelamento).

// Mundo compartilhado entre devices do mesmo usuário (account data do servidor, na vida real):
// o vencedor materializa o 4S; o predicado getDefaultKeyId dos outros devices lê daqui.
interface World {
  defaultKeyId: string | null
  // ADR-061 D2: o backup do servidor (versão + segredo no 4S), como o probeBackup o veria.
  // Ausente do objeto = presente (o mundo dos testes pré-ADR-061 sempre tinha backup junto do 4S).
  backup?: 'present' | 'absent'
  // ADR-082 dec. 2: o master do 4S contra o servidor. Ausente do objeto = igual.
  storedIdentity?: 'same' | 'different' | 'unreadable'
}

interface FakeCryptoState {
  calls: string[]
  cachedCrossSigning: boolean
  cachedBackupKey: boolean
  bootstrappedWith?: Uint8Array
  adoptedWith?: Uint8Array
  backupCreatedWith?: Uint8Array
  importedJson: string[]
}

function fakeCrypto(world: World, holder: { secret?: Uint8Array }, warm = false): FakeCryptoState & RecoveryCrypto {
  const state: FakeCryptoState = { calls: [], cachedCrossSigning: warm, cachedBackupKey: warm, importedJson: [] }
  return {
    ...state,
    get calls() {
      return state.calls
    },
    get importedJson() {
      return state.importedJson
    },
    get cachedCrossSigning() {
      return state.cachedCrossSigning
    },
    get cachedBackupKey() {
      return state.cachedBackupKey
    },
    get bootstrappedWith() {
      return state.bootstrappedWith
    },
    get adoptedWith() {
      return state.adoptedWith
    },
    get backupCreatedWith() {
      return state.backupCreatedWith
    },
    async getCrossSigningStatus() {
      state.calls.push('getCrossSigningStatus')
      const v = state.cachedCrossSigning
      return { privateKeysCachedLocally: { masterKey: v, selfSigningKey: v, userSigningKey: v } }
    },
    async getSessionBackupPrivateKey() {
      state.calls.push('getSessionBackupPrivateKey')
      return state.cachedBackupKey ? new Uint8Array(32) : null
    },
    async checkKeyBackupAndEnable() {
      state.calls.push('checkKeyBackupAndEnable')
      return null
    },
    async bootstrapCrossSigning() {
      state.calls.push('bootstrapCrossSigning')
      state.cachedCrossSigning = true
    },
    async bootstrapSecretStorage(opts) {
      state.calls.push('bootstrapSecretStorage')
      const generated = await opts.createSecretStorageKey()
      state.bootstrappedWith = generated.privateKey
      world.defaultKeyId = 'K'
      world.backup = 'present'
      state.cachedBackupKey = true
    },
    async loadSessionBackupPrivateKeyFromSecretStorage() {
      state.calls.push('loadSessionBackupPrivateKeyFromSecretStorage')
      // Na vida real lê m.megolm_backup.v1 via getSecretStorageKey — o holder TEM de estar
      // populado neste ponto; o fake adota o segredo do holder como âncora da adoção.
      if (!holder.secret) throw new Error('secret not in holder during 4S read')
      state.adoptedWith = holder.secret
      state.cachedBackupKey = true
    },
    async restoreKeyBackup() {
      state.calls.push('restoreKeyBackup')
      return { total: 0, imported: 0 }
    },
    async resetKeyBackup() {
      state.calls.push('resetKeyBackup')
      // Na vida real guarda a chave do backup novo no 4S existente via getSecretStorageKey — o
      // holder TEM de estar populado (é o segredo depositado que abre o 4S).
      if (!holder.secret) throw new Error('secret not in holder during 4S write')
      state.backupCreatedWith = holder.secret
      world.backup = 'present'
      state.cachedBackupKey = true
    },
    async importRoomKeysAsJson(keys) {
      state.calls.push('importRoomKeysAsJson')
      state.importedJson.push(keys)
    },
  }
}

interface Device {
  ports: RecoveryPorts
  crypto: FakeCryptoState & RecoveryCrypto
  holder: { secret?: Uint8Array }
  // Desfechos da consulta à custódia de sessão reportados pela porta (dec. 6/7) — em ordem.
  consults: CustodyConsult[]
  // Passos de backup best-effort que falharam, reportados pela porta (ADR-061 D1) — em ordem.
  backupFailures: BackupStep[]
}

function device(world: World, fake: ReturnType<typeof createEscrowFake>, token: string, warm = false): Device {
  const holder: { secret?: Uint8Array } = {}
  const consults: CustodyConsult[] = []
  const backupFailures: BackupStep[] = []
  const crypto = fakeCrypto(world, holder, warm)
  const ports: RecoveryPorts = {
    crypto,
    getDefaultKeyId: async () => world.defaultKeyId,
    probeBackup: async () => {
      crypto.calls.push('probeBackup')
      return world.backup ?? 'present'
    },
    onBackupStepFailed: (step) => {
      backupFailures.push(step)
    },
    ensureOwnIdentity: async () => {
      crypto.calls.push('ensureOwnIdentity')
    },
    storedIdentity: async () => world.storedIdentity ?? 'same',
    escrow: createEscrowClient({ baseUrl: 'http://escrow.test', token, fetchFn: fake.fetch }),
    setSecret: (s) => {
      holder.secret = s
    },
    clearSecret: () => {
      holder.secret = undefined
    },
    onCustodySessions: (outcome) => {
      consults.push(outcome)
    },
  }
  return { ports, crypto, holder, consults, backupFailures }
}

const consoleMethods = ['log', 'warn', 'error', 'info', 'debug', 'trace'] as const
let consoleSpies: Array<ReturnType<typeof vi.spyOn>>
beforeEach(() => {
  consoleSpies = consoleMethods.map((m) => vi.spyOn(console, m))
})
afterEach(() => {
  // Nenhum material em log em NENHUM caminho (PLANO §6).
  for (const spy of consoleSpies) {
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  }
})

describe('ensureKeyRecovery — ramos', () => {
  it('warm: tudo cacheado → noop barato, backup re-checado, ZERO acesso ao escrow', async () => {
    const world: World = { defaultKeyId: 'K' }
    const fake = createEscrowFake({ 'tok-a': 'sub-a' })
    const d = device(world, fake, 'tok-a', true)
    expect(await ensureKeyRecovery(d.ports)).toBe('noop')
    expect(d.crypto.calls).toEqual(['getCrossSigningStatus', 'getSessionBackupPrivateKey', 'checkKeyBackupAndEnable'])
    expect(fake.audit).toEqual([]) // âncora observável do no-op (assert 3 do gate)
  })

  it('primeiro login: 404 → PUT 201 (primeiro ato mutante) → bootstrap com o MESMO segredo depositado', async () => {
    const world: World = { defaultKeyId: null }
    const fake = createEscrowFake({ 'tok-a': 'sub-a' })
    const d = device(world, fake, 'tok-a')
    expect(await ensureKeyRecovery(d.ports)).toBe('done')
    // Ordem: deposit ANTES de qualquer bootstrap (PF-2 item 3).
    expect(fake.audit.map((e) => [e.verb, e.outcome])).toEqual([
      ['get', 'not_found'],
      ['put', 'created'],
      ['retrieve-sessions', 'ok'], // ADR-061 D1: o vencedor também consulta a custódia, por último
    ])
    expect(d.crypto.calls).toContain('bootstrapCrossSigning')
    expect(d.crypto.calls).toContain('bootstrapSecretStorage')
    // O segredo no escrow é byte a byte o que o 4S recebeu.
    const deposited = Buffer.from(fake.secrets.get('sub-a')!, 'base64')
    expect(Array.from(d.crypto.bootstrappedWith!)).toEqual(Array.from(deposited))
    expect(world.defaultKeyId).toBe('K')
    expect(d.holder.secret, 'higiene: holder limpo ao fim do pass').toBeUndefined()
  })

  it('idempotência: segunda chamada após bootstrap = no-op, auditoria do escrow inalterada', async () => {
    const world: World = { defaultKeyId: null }
    const fake = createEscrowFake({ 'tok-a': 'sub-a' })
    const d = device(world, fake, 'tok-a')
    expect(await ensureKeyRecovery(d.ports)).toBe('done')
    const auditAfterFirst = fake.audit.length
    expect(await ensureKeyRecovery(d.ports)).toBe('noop')
    expect(fake.audit.length).toBe(auditAfterFirst) // nenhum PUT/GET novo
    expect(d.crypto.calls.filter((c) => c === 'bootstrapSecretStorage')).toHaveLength(1)
  })

  it('cold start: segredo no escrow + 4S materializado → adota, restaura e cross-assina (sem criar identidade)', async () => {
    const world: World = { defaultKeyId: null }
    const fake = createEscrowFake({ 'tok-a': 'sub-a', 'tok-a2': 'sub-a' })
    const first = device(world, fake, 'tok-a')
    await ensureKeyRecovery(first.ports) // materializa o mundo

    const cold = device(world, fake, 'tok-a2')
    expect(await ensureKeyRecovery(cold.ports)).toBe('done')
    expect(cold.crypto.calls).toEqual([
      'getCrossSigningStatus',
      'ensureOwnIdentity', // identidade pública própria ANTES do import (achado do gate)
      'bootstrapCrossSigning',
      'probeBackup', // ADR-061 D2: ausência provada decide a terceira janela
      'loadSessionBackupPrivateKeyFromSecretStorage',
      'checkKeyBackupAndEnable',
      'restoreKeyBackup',
      'importRoomKeysAsJson', // dec. 6: a consulta à custódia vem DEPOIS do restore
    ])
    // Consulta feita (mesmo vazia): o veredito da dec. 7 fica habilitado nesta sessão de uso.
    expect(cold.consults).toEqual([{ kind: 'consulted', sessionIds: [] }])
    expect(cold.crypto.calls).not.toContain('bootstrapSecretStorage') // nunca cria identidade própria
    const deposited = Buffer.from(fake.secrets.get('sub-a')!, 'base64')
    expect(Array.from(cold.crypto.adoptedWith!)).toEqual(Array.from(deposited))
    expect(cold.holder.secret).toBeUndefined()
  })

  // ── Recovery estendida (ADR-057 dec. 6, PR-5): consulta à custódia de sessão pós-restore ──

  it('dec. 6: consulta devolve entries → import recebe o payload EXATO; ids reportados; entry sem session_id ignorada', async () => {
    const world: World = { defaultKeyId: null }
    const fake = createEscrowFake({ 'tok-a': 'sub-a', 'tok-a2': 'sub-a' })
    const first = device(world, fake, 'tok-a')
    await ensureKeyRecovery(first.ports) // materializa o mundo (ADR-061 D1: o vencedor consulta)
    expect(first.consults).toEqual([{ kind: 'consulted', sessionIds: [] }])

    fake.sessionEntries = [
      { room_id: '!r:x', session_id: 'sess-1', session_key: 'k1' },
      { room_id: '!r:x', session_id: 'sess-2', session_key: 'k2' },
      { room_id: '!r:x', session_key: 'sem-id' }, // nunca entra no conjunto do veredito
    ]
    const cold = device(world, fake, 'tok-a2')
    expect(await ensureKeyRecovery(cold.ports)).toBe('done')
    // O payload segue OPACO até o SDK: byte a byte o array servido, como string JSON.
    expect(cold.crypto.importedJson).toEqual([JSON.stringify(fake.sessionEntries)])
    expect(cold.consults).toEqual([{ kind: 'consulted', sessionIds: ['sess-1', 'sess-2'] }])
  })

  it('dec. 6: falha da consulta NÃO falha a recovery — done + unavailable pela porta (sem veredito)', async () => {
    const world: World = { defaultKeyId: null }
    const fake = createEscrowFake({ 'tok-a': 'sub-a', 'tok-a2': 'sub-a' })
    await ensureKeyRecovery(device(world, fake, 'tok-a').ports)

    const cold = device(world, fake, 'tok-a2')
    const real = cold.ports.escrow
    cold.ports.escrow = { ...real, retrieveSessions: async () => ({ kind: 'unavailable' }) }
    expect(await ensureKeyRecovery(cold.ports)).toBe('done') // o backup já restaurou o que tinha
    expect(cold.crypto.calls).toContain('restoreKeyBackup')
    expect(cold.crypto.calls).not.toContain('importRoomKeysAsJson')
    expect(cold.consults).toEqual([{ kind: 'unavailable' }])
  })

  it('dec. 6: import que LANÇA → unavailable (consulted exige GET + import completos), recovery segue done', async () => {
    const world: World = { defaultKeyId: null }
    const fake = createEscrowFake({ 'tok-a': 'sub-a', 'tok-a2': 'sub-a' })
    await ensureKeyRecovery(device(world, fake, 'tok-a').ports)

    fake.sessionEntries = [{ room_id: '!r:x', session_id: 'sess-1', session_key: 'k1' }]
    const cold = device(world, fake, 'tok-a2')
    cold.ports.crypto.importRoomKeysAsJson = async () => {
      throw new Error('sdk rejected payload')
    }
    expect(await ensureKeyRecovery(cold.ports)).toBe('done')
    expect(cold.consults).toEqual([{ kind: 'unavailable' }])
    expect(cold.holder.secret).toBeUndefined()
  })

  it('segredo no escrow mas 4S ainda não materializou (vencedor em voo) → espera é a PRIMEIRA resposta, abaixo do teto', async () => {
    const world: World = { defaultKeyId: null }
    const fake = createEscrowFake({ 'tok-a': 'sub-a' })
    fake.secrets.set('sub-a', Buffer.from(new Uint8Array(32).fill(7)).toString('base64'))
    const d = device(world, fake, 'tok-a')
    // Toda tentativa ABAIXO do teto espera (invariante: espera é a resposta padrão a
    // "vencedor em voo"); nenhum efeito colateral, nenhum claim precoce.
    for (const attempt of [0, 1, CLAIM_AFTER_ATTEMPTS - 1]) {
      expect(await ensureKeyRecovery(d.ports, attempt)).toBe('retry')
    }
    expect(d.crypto.calls).not.toContain('bootstrapCrossSigning')
    expect(d.crypto.calls).not.toContain('bootstrapSecretStorage')
    expect(d.holder.secret).toBeUndefined()
  })

  it('carona do Nit (C2 §8 obs. 5): attempt 0 — a passada sob demanda (recheckKeyRecovery) NUNCA claima', async () => {
    // recheckKeyRecovery sempre chama com attempt 0: semântica wait-first, jamais adota a
    // winnership por conta própria. Segredo no escrow + 4S não materializado (vencedor em voo OU
    // morto) → attempt 0 espera; não bootstrapa nem re-deposita. Gatilho de fechamento do Nit:
    // esta fatia toca key-recovery.ts, então o unit de carona entra (nomeado, não só indireto).
    const world: World = { defaultKeyId: null }
    const fake = createEscrowFake({ 'tok-a': 'sub-a' })
    fake.secrets.set('sub-a', Buffer.from(new Uint8Array(32).fill(5)).toString('base64'))
    const d = device(world, fake, 'tok-a')
    expect(await ensureKeyRecovery(d.ports, 0)).toBe('retry')
    expect(d.crypto.calls).not.toContain('bootstrapCrossSigning')
    expect(d.crypto.calls).not.toContain('bootstrapSecretStorage')
    expect(fake.audit.filter((e) => e.verb === 'put')).toEqual([]) // nunca claima/deposita
    expect(d.holder.secret).toBeUndefined()
  })

  it('muro do UIA (401 + data.flows do MSC3967, PF-2) → needs-user, NÃO retry (o device não fica preso)', async () => {
    const world: World = { defaultKeyId: null }
    const fake = createEscrowFake({ 'tok-a': 'sub-a' })
    const d = device(world, fake, 'tok-a')
    // A substituição de identidade rejeita com 401 carregando os flows da UIA — forma verificada
    // no probe (m.oauth / org.matrix.cross_signing_reset). Classificação determinística.
    d.ports.crypto.bootstrapCrossSigning = async () => {
      throw Object.assign(new Error('uia required'), {
        httpStatus: 401,
        data: { session: 's', flows: [{ stages: ['org.matrix.cross_signing_reset'] }] },
      })
    }
    expect(await ensureKeyRecovery(d.ports)).toBe('needs-user')
    expect(d.holder.secret).toBeUndefined() // higiene do holder preservada em todo desfecho
  })

  it.each(['different', 'unreadable'] as const)(
    'half-state (%s, ADR-082 dec. 2): espera até o teto e levanta needs-user, sem importar nem tocar o backup',
    async (storedIdentity) => {
      const fake = createEscrowFake({ 'tok-a': 'sub-a' })
      const world: World = { defaultKeyId: 'k1', storedIdentity }
      const d = device(world, fake, 'tok-a')
      await d.ports.escrow.deposit(new Uint8Array(32).fill(3))
      expect(await ensureKeyRecovery(d.ports, CLAIM_AFTER_ATTEMPTS - 1)).toBe('retry')
      expect(await ensureKeyRecovery(d.ports, CLAIM_AFTER_ATTEMPTS)).toBe('needs-user')
      expect(d.crypto.calls).not.toContain('bootstrapCrossSigning')
      expect(d.crypto.calls).not.toContain('restoreKeyBackup')
      expect(d.holder.secret).toBeUndefined()
    },
  )

  it('401 SEM flows (transitório) → retry, não needs-user (discriminante determinístico, PF-2)', async () => {
    const world: World = { defaultKeyId: null }
    const fake = createEscrowFake({ 'tok-a': 'sub-a' })
    const d = device(world, fake, 'tok-a')
    d.ports.crypto.bootstrapCrossSigning = async () => {
      throw Object.assign(new Error('auth blip'), { httpStatus: 401 }) // sem data.flows
    }
    expect(await ensureKeyRecovery(d.ports)).toBe('retry')
    expect(d.holder.secret).toBeUndefined()
  })

  // ── ADR-061: consulta à custódia independente do backup; terceira janela de claim ──────────

  // O mundo da terceira janela: o vencedor morreu entre o 4S e o backup — 4S + segredo custodiado,
  // backup ausente. Materializado pelo vencedor real e depois "perdendo" o backup.
  async function halfBootstrapped(fake: ReturnType<typeof createEscrowFake>): Promise<World> {
    const world: World = { defaultKeyId: null }
    await ensureKeyRecovery(device(world, fake, 'tok-a').ports)
    world.backup = 'absent'
    return world
  }

  it('ADR-061 (i): 4S sem backup abaixo do teto → custódia consultada, retry, backup NÃO criado', async () => {
    const fake = createEscrowFake({ 'tok-a': 'sub-a', 'tok-a2': 'sub-a' })
    const world = await halfBootstrapped(fake)
    fake.sessionEntries = [{ room_id: '!r:x', session_id: 'sess-1', session_key: 'k1' }]

    const cold = device(world, fake, 'tok-a2')
    expect(await ensureKeyRecovery(cold.ports, CLAIM_AFTER_ATTEMPTS - 1)).toBe('retry')
    expect(cold.consults).toEqual([{ kind: 'consulted', sessionIds: ['sess-1'] }])
    expect(cold.crypto.calls).not.toContain('resetKeyBackup')
    expect(cold.crypto.calls).not.toContain('loadSessionBackupPrivateKeyFromSecretStorage')
    expect(world.backup).toBe('absent')
    expect(cold.holder.secret).toBeUndefined()
  })

  it('ADR-061 (ii): no teto → backup criado COM o segredo depositado, custódia consultada, done', async () => {
    const fake = createEscrowFake({ 'tok-a': 'sub-a', 'tok-a2': 'sub-a' })
    const world = await halfBootstrapped(fake)

    const cold = device(world, fake, 'tok-a2')
    expect(await ensureKeyRecovery(cold.ports, CLAIM_AFTER_ATTEMPTS)).toBe('done')
    const deposited = Buffer.from(fake.secrets.get('sub-a')!, 'base64')
    expect(Array.from(cold.crypto.backupCreatedWith!)).toEqual(Array.from(deposited))
    expect(world.backup).toBe('present')
    // A custódia vem DEPOIS do backup criado; nenhum 4S novo, nenhum PUT novo.
    const calls = cold.crypto.calls
    expect(calls.indexOf('resetKeyBackup')).toBeLessThan(calls.indexOf('importRoomKeysAsJson'))
    expect(calls).not.toContain('bootstrapSecretStorage')
    expect(cold.consults).toEqual([{ kind: 'consulted', sessionIds: [] }])
    expect(fake.audit.filter((e) => e.verb === 'put' && e.outcome === 'created')).toHaveLength(1)
    expect(cold.holder.secret).toBeUndefined()
  })

  it('ADR-061 (ii-b): probe que LANÇA (erro ≠ ausência provada) → retry; nada criado, nada consultado', async () => {
    const fake = createEscrowFake({ 'tok-a': 'sub-a', 'tok-a2': 'sub-a' })
    const world = await halfBootstrapped(fake)
    const cold = device(world, fake, 'tok-a2')
    cold.ports.probeBackup = async () => {
      throw new Error('transient http')
    }
    expect(await ensureKeyRecovery(cold.ports, CLAIM_AFTER_ATTEMPTS)).toBe('retry')
    expect(cold.crypto.calls).not.toContain('resetKeyBackup')
    expect(cold.consults).toEqual([])
  })

  it('ADR-061 (iii): backup presente e restore LANÇA → custódia consultada mesmo assim, done; falha reportada', async () => {
    const fake = createEscrowFake({ 'tok-a': 'sub-a', 'tok-a2': 'sub-a' })
    const world: World = { defaultKeyId: null }
    await ensureKeyRecovery(device(world, fake, 'tok-a').ports)
    fake.sessionEntries = [{ room_id: '!r:x', session_id: 'sess-1', session_key: 'k1' }]

    const cold = device(world, fake, 'tok-a2')
    cold.ports.crypto.restoreKeyBackup = async () => {
      throw new Error('restore failed')
    }
    expect(await ensureKeyRecovery(cold.ports)).toBe('done')
    expect(cold.backupFailures).toEqual(['restore'])
    expect(cold.consults).toEqual([{ kind: 'consulted', sessionIds: ['sess-1'] }])
  })

  it('ADR-061 (iv): bootstrapWorld (vencedor e claim) consulta a custódia', async () => {
    const fake = createEscrowFake({ 'tok-a': 'sub-a' })
    const orphan = new Uint8Array(32).fill(5)
    fake.secrets.set('sub-a', Buffer.from(orphan).toString('base64'))
    fake.sessionEntries = [{ room_id: '!r:x', session_id: 'sess-1', session_key: 'k1' }]
    const d = device({ defaultKeyId: null }, fake, 'tok-a')
    expect(await ensureKeyRecovery(d.ports, CLAIM_AFTER_ATTEMPTS)).toBe('done')
    expect(d.crypto.calls).toContain('bootstrapSecretStorage')
    expect(d.consults).toEqual([{ kind: 'consulted', sessionIds: ['sess-1'] }])
  })

  it('ADR-077 (substitui ADR-061 v): warm limpo → zero; warm + UTD → CustodyReconsult consulta a custódia', async () => {
    vi.useFakeTimers()
    try {
      const fake = createEscrowFake({ 'tok-a': 'sub-a' })
      fake.sessionEntries = [{ room_id: '!r:x', session_id: 'sess-1', session_key: 'k1' }]
      const d = device({ defaultKeyId: 'K' }, fake, 'tok-a', true)
      const pending = new Set<string>()
      const rc = new CustodyReconsult({
        consult: () => consultCustody(d.ports),
        imported: () => false,
        pending: (id) => pending.has(id),
        retryDecryption: (ids) => {
          for (const id of ids) pending.delete(id) // a chave importada decifra na re-tentativa
        },
      })
      expect(await ensureKeyRecovery(d.ports)).toBe('noop')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(fake.audit).toEqual([]) // warm limpo: sem UTD, nenhuma re-consulta nasce
      pending.add('sess-1')
      rc.note('sess-1')
      await vi.advanceTimersByTimeAsync(2_000)
      expect(d.consults).toEqual([{ kind: 'consulted', sessionIds: ['sess-1'] }])
      // Só a consulta de sessões — o segredo nunca é lido no warm.
      expect(fake.audit.map((e) => e.verb)).toEqual(['retrieve-sessions'])
      await vi.advanceTimersByTimeAsync(30_000)
      expect(fake.audit).toHaveLength(1) // decifrada na 1ª volta: sem mais voltas
    } finally {
      vi.useRealTimers()
    }
  })

  it('ADR-061 (vi): warm SEM re-passada sob demanda → zero chamadas ao escrow (C2 §5.2 assert 3 intacto)', async () => {
    const fake = createEscrowFake({ 'tok-a': 'sub-a' })
    fake.sessionEntries = [{ room_id: '!r:x', session_id: 'sess-1', session_key: 'k1' }]
    const d = device({ defaultKeyId: 'K' }, fake, 'tok-a', true)
    expect(await ensureKeyRecovery(d.ports)).toBe('noop')
    expect(await ensureKeyRecovery(d.ports, 0)).toBe('noop')
    expect(fake.audit).toEqual([])
    expect(d.consults).toEqual([])
  })

  it('claim-after-timeout: no teto, o device adota a winnership e bootstrapa COM o segredo depositado (zero PUT novo)', async () => {
    const world: World = { defaultKeyId: null }
    const fake = createEscrowFake({ 'tok-a': 'sub-a' })
    const orphan = new Uint8Array(32).fill(7)
    fake.secrets.set('sub-a', Buffer.from(orphan).toString('base64'))
    const d = device(world, fake, 'tok-a')

    expect(await ensureKeyRecovery(d.ports, CLAIM_AFTER_ATTEMPTS)).toBe('done')
    // O mundo foi criado A PARTIR do segredo órfão do escrow — nenhum segredo novo, em
    // hipótese alguma, neste caminho (invariante: bootstrap converge para o depositado).
    expect(Array.from(d.crypto.bootstrappedWith!)).toEqual(Array.from(orphan))
    expect(world.defaultKeyId).toBe('K')
    // Zero PUT: o claim NÃO re-deposita (o segredo já está custodiado; write-once intacto).
    expect(fake.audit.filter((e) => e.verb === 'put')).toEqual([])
    expect(d.holder.secret).toBeUndefined()
  })

  it('duplo-claim simultâneo converge para o MESMO segredo, sem erro e sem PUT', async () => {
    const world: World = { defaultKeyId: null }
    const fake = createEscrowFake({ 'tok-b1': 'sub-bob', 'tok-b2': 'sub-bob' })
    const orphan = new Uint8Array(32).fill(9)
    fake.secrets.set('sub-bob', Buffer.from(orphan).toString('base64'))
    const d1 = device(world, fake, 'tok-b1')
    const d2 = device(world, fake, 'tok-b2')

    const [r1, r2] = await Promise.all([
      ensureKeyRecovery(d1.ports, CLAIM_AFTER_ATTEMPTS),
      ensureKeyRecovery(d2.ports, CLAIM_AFTER_ATTEMPTS),
    ])
    expect([r1, r2]).toContain('done')
    // Convergência: quem reagir depois do mundo materializar cai no ramo de unlock; quem
    // claimar usa o MESMO segredo depositado — não há fonte de divergência.
    for (const d of [d1, d2]) {
      let outcome: string = [d1, d2].indexOf(d) === 0 ? r1 : r2
      for (let i = 0; i < 5 && outcome === 'retry'; i++) outcome = await ensureKeyRecovery(d.ports, i)
      expect(outcome).not.toBe('retry')
      const used = d.crypto.bootstrappedWith ?? d.crypto.adoptedWith
      expect(Array.from(used!)).toEqual(Array.from(orphan))
    }
    expect(fake.audit.filter((e) => e.verb === 'put')).toEqual([])
  })

  it('escrow indisponível → retry; nenhuma exceção; crypto intocado além do predicado warm', async () => {
    const world: World = { defaultKeyId: null }
    const fake = createEscrowFake({ 'tok-a': 'sub-a' })
    fake.mode = 'down'
    const d = device(world, fake, 'tok-a')
    expect(await ensureKeyRecovery(d.ports)).toBe('retry')
    expect(d.crypto.calls).toEqual(['getCrossSigningStatus']) // curto-circuito do predicado warm
  })

  it('escrow morre entre o GET e o PUT → retry SEM bootstrap (nada server-side aconteceu)', async () => {
    const world: World = { defaultKeyId: null }
    const d = device(world, createEscrowFake({}), 'tok-a')
    d.ports.escrow = {
      retrieve: async () => ({ kind: 'none' }),
      deposit: async () => ({ kind: 'unavailable' }),
      rotate: async () => ({ kind: 'unavailable' }),
      retrieveSessions: async () => ({ kind: 'unavailable' }),
      revokeOthers: async () => ({ kind: 'unavailable' }),
    }
    expect(await ensureKeyRecovery(d.ports)).toBe('retry')
    expect(d.crypto.calls).not.toContain('bootstrapCrossSigning')
    expect(d.crypto.calls).not.toContain('bootstrapSecretStorage')
    expect(d.holder.secret).toBeUndefined()
  })

  it('exceção do SDK no meio do bootstrap → retry; holder limpo; nada vaza', async () => {
    const world: World = { defaultKeyId: null }
    const fake = createEscrowFake({ 'tok-a': 'sub-a' })
    const d = device(world, fake, 'tok-a')
    d.ports.crypto.bootstrapCrossSigning = async () => {
      throw new Error('transient http')
    }
    expect(await ensureKeyRecovery(d.ports)).toBe('retry')
    expect(d.holder.secret).toBeUndefined()
    // O segredo FICOU depositado (write-once): o retry seguinte adota via recuperação.
    expect(fake.secrets.has('sub-a')).toBe(true)
  })

  it('corrida do primeiro PUT: exatamente um 201 e um 409; ambos convergem para o MESMO segredo', async () => {
    const world: World = { defaultKeyId: null }
    const fake = createEscrowFake({ 'tok-b1': 'sub-bob', 'tok-b2': 'sub-bob' })
    const d1 = device(world, fake, 'tok-b1')
    const d2 = device(world, fake, 'tok-b2')

    const [r1, r2] = await Promise.all([ensureKeyRecovery(d1.ports), ensureKeyRecovery(d2.ports)])
    // Determinismo do write-once: um created, um conflict — sempre.
    const putOutcomes = fake.audit.filter((e) => e.verb === 'put').map((e) => e.outcome)
    expect(putOutcomes.sort()).toEqual(['conflict', 'created'])
    expect([r1, r2]).toContain('done') // o vencedor sempre fecha

    // O perdedor pode ter visto o 4S ainda não materializado (consistência eventual) → o retry
    // do runner re-roda o MESMO ensureKeyRecovery até fechar (padrão da fatia A).
    for (const d of [d1, d2]) {
      let outcome: string = [d1, d2].indexOf(d) === 0 ? r1 : r2
      for (let i = 0; i < 5 && outcome === 'retry'; i++) outcome = await ensureKeyRecovery(d.ports)
      expect(outcome).not.toBe('retry')
    }

    const winning = Array.from(Buffer.from(fake.secrets.get('sub-bob')!, 'base64'))
    const used1 = d1.crypto.bootstrappedWith ?? d1.crypto.adoptedWith
    const used2 = d2.crypto.bootstrappedWith ?? d2.crypto.adoptedWith
    expect(Array.from(used1!)).toEqual(winning)
    expect(Array.from(used2!)).toEqual(winning)
    // Exatamente UM dos dois criou o mundo (identidade/4S); o outro só adotou.
    const creators = [d1, d2].filter((d) => d.crypto.calls.includes('bootstrapSecretStorage'))
    expect(creators).toHaveLength(1)
  })
})

describe('RecoveryRunner — retry em background (§3.3)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('start() retorna sem aguardar o pass (login nunca espera); done para o loop', async () => {
    let release!: (v: 'done') => void
    let runs = 0
    const runner = new RecoveryRunner(
      () =>
        new Promise<'done'>((resolve) => {
          runs++
          release = resolve
        }),
    )
    runner.start() // retorna AQUI, com o pass ainda pendente — nada foi aguardado
    expect(runs).toBe(1)
    release('done')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(runs).toBe(1) // nenhum re-agendamento após 'done'
  })

  it('retry → backoff exponencial com teto; para no primeiro desfecho não-retry', async () => {
    const outcomes = ['retry', 'retry', 'retry', 'noop'] as const
    let runs = 0
    const runner = new RecoveryRunner(async () => outcomes[Math.min(runs++, 3)]!, 1_000, 4_000)
    runner.start()
    await vi.advanceTimersByTimeAsync(0) // assenta o primeiro pass
    expect(runs).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000) // 1ª espera: base
    expect(runs).toBe(2)
    await vi.advanceTimersByTimeAsync(2_000) // 2ª espera: 2×
    expect(runs).toBe(3)
    await vi.advanceTimersByTimeAsync(4_000) // 3ª espera: teto
    expect(runs).toBe(4)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runs).toBe(4) // 'noop' encerrou
  })

  it('cancel() entre tentativas impede novas execuções', async () => {
    let runs = 0
    const runner = new RecoveryRunner(async () => {
      runs++
      return 'retry'
    }, 1_000)
    runner.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(runs).toBe(1)
    runner.cancel()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(runs).toBe(1)
  })

  it('cancel() com pass em voo torna o resultado inerte (nenhum agendamento posterior)', async () => {
    let release!: (v: 'retry') => void
    let runs = 0
    const runner = new RecoveryRunner(
      () =>
        new Promise<'retry'>((resolve) => {
          runs++
          release = resolve
        }),
      1_000,
    )
    runner.start() // entra no pass; fica pendente
    expect(runs).toBe(1)
    runner.cancel()
    release('retry') // resolve DEPOIS do cancel
    await vi.advanceTimersByTimeAsync(600_000)
    expect(runs).toBe(1) // resultado ignorado; nada re-agendado
  })

  it('exceção do run() (cinto-e-suspensório) vira retry, não unhandled rejection', async () => {
    let runs = 0
    const runner = new RecoveryRunner(async () => {
      runs++
      if (runs === 1) throw new Error('boom')
      return 'done'
    }, 1_000)
    runner.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(runs).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(runs).toBe(2)
  })

  it("'needs-user' (muro do UIA) → emite via onNeedsUser UMA vez e PARA o loop (ADR-019 §1)", async () => {
    let needsUser = 0
    let runs = 0
    const runner = new RecoveryRunner(
      async () => {
        runs++
        return 'needs-user'
      },
      undefined,
      undefined,
      () => {
        needsUser++
      },
    )
    runner.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(runs).toBe(1)
    expect(needsUser).toBe(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(runs).toBe(1) // parou no muro: não há re-tentativa de UIA headless
    expect(needsUser).toBe(1) // emite exatamente uma vez por ciclo do runner
  })

  it('backstop: preso em retry além do teto → onNeedsUser (fail-toward-oferecer) e para', async () => {
    let needsUser = 0
    let runs = 0
    // teto = 3 (delays = 1s): n=0,1 re-agendam; em n=2, n+1>=3 → emite e para.
    const runner = new RecoveryRunner(
      async () => {
        runs++
        return 'retry'
      },
      1_000,
      1_000,
      () => {
        needsUser++
      },
      3,
    )
    runner.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(runs).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(runs).toBe(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(runs).toBe(3)
    expect(needsUser).toBe(1)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(runs).toBe(3) // não re-agenda após o backstop
    expect(needsUser).toBe(1)
  })
})

// ── ADR-077: re-consulta à custódia por sessão Megolm desconhecida ──────────────────────────
// O agendador contra o MESMO escrow fake e a MESMA consulta (consultCustody) do pass: o gateway
// real só pluga o conjunto importado, o "ainda pendente" (eventos unavailable não decifrados) e a
// re-decifragem do SDK. `missing` espelha o custodyMissing do gateway (ADR-077 dec. 4).
describe('CustodyReconsult (ADR-077)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const rig = (opts: { warm?: boolean } = {}) => {
    const fake = createEscrowFake({ 'tok-a': 'sub-a' })
    fake.secrets.set('sub-a', Buffer.from(new Uint8Array(32).fill(7)).toString('base64'))
    const d = device({ defaultKeyId: 'K' }, fake, 'tok-a', opts.warm ?? false)
    let imported: Set<string> | undefined
    d.ports.onCustodySessions = (outcome) => {
      d.consults.push(outcome)
      if (outcome.kind !== 'consulted') return
      imported ??= new Set()
      for (const id of outcome.sessionIds) imported.add(id)
    }
    // Sessões com evento entregue à UI e ainda não decifrado (unavailableEmitted, no gateway).
    const pending = new Set<string>()
    const retries: string[][] = []
    const rc = new CustodyReconsult({
      consult: () => consultCustody(d.ports),
      imported: (id) => imported?.has(id) === true,
      pending: (id) => pending.has(id),
      retryDecryption: (ids) => {
        retries.push([...ids])
        // A chave importada decifra na re-tentativa: o evento deixa de ser pendente.
        for (const id of ids) if (imported?.has(id)) pending.delete(id)
      },
    })
    const missing = (id: string): boolean => imported !== undefined && !imported.has(id) && rc.exhausted(id)
    const gets = (): number => fake.audit.filter((e) => e.verb === 'retrieve-sessions').length
    const utd = (id: string): void => {
      pending.add(id)
      rc.note(id)
    }
    return { fake, d, rc, pending, retries, missing, gets, utd }
  }
  const entry = (id: string) => ({ room_id: '!r:x', session_id: id, session_key: `k-${id}` })

  it('constantes da dec. 2: 2/4/8/16 s (soma 30 s ≥ 21 s do agente), teto 4', () => {
    expect(CUSTODY_RECONSULT_DELAYS_MS).toEqual([2_000, 4_000, 8_000, 16_000])
    expect(CUSTODY_RECONSULT_MAX).toBe(4)
  })

  it('cold → UTD awaited em sessão desconhecida → re-consulta nos atrasos; importa na 3ª, re-decifra, sem lost', async () => {
    const r = rig()
    // O pass cold consulta no próprio pass — o depósito do agente ainda não chegou.
    expect(await ensureKeyRecovery(r.d.ports)).toBe('done')
    expect(r.gets()).toBe(1)
    r.utd('sess-new')
    expect(r.missing('sess-new')).toBe(false) // consulta feita, sessão ausente — mas sem teto: awaited

    await vi.advanceTimersByTimeAsync(1_999)
    expect(r.gets()).toBe(1)
    await vi.advanceTimersByTimeAsync(1) // +2 s — 1ª volta
    expect(r.gets()).toBe(2)
    expect(r.retries).toEqual([['sess-new']])
    await vi.advanceTimersByTimeAsync(4_000) // +6 s — 2ª volta
    expect(r.gets()).toBe(3)
    // O agente deposita entre a 2ª e a 3ª volta (+6,4–21 s medidos).
    r.fake.sessionEntries = [entry('sess-new')]
    await vi.advanceTimersByTimeAsync(7_999)
    expect(r.gets()).toBe(3)
    await vi.advanceTimersByTimeAsync(1) // +14 s — 3ª volta: importa
    expect(r.gets()).toBe(4)
    expect(r.d.consults.at(-1)).toEqual({ kind: 'consulted', sessionIds: ['sess-new'] })
    // Re-decifragem pedida NA MESMA volta da consulta que importou (dec. 3).
    expect(r.retries).toEqual([['sess-new'], ['sess-new'], ['sess-new']])
    expect(r.missing('sess-new')).toBe(false)
    // Resolvida: nenhuma 4ª volta.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(r.gets()).toBe(4)
  })

  it('esgota o teto: lost SÓ depois da 4ª volta (+30 s), e nenhuma 5ª', async () => {
    const r = rig()
    expect(await ensureKeyRecovery(r.d.ports)).toBe('done')
    r.utd('sess-gone')
    const at = [2_000, 6_000, 14_000, 30_000]
    let t = 0
    for (const [i, due] of at.entries()) {
      await vi.advanceTimersByTimeAsync(due - t - 1)
      expect(r.gets(), `antes da volta ${i + 1}`).toBe(1 + i)
      expect(r.missing('sess-gone'), `sem lost antes da volta ${i + 1}`).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(r.gets(), `volta ${i + 1}`).toBe(2 + i)
      t = due
    }
    expect(r.rc.exhausted('sess-gone')).toBe(true)
    expect(r.missing('sess-gone')).toBe(true)
    expect(r.retries).toHaveLength(CUSTODY_RECONSULT_MAX) // a 4ª re-falha assenta o grau honesto
    await vi.advanceTimersByTimeAsync(120_000)
    expect(r.gets()).toBe(1 + CUSTODY_RECONSULT_MAX)
    // Sessão esgotada não re-arma com novo UTD na mesma sessão de uso.
    r.utd('sess-gone')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(r.gets()).toBe(1 + CUSTODY_RECONSULT_MAX)
  })

  it('warm limpo, sem UTD → ZERO chamadas ao escrow (C2 §5.2 assert 3 preservado)', async () => {
    const r = rig({ warm: true })
    expect(await ensureKeyRecovery(r.d.ports)).toBe('noop')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(r.fake.audit).toEqual([])
    expect(r.d.consults).toEqual([])
  })

  it('UTD resolvido pelo key share comum (ms depois) → a volta descarta a sessão, ZERO GET', async () => {
    const r = rig({ warm: true })
    expect(await ensureKeyRecovery(r.d.ports)).toBe('noop')
    r.utd('sess-race')
    r.pending.delete('sess-race') // o to-device chegou; o Decrypted já fez o upgrade
    await vi.advanceTimersByTimeAsync(60_000)
    expect(r.fake.audit).toEqual([])
    expect(r.retries).toEqual([])
    expect(r.rc.exhausted('sess-race')).toBe(false)
  })

  it('coalescência: duas sessões desconhecidas na mesma espera → UMA consulta, re-decifragem das duas', async () => {
    const r = rig()
    expect(await ensureKeyRecovery(r.d.ports)).toBe('done')
    r.utd('sess-a')
    await vi.advanceTimersByTimeAsync(1_000)
    r.utd('sess-b') // chega durante a espera da 1ª volta
    await vi.advanceTimersByTimeAsync(1_000)
    expect(r.gets()).toBe(2) // pass + UMA volta
    expect(r.retries).toEqual([['sess-a', 'sess-b']])
    r.fake.sessionEntries = [entry('sess-a'), entry('sess-b')]
    await vi.advanceTimersByTimeAsync(4_000)
    expect(r.gets()).toBe(3)
    expect(r.retries.at(-1)).toEqual(['sess-a', 'sess-b'])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(r.gets()).toBe(3)
  })

  it('sessão já no import → não agenda; cancel (disconnect) mata a volta armada', async () => {
    const r = rig()
    r.fake.sessionEntries = [entry('sess-known')]
    expect(await ensureKeyRecovery(r.d.ports)).toBe('done')
    r.utd('sess-known')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(r.gets()).toBe(1)

    r.utd('sess-other')
    r.rc.cancel()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(r.gets()).toBe(1)
    r.utd('sess-late') // depois do teardown: inerte
    await vi.advanceTimersByTimeAsync(60_000)
    expect(r.gets()).toBe(1)
  })

  it('consulta indisponível conta como tentativa: sem veredito, sem laço', async () => {
    const r = rig()
    expect(await ensureKeyRecovery(r.d.ports)).toBe('done')
    r.utd('sess-x')
    r.d.ports.escrow = { ...r.d.ports.escrow, retrieveSessions: async () => ({ kind: 'unavailable' }) }
    await vi.advanceTimersByTimeAsync(30_000)
    expect(r.rc.exhausted('sess-x')).toBe(true)
    // O conjunto do pass cold existe e a sessão nunca veio: o veredito vem do teto, como no caminho feliz.
    expect(r.missing('sess-x')).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(r.retries).toHaveLength(CUSTODY_RECONSULT_MAX)
  })
})
