// One run per burst: calls in the same tick collapse into a single run on the next microtask.
// `people.changed` fires once per state event, and the first sync delivers hundreds in a row.
export function coalesce(run: () => void): () => void {
  let queued = false
  return () => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      run()
    })
  }
}
