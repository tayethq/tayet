// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { loadArchivedCollapsed, saveArchivedCollapsed } from '../src/ui/archived-pref'

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

describe('archived section collapse pref (ADR-076 dec. 7, app-side)', () => {
  it('collapsed when nothing is persisted (manifesto §9 item 2)', () => {
    expect(loadArchivedCollapsed()).toBe(true)
  })

  it('save persists under tayet.archived-collapsed and reads back', () => {
    saveArchivedCollapsed(false)
    expect(localStorage.getItem('tayet.archived-collapsed')).toBe('false')
    expect(loadArchivedCollapsed()).toBe(false)
    saveArchivedCollapsed(true)
    expect(localStorage.getItem('tayet.archived-collapsed')).toBe('true')
    expect(loadArchivedCollapsed()).toBe(true)
  })

  it('any other stored value reads as collapsed', () => {
    localStorage.setItem('tayet.archived-collapsed', 'open')
    expect(loadArchivedCollapsed()).toBe(true)
  })

  it('degrades to collapsed if localStorage throws, and save does not throw', () => {
    const get = Storage.prototype.getItem
    const set = Storage.prototype.setItem
    Storage.prototype.getItem = () => {
      throw new Error('blocked')
    }
    Storage.prototype.setItem = () => {
      throw new Error('blocked')
    }
    try {
      expect(loadArchivedCollapsed()).toBe(true)
      expect(() => saveArchivedCollapsed(false)).not.toThrow()
    } finally {
      Storage.prototype.getItem = get
      Storage.prototype.setItem = set
    }
  })
})
