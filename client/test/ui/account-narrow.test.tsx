// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { Workspace } from '../../src/ui/components/Workspace'
import { StackProvider, useStackScreens, type HistoryEnv, type StackHistoryState } from '../../src/ui/stack'
import { useNarrowWindow } from '../../src/ui/narrow'
import type { KnownAccess } from '../../src/ui/components/AccountSettings'
import type { ResetStatus } from '../../src/ui/components/ResetAccessBanner'
import type { AgentColor, Channel, ChannelId, DeviceId, MyProfile, Person, User, UserId } from '../../src/acl'
import { applyLocale } from '../../src/ui/i18n'
import { en } from '../../src/ui/i18n/en'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'
import { noExport } from '../support/data-export-fake'
import { idleLanguage } from '../support/language-fake'
import { IPHONE_SAFARI_UA, fakeDevice } from '../support/device-fake'

// "Sua conta" on the narrow window (account-access.md §13.2, §14.2; PLANO-MOBILE M7 H1, H2, A1, I1): the real
// Workspace wired to the stack as the App does, over a history whose landings the test decides.

function fakeHistory() {
  const entries: unknown[] = [null]
  let index = 0
  const listeners = new Set<(s: unknown) => void>()
  const queued: number[] = []
  const env: HistoryEnv = {
    state: () => entries[index],
    push: (s: StackHistoryState) => {
      entries.splice(index + 1)
      entries.push(s)
      index = entries.length - 1
    },
    go: (d) => void queued.push(d),
    back: () => void queued.push(-1),
    replace: (s: StackHistoryState) => {
      entries[index] = s
    },
    onPop: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  const land = () =>
    act(() => {
      while (queued.length) {
        index = Math.max(0, index + queued.shift()!)
        for (const fn of [...listeners]) fn(entries[index])
      }
    })
  return {
    env,
    land,
    depth: () => index,
    state: () => entries[index] as StackHistoryState,
    // The system's back.
    back: () => {
      queued.push(-1)
      land()
    },
  }
}

const uid = (s: string) => s as unknown as UserId
const did = (s: string) => s as unknown as DeviceId
const me: User = { id: uid('@marina:tayet.local'), displayName: 'Marina Alves', kind: 'member' }
const ENG: Channel = { id: '!eng:tayet.local' as unknown as ChannelId, name: '#obra', kind: 'public', memberCount: 2, unread: { count: 0, mentions: 0 } }
const MANY: KnownAccess[] = [
  { id: did('D1'), friendlyName: 'Notebook', current: false },
  { id: did('D2'), friendlyName: 'iPhone', current: true },
  { id: did('D3'), current: false },
]
const PROFILE: MyProfile = { fullName: 'Marina Alves', org: { authority: 'directory', jobTitle: 'Financeiro' } }

interface Opts {
  accesses?: KnownAccess[]
  admin?: boolean
  selected?: boolean
  resetStatus?: ResetStatus
  load?: () => Promise<MyProfile>
}

function mount(opts: Opts = {}) {
  const h = fakeHistory()
  const onReset = vi.fn()
  const onSignOut = vi.fn()
  const load = opts.load ?? (() => Promise.resolve(PROFILE))
  let setReset: (s: ResetStatus) => void = () => {}
  function Shell() {
    const narrow = useNarrowWindow()
    const [selected, setSelected] = useState(opts.selected ? ENG.id : undefined)
    const [reset, setStatus] = useState<ResetStatus>(opts.resetStatus ?? 'idle')
    setReset = setStatus
    useStackScreens({ narrow, chat: selected !== undefined, thread: false, onPopChat: () => setSelected(undefined), onPopThread: () => {} })
    return (
      <Workspace
        narrow={narrow}
        channels={[ENG]}
        selectedChannelId={selected}
        messages={[]}
        usersById={{ [me.id]: me }}
        currentUser={me}
        connection="connected"
        onSelectChannel={setSelected}
        onSend={() => {}}
        accesses={opts.accesses ?? MANY}
        orgAdmin={opts.admin}
        people={[{ user: me } as Person]}
        onInvitePerson={(async () => ({})) as never}
        onRemovePerson={async () => {}}
        onCreateAgent={(async (_n: string, _c: AgentColor) => ({})) as never}
        onUpdateAgent={async () => {}}
        onReissueAgent={async () => ({ token: '' })}
        onRemoveAgent={async () => {}}
        onLoadProfile={load}
        onSaveProfile={async () => {}}
        onSaveAvatar={async () => {}}
        onClearAvatar={async () => {}}
        onExportData={noExport}
        onReset={onReset}
        resetStatus={reset}
        onSignOut={onSignOut}
        theme="light"
        onThemeChange={() => {}}
        language={idleLanguage}
      />
    )
  }
  const view = render(
    <StackProvider env={h.env}>
      <Shell />
    </StackProvider>,
  )
  const c = view.container
  const footer = () => c.querySelector<HTMLButtonElement>('.sidebar__footer')!
  return {
    ...view,
    h,
    onReset,
    onSignOut,
    footer,
    setReset: (s: ResetStatus) => act(() => setReset(s)),
    open: () => {
      footer().focus()
      fireEvent.click(footer())
    },
    screen: (title: string) => c.querySelector<HTMLElement>(`.account-screen[aria-label="${title}"]`),
    entry: (label: string) =>
      [...c.querySelectorAll<HTMLButtonElement>('button.account-settings__access-entry')].find((b) => b.textContent!.startsWith(label)),
    titles: () => [...c.querySelectorAll('.account-settings__section-title')].map((el) => el.textContent),
    press: (el: HTMLElement) => {
      el.focus()
      fireEvent.click(el)
    },
  }
}
type View = ReturnType<typeof mount>

const toAccesses = (v: View) => v.press(v.entry(copy.account.accessTitle)!)
const resetBox = (v: View) => v.container.querySelector<HTMLButtonElement>('.account-settings__reset')!

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  applyLocale('pt-BR')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('H1: each screen and each sheet is one entry of the stack', () => {
  beforeEach(() => void fakeDevice())

  it('list → account → accesses → reset sheet; the system back walks one step at a time', () => {
    const v = mount()
    v.open()
    expect(v.h.depth()).toBe(1)
    expect(v.h.state()).toEqual({ tayet: 'stack', screen: 'dialog', depth: 1 })
    expect(v.screen(copy.account.title)!.hasAttribute('inert')).toBe(false)
    expect(v.container.querySelector('.ui-dialog')).toBeNull()

    toAccesses(v)
    expect(v.h.depth()).toBe(2)
    expect(v.screen(copy.account.title)!.hasAttribute('data-stack-covered')).toBe(true)

    v.press(resetBox(v))
    expect(v.h.depth()).toBe(3)
    expect(v.getByRole('alertdialog', { name: copy.account.resetTitle })).toBeTruthy()

    v.h.back()
    expect(v.h.depth()).toBe(2)
    expect(v.queryByRole('alertdialog')).toBeNull()
    expect(v.screen(copy.account.accessTitle)).not.toBeNull()

    v.h.back()
    expect(v.h.depth()).toBe(1)
    expect(v.screen(copy.account.accessTitle)).toBeNull()
    expect(v.screen(copy.account.title)!.hasAttribute('data-stack-covered')).toBe(false)

    v.h.back()
    expect(v.h.depth()).toBe(0)
    expect(v.screen(copy.account.title)).toBeNull()
    expect(v.container.querySelector('.sidebar')!.hasAttribute('inert')).toBe(false)
    expect(v.onReset).not.toHaveBeenCalled()
  })

  it('account → edit profile; back returns to the account, then to the list', async () => {
    const v = mount()
    v.open()
    v.press(within(v.screen(copy.account.title)!).getByRole('button', { name: copy.account.edit }))
    expect(v.h.depth()).toBe(2)
    await waitFor(() => expect(v.getByLabelText(copy.profile.nickname)).toBeTruthy())
    v.h.back()
    expect(v.screen(copy.profile.editTitle)).toBeNull()
    expect(v.h.depth()).toBe(1)
    v.h.back()
    expect(v.screen(copy.account.title)).toBeNull()
  })

  it("the header's back and Esc take the same one step", () => {
    const v = mount()
    v.open()
    toAccesses(v)
    fireEvent.click(within(v.screen(copy.account.accessTitle)!).getByRole('button', { name: copy.dialog.back }))
    v.h.land()
    expect(v.screen(copy.account.accessTitle)).toBeNull()
    expect(v.h.depth()).toBe(1)
    fireEvent.keyDown(v.screen(copy.account.title)!, { key: 'Escape' })
    v.h.land()
    expect(v.screen(copy.account.title)).toBeNull()
    expect(v.h.depth()).toBe(0)
  })

  it('cancel closes the sheet and goes back over its entry alone', () => {
    const v = mount()
    v.open()
    toAccesses(v)
    v.press(resetBox(v))
    fireEvent.click(within(v.getByRole('alertdialog')).getByRole('button', { name: copy.account.cancel }))
    v.h.land()
    expect(v.h.depth()).toBe(2)
    expect(v.screen(copy.account.accessTitle)).not.toBeNull()
  })

  it('a back over several entries closes all of them, and the next open starts at the account', () => {
    const v = mount({ load: () => new Promise<never>(() => {}) })
    v.open()
    toAccesses(v)
    v.press(resetBox(v))
    act(() => {
      v.h.env.go(-3)
    })
    v.h.land()
    expect(v.screen(copy.account.title)).toBeNull()
    // The contributors leave bottom first, so the stack passes through a step of its own before it settles.
    v.h.land()
    expect(v.h.depth()).toBe(0)
    v.open()
    expect(v.screen(copy.account.accessTitle)).toBeNull()
    expect(v.h.depth()).toBe(1)
  })

  it('the focus: on the back of what opens, on the opener of what closes', () => {
    const v = mount()
    v.open()
    const backOf = (title: string) => within(v.screen(title)!).getByRole('button', { name: copy.dialog.back })
    expect(document.activeElement).toBe(backOf(copy.account.title))
    toAccesses(v)
    expect(document.activeElement).toBe(backOf(copy.account.accessTitle))
    v.press(resetBox(v))
    expect(document.activeElement).toBe(within(v.getByRole('alertdialog')).getByRole('button', { name: copy.account.cancel }))
    v.h.back()
    expect(document.activeElement).toBe(resetBox(v))
    v.h.back()
    expect(document.activeElement).toBe(v.entry(copy.account.accessTitle))
    v.h.back()
    expect(document.activeElement).toBe(v.footer())
  })
})

describe('crossing the breakpoint', () => {
  it('account → accesses → sheet over a conversation: four entries in that order, and none when wide', () => {
    const device = fakeDevice({ narrow: false })
    const v = mount({ selected: true })
    v.open()
    toAccesses(v)
    v.press(resetBox(v))
    expect(v.h.depth()).toBe(0)

    device.setNarrow(true)
    v.h.land()
    expect(v.h.depth()).toBe(4)
    expect(v.getByRole('alertdialog')).toBeTruthy()
    v.h.back()
    expect(v.queryByRole('alertdialog')).toBeNull()
    expect(v.screen(copy.account.accessTitle)).not.toBeNull()
    v.h.back()
    expect(v.screen(copy.account.accessTitle)).toBeNull()
    v.h.back()
    expect(v.screen(copy.account.title)).toBeNull()
    expect(v.container.querySelector('.main')!.hasAttribute('inert')).toBe(false)
    expect(v.h.depth()).toBe(1)

    v.open()
    device.setNarrow(false)
    v.h.land()
    expect(v.h.depth()).toBe(0)
    expect(v.getByRole('dialog', { name: copy.account.title })).toBeTruthy()
  })

  it('the profile keeps what was typed, and reads the photo again', async () => {
    const device = fakeDevice({ narrow: false })
    const load = vi.fn(() => Promise.resolve(PROFILE))
    const v = mount({ load })
    v.open()
    v.press(v.getByRole('button', { name: copy.account.edit }))
    fireEvent.change(await waitFor(() => v.getByLabelText(copy.profile.nickname)), { target: { value: 'Mari' } })
    const reads = load.mock.calls.length
    device.setNarrow(true)
    v.h.land()
    expect(v.screen(copy.profile.editTitle)).not.toBeNull()
    expect((v.getByLabelText(copy.profile.nickname) as HTMLInputElement).value).toBe('Mari')
    await waitFor(() => expect(load.mock.calls.length).toBe(reads + 1))
  })
})

describe('H2: a view with no narrow screen that was open stays a dialog until it closes', () => {
  const cases = [
    { name: 'people', entry: copy.people.title, title: copy.people.title },
    { name: 'export', entry: copy.dataExport.entry, title: copy.dataExport.title },
    { name: 'open on phone', entry: copy.account.openOnPhone, title: copy.account.openOnPhone },
  ]

  it.each(cases)('$name', ({ entry, title }) => {
    const device = fakeDevice({ narrow: false })
    const v = mount({ admin: true })
    v.open()
    v.press(v.entry(entry)!)
    const dialog = v.getByRole('dialog', { name: title })

    device.setNarrow(true)
    v.h.land()
    // The same node: the view kept its state.
    expect(v.getByRole('dialog', { name: title })).toBe(dialog)
    expect(v.screen(copy.account.title)!.hasAttribute('inert')).toBe(true)
    expect(v.h.depth()).toBe(2)

    v.h.back()
    expect(v.queryByRole('dialog', { name: title })).toBeNull()
    expect(v.screen(copy.account.title)!.hasAttribute('inert')).toBe(false)
    expect(v.h.depth()).toBe(1)
    expect(v.entry(entry)).toBeUndefined()
  })

  it.each([
    { name: 'invite', button: copy.people.invite, title: copy.people.invite },
    { name: 'agent', button: copy.agent.add, title: copy.agent.createTitle },
  ])('$name, over people: back goes to people, then to the account', ({ button, title }) => {
    const device = fakeDevice({ narrow: false })
    const v = mount({ admin: true })
    v.open()
    v.press(v.entry(copy.people.title)!)
    v.press(v.getAllByRole('button').find((b) => b.textContent!.includes(button))!)
    const dialog = v.getByRole('dialog', { name: title })
    device.setNarrow(true)
    v.h.land()
    expect(v.getByRole('dialog', { name: title })).toBe(dialog)
    expect(v.h.depth()).toBe(3)
    v.h.back()
    expect(v.getByRole('dialog', { name: copy.people.title })).toBeTruthy()
    v.h.back()
    expect(v.queryByRole('dialog')).toBeNull()
    expect(v.h.depth()).toBe(1)
  })
})

describe('the narrow account', () => {
  beforeEach(() => void fakeDevice())

  it('the order: identity, appearance, language, access, data, sign out; no phone, no organization', async () => {
    const v = mount({ admin: true })
    v.open()
    await waitFor(() => expect(v.getByText('Financeiro')).toBeTruthy())
    expect(v.titles()).toEqual([copy.account.accessSection, copy.dataExport.section])
    const blocks = [...v.container.querySelector('.account-settings')!.children].map((el) => (el.tagName === 'HR' ? '—' : el.className.split(' ')[0]))
    expect(blocks).toEqual([
      'account-settings__identity',
      '—',
      'account-settings__appearance',
      'account-settings__language',
      '—',
      'account-settings__access-section',
      '—',
      'account-settings__access-section',
      '—',
      'ui-button',
    ])
    expect(v.container.querySelector('.account-settings__appearance .ui-segmented--fill')).not.toBeNull()
    expect(v.entry(copy.account.openOnPhone)).toBeUndefined()
    expect(v.entry(copy.people.title)).toBeUndefined()
  })

  it('export is a line with no action and no chevron', () => {
    const v = mount()
    v.open()
    const line = v.container.querySelector<HTMLElement>('.account-settings__desktop-only')!
    expect(line.textContent).toBe(`${copy.dataExport.entry}${copy.dataExport.desktopOnly}`)
    expect(line.closest('button')).toBeNull()
    expect(line.querySelector('button, svg, .account-settings__access-entry-chevron')).toBeNull()
    fireEvent.click(line)
    expect(v.queryByRole('dialog')).toBeNull()
  })

  it('accesses: the current first, the box last', () => {
    const v = mount()
    v.open()
    toAccesses(v)
    const s = v.screen(copy.account.accessTitle)!
    expect([...s.querySelectorAll('.account-settings__access-name')].map((el) => el.textContent)).toEqual(['iPhone', 'Notebook', copy.account.accessUnknown])
    expect(s.querySelector('.account-settings--access')!.lastElementChild).toBe(resetBox(v))
  })

  it.each([
    ['pt-BR', copy],
    ['en', en],
  ] as const)('P1 on every screen and sheet (%s)', async (locale, words) => {
    applyLocale(locale)
    const clean = () => expect(findProtocolLeaksInText(v.container.innerHTML)).toEqual([])
    const v = mount()
    v.open()
    expect(v.screen(words.account.title)).not.toBeNull()
    clean()
    v.press(v.entry(words.account.accessTitle)!)
    expect(v.screen(words.account.accessTitle)).not.toBeNull()
    clean()
    v.press(resetBox(v))
    expect(v.getByRole('alertdialog', { name: words.account.resetTitle })).toBeTruthy()
    clean()
    v.h.back()
    v.h.back()
    v.press(within(v.screen(words.account.title)!).getByRole('button', { name: words.account.edit }))
    await waitFor(() => expect(v.getByLabelText(words.profile.nickname)).toBeTruthy())
    clean()
  })
})

describe('A1: one access, in both widths', () => {
  it.each([true, false])('narrow=%s', (narrow) => {
    fakeDevice({ narrow })
    const v = mount({ accesses: [{ id: did('D2'), friendlyName: 'iPhone', current: true }] })
    v.open()
    expect(v.entry(copy.account.accessTitle)!.querySelector('.account-settings__access-entry-summary')!.textContent).toBe(
      copy.account.accessesOnlyThis,
    )
  })

  it.each([true, false])('several keep the count (narrow=%s)', (narrow) => {
    fakeDevice({ narrow })
    const v = mount()
    v.open()
    expect(v.entry(copy.account.accessTitle)!.textContent).toContain(fill(copy.account.accessCount.other, { n: 3 }))
  })
})

describe('the reset sheet (§13.2 item 5)', () => {
  beforeEach(() => void fakeDevice())

  function openSheet(opts: Opts = {}) {
    const v = mount(opts)
    v.open()
    toAccesses(v)
    v.press(resetBox(v))
    return v
  }
  const labels = (v: View) => within(v.getByRole('alertdialog')).queryAllByRole('button').map((b) => b.textContent)

  it('idle: body, caveat, the danger over cancel, and only the danger resets', () => {
    const v = openSheet()
    expect(v.getByText(copy.account.resetWarning)).toBeTruthy()
    expect(v.getByText(copy.account.resetCaveat)).toBeTruthy()
    expect(labels(v)).toEqual([copy.account.reset, copy.account.cancel])
    expect(v.onReset).not.toHaveBeenCalled()
    fireEvent.click(within(v.getByRole('alertdialog')).getByRole('button', { name: copy.account.reset }))
    expect(v.onReset).toHaveBeenCalledTimes(1)
  })

  it('pending: the status and the sweep, no buttons, and Esc still heard', () => {
    const v = openSheet()
    v.setReset('pending')
    const sheet = within(v.getByRole('alertdialog'))
    expect(sheet.getByRole('status').textContent).toBe(copy.account.resetPending)
    expect(v.container.querySelector('.reset-sheet .sweep')).not.toBeNull()
    expect(labels(v)).toEqual([])
    expect(document.activeElement).toBe(sheet.getByRole('status'))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    v.h.land()
    expect(v.queryByRole('alertdialog')).toBeNull()
  })

  it('closing while it waits leaves the reset running: reopened, it shows where it stands', () => {
    const v = openSheet()
    v.setReset('pending')
    fireEvent.click(v.container.querySelector('.ui-sheet__scrim')!)
    v.h.land()
    expect(v.h.depth()).toBe(2)
    expect(v.onSignOut).not.toHaveBeenCalled()
    v.setReset('done')
    v.press(resetBox(v))
    expect(v.getByText(copy.account.resetDone)).toBeTruthy()
  })

  it('not done: try again over cancel, with the focus on cancel', () => {
    const v = openSheet()
    v.setReset('notDone')
    expect(v.getByText(copy.account.resetNotDone)).toBeTruthy()
    expect(labels(v)).toEqual([copy.account.resetTryAgain, copy.account.cancel])
    expect(document.activeElement!.textContent).toBe(copy.account.cancel)
  })

  it('done: only sign in again, primary', () => {
    const v = openSheet({ resetStatus: 'done' })
    expect(labels(v)).toEqual([copy.account.resetSignInAgain])
    const again = within(v.getByRole('alertdialog')).getByRole('button')
    expect(again.dataset.variant).toBe('fill')
    fireEvent.click(again)
    expect(v.onSignOut).toHaveBeenCalledTimes(1)
  })
})

describe('the install row and sheet (I1, I2)', () => {
  it('none outside the iPhone Safari', () => {
    fakeDevice({ coarse: true })
    const v = mount()
    v.open()
    expect(v.entry(copy.install.row)).toBeUndefined()
  })

  it('after the data, even when the sign-in sheet was dismissed; "Agora não" closes; one entry of the stack', () => {
    fakeDevice({ coarse: true, ua: IPHONE_SAFARI_UA })
    localStorage.setItem('tayet.install-dismissed', '1')
    const v = mount()
    v.open()
    expect(v.titles()).toEqual([copy.account.accessSection, copy.dataExport.section, copy.install.section])
    expect(v.queryByRole('dialog')).toBeNull()
    v.press(v.entry(copy.install.row)!)
    const sheet = within(v.getByRole('dialog', { name: copy.install.sheetLabel }))
    expect(sheet.getByRole('img', { name: copy.install.share })).toBeTruthy()
    expect(sheet.getAllByRole('listitem')).toHaveLength(3)
    expect(v.h.depth()).toBe(2)
    expect(findProtocolLeaksInText(v.container.innerHTML)).toEqual([])
    fireEvent.click(sheet.getByRole('button', { name: copy.install.notNow }))
    v.h.land()
    expect(v.queryByRole('dialog')).toBeNull()
    expect(v.h.depth()).toBe(1)
    expect(document.activeElement).toBe(v.entry(copy.install.row))
  })

  it('on its side (728 or more) neither the row nor the sheet exists', () => {
    const device = fakeDevice({ coarse: true, ua: IPHONE_SAFARI_UA })
    const v = mount()
    v.open()
    v.press(v.entry(copy.install.row)!)
    device.setNarrow(false)
    v.h.land()
    expect(v.queryByRole('dialog', { name: copy.install.sheetLabel })).toBeNull()
    expect(v.entry(copy.install.row)).toBeUndefined()
    expect(v.h.depth()).toBe(0)
  })
})
