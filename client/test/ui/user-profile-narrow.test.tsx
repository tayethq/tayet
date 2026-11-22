// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { UserProfileDialog } from '../../src/ui/components/UserProfileDialog'
import { applyLocale } from '../../src/ui/i18n'
import { en } from '../../src/ui/i18n/en'
import type { UserProfile } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'
import { fakeDevice } from '../support/device-fake'
import { BRUNA, DM, ME, RAFA, ROBO, channel, held, mountShell, profileOf, type ShellOpts } from '../support/narrow-shell'

// Someone's profile on the narrow window (view-profile.md §8; PLANO-MOBILE M8 P1 to P4): the real Workspace
// over the stack.

const late = vi.hoisted(() => ({ count: 0 }))
vi.mock('react', async (original) => {
  const { countLateWrites } = await import('../support/late-writes')
  return countLateWrites(await original(), late)
})

beforeEach(() => void (late.count = 0))
afterEach(() => {
  cleanup()
  applyLocale('pt-BR')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function open(opts: ShellOpts = {}, shows: string = BRUNA.displayName) {
  const v = mountShell(opts)
  v.press(v.author())
  await waitFor(() => expect(v.profile()!.querySelector('.user-profile__name')?.textContent).toBe(shows))
  return v
}
type View = Awaited<ReturnType<typeof open>>
const footer = (v: View) => v.profile()!.querySelector<HTMLElement>('.profile-screen__footer')
const send = (v: View) => within(footer(v)!).getByRole('button', { name: copy.profile.sendMessage })

describe('the screen (§8.1)', () => {
  beforeEach(() => void fakeDevice())

  it("P1: the author opens it, one entry; back and the title; the system's back returns the conversation", async () => {
    const v = await open()
    expect(v.profile()!.getAttribute('aria-label')).toBe(fill(copy.profile.viewLabel, { name: BRUNA.displayName }))
    expect(within(v.profile()!).getByRole('heading', { level: 2 }).textContent).toBe(copy.profile.viewTitle)
    expect(v.h.screens()).toEqual(['chat', 'dialog'])
    expect(v.container.querySelector('.ui-dialog')).toBeNull()
    expect(v.container.querySelector('.main')!.hasAttribute('inert')).toBe(true)
    expect(document.activeElement).toBe(within(v.profile()!).getByRole('button', { name: copy.dialog.back }))
    v.h.back()
    expect(v.profile()).toBeNull()
    expect(v.h.depth()).toBe(1)
    expect(document.activeElement).toBe(v.author())
  })

  it('"Enviar mensagem" is out of the identity column, alone in the fixed footer', async () => {
    const v = await open()
    expect(v.profile()!.querySelector('.user-profile__identity button')).toBeNull()
    expect([...footer(v)!.querySelectorAll('button')]).toEqual([send(v)])
    expect(v.profile()!.querySelector('.profile-screen__body button')).toBeNull()
  })

  it('P2: shown from inside the direct conversation with the same person, which stays in front', async () => {
    const v = await open({ selected: DM })
    fireEvent.click(send(v))
    await act(async () => {})
    v.h.land()
    expect(v.profile()).toBeNull()
    expect(v.front()).toBe('chat')
    expect(v.container.querySelector('.main .ui-screen-header__title')!.textContent).toBe(DM.name)
    expect(v.h.screens()).toEqual(['chat'])
  })

  it('P3: no footer while it loads', async () => {
    const v = mountShell({ load: () => new Promise<UserProfile>(() => {}) })
    v.press(v.author())
    expect(within(v.profile()!).getByText(copy.profile.loading)).toBeTruthy()
    expect(v.profile()!.getAttribute('aria-label')).toBe(copy.profile.viewTitle)
    expect(v.profile()!.querySelector('.profile-screen__footer')).toBeNull()
  })

  it('P3: no footer when the load failed', async () => {
    const v = mountShell({ load: () => Promise.reject(new Error('unreachable')) })
    v.press(v.author())
    await within(v.profile()!).findByText(copy.profile.loadFailed)
    expect(v.profile()!.querySelector('.profile-screen__footer')).toBeNull()
  })

  it.each([
    ["another operator's agent", ROBO],
    ['the reader', ME],
  ])('P3: no footer without the verb (%s)', async (_, user) => {
    const v = mountShell()
    v.press(v.more())
    v.press(v.rows().find((r) => r.getAttribute('aria-label') === fill(copy.channel.viewProfile, { name: user.displayName }))!)
    await waitFor(() => expect(v.profile()!.querySelector('.user-profile__name')?.textContent).toBe(user.displayName))
    expect(v.profile()!.querySelector('.profile-screen__footer')).toBeNull()
    if (user === ROBO) {
      expect(v.profile()!.querySelector('[data-agent-avatar]')).not.toBeNull()
      expect(v.profile()!.querySelector('.user-profile__presence')).toBeNull()
    }
  })

  it('the failure line sits in the footer, over the button, and clears on a retry', async () => {
    let fail = true
    const v = await open({ dm: async () => (fail ? Promise.reject(new Error('refused')) : undefined) })
    fireEvent.click(send(v))
    const alert = await within(footer(v)!).findByRole('alert')
    expect(alert.textContent).toBe(copy.profile.openFailed)
    expect(alert.nextElementSibling).toBe(send(v))
    fail = false
    fireEvent.click(send(v))
    await waitFor(() => expect(v.profile()).toBeNull())
  })
})

describe('the chips (§8.1 item 4)', () => {
  beforeEach(() => void fakeDevice())

  it('each is a button, eight and the +N, which shows the rest', async () => {
    const v = await open({ common: Array.from({ length: 12 }, (_, i) => channel(i)) })
    await waitFor(() => expect(v.profile()!.querySelectorAll('button.user-profile__chip')).toHaveLength(9))
    fireEvent.click(v.profile()!.querySelector('.user-profile__chip--more')!)
    expect(v.profile()!.querySelectorAll('button.user-profile__chip')).toHaveLength(12)
    expect(v.profile()).not.toBeNull()
  })

  it('a chip closes the profile and leads to the channel', async () => {
    const v = await open({ common: [channel(4)] })
    fireEvent.click(await within(v.profile()!).findByRole('button', { name: '#canal-4' }))
    v.h.land()
    expect(v.profile()).toBeNull()
    expect(v.h.screens()).toEqual(['chat'])
    expect(v.container.querySelector('.main .ui-screen-header__title')!.textContent).toContain('canal-4')
  })
})

describe('P4: the back is never held by "Enviar mensagem"', () => {
  beforeEach(() => void fakeDevice())

  it('back closes it while the verb runs; the conversation is selected when the verb settles', async () => {
    const verb = held()
    const v = await open({ dm: () => verb.promise })
    fireEvent.click(send(v))
    const back = within(v.profile()!).getByRole('button', { name: copy.dialog.back }) as HTMLButtonElement
    expect(back.disabled).toBe(false)
    v.h.back()
    expect(v.profile()).toBeNull()
    expect(v.h.depth()).toBe(1)
    await act(async () => verb.resolve())
    v.h.land()
    expect(v.container.querySelector('.main .ui-screen-header__title')!.textContent).toBe(DM.name)
  })

  it('a failure that lands after it closed writes no state and logs no error', async () => {
    const verb = held()
    const error = vi.spyOn(console, 'error')
    const v = await open({ dm: () => verb.promise })
    fireEvent.click(send(v))
    v.h.back()
    await act(async () => verb.reject(new Error('refused')))
    expect(late.count).toBe(0)
    expect(error).not.toHaveBeenCalled()
  })
})

describe('crossing the breakpoint', () => {
  it('the same instance: no second load, and the button moves between the footer and the column', async () => {
    const device = fakeDevice({ narrow: false })
    const load = vi.fn(async (id: UserProfile['id']) => profileOf(id))
    const v = mountShell({ load })
    v.press(v.author())
    await v.findByRole('button', { name: copy.profile.sendMessage })
    expect(v.container.querySelector('.user-profile__identity .user-profile__dm')).not.toBeNull()
    device.setNarrow(true)
    v.h.land()
    expect(footer(v)).not.toBeNull()
    device.setNarrow(false)
    v.h.land()
    expect(v.container.querySelector('.user-profile__identity .user-profile__dm')).not.toBeNull()
    expect(v.h.depth()).toBe(0)
    expect(load).toHaveBeenCalledTimes(1)
  })
})

describe('R4: a late "Enviar mensagem" closes only the profile it started from', () => {
  const closeProfile = (v: ReturnType<typeof mountShell>, narrow: boolean) => {
    if (narrow) v.h.back()
    else fireEvent.keyDown(v.container.querySelector('.user-profile-dialog')!, { key: 'Escape' })
    expect(v.container.querySelector('.user-profile')).toBeNull()
  }

  it.each([
    [true, 'another person'],
    [true, 'the same person again'],
    [false, 'another person'],
    [false, 'the same person again'],
  ] as const)('narrow=%s: closed, then %s: the profile on screen stays', async (narrow, next) => {
    fakeDevice({ narrow })
    const verb = held()
    const v = mountShell({ dm: () => verb.promise })
    v.press(v.more())
    const row = (name: string) => v.rows().find((r) => r.getAttribute('aria-label') === fill(copy.channel.viewProfile, { name }))!
    v.press(row(BRUNA.displayName))
    fireEvent.click(await v.findByRole('button', { name: copy.profile.sendMessage }))
    closeProfile(v, narrow)
    const name = next === 'another person' ? RAFA.displayName : BRUNA.displayName
    v.press(row(name))
    await waitFor(() => expect(v.container.querySelector('.user-profile__name')?.textContent).toBe(name))
    await act(async () => verb.resolve())
    v.h.land()
    expect(v.container.querySelector('.user-profile__name')?.textContent).toBe(name)
    expect(v.rows().length).toBeGreaterThan(0)
  })

  it.each([true, false])('closed with nothing opened: neither onClose nor onNavigated (narrow=%s)', async (narrow) => {
    const verb = held()
    const onClose = vi.fn()
    const onNavigated = vi.fn()
    const r = render(
      <UserProfileDialog userId={BRUNA.id} onLoadUserProfile={async (id) => profileOf(id)} onOpenDirectMessage={() => verb.promise} onClose={onClose} onNavigated={onNavigated} narrow={narrow} />,
    )
    fireEvent.click(await r.findByRole('button', { name: copy.profile.sendMessage }))
    r.unmount()
    await act(async () => verb.resolve())
    expect(onClose).not.toHaveBeenCalled()
    expect(onNavigated).not.toHaveBeenCalled()
  })

  it.each([true, false])('an instance handed another person does not close it, nor keep its wait (narrow=%s)', async (narrow) => {
    const verb = held()
    const onClose = vi.fn()
    const onNavigated = vi.fn()
    const load = async (id: UserProfile['id']) => profileOf(id)
    const card = (id: UserProfile['id']) => (
      <UserProfileDialog userId={id} onLoadUserProfile={load} onOpenDirectMessage={() => verb.promise} onClose={onClose} onNavigated={onNavigated} narrow={narrow} />
    )
    const r = render(card(BRUNA.id))
    fireEvent.click(await r.findByRole('button', { name: copy.profile.sendMessage }))
    r.rerender(card(RAFA.id))
    await waitFor(() => expect(r.container.querySelector('.user-profile__name')?.textContent).toBe(RAFA.displayName))
    expect((r.getByRole('button', { name: copy.profile.sendMessage }) as HTMLButtonElement).disabled).toBe(false)
    await act(async () => verb.resolve())
    expect(onClose).not.toHaveBeenCalled()
    expect(onNavigated).not.toHaveBeenCalled()
  })
})

describe('P1 (protocol)', () => {
  it.each([
    ['pt-BR', copy],
    ['en', en],
  ] as const)('on the screen (%s)', async (locale, words) => {
    fakeDevice()
    applyLocale(locale)
    const v = await open({ common: [channel(1)] })
    expect(within(v.profile()!).getByRole('button', { name: words.profile.sendMessage })).toBeTruthy()
    expect(findProtocolLeaksInText(v.container.innerHTML)).toEqual([])
  })
})
