// ── Lock de aba: uma aba ativa por origem (ADR-065). ──────────────────────────────────────────────
// A sessão persistida (session-store.ts, chave constante) e o store de cripto (IndexedDB de prefixo
// constante, dentro da ACL) são únicos por ORIGEM. Duas abas com client próprio disputam o mesmo
// refresh token e abrem duas OlmMachines sobre o mesmo store (PLANO-RELEASE-PUBLICA §8.24, variante
// (d)). Este módulo é o lado APP da exclusão: um lock `navigator.locks` exclusivo, de nome constante
// pelo mesmo motivo que o blob e o store têm nome constante. Trabalho de app (ADR-030: a posse da
// sessão é do app) — nada daqui cruza o barrel da ACL, e a ACL segue multi-instância.
//
// O Boot adquire com `ifAvailable` no topo do run(), ANTES do primeiro uso de token (refresh do boot,
// callback OIDC, modo env): quem não leva o lock fica na tela neutra e não lê a sessão. A liberação é
// por fase do Boot (ADR-065 D2). Sem a API (contexto inseguro, browser antigo) o comportamento é o
// anterior ao ADR-065, com um aviso no console (D7).
//
// "Usar aqui" (D4/D5): o requisitante publica `release-request` num BroadcastChannel e ENFILEIRA um
// request normal (sem ifAvailable, com signal). O dono vivo cede gravando uma flag em sessionStorage e
// recarregando — sem wipe, sem signOut, sem request; o unload solta o lock, o wasm e o IndexedDB. Ele
// NÃO solta o lock antes do reload: soltar com a OlmMachine viva daria o store a duas abas. Dono
// fechado/descartado: o lock cai sozinho. Dono congelado: o requisitante espera, sem prazo — tomar o lock
// à força nunca é opção (rodaria duas OlmMachines no mesmo store por construção). Quem adquire publica
// `acquired`; um requisitante que o recebe aborta o próprio request (último clique vence). BFCache
// (D6): o lock não é solto no pagehide; um pageshow `persisted` recarrega e passa de novo pelo lock.

export const TAB_LOCK_NAME = 'tayet.session-owner'
// Latência de UX adjudicada pelo owner (ADR-065 D4): depois disso a copy de espera do "Usar aqui"
// passa à secundária. Não é prazo de correção — a espera continua.
export const WAIT_COPY_DELAY_MS = 3_000
// sessionStorage (por aba): esta aba acabou de ceder → o próximo boot vai direto à tela neutra.
const YIELDED_FLAG = 'tayet.tab-yielded'

type TabLockMessage = { t: 'release-request' } | { t: 'acquired' }

export type TabLockAcquire = 'held' | 'busy' | 'unsupported'

export interface TabLock {
  // `ifAvailable`: nunca enfileira. Idempotente enquanto esta aba segura o lock.
  acquire(): Promise<TabLockAcquire>
  // Solta o lock (no-op se não o segura).
  release(): void
  // "Usar aqui": pede ao dono que ceda e espera na fila. true = esta aba segura o lock; false = outra
  // aba adquiriu antes (`acquired`) ou cancel().
  takeOver(): { granted: Promise<boolean>; cancel: () => void }
  // Esta aba acabou de ceder? Lê e apaga a flag.
  consumeYielded(): boolean
  // Escuta enquanto o Boot está montado: `release-request` → se segura o lock, cede por reload;
  // pageshow persisted → reload. Devolve o dispose.
  watch(): () => void
}

export interface TabLockChannel {
  postMessage(message: TabLockMessage): void
  addEventListener(type: 'message', listener: (e: { data: unknown }) => void): void
  removeEventListener(type: 'message', listener: (e: { data: unknown }) => void): void
  close(): void
}

interface FlagStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface PageEvents {
  addEventListener(type: 'pageshow', listener: (e: { persisted?: boolean }) => void): void
  removeEventListener(type: 'pageshow', listener: (e: { persisted?: boolean }) => void): void
}

// Só o pedaço do LockManager que usamos — o fake dos testes implementa isto.
export interface LockRequester {
  request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<void> | undefined,
  ): Promise<unknown>
}

export interface TabLockEnv {
  locks: LockRequester | undefined
  openChannel?: () => TabLockChannel | undefined
  reload?: () => void
  flags?: FlagStore
  page?: PageEvents
}

export function browserTabLockEnv(): TabLockEnv {
  const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: LockRequester }).locks : undefined
  let flags: FlagStore | undefined
  try {
    flags = typeof sessionStorage !== 'undefined' ? sessionStorage : undefined
  } catch {
    flags = undefined
  }
  return {
    locks,
    openChannel: () =>
      typeof BroadcastChannel !== 'undefined' ? (new BroadcastChannel(TAB_LOCK_NAME) as TabLockChannel) : undefined,
    reload: () => window.location.reload(),
    flags,
    page: typeof window !== 'undefined' ? window : undefined,
  }
}

const isMessage = (data: unknown, t: TabLockMessage['t']): boolean =>
  typeof data === 'object' && data !== null && (data as { t?: unknown }).t === t

export function createTabLock(env: TabLockEnv = browserTabLockEnv()): TabLock {
  let releaseHeld: (() => void) | undefined
  let warned = false
  let channel: TabLockChannel | undefined
  let channelUsers = 0

  // Um canal por aba, aberto enquanto alguém (watch / takeOver) o usa.
  const openChannel = (): TabLockChannel | undefined => {
    channelUsers++
    channel ??= env.openChannel?.()
    return channel
  }
  const closeChannel = (): void => {
    channelUsers--
    if (channelUsers === 0) {
      channel?.close()
      channel = undefined
    }
  }
  const announceAcquired = (): void => {
    const ch = openChannel()
    ch?.postMessage({ t: 'acquired' })
    closeChannel()
  }

  const unsupported = (): TabLockAcquire => {
    if (!warned) {
      warned = true
      console.warn('[boot] tab lock unavailable')
    }
    return 'unsupported'
  }

  return {
    acquire: () => {
      if (releaseHeld) return Promise.resolve('held')
      const locks = env.locks
      if (!locks) return Promise.resolve(unsupported())
      return new Promise<TabLockAcquire>((resolve) => {
        locks
          .request(TAB_LOCK_NAME, { ifAvailable: true }, (lock) => {
            if (!lock) {
              resolve('busy')
              return undefined
            }
            // Segurado enquanto esta promise não assenta: release() a resolve.
            return new Promise<void>((done) => {
              releaseHeld = done
              announceAcquired()
              resolve('held')
            })
          })
          // A API existe mas recusou (ex.: SecurityError em origem opaca) → mesmo regime de "sem API".
          .catch(() => resolve(unsupported()))
      })
    },
    release: () => {
      const done = releaseHeld
      releaseHeld = undefined
      done?.()
    },
    takeOver: () => {
      const locks = env.locks
      const abort = new AbortController()
      if (!locks) return { granted: Promise.resolve(false), cancel: () => {} }
      const ch = openChannel()
      const onMessage = (e: { data: unknown }): void => {
        if (isMessage(e.data, 'acquired')) abort.abort()
      }
      ch?.addEventListener('message', onMessage)
      ch?.postMessage({ t: 'release-request' })
      const granted = new Promise<boolean>((resolve) => {
        locks
          .request(TAB_LOCK_NAME, { signal: abort.signal }, () => {
            return new Promise<void>((done) => {
              releaseHeld = done
              announceAcquired()
              resolve(true)
            })
          })
          .catch(() => resolve(false))
      }).finally(() => {
        ch?.removeEventListener('message', onMessage)
        closeChannel()
      })
      return { granted, cancel: () => abort.abort() }
    },
    consumeYielded: () => {
      try {
        const yielded = (env.flags?.getItem(YIELDED_FLAG) ?? null) !== null
        env.flags?.removeItem(YIELDED_FLAG)
        return yielded
      } catch {
        return false
      }
    },
    watch: () => {
      const ch = openChannel()
      const onMessage = (e: { data: unknown }): void => {
        if (!isMessage(e.data, 'release-request') || !releaseHeld) return
        try {
          env.flags?.setItem(YIELDED_FLAG, '1')
        } catch {
          // best-effort: sem a flag, o reload tenta o lock e cai na tela neutra do mesmo jeito
        }
        env.reload?.()
      }
      const onPageShow = (e: { persisted?: boolean }): void => {
        if (e.persisted === true) env.reload?.()
      }
      ch?.addEventListener('message', onMessage)
      env.page?.addEventListener('pageshow', onPageShow)
      return () => {
        ch?.removeEventListener('message', onMessage)
        env.page?.removeEventListener('pageshow', onPageShow)
        closeChannel()
      }
    },
  }
}
