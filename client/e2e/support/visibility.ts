import type { Page } from '@playwright/test'

// A page in the background, as the app can observe it. Headless Chromium keeps every page `visible`
// (bringToFront does not change it), and CDP Page.setWebLifecycleState `frozen` is a no-op on a visible
// page (measured: no `freeze` event, timers keep ticking). So the background is the part the app can
// observe: the page says it is hidden (visibilityState + the visibilitychange event, from an init
// script). Chrome's timer throttling and freezing of a tab hidden for hours is NOT reproduced here —
// that goes to the soak's long variant, after the tag (ROTEIRO-U2 §2). Install with
// `context.addInitScript(VISIBILITY_SHIM)`.
export const VISIBILITY_SHIM = () => {
  let hidden = false
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => hidden })
  Object.defineProperty(Document.prototype, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  })
  ;(window as unknown as { __e2eSetHidden: (h: boolean) => void }).__e2eSetHidden = (h: boolean) => {
    hidden = h
    document.dispatchEvent(new Event('visibilitychange'))
  }
}

export async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => (window as unknown as { __e2eSetHidden: (h: boolean) => void }).__e2eSetHidden(h), hidden)
}
