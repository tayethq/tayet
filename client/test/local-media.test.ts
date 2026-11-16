import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LocalMediaRegistry } from '../src/acl/internal/local-media'

// PLANO-FASE-1-UPLOAD §2/§3 (commit 3): the LOCAL MediaRef registry that backs the optimistic
// attachment preview. resolveMedia of a local ref must yield an object URL of the picked bytes
// with an IDEMPOTENT release() — and never touch the SDK or carry an mxc (§6). These are pure
// unit assertions; the end-to-end gateway path is covered by the optimistic-echo tests (commit 5).

let created: Blob[]
let revoked: string[]
let realCreate: unknown
let realRevoke: unknown

beforeEach(() => {
  created = []
  revoked = []
  realCreate = (globalThis.URL as unknown as { createObjectURL?: unknown }).createObjectURL
  realRevoke = (globalThis.URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
  let n = 0
  ;(globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b) => {
    created.push(b)
    n += 1
    return `blob:local/${n}`
  }
  ;(globalThis.URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (u) => {
    revoked.push(u)
  }
})

afterEach(() => {
  ;(globalThis.URL as unknown as Record<string, unknown>).createObjectURL = realCreate
  ;(globalThis.URL as unknown as Record<string, unknown>).revokeObjectURL = realRevoke
})

describe('LocalMediaRegistry (optimistic attachment preview)', () => {
  it('mints an opaque, non-mxc token and resolves it to an object URL of the bytes', () => {
    const reg = new LocalMediaRegistry()
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    const token = reg.mint(blob)

    // The token is opaque — never an mxc (P1 / §6).
    expect(token).not.toMatch(/mxc:\/\//)
    expect(reg.has(token)).toBe(true)

    const resolved = reg.resolve(token)
    expect(resolved).toBeDefined()
    expect(resolved!.url).toBe('blob:local/1')
    expect(created[0]).toBe(blob) // resolved from the SAME bytes, no fetch
  })

  it('release() is idempotent — revokes once even when called twice', () => {
    const reg = new LocalMediaRegistry()
    const token = reg.mint(new Blob([new Uint8Array([9])]))
    const resolved = reg.resolve(token)!
    resolved.release()
    resolved.release()
    expect(revoked).toEqual([resolved.url])
  })

  it('resolves the same bytes across remounts (decision (a): blob kept for the session)', () => {
    const reg = new LocalMediaRegistry()
    const blob = new Blob([new Uint8Array([7, 7])])
    const token = reg.mint(blob)

    const first = reg.resolve(token)!
    first.release() // unmount
    const second = reg.resolve(token)! // remount → fresh URL, same blob

    expect(second.url).not.toBe(first.url)
    expect(created).toEqual([blob, blob])
  })

  it('returns undefined for an unknown (e.g. remote) token so the caller falls through', () => {
    const reg = new LocalMediaRegistry()
    expect(reg.resolve('mr_42')).toBeUndefined()
  })

  it('clear() drops the registry (session ended)', () => {
    const reg = new LocalMediaRegistry()
    const token = reg.mint(new Blob([new Uint8Array([1])]))
    reg.clear()
    expect(reg.has(token)).toBe(false)
    expect(reg.resolve(token)).toBeUndefined()
  })
})
