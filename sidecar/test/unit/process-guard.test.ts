import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FREED_CRYPTO_REJECTION, handleRejection, SDK_ORPHAN_REJECTION } from '../../src/process-guard'
import { SIDECAR_ROOT } from '../support/sidecar-process'

// The orphan rejection of the SDK, and the abort of a request in flight, are tolerated only after the core
// called stopClient (§0.3.6 adj. 12; §8.19 item 19).
function run(reason: unknown, stopping: boolean) {
  const logs: Array<Record<string, unknown>> = []
  const exits: number[] = []
  handleRejection(reason, { stopping: () => stopping, log: (l) => logs.push(l), exit: (c) => exits.push(c) })
  return { logs, exits }
}

describe('process guard', () => {
  it('before stopClient: the orphan message is fatal (exit 1)', () => {
    const r = run(new Error(SDK_ORPHAN_REJECTION), false)
    expect(r.exits).toEqual([1])
    expect(r.logs).toEqual([{ evt: 'fatal', stage: 'unhandled-rejection', message: SDK_ORPHAN_REJECTION }])
  })

  it('after stopClient: the exact orphan message is one log line, no exit', () => {
    const r = run(new Error(SDK_ORPHAN_REJECTION), true)
    expect(r.exits).toEqual([])
    expect(r.logs).toEqual([{ evt: 'sdk-orphan-rejection', message: SDK_ORPHAN_REJECTION }])
  })

  it('after stopClient: any other rejection (or a non-Error with the text) stays fatal', () => {
    expect(run(new Error('boom'), true).exits).toEqual([1])
    expect(run(SDK_ORPHAN_REJECTION, true).exits).toEqual([1])
    expect(run(new Error(`${SDK_ORPHAN_REJECTION}!`), true).exits).toEqual([1])
  })

  // §8.19 item 19 (issue #7): stopClient() aborts an SDK request nobody holds. The reason, captured from
  // dist/cli.js under the parallel unit run: DOMException `AbortError`, "This operation was aborted".
  const fetchAbort = async (): Promise<unknown> => {
    const c = new AbortController()
    c.abort()
    return fetch('http://127.0.0.1:9', { signal: c.signal }).catch((e: unknown) => e)
  }

  it('after stopClient: the abort of a request (AbortError) is dropped — no line, no exit', async () => {
    const reason = await fetchAbort()
    expect(reason).toMatchObject({ name: 'AbortError', message: 'This operation was aborted' })
    expect(run(reason, true)).toEqual({ logs: [], exits: [] })
    expect(run(new DOMException('This operation was aborted', 'AbortError'), true)).toEqual({ logs: [], exits: [] })
  })

  it('before stopClient: the same abort is fatal (exit 1, unhandled-rejection)', async () => {
    const r = run(await fetchAbort(), false)
    expect(r.exits).toEqual([1])
    expect(r.logs).toEqual([{ evt: 'fatal', stage: 'unhandled-rejection', message: 'This operation was aborted' }])
  })

  it('after stopClient: matched by the error name, never by the message', () => {
    // The text of an abort with another name, and a plain object named AbortError, stay fatal.
    expect(run(new Error('This operation was aborted'), true).exits).toEqual([1])
    expect(run(new DOMException('This operation was aborted', 'TimeoutError'), true).exits).toEqual([1])
    expect(run({ name: 'AbortError', message: 'This operation was aborted' }, true).exits).toEqual([1])
  })

  it('the freed crypto machine ("null pointer passed to rust"): one line after stopClient, fatal before it (S-h)', () => {
    const after = run(new Error(FREED_CRYPTO_REJECTION), true)
    expect(after.exits).toEqual([])
    expect(after.logs).toEqual([{ evt: 'sdk-orphan-rejection', message: FREED_CRYPTO_REJECTION }])
    expect(run(new Error(FREED_CRYPTO_REJECTION), false).exits).toEqual([1])
    expect(run(FREED_CRYPTO_REJECTION, true).exits).toEqual([1])
    expect(run(new Error(`${FREED_CRYPTO_REJECTION} (other)`), true).exits).toEqual([1])
  })

  it('boot.ts marks immediately before each of its stopClient() calls', () => {
    const src = readFileSync(join(SIDECAR_ROOT, 'src', 'boot.ts'), 'utf8')
    const calls = src.split('\n').flatMap((line, i, all) => (line.includes('client.stopClient()') ? [all[i - 1]?.trim()] : []))
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls.every((prev) => prev === 'markClientStopping()')).toBe(true)
  })
})
