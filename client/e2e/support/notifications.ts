import type { BrowserContext, Page } from '@playwright/test'

// window.Notification as the browser E2E tier drives it (ADR-073). The system notification and the
// browser's permission prompt are not observable headless, so a context's pages get a stub that owns the
// permission: it starts where the test says (`default` or `granted`), `requestPermission` is counted and
// resolves with the answer the test chose (and the permission becomes it), and the permission survives a
// reload of the same tab (sessionStorage), as the browser's per-site permission does. Every construction
// reaches the test with its title and body; the test can fire the instance's `onclick` and sees whether
// `close()` was called. `window.focus` is counted. The stub is the owner of the permission: the context
// gets no grantPermissions.

export type Permission = 'default' | 'granted' | 'denied'

export interface Shown {
  /** The stub's own handle for the instance (never the app's tag). */
  id: string
  title: string
  body: string
  closed: boolean
}

type StubEvent =
  | { type: 'request' }
  | { type: 'construct'; id: string; title: string; body: string }
  | { type: 'close'; id: string }
  | { type: 'focus' }

interface StubControl {
  setPermission(p: Permission): void
  answerWith(p: Permission): void
  click(id: string): boolean
}

const BINDING = '__e2eNotificationEvent'

const NOTIFICATION_STUB = ({ initial, binding }: { initial: Permission; binding: string }) => {
  const KEY = '__e2e.notifications'
  const report = (e: unknown): void => {
    void (window as unknown as Record<string, (e: unknown) => Promise<void>>)[binding]!(e)
  }
  let saved: { permission: Permission; answer: Permission } | null
  try {
    saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null')
  } catch {
    saved = null
  }
  const state = saved ?? { permission: initial, answer: initial }
  const save = (): void => sessionStorage.setItem(KEY, JSON.stringify(state))
  save()
  const page = Math.random().toString(36).slice(2, 8)
  let count = 0
  const instances = new Map<string, StubNotification>()
  class StubNotification {
    static get permission(): Permission {
      return state.permission
    }
    static async requestPermission(): Promise<Permission> {
      report({ type: 'request' })
      state.permission = state.answer
      save()
      return state.permission
    }
    readonly id: string
    onclick: ((ev: Event) => void) | null = null
    constructor(title: string, options?: { body?: string }) {
      this.id = `${page}-${++count}`
      instances.set(this.id, this)
      report({ type: 'construct', id: this.id, title, body: options?.body ?? '' })
    }
    close(): void {
      report({ type: 'close', id: this.id })
    }
  }
  Object.defineProperty(window, 'Notification', { configurable: true, writable: true, value: StubNotification })
  window.focus = () => report({ type: 'focus' })
  const control: StubControl = {
    setPermission: (p) => {
      state.permission = p
      save()
    },
    answerWith: (p) => {
      state.answer = p
      save()
    },
    click: (id) => {
      const n = instances.get(id)
      n?.onclick?.call(n, new Event('click'))
      return n !== undefined
    },
  }
  ;(window as unknown as { __e2eNotifications: StubControl }).__e2eNotifications = control
}

export class NotificationStub {
  readonly shown: Shown[] = []
  requests = 0
  focuses = 0

  private constructor() {}

  // Install on every page of `context`, before any app script. Call before the context's first page.
  static async install(context: BrowserContext, initial: Permission): Promise<NotificationStub> {
    const stub = new NotificationStub()
    await context.exposeFunction(BINDING, (e: StubEvent) => stub.record(e))
    await context.addInitScript(NOTIFICATION_STUB, { initial, binding: BINDING })
    return stub
  }

  private record(e: StubEvent): void {
    if (e.type === 'request') this.requests++
    else if (e.type === 'focus') this.focuses++
    else if (e.type === 'construct') this.shown.push({ id: e.id, title: e.title, body: e.body, closed: false })
    else {
      const n = this.shown.find((s) => s.id === e.id)
      if (n) n.closed = true
    }
  }

  // The permission the page reads from now on (and after its reloads): the person changing it in the browser.
  async setPermission(page: Page, permission: Permission): Promise<void> {
    await page.evaluate((p) => (window as unknown as { __e2eNotifications: StubControl }).__e2eNotifications.setPermission(p), permission)
  }

  // What the next requestPermission resolves with: the person's answer to the browser's prompt.
  async answerRequestsWith(page: Page, permission: Permission): Promise<void> {
    await page.evaluate((p) => (window as unknown as { __e2eNotifications: StubControl }).__e2eNotifications.answerWith(p), permission)
  }

  // The person clicks the system notification: its onclick runs in the page that built it.
  async click(page: Page, notification: Shown): Promise<void> {
    const found = await page.evaluate(
      (id) => (window as unknown as { __e2eNotifications: StubControl }).__e2eNotifications.click(id),
      notification.id,
    )
    if (!found) throw new Error('the notification was not built by this page')
  }
}
