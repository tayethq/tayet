// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { dismissNotifications, loadNotificationsPref } from '../src/ui/notifications-pref'

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

describe('notifications pref (ADR-073 dec. 6, app-side)', () => {
  it('not dismissed when nothing is persisted', () => {
    expect(loadNotificationsPref()).toBeUndefined()
  })

  it('dismiss persists under tayet.notifications and reads back', () => {
    dismissNotifications()
    expect(localStorage.getItem('tayet.notifications')).toBe('dismissed')
    expect(loadNotificationsPref()).toBe('dismissed')
  })

  it('any other stored value reads as not dismissed', () => {
    localStorage.setItem('tayet.notifications', 'granted')
    expect(loadNotificationsPref()).toBeUndefined()
  })

  it('degrades to not dismissed if localStorage throws, and dismiss does not throw', () => {
    const get = Storage.prototype.getItem
    const set = Storage.prototype.setItem
    Storage.prototype.getItem = () => {
      throw new Error('blocked')
    }
    Storage.prototype.setItem = () => {
      throw new Error('blocked')
    }
    try {
      expect(loadNotificationsPref()).toBeUndefined()
      expect(() => dismissNotifications()).not.toThrow()
    } finally {
      Storage.prototype.getItem = get
      Storage.prototype.setItem = set
    }
  })
})
