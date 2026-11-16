import { describe, it, expect } from 'vitest'
import { roleOf, roleToPowerLevel } from '../src/internal'

describe('roleOf — Role por kind (ADR-083 dec. 4)', () => {
  it('membro segue o limiar de power level', () => {
    expect(roleOf(0, 'member')).toBe('member')
    expect(roleOf(49, 'member')).toBe('member')
    expect(roleOf(50, 'member')).toBe('admin')
    expect(roleOf(100, 'member')).toBe('admin')
  })

  it('guest é guest em qualquer power level', () => {
    expect(roleOf(0, 'guest')).toBe('guest')
    expect(roleOf(50, 'guest')).toBe('guest')
    expect(roleOf(100, 'guest')).toBe('guest')
  })

  it('a inversa não muda', () => {
    expect(roleToPowerLevel('admin')).toBe(50)
    expect(roleToPowerLevel('member')).toBe(0)
  })
})
