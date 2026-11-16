// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, cleanup, screen, waitFor, act, within } from '@testing-library/react'

// ADR-065: o lock de aba no Boot. O fluxo OIDC é mockado no módulo app (como em boot-lifecycle).
vi.mock('../../src/ui/oidc', () => ({
  isCallback: vi.fn(() => false),
  beginLogin: vi.fn(async () => {}),
  completeLogin: vi.fn(async () => 'OIDC_BLOB' as unknown),
  scrubCallback: vi.fn(),
  isErrorCallback: vi.fn(() => false),
}))

import { Boot } from '../../src/ui/components/Boot'
import { isCallback, completeLogin, scrubCallback, isErrorCallback } from '../../src/ui/oidc'
import { createTabLock, TAB_LOCK_NAME, WAIT_COPY_DELAY_MS, type TabLockEnv } from '../../src/ui/tab-lock'
import { ConnectionError, SessionExpiredError } from '../../src/acl'
import type { Acl, AclTelemetry, OpaqueSession } from '../../src/acl'
import { STORE_WIPE_BOUND_MS } from '../../src/acl/internal/matrix-client'
import { FakeBus, FakeFlags, FakeLocks } from '../support/fake-locks'

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const session = (v: string) => v as unknown as OpaqueSession
const READY = 'STUB_READY_SURFACE'
const renderReady = () => <div>{READY}</div>
const base = { serverUrl: 'http://x', clientId: 'TAYET', ssoLabel: 'Dex (local)', telemetry: noopTelemetry }
const ELSEWHERE = 'O Tayet já está aberto em outra aba deste navegador'

// Outra aba que já segura o lock (mesma "origem" = mesmo FakeLocks).
async function otherTabHolds(locks: FakeLocks) {
  const other = createTabLock({ locks })
  expect(await other.acquire()).toBe('held')
  return other
}

// O lock está livre? (uma terceira aba consegue com ifAvailable — e solta em seguida).
async function lockIsFree(locks: FakeLocks): Promise<boolean> {
  const probe = createTabLock({ locks })
  const got = await probe.acquire()
  probe.release()
  return got === 'held'
}

afterEach(() => {
  cleanup()
  vi.mocked(isCallback).mockReturnValue(false)
  vi.mocked(isErrorCallback).mockReturnValue(false)
  vi.mocked(completeLogin).mockClear()
  vi.mocked(scrubCallback).mockClear()
  vi.restoreAllMocks()
})

describe('tab-lock: o módulo', () => {
  it('ifAvailable, nome constante, idempotente enquanto segura; release solta', async () => {
    const locks = new FakeLocks()
    const a = createTabLock({ locks })
    expect(await a.acquire()).toBe('held')
    expect(await a.acquire()).toBe('held')
    expect(locks.calls).toEqual([{ ifAvailable: true, signal: false, steal: undefined }])
    expect(TAB_LOCK_NAME).toBe('tayet.session-owner')
    const b = createTabLock({ locks })
    expect(await b.acquire()).toBe('busy')
    a.release()
    await waitFor(() => expect(locks.isHeld()).toBe(false))
    expect(await b.acquire()).toBe('held')
  })

  it('sem navigator.locks → unsupported, com um aviso único no console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lock = createTabLock({ locks: undefined })
    expect(await lock.acquire()).toBe('unsupported')
    expect(await lock.acquire()).toBe('unsupported')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[boot] tab lock unavailable')
  })
})

describe('Boot: aba sem lock (ADR-065 D3)', () => {
  it('outra aba segura o lock → tela neutra; não lê a sessão, não cria client', async () => {
    const locks = new FakeLocks()
    await otherTabHolds(locks)
    const resolve = vi.fn(() => session('PERSISTED_BLOB'))
    const makeAcl = vi.fn()
    render(
      <Boot {...base} envToken={undefined} resolve={resolve} makeAcl={makeAcl} tabLock={createTabLock({ locks })} renderReady={renderReady} />,
    )
    await waitFor(() => expect(screen.getByText(ELSEWHERE)).toBeTruthy())
    expect(screen.getByText('Continue por lá ou traga o Tayet para esta aba.')).toBeTruthy()
    expect(resolve).not.toHaveBeenCalled()
    expect(makeAcl).not.toHaveBeenCalled()
  })

  it('callback OIDC numa aba sem lock → não troca o código e preserva a URL', async () => {
    vi.mocked(isCallback).mockReturnValue(true)
    const locks = new FakeLocks()
    await otherTabHolds(locks)
    const makeAcl = vi.fn()
    render(<Boot {...base} envToken={undefined} makeAcl={makeAcl} tabLock={createTabLock({ locks })} renderReady={renderReady} />)
    await waitFor(() => expect(screen.getByText(ELSEWHERE)).toBeTruthy())
    expect(completeLogin).not.toHaveBeenCalled()
    expect(scrubCallback).not.toHaveBeenCalled()
    expect(makeAcl).not.toHaveBeenCalled()
  })

  it('sem navigator.locks → o caminho de antes (connect → ready), com o aviso', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const acl = { connect: vi.fn(async () => {}) } as unknown as Acl
    render(
      <Boot
        {...base}
        envToken="mct_ok"
        makeAcl={() => acl}
        resolve={(t) => (t ? session(t) : null)}
        tabLock={createTabLock({ locks: undefined })}
        renderReady={renderReady}
      />,
    )
    await waitFor(() => expect(screen.getByText(READY)).toBeTruthy())
    expect(warn).toHaveBeenCalledWith('[boot] tab lock unavailable')
  })
})

describe('Boot: liberação por fase (ADR-065 D2)', () => {
  const boot = (locks: FakeLocks, acl: Partial<Acl>, resolved: OpaqueSession | null = session('BLOB')) => {
    let fireLost: () => void = () => {}
    render(
      <Boot
        {...base}
        envToken={undefined}
        resolve={() => resolved}
        makeAcl={(_s, _t, _r, onLost) => {
          fireLost = onLost
          return acl as Acl
        }}
        tabLock={createTabLock({ locks })}
        renderReady={(_acl, onSignOut) => <button onClick={onSignOut}>{READY}</button>}
      />,
    )
    return { fireLost: () => fireLost() }
  }

  it('connecting e ready seguram', async () => {
    const locks = new FakeLocks()
    let finish: () => void = () => {}
    boot(locks, { connect: vi.fn(() => new Promise<void>((r) => (finish = r))) })
    await waitFor(() => expect(locks.isHeld()).toBe(true))
    expect(await lockIsFree(locks)).toBe(false) // connecting
    act(() => finish())
    await waitFor(() => expect(screen.getByText(READY)).toBeTruthy())
    expect(await lockIsFree(locks)).toBe(false) // ready
  })

  it('no-session solta', async () => {
    const locks = new FakeLocks()
    boot(locks, {}, null)
    await waitFor(() => expect(screen.getByText('Entre no Tayet')).toBeTruthy())
    await waitFor(async () => expect(await lockIsFree(locks)).toBe(true))
  })

  it('idp-denied solta', async () => {
    vi.mocked(isErrorCallback).mockReturnValue(true)
    const locks = new FakeLocks()
    boot(locks, {})
    await waitFor(() => expect(screen.getByText('Não foi possível entrar')).toBeTruthy())
    await waitFor(async () => expect(await lockIsFree(locks)).toBe(true))
  })

  it('error solta; o retry readquire', async () => {
    const locks = new FakeLocks()
    const connect = vi.fn(async (): Promise<void> => {
      throw new ConnectionError()
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    boot(locks, { connect })
    await waitFor(() => expect(screen.getByText('Não foi possível conectar')).toBeTruthy())
    await waitFor(async () => expect(await lockIsFree(locks)).toBe(true))
    connect.mockImplementation(() => new Promise<void>(() => {}))
    act(() => screen.getByText('Tentar novamente').click())
    await waitFor(() => expect(locks.isHeld()).toBe(true))
  })

  it('failed segura (o escape dele faz wipe)', async () => {
    const locks = new FakeLocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    boot(locks, {
      connect: vi.fn(async () => {
        throw new Error('local')
      }),
    })
    await waitFor(() => expect(screen.getByText('Não foi possível iniciar')).toBeTruthy())
    expect(await lockIsFree(locks)).toBe(false)
  })

  it('revoked no boot (wipe já assentou dentro do connect) solta', async () => {
    const locks = new FakeLocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    boot(locks, {
      connect: vi.fn(async () => {
        throw new SessionExpiredError()
      }),
    })
    await waitFor(() => expect(screen.getByText('Seu acesso foi encerrado')).toBeTruthy())
    await waitFor(async () => expect(await lockIsFree(locks)).toBe(true))
  })

  it('sair → revoked solta depois do signOut da ACL (wipe assentado)', async () => {
    const locks = new FakeLocks()
    let wiped: () => void = () => {}
    const signOut = vi.fn(() => new Promise<void>((r) => (wiped = r)))
    boot(locks, { connect: vi.fn(async () => {}), signOut })
    await waitFor(() => expect(screen.getByText(READY)).toBeTruthy())
    act(() => screen.getByText(READY).click())
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1))
    expect(await lockIsFree(locks)).toBe(false)
    act(() => wiped())
    await waitFor(() => expect(screen.getByText('Seu acesso foi encerrado')).toBeTruthy())
    await waitFor(async () => expect(await lockIsFree(locks)).toBe(true))
  })

  it('sessão perdida → revoked JÁ; o lock só solta quando o wipe assenta', async () => {
    const locks = new FakeLocks()
    let wiped: () => void = () => {}
    const signOut = vi.fn(() => new Promise<void>((r) => (wiped = r)))
    const { fireLost } = boot(locks, { connect: vi.fn(async () => {}), signOut })
    await waitFor(() => expect(screen.getByText(READY)).toBeTruthy())
    act(() => fireLost())
    expect(screen.getByText('Seu acesso foi encerrado')).toBeTruthy() // ADR-059 D2: a tela não espera
    expect(await lockIsFree(locks)).toBe(false)
    act(() => wiped())
    await waitFor(async () => expect(await lockIsFree(locks)).toBe(true))
  })

  it('sessão perdida com wipe bloqueado → o lock solta no STORE_WIPE_BOUND_MS (o bound do signOut da ACL)', async () => {
    // O signOut real da ACL assenta no bound mesmo com o deleteDatabase preso por outra conexão
    // (matrix-client.ts, bounded(…, STORE_WIPE_BOUND_MS, 'store wipe')). O fake reproduz isso.
    const locks = new FakeLocks()
    const signOut = vi.fn(() => new Promise<void>((r) => setTimeout(r, STORE_WIPE_BOUND_MS)))
    const { fireLost } = boot(locks, { connect: vi.fn(async () => {}), signOut })
    await waitFor(() => expect(screen.getByText(READY)).toBeTruthy())
    vi.useFakeTimers()
    try {
      act(() => fireLost())
      expect(screen.getByText('Seu acesso foi encerrado')).toBeTruthy()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STORE_WIPE_BOUND_MS - 1)
      })
      expect(locks.isHeld()).toBe(true)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(locks.isHeld()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── Handoff (ADR-065 D4–D6) ───────────────────────────────────────────────────────────────────────
// Cada "aba" = um env próprio (flags, reload, pageshow) sobre a MESMA origem (FakeLocks + FakeBus).
function tab(locks: FakeLocks, bus: FakeBus) {
  const flags = new FakeFlags()
  const reload = vi.fn()
  const page = new EventTarget()
  const env: TabLockEnv = {
    locks,
    openChannel: () => bus.channel(),
    reload,
    flags,
    page: page as unknown as TabLockEnv['page'],
  }
  return { env, flags, reload, page, lock: createTabLock(env) }
}

const HANDOFF = 'Trazendo o Tayet para esta aba…'
const HANDOFF_LONG = 'A outra aba não respondeu. Feche-a ou volte a ela por um instante.'

function bootTab(t: ReturnType<typeof tab>, acl: Partial<Acl> = { connect: vi.fn(async () => {}) }) {
  const makeAcl = vi.fn(() => acl as Acl)
  const resolve = vi.fn(() => session('BLOB'))
  const view = render(
    <Boot {...base} envToken={undefined} resolve={resolve} makeAcl={makeAcl} tabLock={t.lock} renderReady={renderReady} />,
  )
  // Duas "abas" no mesmo document: as queries ficam presas ao container DESTA aba.
  return { ...within(view.container), makeAcl, resolve }
}

describe('Boot: "Usar aqui" (ADR-065 D4–D6)', () => {
  it('o dono vivo cede por reload (flag, sem soltar antes); o requisitante adquire e conecta', async () => {
    const locks = new FakeLocks()
    const bus = new FakeBus()
    const owner = tab(locks, bus)
    const ownerView = bootTab(owner)
    await waitFor(() => expect(ownerView.getByText(READY)).toBeTruthy())

    const req = tab(locks, bus)
    const reqView = bootTab(req)
    await waitFor(() => expect(reqView.getByText(ELSEWHERE)).toBeTruthy())
    act(() => reqView.getByText('Usar aqui').click())
    await waitFor(() => expect(reqView.getByText(HANDOFF)).toBeTruthy())

    // O dono recebe o release-request: grava a flag e recarrega — o lock segue com ele até o unload.
    await waitFor(() => expect(owner.reload).toHaveBeenCalledTimes(1))
    expect(owner.flags.getItem('tayet.tab-yielded')).toBe('1')
    expect(locks.isHeld()).toBe(true)
    expect(reqView.queryByText(READY)).toBeNull()

    // O unload do reload solta o lock (aqui: release explícito, o que o browser faz no unload).
    owner.lock.release()
    await waitFor(() => expect(reqView.getByText(READY)).toBeTruthy())
    expect(reqView.resolve).toHaveBeenCalledTimes(1)
    expect(bus.posted).toContainEqual({ t: 'acquired' })
    expect(locks.calls.every((c) => c.steal === undefined)).toBe(true)
  })

  it('reload com a flag → tela neutra direto, sem tentar o lock; a flag some', async () => {
    const locks = new FakeLocks()
    const bus = new FakeBus()
    const t = tab(locks, bus)
    t.flags.setItem('tayet.tab-yielded', '1')
    const view = bootTab(t)
    await waitFor(() => expect(view.getByText(ELSEWHERE)).toBeTruthy())
    expect(locks.calls).toEqual([])
    expect(view.resolve).not.toHaveBeenCalled()
    expect(t.flags.size()).toBe(0)
  })

  it('dono que não responde (congelado): request pendente, copy secundária em WAIT_COPY_DELAY_MS, sem steal; liberação posterior → adquire', async () => {
    const locks = new FakeLocks()
    const bus = new FakeBus()
    const frozen = tab(locks, bus)
    expect(await frozen.lock.acquire()).toBe('held') // segura e não escuta (sem watch)

    const req = tab(locks, bus)
    const view = bootTab(req)
    await waitFor(() => expect(view.getByText(ELSEWHERE)).toBeTruthy())
    vi.useFakeTimers()
    try {
      act(() => view.getByText('Usar aqui').click())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WAIT_COPY_DELAY_MS - 1)
      })
      expect(view.getByText(HANDOFF)).toBeTruthy()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(view.getByText(HANDOFF_LONG)).toBeTruthy()
      expect(locks.pending()).toBe(1)
      expect(locks.calls.at(-1)).toEqual({ ifAvailable: undefined, signal: true, steal: undefined })
      // Muito depois: continua esperando, nunca rouba.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * WAIT_COPY_DELAY_MS)
      })
      expect(locks.pending()).toBe(1)
      expect(view.queryByText(READY)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
    frozen.lock.release() // descongelou e cedeu / foi descartada
    await waitFor(() => expect(view.getByText(READY)).toBeTruthy())
  })

  it('D-ACQUIRED: outro requisitante adquire antes → o request pendente aborta e volta à tela neutra', async () => {
    const locks = new FakeLocks()
    const bus = new FakeBus()
    const frozen = tab(locks, bus)
    expect(await frozen.lock.acquire()).toBe('held')

    const first = tab(locks, bus)
    const firstGranted = first.lock.takeOver().granted // clicou antes: 1º da fila

    const req = tab(locks, bus)
    const view = bootTab(req)
    await waitFor(() => expect(view.getByText(ELSEWHERE)).toBeTruthy())
    act(() => view.getByText('Usar aqui').click())
    await waitFor(() => expect(locks.pending()).toBe(2))

    frozen.lock.release()
    expect(await firstGranted).toBe(true)
    await waitFor(() => expect(view.getByText(ELSEWHERE)).toBeTruthy())
    expect(view.getByText('Usar aqui')).toBeTruthy()
    expect(locks.pending()).toBe(0)
    expect(view.makeAcl).not.toHaveBeenCalled()
  })

  it('pageshow vindo do BFCache (persisted) → reload; pageshow normal → nada', async () => {
    const locks = new FakeLocks()
    const bus = new FakeBus()
    const t = tab(locks, bus)
    const view = bootTab(t)
    await waitFor(() => expect(view.getByText(READY)).toBeTruthy())
    act(() => {
      t.page.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }))
    })
    expect(t.reload).not.toHaveBeenCalled()
    act(() => {
      t.page.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
    })
    expect(t.reload).toHaveBeenCalledTimes(1)
  })

  it('callback OIDC numa aba sem lock: não troca o código; depois de "Usar aqui", tenta o completeLogin', async () => {
    vi.mocked(isCallback).mockReturnValue(true)
    const locks = new FakeLocks()
    const bus = new FakeBus()
    const owner = tab(locks, bus)
    expect(await owner.lock.acquire()).toBe('held')
    owner.lock.watch()

    const req = tab(locks, bus)
    const view = bootTab(req)
    await waitFor(() => expect(view.getByText(ELSEWHERE)).toBeTruthy())
    expect(completeLogin).not.toHaveBeenCalled()
    expect(scrubCallback).not.toHaveBeenCalled()

    act(() => view.getByText('Usar aqui').click())
    await waitFor(() => expect(owner.reload).toHaveBeenCalledTimes(1))
    owner.lock.release()
    await waitFor(() => expect(completeLogin).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(view.getByText(READY)).toBeTruthy())
  })
})
