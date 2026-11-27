// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GroupDetailsPanel } from '../../src/ui/components/GroupDetailsPanel'
import { applyLocale } from '../../src/ui/i18n'
import { en } from '../../src/ui/i18n/en'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'
import { fakeDevice } from '../support/device-fake'
import { BRUNA, DM, GROUP, GROUP2, RAFA, ROSTER, channel, held, mountShell, type ShellOpts } from '../support/narrow-shell'

// "Detalhes da conversa" on the narrow window (channel-management.md §11; PLANO-MOBILE M8 G1 to G3, §3.4 item 3):
// the real Workspace over the stack, on a history whose landings the test decides.

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

const flush = () => act(async () => {})
function open(opts: ShellOpts = {}) {
  const v = mountShell(opts)
  v.press(v.more())
  return v
}
type View = ReturnType<typeof open>
const leaveEntry = (v: View) => within(v.details()!).getByRole('button', { name: copy.group.leave })
const sheet = (v: View) => within(v.getByRole('alertdialog', { name: copy.group.leave }))
const confirmLeave = (v: View) => fireEvent.click(sheet(v).getByRole('button', { name: copy.channel.leave }))
async function openProfile(v: View, name: string) {
  v.press(within(v.details()!).getByRole('button', { name: fill(copy.channel.viewProfile, { name }) }))
  await waitFor(() => expect(v.getByRole('region', { name: fill(copy.profile.viewLabel, { name }) })).toBeTruthy())
}

describe('the screen (§11.1)', () => {
  beforeEach(() => void fakeDevice())

  it('back and the title, one entry over the conversation, which is covered; no dialog', () => {
    const v = open()
    expect(v.getByRole('region', { name: copy.group.details })).toBe(v.details())
    expect(within(v.details()!).getByRole('heading', { level: 2 }).textContent).toBe(copy.group.details)
    expect(document.activeElement).toBe(within(v.details()!).getByRole('button', { name: copy.dialog.back }))
    expect(v.h.screens()).toEqual(['chat', 'dialog'])
    expect(v.container.querySelector('.main')!.hasAttribute('inert')).toBe(true)
    expect(v.container.querySelector('.ui-dialog')).toBeNull()
  })

  it('the rows: the reader first, then the participants; the agent with its operator; read-only', () => {
    const v = open()
    expect(v.rows().map((r) => r.textContent!.replace(/^[A-Z](?=[A-Z])/, ''))).toEqual([
      `Marina Alves ${copy.channel.you}`,
      'Bruna Lima',
      'Rafael Souza',
      `Ledger${fill(copy.agent.operatedBy, { name: 'Bruna Lima' })}`,
    ])
    expect(v.rows()[3]!.querySelector('[data-agent-avatar]')).not.toBeNull()
    expect(v.details()!.querySelector('select, .channel-management-panel__member-remove')).toBeNull()
    expect(v.details()!.querySelectorAll('button')).toHaveLength(1 + 4 + 1)
  })

  it('G2: an admin gets no convert, only leave in the fixed footer', () => {
    const v = open()
    expect(within(v.details()!).queryByRole('button', { name: copy.group.convert })).toBeNull()
    const footer = v.details()!.querySelector('.group-screen__footer')!
    expect([...footer.querySelectorAll('button')].map((b) => [b.textContent, b.dataset.variant])).toEqual([[copy.group.leave, 'danger']])
  })

  it("the header's back, Esc and the system's back close it, and the focus returns to the ⋯", () => {
    const v = open()
    fireEvent.click(within(v.details()!).getByRole('button', { name: copy.dialog.back }))
    v.h.land()
    expect(v.details()).toBeNull()
    expect(v.h.depth()).toBe(1)
    expect(document.activeElement).toBe(v.more())
    v.press(v.more())
    fireEvent.keyDown(v.details()!, { key: 'Escape' })
    v.h.land()
    expect(v.details()).toBeNull()
    v.press(v.more())
    v.h.back()
    expect(v.details()).toBeNull()
    expect(v.front()).toBe('chat')
  })
})

describe('G1: a row opens the profile over the details (§3.4 item 3)', () => {
  beforeEach(() => void fakeDevice())

  it("the system's back closes the profile and shows the details, then the conversation, then the list", async () => {
    const v = open()
    await openProfile(v, RAFA.displayName)
    expect(v.h.screens()).toEqual(['chat', 'dialog', 'dialog'])
    expect(v.details()!.hasAttribute('data-stack-covered')).toBe(true)
    expect(v.details()!.hasAttribute('inert')).toBe(true)

    v.h.back()
    expect(v.profile()).toBeNull()
    expect(v.details()!.hasAttribute('inert')).toBe(false)
    expect(v.h.depth()).toBe(2)
    expect(document.activeElement?.getAttribute('aria-label')).toBe(fill(copy.channel.viewProfile, { name: RAFA.displayName }))
    v.h.back()
    expect(v.details()).toBeNull()
    expect(v.h.depth()).toBe(1)
    v.h.back()
    expect(v.front()).toBe('list')
    expect(v.h.depth()).toBe(0)
  })

  it('"Enviar mensagem" closes both, and the stack settles on list and conversation', async () => {
    const v = open()
    await openProfile(v, BRUNA.displayName)
    fireEvent.click(within(v.profile()!).getByRole('button', { name: copy.profile.sendMessage }))
    await flush()
    v.h.land()
    expect(v.dm).toHaveBeenCalledWith(BRUNA.id)
    expect(v.profile()).toBeNull()
    expect(v.details()).toBeNull()
    expect(v.front()).toBe('chat')
    expect(v.container.querySelector('.main .ui-screen-header__title')!.textContent).toBe(DM.name)
    expect(v.h.screens()).toEqual(['chat'])
    expect(v.container.querySelector('.main')!.hasAttribute('inert')).toBe(false)
    v.h.back()
    expect(v.front()).toBe('list')
    expect(v.h.depth()).toBe(0)
  })

  it('a channel chip closes both too', async () => {
    const v = open({ common: [channel(1)] })
    await openProfile(v, BRUNA.displayName)
    fireEvent.click(await within(v.profile()!).findByRole('button', { name: '#canal-1' }))
    v.h.land()
    expect(v.profile()).toBeNull()
    expect(v.details()).toBeNull()
    expect(v.h.screens()).toEqual(['chat'])
    expect(v.container.querySelector('.main .ui-screen-header__title')!.textContent).toContain('canal-1')
  })

  it('the verb settling after the profile was closed leaves the details open (P4)', async () => {
    const verb = held()
    const v = open({ dm: () => verb.promise })
    await openProfile(v, BRUNA.displayName)
    fireEvent.click(within(v.profile()!).getByRole('button', { name: copy.profile.sendMessage }))
    v.h.back()
    await act(async () => verb.resolve())
    v.h.land()
    expect(v.profile()).toBeNull()
    expect(v.details()).not.toBeNull()
    expect(v.h.screens()).toEqual(['chat', 'dialog'])
  })
})

describe('the leave sheet (§11.1 item 4, G3, Implementação 2)', () => {
  beforeEach(() => void fakeDevice())

  it('an entry of its own: title, body, the danger over cancel, the focus on cancel; back closes it first', () => {
    const v = open()
    v.press(leaveEntry(v))
    expect(v.h.screens()).toEqual(['chat', 'dialog', 'dialog'])
    expect(sheet(v).getByRole('heading').textContent).toBe(copy.group.leave)
    expect(sheet(v).getByText(copy.group.leaveBody)).toBeTruthy()
    expect(sheet(v).getAllByRole('button').map((b) => b.textContent)).toEqual([copy.channel.leave, copy.channel.cancel])
    expect(document.activeElement?.textContent).toBe(copy.channel.cancel)
    v.h.back()
    expect(v.queryByRole('alertdialog')).toBeNull()
    expect(v.details()).not.toBeNull()
    expect(v.h.depth()).toBe(2)
    expect(document.activeElement).toBe(leaveEntry(v))
    expect(v.leave).not.toHaveBeenCalled()
  })

  it('cancel goes back over its entry alone', () => {
    const v = open()
    v.press(leaveEntry(v))
    fireEvent.click(sheet(v).getByRole('button', { name: copy.channel.cancel }))
    v.h.land()
    expect(v.queryByRole('alertdialog')).toBeNull()
    expect(v.h.depth()).toBe(2)
  })

  it('waiting: the action disabled with the wait text, one verb, the focus on cancel', () => {
    const verb = held()
    const v = open({ leave: () => verb.promise })
    v.press(leaveEntry(v))
    const go = sheet(v).getByRole('button', { name: copy.channel.leave }) as HTMLButtonElement
    v.press(go)
    expect(go.textContent).toBe(copy.channel.working)
    expect(go.disabled).toBe(true)
    expect(go.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(go)
    expect(v.leave).toHaveBeenCalledTimes(1)
    expect(document.activeElement?.textContent).toBe(copy.channel.cancel)
  })

  it('failure: the confirm text under the buttons, and the action again', async () => {
    const verb = held()
    const v = open({ leave: () => verb.promise })
    v.press(leaveEntry(v))
    confirmLeave(v)
    await act(async () => verb.reject(new Error('refused')))
    const alert = sheet(v).getByRole('alert')
    expect(alert.textContent).toBe(copy.channel.failed)
    expect(alert.previousElementSibling!.classList.contains('leave-sheet__actions')).toBe(true)
    expect((sheet(v).getByRole('button', { name: copy.channel.leave }) as HTMLButtonElement).disabled).toBe(false)
  })

  it.each(['scrim', 'back', 'cancel', 'Esc'] as const)('closing by %s while it waits closes the sheet, and leaving goes on', async (how) => {
    const verb = held()
    const v = open({ leave: () => verb.promise })
    v.press(leaveEntry(v))
    confirmLeave(v)
    if (how === 'scrim') fireEvent.click(v.container.querySelector('.ui-sheet__scrim')!)
    if (how === 'cancel') fireEvent.click(sheet(v).getByRole('button', { name: copy.channel.cancel }))
    if (how === 'Esc') fireEvent.keyDown(v.getByRole('alertdialog'), { key: 'Escape' })
    if (how === 'back') v.h.back()
    v.h.land()
    expect(v.queryByRole('alertdialog')).toBeNull()
    expect(v.h.depth()).toBe(2)

    v.press(leaveEntry(v))
    expect((sheet(v).getByRole('button', { name: copy.channel.working }) as HTMLButtonElement).disabled).toBe(true)
    v.h.back()
    await act(async () => verb.resolve())
    v.h.land()
    expect(v.leave).toHaveBeenCalledTimes(1)
    expect(v.details()).toBeNull()
    expect(v.h.depth()).toBe(1)
  })

  it('a failure that lands with the sheet closed shows when it reopens', async () => {
    const verb = held()
    const v = open({ leave: () => verb.promise })
    v.press(leaveEntry(v))
    confirmLeave(v)
    v.h.back()
    await act(async () => verb.reject(new Error('refused')))
    v.press(leaveEntry(v))
    expect(sheet(v).getByRole('alert').textContent).toBe(copy.channel.failed)
  })

  it('confirmed: the sheet and the details close, and the group going away leaves the list', async () => {
    const v = open()
    v.press(leaveEntry(v))
    confirmLeave(v)
    await flush()
    expect(v.leave).toHaveBeenCalledWith(GROUP.id)
    act(() => v.select(undefined))
    v.h.land()
    expect(v.queryByRole('alertdialog')).toBeNull()
    expect(v.details()).toBeNull()
    expect(v.front()).toBe('list')
    expect(v.h.depth()).toBe(0)
  })

  it('a failure after the details were left writes no state', async () => {
    const verb = held()
    const error = vi.spyOn(console, 'error')
    const v = open({ leave: () => verb.promise })
    v.press(leaveEntry(v))
    confirmLeave(v)
    v.h.back()
    v.h.back()
    expect(v.details()).toBeNull()
    await act(async () => verb.reject(new Error('refused')))
    expect(late.count).toBe(0)
    expect(error).not.toHaveBeenCalled()
  })
})

describe('crossing the breakpoint', () => {
  it('details and the leave confirm: two entries in that order over the conversation, none when wide', () => {
    const device = fakeDevice({ narrow: false })
    const v = open()
    fireEvent.click(v.getByRole('button', { name: copy.group.leave }))
    expect(v.h.depth()).toBe(0)
    device.setNarrow(true)
    v.h.land()
    expect(v.h.screens()).toEqual(['chat', 'dialog', 'dialog'])
    expect(v.getByRole('alertdialog', { name: copy.group.leave })).toBeTruthy()
    v.h.back()
    expect(v.queryByRole('alertdialog')).toBeNull()
    expect(v.details()).not.toBeNull()
    device.setNarrow(false)
    v.h.land()
    expect(v.h.depth()).toBe(0)
    expect(v.getByRole('dialog', { name: copy.group.details })).toBeTruthy()
  })

  it('details and a profile: the profile on top', async () => {
    const device = fakeDevice({ narrow: false })
    const v = open()
    fireEvent.click(v.getByRole('button', { name: fill(copy.channel.viewProfile, { name: RAFA.displayName }) }))
    await flush()
    device.setNarrow(true)
    v.h.land()
    expect(v.h.depth()).toBe(3)
    v.h.back()
    expect(v.profile()).toBeNull()
    expect(v.details()).not.toBeNull()
  })

  it('G2: a convert confirm open when it narrows is not shown', () => {
    const device = fakeDevice({ narrow: false })
    const v = open()
    fireEvent.click(v.getByRole('button', { name: copy.group.convert }))
    device.setNarrow(true)
    v.h.land()
    expect(v.queryByLabelText(copy.group.convertName)).toBeNull()
    expect(within(v.details()!).queryByRole('button', { name: copy.group.convert })).toBeNull()
    expect(v.h.depth()).toBe(2)
    v.press(leaveEntry(v))
    confirmLeave(v)
    expect(v.convert).not.toHaveBeenCalled()
    expect(v.leave).toHaveBeenCalledTimes(1)
  })
})

describe('R1 and R2: the section head and the suffix of a row', () => {
  const css = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'styles.narrow.css'), 'utf8')
  const rule = (selector: string) => css.split(`  ${selector} {`)[1]!.split('}')[0]!

  it('R1: the head takes 4, 12 and 8', () => {
    expect(rule('.group-screen .channel-management-panel__roster-head')).toContain('padding: var(--space-4) var(--space-12) var(--space-8);')
  })

  it('R2: the name and what follows it are boxes of their own, each cut, in a line that wraps', () => {
    fakeDevice()
    const v = open()
    const name = v.rows()[3]!.querySelector('.channel-management-panel__member-name')!
    const [label, suffix] = [...name.children]
    expect(name.childNodes).toHaveLength(2)
    expect(label!.textContent).toBe('Ledger')
    expect(suffix!.textContent).toBe(fill(copy.agent.operatedBy, { name: 'Bruna Lima' }))
    // §13.6 item 3: the operator's line no longer depends on fitting beside the name.
    expect(suffix!.classList.contains('channel-management-panel__member-sub')).toBe(true)
    expect(rule('.group-screen .channel-management-panel__member-name')).toContain('flex-wrap: wrap;')
    expect(rule('.group-screen .channel-management-panel__member-name > span')).toContain('text-overflow: ellipsis;')
  })
})

describe('R4: a late leave closes only the details it started from', () => {
  it.each([true, false])("another group's details stay (narrow=%s)", async (narrow) => {
    fakeDevice({ narrow })
    const verb = held()
    const v = open({ leave: () => verb.promise })
    if (narrow) {
      v.press(leaveEntry(v))
      confirmLeave(v)
      v.h.back()
      v.h.back()
    } else {
      fireEvent.click(v.getByRole('button', { name: copy.group.leave }))
      fireEvent.click(v.getByRole('button', { name: copy.channel.leave }))
      for (const name of [copy.group.leave, copy.group.details]) fireEvent.keyDown(v.getByRole('dialog', { name }), { key: 'Escape' })
    }
    expect(v.queryByRole(narrow ? 'region' : 'dialog', { name: copy.group.details })).toBeNull()
    act(() => v.select(GROUP2.id))
    v.press(v.more())
    await act(async () => verb.resolve())
    v.h.land()
    expect(v.leave).toHaveBeenCalledWith(GROUP.id)
    expect(v.getByRole(narrow ? 'region' : 'dialog', { name: copy.group.details })).toBeTruthy()
  })

  it.each([true, false])('an instance handed another group does not close it, nor show its wait (narrow=%s)', async (narrow) => {
    fakeDevice({ narrow })
    const verb = held()
    const onClose = vi.fn()
    const panel = (group: typeof GROUP) => (
      <GroupDetailsPanel
        channel={group}
        members={ROSTER}
        onConvertToChannel={async () => {}}
        onLeaveChannel={() => verb.promise}
        onClose={onClose}
        narrow={narrow}
      />
    )
    const r = render(panel(GROUP))
    fireEvent.click(r.getByRole('button', { name: copy.group.leave }))
    fireEvent.click(r.getByRole('button', { name: copy.channel.leave }))
    r.rerender(panel(GROUP2))
    expect(r.queryByRole('button', { name: copy.channel.working })).toBeNull()
    await act(async () => verb.resolve())
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('P1', () => {
  it.each([
    ['pt-BR', copy],
    ['en', en],
  ] as const)('on the screen and the sheet (%s)', (locale, words) => {
    fakeDevice()
    applyLocale(locale)
    const v = open()
    expect(v.getByRole('region', { name: words.group.details })).toBeTruthy()
    expect(findProtocolLeaksInText(v.container.innerHTML)).toEqual([])
    v.press(within(v.details()!).getByRole('button', { name: words.group.leave }))
    expect(v.getByRole('alertdialog', { name: words.group.leave })).toBeTruthy()
    expect(findProtocolLeaksInText(v.container.innerHTML)).toEqual([])
  })
})
