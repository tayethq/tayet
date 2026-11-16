import type { DataExportOptions, DataExportPart } from '../../src/acl'

// Fakes of the data export verb (Acl.exportMyData) for the screen's tests.

/** A verb whose parts end at once (for surfaces that only mount "Sua conta"). */
export const noExport = (): AsyncIterable<DataExportPart> => ({
  [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: undefined }) }),
})

/**
 * A verb whose parts the test hands out one by one. `push` delivers a part to the pending next() (or queues
 * it); `fail` rejects the pending next(); aborting the run's signal rejects it with the signal's reason, as
 * the real verb does. `calls` holds each run's options, `closed` counts iterators closed by return().
 */
export function controlledExport() {
  interface Run {
    opts: DataExportOptions
    queue: Array<{ part?: DataExportPart; error?: unknown }>
    waiting?: { resolve: (r: IteratorResult<DataExportPart>) => void; reject: (e: unknown) => void }
    finished: boolean
  }
  const runs: Run[] = []
  const state = { closed: 0 }

  const settle = (run: Run) => {
    if (!run.waiting || run.queue.length === 0) return
    const { resolve, reject } = run.waiting
    run.waiting = undefined
    const item = run.queue.shift()!
    if (item.error !== undefined) {
      run.finished = true
      reject(item.error)
    } else resolve({ done: false, value: item.part! })
  }

  const verb = (opts: DataExportOptions): AsyncIterable<DataExportPart> => {
    const run: Run = { opts, queue: [], finished: false }
    runs.push(run)
    opts.signal?.addEventListener('abort', () => {
      run.queue.push({ error: opts.signal!.reason })
      settle(run)
    })
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          run.finished
            ? Promise.resolve({ done: true as const, value: undefined })
            : new Promise<IteratorResult<DataExportPart>>((resolve, reject) => {
                run.waiting = { resolve, reject }
                settle(run)
              }),
        return: async () => {
          run.finished = true
          state.closed++
          return { done: true as const, value: undefined }
        },
      }),
    }
  }

  const last = (): Run => runs[runs.length - 1] ?? (() => { throw new Error('no export run') })()
  return {
    verb,
    runs,
    get closed() {
      return state.closed
    },
    push(part: DataExportPart) {
      const run = last()
      run.queue.push({ part })
      settle(run)
    },
    fail(error: unknown = new Error('lost')) {
      const run = last()
      run.queue.push({ error })
      settle(run)
    },
  }
}
