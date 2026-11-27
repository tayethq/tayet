// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { AccountSettings } from '../../src/ui/components/AccountSettings'
import type { DeviceNotificationsRow, DeviceNotificationsStatus } from '../../src/ui/useDeviceNotifications'
import { applyLocale } from '../../src/ui/i18n'
import { ptBR } from '../../src/ui/i18n/pt-BR'
import { en } from '../../src/ui/i18n/en'
import { noExport } from '../support/data-export-fake'
import { idleLanguage } from '../support/language-fake'

// The "Notificações" section of "Sua conta" (account-access.md §16; PR 5b, F1 and F3): between "Idioma" and
// "Acesso", in both widths, with the divider before it, the section title, the row "Neste aparelho" with its state
// (a live status) and the button on the right, and the help under the row. And the P1 render-scan of "Sua conta".

const copy = ptBR.account

function row(status: DeviceNotificationsStatus, over: Partial<DeviceNotificationsRow> = {}): DeviceNotificationsRow {
  return { status, onEnable: vi.fn(), onDisable: vi.fn(), onOpen: vi.fn(), onDismissFailure: vi.fn(), ...over }
}

function account(notifications: DeviceNotificationsRow | undefined, props: Partial<ComponentProps<typeof AccountSettings>> = {}) {
  return render(
    <AccountSettings
      open
      accesses={[]}
      onLoadProfile={async () => ({ fullName: 'Marina' })}
      onSaveProfile={async () => {}}
      onSaveAvatar={async () => {}}
      onClearAvatar={async () => {}}
      onExportData={noExport}
      onReset={() => {}}
      onSignOut={() => {}}
      theme="light"
      onThemeChange={() => {}}
      language={idleLanguage}
      notifications={notifications}
      onClose={() => {}}
      {...props}
    />,
  )
}

const section = (root: HTMLElement) => root.querySelector<HTMLElement>('.account-settings__notifications')
const state = (root: HTMLElement) => section(root)!.querySelector('[role="status"]')!
const buttons = (root: HTMLElement) => [...section(root)!.querySelectorAll('button')]
const help = (root: HTMLElement) => section(root)!.querySelector('.account-settings__notifications-help')!.textContent

afterEach(() => {
  cleanup()
  applyLocale('pt-BR')
})

describe.each([
  ['wide', false],
  ['narrow', true],
] as const)('the section, %s', (_name, narrow) => {
  it('sits between "Idioma" and "Acesso", with a divider before it and the one before "Acesso" after it', () => {
    const { container } = account(row('off'), { narrow })
    const language = container.querySelector('.account-settings__language')!
    expect(language.nextElementSibling?.tagName).toBe('HR')
    expect(language.nextElementSibling?.nextElementSibling).toBe(section(container))
    expect(section(container)!.nextElementSibling?.tagName).toBe('HR')
    expect(section(container)!.nextElementSibling?.nextElementSibling?.textContent).toContain(copy.accessSection)
    expect(section(container)!.querySelector('h3')!.textContent).toBe(copy.notifications)
    expect(section(container)!.querySelector('h4')!.textContent).toBe(copy.notificationsDevice)
  })

  it('off: "Desativadas" and "Ativar"; the click turns them on', () => {
    const r = row('off')
    const { container } = account(r, { narrow })
    expect(state(container).textContent).toBe(copy.notificationsOff)
    expect(buttons(container).map((b) => b.textContent)).toEqual([copy.notificationsTurnOn])
    expect(help(container)).toBe(copy.notificationsHelp)
    fireEvent.click(buttons(container)[0]!)
    expect(r.onEnable).toHaveBeenCalledTimes(1)
  })

  it('enabling: "Ativando…" and "Ativar" faded and inert, the look inline', () => {
    const r = row('enabling')
    const { container } = account(r, { narrow })
    expect(state(container).textContent).toBe(copy.notificationsEnabling)
    const [turnOn] = buttons(container)
    expect(turnOn!.textContent).toBe(copy.notificationsTurnOn)
    expect(turnOn!.getAttribute('aria-disabled')).toBe('true')
    expect(turnOn!.style.opacity).toBe('0.5')
    expect(turnOn!.style.cursor).toBe('default')
    fireEvent.click(turnOn!)
    expect(r.onEnable).not.toHaveBeenCalled()
  })

  it('failed: the state in danger (data-status) and "Ativar" again', () => {
    const { container } = account(row('failed'), { narrow })
    expect(state(container).textContent).toBe(copy.notificationsFailed)
    expect(section(container)!.dataset.status).toBe('failed')
    expect(buttons(container).map((b) => b.textContent)).toEqual([copy.notificationsTurnOn])
  })

  it('on: "Ativadas" and "Desativar"; the click turns them off', () => {
    const r = row('on')
    const { container } = account(r, { narrow })
    expect(state(container).textContent).toBe(copy.notificationsOn)
    expect(buttons(container).map((b) => b.textContent)).toEqual([copy.notificationsTurnOff])
    fireEvent.click(buttons(container)[0]!)
    expect(r.onDisable).toHaveBeenCalledTimes(1)
  })

  it('blocked: no button, and the help of its own', () => {
    const { container } = account(row('blocked'), { narrow })
    expect(state(container).textContent).toBe(copy.notificationsBlocked)
    expect(buttons(container)).toEqual([])
    expect(help(container)).toBe(copy.notificationsHelpBlocked)
  })

  it('hidden, or no row given: no section and a single divider between "Idioma" and "Acesso"', () => {
    for (const r of [row('hidden'), undefined]) {
      const { container } = account(r, { narrow })
      expect(section(container)).toBeNull()
      const language = container.querySelector('.account-settings__language')!
      expect(language.nextElementSibling?.tagName).toBe('HR')
      expect(language.nextElementSibling?.nextElementSibling?.textContent).toContain(copy.accessSection)
      cleanup()
    }
  })

  it('P1: no protocol shape in "Sua conta" in any state', () => {
    for (const status of ['off', 'enabling', 'on', 'failed', 'blocked'] as const) {
      const { container } = account(row(status), { narrow })
      expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
      cleanup()
    }
  })
})

describe('the focus when the button changes (round 1b, R2)', () => {
  function rerenderWith(view: ReturnType<typeof account>, r: DeviceNotificationsRow) {
    view.rerender(
      <AccountSettings
        open
        accesses={[]}
        onLoadProfile={async () => ({ fullName: 'Marina' })}
        onSaveProfile={async () => {}}
        onSaveAvatar={async () => {}}
        onClearAvatar={async () => {}}
        onExportData={noExport}
        onReset={() => {}}
        onSignOut={() => {}}
        theme="light"
        onThemeChange={() => {}}
        language={idleLanguage}
        notifications={r}
        onClose={() => {}}
      />,
    )
  }

  it('off → enabling → on, and on → off: one button element keeps the focus; medium weight only on "Ativar"', () => {
    const view = account(row('off'))
    const button = buttons(view.container)[0]!
    button.focus()
    expect(button.classList.contains('account-settings__notifications-action--on')).toBe(true)
    for (const [status, label] of [
      ['enabling', copy.notificationsTurnOn],
      ['on', copy.notificationsTurnOff],
      ['off', copy.notificationsTurnOn],
      ['failed', copy.notificationsTurnOn],
    ] as const) {
      rerenderWith(view, row(status))
      expect(buttons(view.container)).toEqual([button])
      expect(button.textContent).toBe(label)
      expect(document.activeElement).toBe(button)
      expect(button.classList.contains('account-settings__notifications-action--on')).toBe(status !== 'on')
    }
  })

  it('the action follows the label on the same element', () => {
    const r = row('on')
    const view = account(r)
    const button = buttons(view.container)[0]!
    fireEvent.click(button)
    expect(r.onDisable).toHaveBeenCalledTimes(1)
    const r2 = row('off')
    rerenderWith(view, r2)
    fireEvent.click(button)
    expect(r2.onEnable).toHaveBeenCalledTimes(1)
  })

  it('enabling → blocked with the focus on the button: the focus goes to the state line', () => {
    const view = account(row('enabling'))
    buttons(view.container)[0]!.focus()
    rerenderWith(view, row('blocked'))
    expect(buttons(view.container)).toEqual([])
    expect(document.activeElement).toBe(state(view.container))
    expect(state(view.container).getAttribute('tabindex')).toBe('-1')
  })

  it('blocked with the focus outside the section: nothing moves', () => {
    const view = account(row('enabling'))
    const outside = view.getByRole('button', { name: ptBR.dialog.close })
    outside.focus()
    rerenderWith(view, row('blocked'))
    expect(document.activeElement).toBe(outside)
  })
})

describe('opening and closing "Sua conta"', () => {
  it('each opening re-reads (onOpen); closing drops a failure (onDismissFailure)', () => {
    const r = row('failed')
    const onClose = vi.fn()
    const view = account(r, { onClose })
    expect(r.onOpen).toHaveBeenCalledTimes(1)
    fireEvent.click(view.getByRole('button', { name: ptBR.dialog.close }))
    expect(r.onDismissFailure).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    view.rerender(
      <AccountSettings
        open={false}
        accesses={[]}
        onLoadProfile={async () => ({ fullName: 'Marina' })}
        onSaveProfile={async () => {}}
        onSaveAvatar={async () => {}}
        onClearAvatar={async () => {}}
        onExportData={noExport}
        onReset={() => {}}
        onSignOut={() => {}}
        theme="light"
        onThemeChange={() => {}}
        language={idleLanguage}
        notifications={r}
        onClose={onClose}
      />,
    )
    expect(r.onOpen).toHaveBeenCalledTimes(1)
  })
})

describe('copy (F8)', () => {
  it('English: the section and the states', () => {
    applyLocale('en')
    const { container } = account(row('off'))
    expect(section(container)!.querySelector('h3')!.textContent).toBe(en.account.notifications)
    expect(state(container).textContent).toBe('Off')
    expect(buttons(container)[0]!.textContent).toBe('Turn on')
    expect(help(container)).toBe(en.account.notificationsHelp)
  })

  it('the install copy promises notifications again, in both languages', () => {
    expect(ptBR.install.body).toBe('Com o Tayet na Tela de Início, você recebe avisos de mensagens e de pedidos de aprovação.')
    expect(ptBR.install.rowHint).toBe('Para receber avisos de mensagens e de pedidos de aprovação')
    expect(ptBR.account.openOnPhoneHelp).toBe(
      'O Tayet abre no navegador do celular. No iPhone, você pode instalar na Tela de Início para receber avisos.',
    )
    expect(en.install.body).toBe('With Tayet on your Home Screen, you get notified of messages and approval requests.')
    expect(en.install.rowHint).toBe('To get notified of messages and approval requests')
    expect(en.account.openOnPhoneHelp).toBe(
      "Tayet opens in your phone's browser. On an iPhone, you can install it on the Home Screen to get notified.",
    )
  })
})
