import type { LockRequester } from '../../src/ui/tab-lock'

// Fake do LockManager (Web Locks) para os testes do lock de aba (ADR-065): UM lock exclusivo por
// nome, fila FIFO, `ifAvailable` (callback com null, sem enfileirar) e `signal` (abort rejeita com
// AbortError e sai da fila). Compartilhado entre "abas" (instâncias de TabLock) do mesmo teste — é o
// papel da origem. Não implementa `steal`: o produto nunca o usa (ADR-065 D4).
export class FakeLocks implements LockRequester {
  private held = false
  private readonly queue: Array<() => void> = []
  readonly calls: Array<{ ifAvailable?: boolean; signal?: boolean; steal?: unknown }> = []

  isHeld(): boolean {
    return this.held
  }

  pending(): number {
    return this.queue.length
  }

  request(
    _name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal; steal?: unknown },
    callback: (lock: unknown) => Promise<void> | undefined,
  ): Promise<unknown> {
    this.calls.push({ ifAvailable: options.ifAvailable, signal: options.signal !== undefined, steal: options.steal })
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        this.held = true
        void Promise.resolve(callback({ name: _name })).then((v) => {
          this.held = false
          resolve(v)
          this.queue.shift()?.()
        })
      }
      if (!this.held && this.queue.length === 0) return grant()
      if (options.ifAvailable) {
        void Promise.resolve(callback(null)).then(resolve)
        return
      }
      const signal = options.signal
      if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
      const entry = (): void => {
        signal?.removeEventListener('abort', onAbort)
        grant()
      }
      const onAbort = (): void => {
        const i = this.queue.indexOf(entry)
        if (i >= 0) this.queue.splice(i, 1)
        reject(new DOMException('aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', onAbort)
      this.queue.push(entry)
    })
  }
}

// Fake do BroadcastChannel do lock de aba: um barramento por "origem"; postMessage entrega de forma
// assíncrona (como o real) a todos os OUTROS canais abertos, nunca ao próprio.
export class FakeBus {
  private readonly open = new Set<FakeChannel>()
  readonly posted: unknown[] = []

  channel(): FakeChannel {
    const ch = new FakeChannel(this)
    this.open.add(ch)
    return ch
  }

  deliver(from: FakeChannel, data: unknown): void {
    this.posted.push(data)
    for (const ch of this.open) if (ch !== from) setTimeout(() => ch.dispatch(data), 0)
  }

  drop(ch: FakeChannel): void {
    this.open.delete(ch)
  }
}

export class FakeChannel {
  private readonly listeners = new Set<(e: { data: unknown }) => void>()
  private closed = false
  constructor(private readonly bus: FakeBus) {}
  postMessage(data: unknown): void {
    if (!this.closed) this.bus.deliver(this, data)
  }
  addEventListener(_t: 'message', l: (e: { data: unknown }) => void): void {
    this.listeners.add(l)
  }
  removeEventListener(_t: 'message', l: (e: { data: unknown }) => void): void {
    this.listeners.delete(l)
  }
  close(): void {
    this.closed = true
    this.bus.drop(this)
  }
  dispatch(data: unknown): void {
    if (!this.closed) for (const l of this.listeners) l({ data })
  }
}

// sessionStorage de uma aba.
export class FakeFlags {
  private readonly m = new Map<string, string>()
  getItem(k: string): string | null {
    return this.m.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v)
  }
  removeItem(k: string): void {
    this.m.delete(k)
  }
  size(): number {
    return this.m.size
  }
}
