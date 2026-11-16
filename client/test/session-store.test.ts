// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { loadSession, saveSession, clearSession, resolveBootSession } from '../src/ui/session-store'
import type { OpaqueSession } from '../src/acl'

const s = (v: string): OpaqueSession => v as unknown as OpaqueSession

afterEach(() => localStorage.clear())

describe('session-store: persistência app-side da sessão', () => {
  it('round-trip save/load', () => {
    expect(loadSession()).toBeNull()
    saveSession(s('mct_abc'))
    expect(loadSession()).toBe('mct_abc')
  })

  it('resolveBootSession: env presente vence E é persistida (override do operador)', () => {
    saveSession(s('mct_stale'))
    const out = resolveBootSession('mct_fresh')
    expect(out).toBe('mct_fresh')
    expect(loadSession()).toBe('mct_fresh') // a env sobrescreveu a persistida
  })

  it('resolveBootSession: sem env usa a persistida', () => {
    saveSession(s('mct_persisted'))
    expect(resolveBootSession(undefined)).toBe('mct_persisted')
  })

  it('resolveBootSession: sem env e sem persistida → null (estado no-session)', () => {
    expect(resolveBootSession(undefined)).toBeNull()
  })

  // ADR-032 D2: a OpaqueSession passou a carregar o blob OIDC serializado. O store continua opaco —
  // só persiste/lê a string; quem interpreta é o connect. Round-trip byte-a-byte da string do blob.
  it('blob OIDC round-trip: a string serializada persiste e volta idêntica', () => {
    const blob = JSON.stringify({
      kind: 'oidc',
      accessToken: 'at_1',
      refreshToken: 'rt_1',
      deviceId: 'DEV1',
      userId: '@a:x',
      issuer: 'https://mas',
      clientId: 'TAYET',
      homeserverUrl: 'http://hs',
      idTokenClaims: { sub: '@a:x' },
    })
    saveSession(s(blob))
    expect(loadSession()).toBe(blob)
  })

  it('clearSession apaga a sessão persistida', () => {
    saveSession(s('mct_abc'))
    expect(loadSession()).toBe('mct_abc')
    clearSession()
    expect(loadSession()).toBeNull()
  })
})
