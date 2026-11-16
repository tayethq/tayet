import { describe, it, expect, vi } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import {
  compareIdentity,
  phaseOf,
  resetAccess,
  ResetDeferredError,
  type ResetPorts,
  type ResetPhase,
  type StoredIdentity,
} from '../src/acl/internal/key-reset'
import type {
  EscrowClient,
  RotateOutcome,
  DepositOutcome,
  RevokeOthersOutcome,
} from '../src/acl/internal/escrow-client'

// ── resetAccess — fluxo total único re-entrante (ADR-019 §2/§3, ADR-082) ────────────────────────
// Unit contra ports fakes (o SDK fica na integração). Provam o phase-machine: janela no gesto,
// aprovação → revogação → rotate → upload, RETOMADA sem re-burn no half-state (a propriedade de
// re-entrância), adoção (recover) do vencedor do CAS, fail-closed na custódia indisponível, e a
// higiene do holder (set/clear balanceado em todo desfecho).

interface Harness {
  ports: ResetPorts
  calls: string[]
  fresh: Uint8Array<ArrayBuffer>
  recreate4SArg?: Uint8Array<ArrayBuffer>
  resetIdentityCalled: () => boolean
  adoptArg?: Uint8Array<ArrayBuffer>
}

function harness(opts: {
  phases: ResetPhase[]
  rotate?: RotateOutcome
  deposit?: DepositOutcome
  history?: boolean
  approved?: boolean
  revoke?: RevokeOthersOutcome
  resetIdentityFails?: boolean
}): Harness {
  const calls: string[] = []
  let phaseIdx = 0
  const fresh = new Uint8Array(32).fill(99) as Uint8Array<ArrayBuffer>
  const h: Harness = { ports: undefined as never, calls, fresh, resetIdentityCalled: () => calls.includes('resetIdentity') }

  const escrow: EscrowClient = {
    deposit: async () => {
      calls.push('deposit')
      return opts.deposit ?? { kind: 'deposited' }
    },
    retrieve: async () => ({ kind: 'none' }), // observe is faked; never reached here
    rotate: async (_secret, etag) => {
      calls.push(`rotate:${etag}`)
      return opts.rotate ?? { kind: 'rotated', etag: 'etag-new' }
    },
    retrieveSessions: async () => ({ kind: 'unavailable' }), // PR-5: fora do caminho do reset
    revokeOthers: async () => {
      calls.push('revokeOthers')
      return opts.revoke ?? { kind: 'revoked' }
    },
  }

  h.ports = {
    escrow,
    openApproval: () => {
      calls.push('openApproval')
      return {
        wait: async () => {
          calls.push('approvalWait')
          return opts.approved ?? true
        },
        close: () => {
          calls.push('approvalClose')
        },
      }
    },
    observe: async () => {
      calls.push('observe')
      return opts.phases[Math.min(phaseIdx++, opts.phases.length - 1)]!
    },
    generateSecret: () => {
      calls.push('generateSecret')
      return fresh
    },
    resetIdentity: async () => {
      calls.push('resetIdentity')
      if (opts.resetIdentityFails) throw new Error('401')
    },
    resetBackup: async () => {
      calls.push('resetBackup')
    },
    recreate4S: async (s) => {
      calls.push('recreate4S')
      h.recreate4SArg = s
    },
    adoptWorld: async (s) => {
      calls.push('adoptWorld')
      h.adoptArg = s
    },
    restoreHistory: async () => {
      calls.push('restoreHistory')
      return opts.history ?? true
    },
    raiseAttention: () => {
      calls.push('raiseAttention')
    },
    setSecret: () => {
      calls.push('setSecret')
    },
    clearSecret: () => {
      calls.push('clearSecret')
    },
  }
  return h
}

const balancedHolder = (calls: string[]): boolean =>
  calls.filter((c) => c === 'setSecret').length === calls.filter((c) => c === 'clearSecret').length &&
  calls.filter((c) => c === 'setSecret').length > 0

describe('resetAccess — phase machine', () => {
  it("'fresh' (mundo saudável): rotate-primeiro p/ segredo NOVO, reset de identidade, 4S do novo, done", async () => {
    const custodied = new Uint8Array(32).fill(1) as Uint8Array<ArrayBuffer>
    const h = harness({ phases: [{ kind: 'fresh', secret: custodied, etag: 'E1' }] })
    const out = await resetAccess(h.ports)
    expect(out).toEqual({ t: 'done', historyPreserved: true })
    expect(h.calls).toContain('generateSecret')
    expect(h.calls).toContain('rotate:E1') // CAS no etag corrente
    expect(h.calls).toContain('resetIdentity')
    expect(Array.from(h.recreate4SArg!)).toEqual(Array.from(h.fresh)) // 4S rooteado no segredo NOVO
    expect(balancedHolder(h.calls)).toBe(true)
  })

  it("RE-ENTRÂNCIA — 'resume' (meu half-state): RETOMA do segredo já custodiado, sem re-burn, sem regenerar", async () => {
    const custodied = new Uint8Array(32).fill(7) as Uint8Array<ArrayBuffer>
    const h = harness({ phases: [{ kind: 'resume', secret: custodied }] })
    const out = await resetAccess(h.ports)
    expect(out.t).toBe('done')
    // A propriedade-chave: NÃO gera material novo nem rotaciona de novo — retoma do observado.
    expect(h.calls).not.toContain('generateSecret')
    expect(h.calls.some((c) => c.startsWith('rotate'))).toBe(false)
    expect(h.calls).not.toContain('deposit')
    // O 4S é recriado a partir do segredo JÁ na custódia (não de um regenerado-e-perdido).
    expect(Array.from(h.recreate4SArg!)).toEqual(Array.from(custodied))
    expect(h.calls).toContain('resetIdentity') // idempotente
    expect(balancedHolder(h.calls)).toBe(true)
  })

  it("'adopt' (vencedor do CAS / mundo alheio): RECUPERA (import), NUNCA reseta identidade nem recria 4S", async () => {
    const winner = new Uint8Array(32).fill(3) as Uint8Array<ArrayBuffer>
    const h = harness({ phases: [{ kind: 'adopt', secret: winner }] })
    const out = await resetAccess(h.ports)
    expect(out.t).toBe('done')
    expect(h.calls).toContain('adoptWorld')
    expect(Array.from(h.adoptArg!)).toEqual(Array.from(winner))
    expect(h.calls).not.toContain('resetIdentity') // recover, não reset (não dessincroniza)
    expect(h.calls).not.toContain('recreate4S')
    expect(h.calls).not.toContain('generateSecret')
    expect(balancedHolder(h.calls)).toBe(true)
  })

  it('CAS perdido (rotate→stale): re-observa e CONVERGE adotando o mundo do vencedor (superseded não vaza)', async () => {
    const old = new Uint8Array(32).fill(1) as Uint8Array<ArrayBuffer>
    const winner = new Uint8Array(32).fill(2) as Uint8Array<ArrayBuffer>
    const h = harness({
      phases: [
        { kind: 'fresh', secret: old, etag: 'E1' }, // antes da aprovação
        { kind: 'fresh', secret: old, etag: 'E1' }, // depois dela: o rotate perde o CAS
        { kind: 'adopt', secret: winner },
      ],
      rotate: { kind: 'stale' },
    })
    const out = await resetAccess(h.ports)
    expect(out.t).toBe('done')
    expect(h.calls.filter((c) => c === 'observe').length).toBe(3) // re-observou após o 412
    expect(h.calls).toContain('rotate:E1')
    expect(h.calls).toContain('adoptWorld')
    expect(h.calls).not.toContain('resetIdentity')
  })

  it("'fresh' sem nada custodiado (none): deposita (write-once), sem rotate, e constrói do novo", async () => {
    const h = harness({ phases: [{ kind: 'fresh' }], deposit: { kind: 'deposited' } })
    const out = await resetAccess(h.ports)
    expect(out.t).toBe('done')
    expect(h.calls).toContain('deposit')
    expect(h.calls.some((c) => c.startsWith('rotate'))).toBe(false)
    expect(Array.from(h.recreate4SArg!)).toEqual(Array.from(h.fresh))
  })

  it("'fresh' + deposit racing (exists): re-observa e adota (não cria mundo paralelo)", async () => {
    const winner = new Uint8Array(32).fill(5) as Uint8Array<ArrayBuffer>
    const h = harness({
      phases: [{ kind: 'fresh' }, { kind: 'fresh' }, { kind: 'adopt', secret: winner }],
      deposit: { kind: 'exists' },
    })
    const out = await resetAccess(h.ports)
    expect(out.t).toBe('done')
    expect(h.calls).toContain('deposit')
    expect(h.calls.filter((c) => c === 'observe').length).toBe(3)
    expect(h.calls).toContain('adoptWorld')
  })

  it('custódia indisponível → fail-closed: re-oferece via device.attention e NÃO finge done', async () => {
    const h = harness({ phases: [{ kind: 'unreachable' }] })
    await expect(resetAccess(h.ports)).rejects.toBeInstanceOf(ResetDeferredError)
    expect(h.calls).toContain('raiseAttention')
    expect(h.calls).not.toContain('resetIdentity')
  })

  it('rotate indisponível (não 412) → fail-closed: re-oferece e NÃO finge done; storage intocado', async () => {
    const old = new Uint8Array(32).fill(1) as Uint8Array<ArrayBuffer>
    const h = harness({ phases: [{ kind: 'fresh', secret: old, etag: 'E1' }], rotate: { kind: 'unavailable' } })
    await expect(resetAccess(h.ports)).rejects.toBeInstanceOf(ResetDeferredError)
    expect(h.calls).toContain('raiseAttention')
    expect(h.calls).not.toContain('resetIdentity')
  })

  it('perda honesta: historyPreserved reflete o restore best-effort (false quando nada recupera)', async () => {
    const custodied = new Uint8Array(32).fill(7) as Uint8Array<ArrayBuffer>
    const h = harness({ phases: [{ kind: 'resume', secret: custodied }], history: false })
    expect(await resetAccess(h.ports)).toEqual({ t: 'done', historyPreserved: false })
  })
})

describe('resetAccess — aprovação antes do rotate (ADR-082 dec. 1 e 3)', () => {
  const custodied = new Uint8Array(32).fill(1) as Uint8Array<ArrayBuffer>
  const healthy: ResetPhase = { kind: 'fresh', secret: custodied, etag: 'E1' }
  const before = (calls: string[], a: string, b: string): boolean => calls.indexOf(a) !== -1 && calls.indexOf(a) < calls.indexOf(b)

  it('a janela abre ANTES do primeiro await: resetAccess a abriu ao retornar a Promise', () => {
    // Síncrono de propósito, sem await: mover o openApproval para depois de qualquer await deixa
    // `calls` vazio aqui, e o bloqueador de popup barraria a janela fora do gesto.
    const h = harness({ phases: [healthy] })
    const running = resetAccess(h.ports)
    expect(h.calls[0]).toBe('openApproval')
    return running
  })

  it('o verbo do gateway também: window.open acontece antes do primeiro await', async () => {
    const popup = { closed: false, close: vi.fn() }
    const open = vi.fn(() => popup)
    vi.stubGlobal('window', { open })
    try {
      const gateway = new MatrixGateway({ mode: 'strict', telemetry: { untranslated: () => {} }, serverUrl: 'http://hs.test' })
      const running = gateway.resetAccess()
      expect(open).toHaveBeenCalledTimes(1)
      await expect(running).rejects.toBeInstanceOf(ResetDeferredError) // sem conexão: 'unreachable'
      expect(popup.close).toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a ordem é aprovação → revogação → histórico → rotate → 4S novo → identidade → backup → varredura', async () => {
    const h = harness({ phases: [healthy] })
    await resetAccess(h.ports)
    const order = ['approvalWait', 'revokeOthers', 'restoreHistory', 'rotate:E1', 'recreate4S', 'resetIdentity', 'resetBackup']
    for (let i = 1; i < order.length; i++) expect(before(h.calls, order[i - 1]!, order[i]!), order[i]).toBe(true)
    expect(h.calls.filter((c) => c === 'revokeOthers')).toHaveLength(2)
    expect(h.calls.lastIndexOf('revokeOthers')).toBeGreaterThan(h.calls.indexOf('resetBackup'))
    expect(h.calls.at(-1)).toBe('approvalClose')
  })

  it('o mundo é re-observado depois da aprovação: o rotate usa o etag de agora', async () => {
    const h = harness({ phases: [healthy, { kind: 'fresh', secret: custodied, etag: 'E2' }] })
    await resetAccess(h.ports)
    expect(h.calls).toContain('rotate:E2')
    expect(h.calls).not.toContain('rotate:E1')
  })

  it('desistência: não-conclusão, sem revogar, sem burn, sem atenção num mundo saudável', async () => {
    const h = harness({ phases: [healthy], approved: false })
    await expect(resetAccess(h.ports)).rejects.toBeInstanceOf(ResetDeferredError)
    for (const step of ['revokeOthers', 'generateSecret', 'rotate:E1', 'recreate4S', 'resetIdentity', 'raiseAttention']) {
      expect(h.calls).not.toContain(step)
    }
    expect(h.calls.at(-1)).toBe('approvalClose')
  })

  it('revogação falhou: não-conclusão, sem burn (dec. 3)', async () => {
    const h = harness({ phases: [healthy], revoke: { kind: 'unavailable' } })
    await expect(resetAccess(h.ports)).rejects.toBeInstanceOf(ResetDeferredError)
    expect(h.calls).not.toContain('generateSecret')
    expect(h.calls.some((c) => c.startsWith('rotate'))).toBe(false)
  })

  it("'resume' pede a aprovação e revoga como o reset, sem novo rotate", async () => {
    const h = harness({ phases: [{ kind: 'resume', secret: custodied }] })
    await resetAccess(h.ports)
    expect(before(h.calls, 'approvalWait', 'resetIdentity')).toBe(true)
    expect(before(h.calls, 'revokeOthers', 'resetIdentity')).toBe(true)
    expect(h.calls.some((c) => c.startsWith('rotate'))).toBe(false)
  })

  it('401 tardio no upload: vira half-state re-oferecido, e a re-chamada converge sem novo burn', async () => {
    const h = harness({ phases: [healthy], resetIdentityFails: true })
    await expect(resetAccess(h.ports)).rejects.toBeInstanceOf(ResetDeferredError)
    expect(h.calls).toContain('raiseAttention')
    expect(balancedHolder(h.calls)).toBe(true)

    const next = harness({ phases: [{ kind: 'resume', secret: h.fresh }] })
    expect((await resetAccess(next.ports)).t).toBe('done')
    expect(next.calls.some((c) => c.startsWith('rotate'))).toBe(false)
    expect(Array.from(next.recreate4SArg!)).toEqual(Array.from(h.fresh))
  })

  it("'adopt' real e 'unreachable' fecham a janela sem esperar aprovação", async () => {
    const adopt = harness({ phases: [{ kind: 'adopt', secret: custodied }] })
    await resetAccess(adopt.ports)
    const down = harness({ phases: [{ kind: 'unreachable' }] })
    await expect(resetAccess(down.ports)).rejects.toBeInstanceOf(ResetDeferredError)
    for (const h of [adopt, down]) {
      expect(h.calls).not.toContain('approvalWait')
      expect(h.calls.indexOf('approvalClose')).toBeLessThan(h.calls.indexOf(h === adopt ? 'adoptWorld' : 'raiseAttention'))
    }
  })

  it('historyPreserved vem do backup ANTERIOR: o restore roda antes do rotate, com o segredo velho no holder', async () => {
    const h = harness({ phases: [healthy], history: false })
    expect(await resetAccess(h.ports)).toEqual({ t: 'done', historyPreserved: false })
    expect(before(h.calls, 'restoreHistory', 'rotate:E1')).toBe(true)
    expect(h.calls.filter((c) => c === 'restoreHistory')).toHaveLength(1)
  })
})

describe('half-state (ADR-082 dec. 2)', () => {
  const secret = new Uint8Array(32).fill(4) as Uint8Array<ArrayBuffer>
  const world = (identity: StoredIdentity, has4S = true, crossSigningCached = true) =>
    phaseOf({ secret, etag: 'E', has4S, crossSigningCached, identity })

  it('a pública derivada do 4S contra a do servidor: igual, diferente, ilegível', () => {
    expect(compareIdentity('PUB', 'PUB')).toBe('same')
    expect(compareIdentity('PUB', 'OTHER')).toBe('different')
    expect(compareIdentity('PUB', undefined)).toBe('different')
    expect(compareIdentity(undefined, 'PUB')).toBe('unreadable')
  })

  it("igual: comportamento do ADR-019 ('fresh' com a identidade em mãos, 'adopt' sem ela)", () => {
    expect(world('same').kind).toBe('fresh')
    expect(world('same', true, false).kind).toBe('adopt')
  })

  it("diferente ou ilegível: 'resume' de QUALQUER device, nunca 'adopt'", () => {
    for (const identity of ['different', 'unreadable'] as const) {
      expect(world(identity).kind).toBe('resume')
      expect(world(identity, true, false).kind).toBe('resume')
    }
  })

  it('sem 4S: meu meio-reset retoma; perda total recomeça', () => {
    expect(world('unreadable', false, true).kind).toBe('resume')
    expect(world('unreadable', false, false).kind).toBe('fresh')
  })
})
