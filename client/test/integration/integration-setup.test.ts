import { describe, it, expect } from 'vitest'

// The integration setup (test/integration-setup.ts) tracks every fetch of the file so the end of the
// file can wait for what is still in flight (PLANO-RELEASE-PUBLICA §8.36). No stack needed: a data:
// URL resolves locally and port 9 (discard) refuses.
const TRACKED = Symbol.for('aurora.integration.fetchTracked')
const inflightOf = (): Set<Promise<Response>> | undefined =>
  (globalThis.fetch as typeof fetch & { [TRACKED]?: Set<Promise<Response>> })[TRACKED]

describe('integration setup — fetch tracker', () => {
  it('is installed in an integration file', () => {
    expect(inflightOf()).toBeInstanceOf(Set)
  })

  it('tracks the same promise while in flight and drops it when settled', async () => {
    const pending = fetch('data:text/plain,ok')
    expect(inflightOf()!.has(pending)).toBe(true)
    expect(await (await pending).text()).toBe('ok')
    await new Promise((r) => setTimeout(r, 0))
    expect(inflightOf()!.has(pending)).toBe(false)
  })

  it('passes a rejection through to the caller unchanged', async () => {
    await expect(fetch('http://127.0.0.1:9/')).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(inflightOf()!.size).toBe(0)
  })
})
