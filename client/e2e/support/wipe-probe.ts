import type { Page } from '@playwright/test'

// #247 (PLANO-RELEASE-PUBLICA §8.62): the diagnosis a forbidden `[acl] store wipe timed out` needs.
// A healthy sign-out closes the rust crypto store's IndexedDB connection synchronously inside
// stopClient (RustCrypto.stop → olmMachine.close → last Arc of the store dropped). A blocked wipe means
// another holder of that Arc at close() time; the root of the stack of the connection's LATE close says
// which: a wasm future still in flight, or a wasm object only released by the GC (FinalizationRegistry).
//
// Records, for the rust store only, every open/close of a connection (close with its JS+wasm stack)
// and the deleteDatabase with its blocked/success. No console output (the ledger stays clean). The
// page buffers in `window.__tayetWipeProbeLog` and forwards each event through a binding to a list on
// the test side: the sign-out and the late close happen in one document, the ledger is checked after
// the re-login navigated to another, so a window-only buffer would lose the event that decides.
// Cost: one event per open/close/delete of the store, a few dozen per session.

const RUST_STORE = 'matrix-js-sdk::matrix-sdk-crypto'
const BINDING = '__tayetWipeProbe'

export interface WipeEvent {
  /** performance.now() of the document that recorded it. */
  t: number
  /** performance.timeOrigin of that document: events of one document share it. */
  doc: number
  kind: 'open' | 'close' | 'delete' | 'delete-blocked' | 'delete-success' | 'delete-error'
  conn?: number
  stack?: string
}

const recorded = new WeakMap<Page, WipeEvent[]>()

const INIT = `(() => {
  const STORE = ${JSON.stringify(RUST_STORE)};
  const log = (window.__tayetWipeProbeLog = []);
  const record = (kind, conn, stack) => {
    const e = { t: performance.now(), doc: performance.timeOrigin, kind, conn, stack };
    log.push(e);
    try { window.${BINDING}?.(e); } catch {}
  };
  const F = IDBFactory.prototype;
  const open0 = F.open, del0 = F.deleteDatabase, close0 = IDBDatabase.prototype.close;
  const conns = new WeakMap();
  let seq = 0;
  F.open = function (name, ...rest) {
    const req = open0.call(this, name, ...rest);
    if (name === STORE) {
      req.addEventListener('success', () => {
        const conn = ++seq;
        conns.set(req.result, conn);
        record('open', conn);
      });
    }
    return req;
  };
  F.deleteDatabase = function (name) {
    const req = del0.call(this, name);
    if (name === STORE) {
      record('delete');
      req.addEventListener('blocked', () => record('delete-blocked'));
      req.addEventListener('success', () => record('delete-success'));
      req.addEventListener('error', () => record('delete-error'));
    }
    return req;
  };
  IDBDatabase.prototype.close = function () {
    if (this.name === STORE) {
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 60;
      const stack = new Error().stack;
      Error.stackTraceLimit = limit;
      record('close', conns.get(this), stack);
    }
    return close0.call(this);
  };
})()`

/** Install on a page before it navigates; idempotent per page. */
export function installWipeProbe(page: Page): void {
  if (recorded.has(page)) return
  const events: WipeEvent[] = []
  recorded.set(page, events)
  void page.exposeBinding(BINDING, (_source, e: WipeEvent) => void events.push(e)).catch(() => {})
  void page.addInitScript(INIT).catch(() => {})
}

// The stack of a close is shown only where it decides something: the last close before each delete
// (the healthy one, inside stopClient) and every close after a delete (the late one of a blocked wipe).
// The other closes are the store's own migrations at login.
export function dumpWipeProbe(page: Page): string {
  const events = recorded.get(page) ?? []
  if (!events.length) return 'wipe probe: no event of the rust crypto store recorded'
  const lastCloseBeforeDelete = new Set<WipeEvent>()
  let lastClose: WipeEvent | undefined
  let afterDelete = false
  const withStack = new Set<WipeEvent>()
  for (const e of events) {
    if (e.kind === 'close') {
      lastClose = e
      if (afterDelete) withStack.add(e)
    } else if (e.kind === 'open') {
      afterDelete = false
    } else if (e.kind === 'delete') {
      if (lastClose) lastCloseBeforeDelete.add(lastClose)
      afterDelete = true
    }
  }
  for (const e of lastCloseBeforeDelete) withStack.add(e)
  const lines = [`wipe probe (${RUST_STORE}), t in ms of each document:`]
  let doc: number | undefined
  // An open followed at once by its own close, without a stack to show: the store's migrations at
  // boot, folded into one line per run.
  let run: { first: WipeEvent; last: WipeEvent } | undefined
  const flush = () => {
    if (!run) return
    const span = `${run.first.t.toFixed(1)}–${run.last.t.toFixed(1)}`
    lines.push(`    ${span.padStart(10)}  #${run.first.conn}–#${run.last.conn} opened and closed (migrations)`)
    run = undefined
  }
  for (const [i, e] of events.entries()) {
    const next = events[i + 1]
    const pair = e.kind === 'open' && next?.kind === 'close' && next.conn === e.conn && next.doc === e.doc && !withStack.has(next)
    if (e.doc !== doc) {
      flush()
      doc = e.doc
      lines.push(`  document @ ${new Date(e.doc).toISOString()}`)
    }
    if (pair) {
      run = run ? { first: run.first, last: e } : { first: e, last: e }
      continue
    }
    if (e.kind === 'close' && run && run.last.conn === e.conn) {
      run.last = e
      continue
    }
    flush()
    lines.push(`    ${e.t.toFixed(1).padStart(10)}  ${e.kind}${e.conn ? ` #${e.conn}` : ''}`)
    if (e.stack && withStack.has(e)) {
      // `←` rather than `at`: Playwright reads `at …` lines of a failure message as its own stack.
      for (const frame of e.stack.split('\n').slice(1)) lines.push(`                  ← ${frame.trim().replace(/^at /, '')}`)
    }
  }
  flush()
  return lines.join('\n')
}
