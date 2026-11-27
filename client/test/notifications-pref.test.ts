// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import {
  clearNotificationsPref,
  dismissNotificationsPrompt,
  loadNotificationsPref,
  notificationsPromptDismissed,
  saveNotificationsPref,
} from '../src/ui/notifications-pref'

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

describe('notifications pref (ADR-073 dec. 6; ADR-117 addendum of 26/Nov/2026, F4)', () => {
  it('empty and not dismissed when nothing is persisted', () => {
    expect(loadNotificationsPref()).toBeUndefined()
    expect(notificationsPromptDismissed()).toBe(false)
  })

  it('on and off persist under tayet.notifications and read back; clear empties it', () => {
    saveNotificationsPref('on')
    expect(localStorage.getItem('tayet.notifications')).toBe('on')
    expect(loadNotificationsPref()).toBe('on')
    saveNotificationsPref('off')
    expect(loadNotificationsPref()).toBe('off')
    clearNotificationsPref()
    expect(localStorage.getItem('tayet.notifications')).toBeNull()
    expect(loadNotificationsPref()).toBeUndefined()
  })

  it('the dismissal has a key of its own, untouched by the preference and by clearing it', () => {
    dismissNotificationsPrompt()
    expect(localStorage.getItem('tayet.notifications-dismissed')).toBe('1')
    saveNotificationsPref('on')
    clearNotificationsPref()
    expect(notificationsPromptDismissed()).toBe(true)
  })

  it('migration: a dismissed under the old key moves to the dismissal key and frees the preference', () => {
    localStorage.setItem('tayet.notifications', 'dismissed')
    expect(loadNotificationsPref()).toBeUndefined()
    expect(localStorage.getItem('tayet.notifications')).toBeNull()
    expect(localStorage.getItem('tayet.notifications-dismissed')).toBe('1')
    expect(notificationsPromptDismissed()).toBe(true)
  })

  it('migration through the dismissal read too', () => {
    localStorage.setItem('tayet.notifications', 'dismissed')
    expect(notificationsPromptDismissed()).toBe(true)
    expect(localStorage.getItem('tayet.notifications')).toBeNull()
  })

  it('any other stored value reads as empty', () => {
    localStorage.setItem('tayet.notifications', 'granted')
    expect(loadNotificationsPref()).toBeUndefined()
  })

  it('degrades to empty and not dismissed if localStorage throws, and the writes do not throw', () => {
    const get = Storage.prototype.getItem
    const set = Storage.prototype.setItem
    const remove = Storage.prototype.removeItem
    const blocked = () => {
      throw new Error('blocked')
    }
    Storage.prototype.getItem = blocked
    Storage.prototype.setItem = blocked
    Storage.prototype.removeItem = blocked
    try {
      expect(loadNotificationsPref()).toBeUndefined()
      expect(notificationsPromptDismissed()).toBe(false)
      expect(() => saveNotificationsPref('on')).not.toThrow()
      expect(() => clearNotificationsPref()).not.toThrow()
      expect(() => dismissNotificationsPrompt()).not.toThrow()
    } finally {
      Storage.prototype.getItem = get
      Storage.prototype.setItem = set
      Storage.prototype.removeItem = remove
    }
  })
})
