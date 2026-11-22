// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { canInstall, installDismissed, saveInstallDismissed, useCanInstall, type InstallEnv } from '../../src/ui/install'
import { DESKTOP_UA, IPHONE_SAFARI_UA, fakeDevice } from '../support/device-fake'

// The install detection (PLANO-MOBILE M7 I1), by table, and the I2 flag.

const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)'
const portrait = { standalone: false, coarse: true, narrow: true }

const TABLE: Array<[string, InstallEnv, boolean]> = [
  ['Safari on the iPhone', { ...portrait, userAgent: IPHONE_SAFARI_UA }, true],
  ['Safari on an older iPhone', { ...portrait, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1' }, true],
  ['Safari with a three-part version', { ...portrait, userAgent: `${IOS} Version/18.3.1 Mobile/15E148 Safari/604.1` }, true],
  ['iPhone on its side (728 or more)', { ...portrait, narrow: false, userAgent: IPHONE_SAFARI_UA }, false],
  ['the installed app', { ...portrait, standalone: true, userAgent: IPHONE_SAFARI_UA }, false],
  ['a fine pointer', { ...portrait, coarse: false, userAgent: IPHONE_SAFARI_UA }, false],
  ['Chrome on the iPhone', { ...portrait, userAgent: `${IOS} CriOS/153.0.8010.24 Mobile/15E148 Safari/604.1` }, false],
  ['Firefox on the iPhone', { ...portrait, userAgent: `${IOS} FxiOS/143.0 Mobile/15E148 Safari/605.1.15` }, false],
  ['Firefox on the iPhone, two spaces', { ...portrait, userAgent: `${IOS} FxiOS/26.0  Mobile/15E148 Safari/605.1.15` }, false],
  ['Edge on the iPhone', { ...portrait, userAgent: `${IOS} Version/18.0 EdgiOS/141.0 Mobile/15E148 Safari/605.1.15` }, false],
  ['the Google app', { ...portrait, userAgent: `${IOS} GSA/380.0 Mobile/15E148 Safari/604.1` }, false],
  ['a browser that adds a suffix', { ...portrait, userAgent: `${IOS} Version/18.5 Mobile/15E148 Safari/604.1 Ddg/18.5` }, false],
  ['a web view', { ...portrait, userAgent: `${IOS} Mobile/15E148` }, false],
  ['iPad', { ...portrait, userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1' }, false],
  ['iPad asking for the desktop site', { ...portrait, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15' }, false],
  ['Chrome on Android', { ...portrait, userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36' }, false],
  ['a narrow computer window', { ...portrait, coarse: false, userAgent: DESKTOP_UA }, false],
  ['no user agent', { ...portrait, userAgent: '' }, false],
]

beforeEach(() => localStorage.clear())
afterEach(() => {
  Reflect.deleteProperty(navigator, 'standalone')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('canInstall (I1)', () => {
  it.each(TABLE)('%s', (_, env, expected) => {
    expect(canInstall(env)).toBe(expected)
  })
})

describe('useCanInstall', () => {
  const iphone = { coarse: true, ua: IPHONE_SAFARI_UA }

  it('follows the rotation', () => {
    const device = fakeDevice(iphone)
    const { result } = renderHook(() => useCanInstall())
    expect(result.current).toBe(true)
    device.setNarrow(false)
    expect(result.current).toBe(false)
    device.setNarrow(true)
    expect(result.current).toBe(true)
  })

  it('the installed app answers by display-mode', () => {
    fakeDevice({ ...iphone, standalone: true })
    expect(renderHook(() => useCanInstall()).result.current).toBe(false)
  })

  it('the installed app answers by navigator.standalone', () => {
    fakeDevice(iphone)
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true })
    expect(renderHook(() => useCanInstall()).result.current).toBe(false)
  })

  it('logs nothing', () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m))
    fakeDevice(iphone)
    renderHook(() => useCanInstall())
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })
})

describe('the I2 flag', () => {
  it('is one local key with no id in it', () => {
    expect(installDismissed()).toBe(false)
    saveInstallDismissed()
    expect(installDismissed()).toBe(true)
    expect({ ...localStorage }).toEqual({ 'tayet.install-dismissed': '1' })
  })

  it('storage blocked: not dismissed, and saving does not throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => saveInstallDismissed()).not.toThrow()
    expect(installDismissed()).toBe(false)
  })
})
