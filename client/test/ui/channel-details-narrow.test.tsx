// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RosterEntry, User, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'
import { fakeDevice } from '../support/device-fake'
import { ALL_ABILITIES, BRUNA, CHAN, ME, NO_ABILITIES, RAFA, ROBO, ROSTER, held, mountShell, type ShellOpts } from '../support/narrow-shell'

// "Detalhes do canal" on the narrow window (channel-management.md §13.2, §14; PLANO-MOBILE §0.21 and §0.22): the
// real Workspace over the stack, on a history whose landings the test decides.

const late = vi.hoisted(() => ({ count: 0 }))
vi.mock('react', async (original) => {
  const { countLateWrites } = await import('../support/late-writes')
  return countLateWrites(await original(), late)
})

beforeEach(() => {
  late.count = 0
  fakeDevice()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const uid = (s: string) => s as unknown as UserId
const ANA: User = { id: uid('@ana:tayet.local'), displayName: 'Ana Costa', kind: 'member' }
const IGOR: User = { id: uid('@igor:tayet.local'), displayName: 'Igor Lemos', kind: 'member' }
const MINE: User = { id: uid('@a-mnopqrstuvwx:tayet.local'), displayName: 'Resumo semanal', kind: 'agent', agentColor: 'argila', operatorName: ME.displayName }
const GUEST: User = { id: uid('@gisele:tayet.local'), displayName: 'Gisele Rocha', kind: 'guest' }
const INVITED: User = { id: uid('@helena:tayet.local'), displayName: 'Helena Dias', kind: 'member' }

const flush = () => act(async () => {})
function open(opts: ShellOpts = {}) {
  const v = mountShell({ selected: CHAN, ...opts })
  v.press(v.more())
  return v
}
type View = ReturnType<typeof open>
const row = (v: View, name: string) =>
  [...v.channelDetails()!.querySelectorAll<HTMLButtonElement>('button.channel-screen__row')].find(
    (b) => b.querySelector('.channel-management-panel__member-label')?.textContent === name,
  )!
const personSheet = (v: View, name: string) => within(v.getByRole('dialog', { name }))
const confirmSheet = (v: View, title: string) => within(v.getByRole('alertdialog', { name: title }))
const asMember = (list: RosterEntry[]): RosterEntry[] => list.map((m) => (m.self ? { ...m, role: 'member' } : m))

describe('the screen (§13.2 items 1, 2, 3 and 7)', () => {
  it('opens from the "⋯" of the channel: back and the title, one entry over the conversation; no dialog', () => {
    const v = open()
    expect(v.more().getAttribute('aria-label')).toBe(fill(copy.channel.manageNamed, { name: '#design' }))
    expect(v.getByRole('region', { name: copy.channel.details })).toBe(v.channelDetails())
    expect(within(v.channelDetails()!).getByRole('heading', { level: 2 }).textContent).toBe(copy.channel.details)
    expect(document.activeElement).toBe(within(v.channelDetails()!).getByRole('button', { name: copy.dialog.back }))
    expect(v.h.screens()).toEqual(['chat', 'dialog'])
    expect(v.container.querySelector('.main')!.hasAttribute('inert')).toBe(true)
    expect(v.container.querySelector('.ui-dialog')).toBeNull()
  })

  it('the name with its mark saves as the wide window does; the field is on the 16px of the narrow window', async () => {
    const v = open()
    const name = within(v.channelDetails()!).getByLabelText(copy.channel.name) as HTMLInputElement
    expect(name.value).toBe('design')
    expect(name.parentElement!.querySelector('.channel-management-panel__input-mark')!.textContent).toBe('#')
    fireEvent.change(name, { target: { value: 'design-system' } })
    fireEvent.blur(name)
    await waitFor(() => expect(v.update).toHaveBeenCalledWith(CHAN.id, { name: 'design-system' }))
    expect(await within(v.channelDetails()!).findByText(copy.channel.saved)).toBeTruthy()
    const css = readFileSync(join(__dirname, '../../src/ui/styles.narrow.css'), 'utf8')
    expect(css.split('  .channel-screen .channel-management-panel__input {')[1]!.split('}')[0]).toContain('font-size: var(--font-size-field);')
  })

  it('the rows: the own one is not a target; the others are buttons with the role on the right; the agent in two lines', () => {
    const v = open()
    const own = v.channelDetails()!.querySelector('div.channel-screen__row')!
    expect(own.textContent).toContain(copy.channel.you)
    expect(own.closest('button')).toBeNull()
    expect(row(v, RAFA.displayName).querySelector('.channel-management-panel__member-role')!.textContent).toBe(copy.channel.roleAdmin)
    const agent = row(v, ROBO.displayName)
    expect(agent.querySelector('[data-agent-avatar]')).not.toBeNull()
    expect(agent.querySelector('.channel-management-panel__member-sub')!.textContent).toBe(
      fill(copy.agent.operatedBy, { name: ROBO.operatorName! }),
    )
    expect(within(v.channelDetails()!).getByRole('heading', { name: fill(copy.channel.membersCount, { n: 4 }) })).toBeTruthy()
  })

  it('the footer stacks archive and leave', () => {
    const v = open()
    const footer = v.channelDetails()!.querySelector('.channel-screen__footer')!
    expect([...footer.querySelectorAll('button')].map((b) => b.textContent)).toEqual([copy.channel.archiveTitle, copy.channel.leaveTitle])
  })

  it('renders no protocol shape', () => {
    const v = open()
    v.press(row(v, RAFA.displayName))
    expect(findProtocolLeaksInText(v.container.innerHTML)).toEqual([])
  })
})

describe("the person's sheet (§13.2 item 4)", () => {
  it('the person on top, "Ver perfil", the pair of the role and "Remover"; an entry of its own', () => {
    const v = open()
    v.press(row(v, RAFA.displayName))
    const s = personSheet(v, RAFA.displayName)
    expect(s.getByText(RAFA.displayName)).toBeTruthy()
    expect(s.getByRole('button', { name: copy.channel.openProfile })).toBeTruthy()
    const pair = s.getByRole('group', { name: fill(copy.channel.roleFor, { name: RAFA.displayName }) })
    expect(within(pair).getByRole('button', { name: copy.channel.roleAdmin }).getAttribute('aria-pressed')).toBe('true')
    expect(pair.classList.contains('ui-segmented')).toBe(true)
    expect(s.getByRole('button', { name: copy.channel.remove })).toBeTruthy()
    expect(v.h.screens()).toEqual(['chat', 'dialog', 'dialog'])
  })

  it('the pair applies on the tap, waits disabled, and a failure shows in the sheet, which stays open', async () => {
    const verb = held()
    const v = open({ setRole: () => verb.promise })
    v.press(row(v, RAFA.displayName))
    fireEvent.click(personSheet(v, RAFA.displayName).getByRole('button', { name: copy.channel.roleMember }))
    expect(v.setRole).toHaveBeenCalledWith(CHAN.id, RAFA.id, 'member')
    expect((personSheet(v, RAFA.displayName).getByRole('button', { name: copy.channel.roleMember }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => verb.reject(new Error('refused')))
    expect(personSheet(v, RAFA.displayName).getByRole('alert').textContent).toBe(copy.channel.roleFailed)
    expect((personSheet(v, RAFA.displayName).getByRole('button', { name: copy.channel.roleMember }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('§14 item 3: closing the sheet while the role verb runs closes it, and the verb goes on without a late write', async () => {
    const verb = held()
    const v = open({ setRole: () => verb.promise })
    v.press(row(v, RAFA.displayName))
    fireEvent.click(personSheet(v, RAFA.displayName).getByRole('button', { name: copy.channel.roleMember }))
    v.h.back()
    expect(v.queryByRole('dialog', { name: RAFA.displayName })).toBeNull()
    expect(v.channelDetails()).not.toBeNull()
    await act(async () => verb.reject(new Error('refused')))
    expect(late.count).toBe(0)
  })

  it('a guest and someone not connected yet show the role as text, without the pair; an agent gets the same sheet', () => {
    const members: RosterEntry[] = [
      ...ROSTER,
      { user: GUEST, role: 'guest', state: 'active', self: false },
      { user: INVITED, role: 'member', state: 'invited', self: false },
    ]
    const v = open({ members })
    for (const [who, label] of [
      [GUEST, copy.channel.roleGuest],
      [INVITED, copy.channel.roleMember],
    ] as const) {
      v.press(row(v, who.displayName))
      const s = personSheet(v, who.displayName)
      expect(s.queryByRole('group')).toBeNull()
      expect(v.getByRole('dialog', { name: who.displayName }).querySelector('.channel-management-panel__member-role')!.textContent).toBe(label)
      v.h.back()
    }
    v.press(row(v, ROBO.displayName))
    expect(v.getByRole('dialog', { name: ROBO.displayName }).querySelector('[data-agent-avatar]')).not.toBeNull()
    expect(personSheet(v, ROBO.displayName).getByRole('group')).toBeTruthy()
  })

  it('"Ver perfil" closes the sheet and stacks the profile over the details', async () => {
    const v = open()
    v.press(row(v, BRUNA.displayName))
    fireEvent.click(personSheet(v, BRUNA.displayName).getByRole('button', { name: copy.channel.openProfile }))
    await waitFor(() => expect(v.profile()).not.toBeNull())
    v.h.land()
    expect(v.queryByRole('dialog', { name: BRUNA.displayName })).toBeNull()
    expect(v.channelDetails()!.hasAttribute('inert')).toBe(true)
    expect(v.h.screens()).toEqual(['chat', 'dialog', 'dialog'])
    v.h.back()
    expect(v.profile()).toBeNull()
    expect(v.channelDetails()!.hasAttribute('inert')).toBe(false)
  })

  it('remove: the confirm over the sheet; success closes the confirm and the sheet; the details stay', async () => {
    const v = open()
    v.press(row(v, RAFA.displayName))
    v.press(personSheet(v, RAFA.displayName).getByRole('button', { name: copy.channel.remove }))
    const c = confirmSheet(v, copy.channel.removeTitle)
    expect(c.getByText(fill(copy.channel.removeBody, { name: RAFA.displayName }))).toBeTruthy()
    expect(v.h.screens()).toEqual(['chat', 'dialog', 'dialog', 'dialog'])
    fireEvent.click(c.getByRole('button', { name: copy.channel.remove }))
    await flush()
    v.h.land()
    expect(v.remove).toHaveBeenCalledWith(CHAN.id, RAFA.id)
    expect(v.queryByRole('alertdialog')).toBeNull()
    expect(v.queryByRole('dialog', { name: RAFA.displayName })).toBeNull()
    expect(v.channelDetails()).not.toBeNull()
    expect(v.h.screens()).toEqual(['chat', 'dialog'])
  })
})

describe("the person's sheet and its scrim under the remove confirm (§13.2 item 8; #508 R1)", () => {
  // The sheet rules of the stylesheet, so jsdom computes `visibility` the way the browser does.
  const css = readFileSync(join(__dirname, '../../src/ui/styles.css'), 'utf8')
  const sheetRules = css.match(/\.ui-sheet__scrim\[data-under\],\n\.ui-sheet\[data-under\] \{[^}]*\}/)![0]
  beforeEach(() => {
    const style = document.createElement('style')
    style.textContent = sheetRules
    document.head.appendChild(style)
    return () => style.remove()
  })
  const panelOf = (v: View, name: string) => v.getByRole('dialog', { name })
  const scrimOf = (panel: HTMLElement) => panel.previousElementSibling as HTMLElement
  const painted = (el: Element) => getComputedStyle(el).visibility !== 'hidden'

  it('alone, the sheet and its scrim are painted, and a tap on the scrim closes the sheet', () => {
    const v = open()
    v.press(row(v, RAFA.displayName))
    const panel = panelOf(v, RAFA.displayName)
    const scrim = scrimOf(panel)
    expect(scrim.classList.contains('ui-sheet__scrim')).toBe(true)
    expect(painted(panel)).toBe(true)
    expect(painted(scrim)).toBe(true)
    fireEvent.click(scrim)
    v.h.land()
    expect(v.queryByRole('dialog', { name: RAFA.displayName })).toBeNull()
    expect(v.h.screens()).toEqual(['chat', 'dialog'])
  })

  it('with the remove confirm over it, neither the sheet nor its scrim is painted; the confirm and its scrim are', () => {
    const v = open()
    v.press(row(v, RAFA.displayName))
    v.press(personSheet(v, RAFA.displayName).getByRole('button', { name: copy.channel.remove }))
    const panel = v.container.querySelector<HTMLElement>('.ui-sheet[role="dialog"]')!
    expect(panel.getAttribute('aria-label')).toBe(RAFA.displayName)
    expect(painted(panel)).toBe(false)
    expect(painted(scrimOf(panel))).toBe(false)
    const confirm = v.getByRole('alertdialog', { name: copy.channel.removeTitle })
    expect(painted(confirm)).toBe(true)
    expect(painted(scrimOf(confirm))).toBe(true)
    // Cancelled, the sheet is painted again.
    fireEvent.click(within(confirm).getByRole('button', { name: copy.channel.cancel }))
    v.h.land()
    expect(painted(panelOf(v, RAFA.displayName))).toBe(true)
    expect(painted(scrimOf(panelOf(v, RAFA.displayName)))).toBe(true)
  })
})

describe('the picker (§13.2 item 6, §9 items 5–6)', () => {
  const candidates = async () => [ANA, IGOR, MINE]

  it('a screen over the details: back, the filter, the rows; adding keeps it open and the person leaves the list', async () => {
    const v = open({ candidates })
    v.press(within(v.channelDetails()!).getByRole('button', { name: copy.channel.addMember }))
    await waitFor(() => expect(within(v.picker()!).getByText(ANA.displayName)).toBeTruthy())
    expect(v.channelDetails()!.hasAttribute('inert')).toBe(true)
    expect(within(v.picker()!).getByRole('heading', { level: 2 }).textContent).toBe(copy.channel.addMember)
    expect(v.h.screens()).toEqual(['chat', 'dialog', 'dialog'])
    expect(v.picker()!.querySelector('.ui-dialog__footer, .ui-dialog__close')).toBeNull()
    // The agent in two lines, the reader as operator; the filter reads the name only.
    expect(within(v.picker()!).getByText(fill(copy.agent.operatedBy, { name: ME.displayName }))).toBeTruthy()
    const filter = within(v.picker()!).getByRole('textbox', { name: copy.newConversation.filterPeople })
    fireEvent.change(filter, { target: { value: ME.displayName.slice(0, 6) } })
    expect(within(v.picker()!).getByText(fill(copy.people.noResults, { term: ME.displayName.slice(0, 6) }))).toBeTruthy()
    fireEvent.click(within(v.picker()!).getByRole('button', { name: copy.people.clearFilter }))
    fireEvent.click(within(v.picker()!).getByText(ANA.displayName))
    await flush()
    expect(v.add).toHaveBeenCalledWith(CHAN.id, ANA.id)
    expect(v.picker()).not.toBeNull()
    expect(within(v.picker()!).queryByText(ANA.displayName)).toBeNull()
    expect(within(v.picker()!).getByText(IGOR.displayName)).toBeTruthy()
    v.h.back()
    expect(v.picker()).toBeNull()
    expect(v.channelDetails()!.hasAttribute('inert')).toBe(false)
  })

  it('empty: "Nenhuma pessoa disponível para adicionar"', async () => {
    const v = open()
    v.press(within(v.channelDetails()!).getByRole('button', { name: copy.channel.addMember }))
    expect(await within(v.picker()!).findByText(copy.channel.noCandidates)).toBeTruthy()
  })
})

describe('the confirms and the stack (§13.2 items 8 and 9)', () => {
  it('archive: a sheet with the primary action; success closes the details', async () => {
    const v = open()
    v.press(within(v.channelDetails()!).getByRole('button', { name: copy.channel.archiveTitle }))
    const c = confirmSheet(v, copy.channel.archiveTitle)
    expect(c.getByRole('button', { name: copy.channel.archive }).getAttribute('data-variant')).toBe('fill')
    expect(v.getByRole('alertdialog').querySelector('.manage-dialog__dot')).toBeNull()
    fireEvent.click(c.getByRole('button', { name: copy.channel.archive }))
    await flush()
    v.h.land()
    expect(v.archive).toHaveBeenCalledWith(CHAN.id)
    expect(v.channelDetails()).toBeNull()
  })

  it('leave: the danger action waits disabled with "Aguarde…", and a failure shows under the buttons', async () => {
    const verb = held()
    const v = open({ leave: () => verb.promise })
    v.press(within(v.channelDetails()!).getByRole('button', { name: copy.channel.leaveTitle }))
    fireEvent.click(confirmSheet(v, copy.channel.leaveTitle).getByRole('button', { name: copy.channel.leave }))
    const busy = confirmSheet(v, copy.channel.leaveTitle).getByRole('button', { name: copy.channel.working }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    expect(busy.getAttribute('data-variant')).toBe('danger-fill')
    await act(async () => verb.reject(new Error('refused')))
    expect(confirmSheet(v, copy.channel.leaveTitle).getByRole('alert').textContent).toBe(copy.channel.failed)
  })

  it("the system's back closes the top entry, level by level", async () => {
    const v = open()
    v.press(row(v, RAFA.displayName))
    v.press(personSheet(v, RAFA.displayName).getByRole('button', { name: copy.channel.remove }))
    v.h.back()
    expect(v.queryByRole('alertdialog')).toBeNull()
    expect(v.getByRole('dialog', { name: RAFA.displayName })).toBeTruthy()
    v.h.back()
    expect(v.queryByRole('dialog', { name: RAFA.displayName })).toBeNull()
    expect(v.channelDetails()).not.toBeNull()
    v.h.back()
    expect(v.channelDetails()).toBeNull()
    expect(v.front()).toBe('chat')
    v.h.back()
    expect(v.front()).toBe('list')
  })
})

describe('who may do nothing in the channel (§13.2 item 5, §13.1 item 5; §15 item 1)', () => {
  it('read-only: name and topic as text, no add, no archive; the row opens the profile, no sheet', async () => {
    const v = open({ members: asMember(ROSTER), abilities: NO_ABILITIES })
    const details = within(v.channelDetails()!)
    expect(details.queryByLabelText(copy.channel.name)).toBeNull()
    expect(v.channelDetails()!.querySelector('.channel-management-panel__value')!.textContent).toBe('#design')
    expect(details.getByText(CHAN.topic!)).toBeTruthy()
    expect(details.queryByRole('button', { name: copy.channel.addMember })).toBeNull()
    expect(details.queryByRole('button', { name: copy.channel.archiveTitle })).toBeNull()
    expect(details.getByRole('button', { name: copy.channel.leaveTitle })).toBeTruthy()
    v.press(row(v, RAFA.displayName))
    await waitFor(() => expect(v.profile()).not.toBeNull())
    expect(v.queryByRole('dialog', { name: RAFA.displayName })).toBeNull()
  })

  it('§15 item 1: closed while the answers have not been read, even for an admin row', () => {
    const v = open({ abilities: 'unread' })
    const details = within(v.channelDetails()!)
    expect(details.queryByLabelText(copy.channel.name)).toBeNull()
    expect(details.queryByLabelText(copy.channel.topic)).toBeNull()
    expect(details.queryByRole('button', { name: copy.channel.addMember })).toBeNull()
    expect(details.queryByRole('button', { name: copy.channel.archiveTitle })).toBeNull()
  })

  it('ADR-115 dec. 2: the answers, not the own row, open the controls — a guest row with every answer manages', () => {
    const v = open({ members: ROSTER.map((m) => (m.self ? { ...m, role: 'guest' } : m)) })
    const details = within(v.channelDetails()!)
    expect(v.channelDetails()!.querySelector('div.channel-screen__row')!.textContent).toContain(copy.channel.roleGuest)
    expect(details.getByLabelText(copy.channel.name)).toBeTruthy()
    expect(details.getByRole('button', { name: copy.channel.archiveTitle })).toBeTruthy()
  })

  it('a member of a private channel who may only add sees "+ Adicionar" and nothing else', () => {
    const v = open({ members: asMember(ROSTER), abilities: { ...NO_ABILITIES, addPeople: true } })
    const details = within(v.channelDetails()!)
    expect(details.getByRole('button', { name: copy.channel.addMember })).toBeTruthy()
    expect(details.queryByLabelText(copy.channel.name)).toBeNull()
    expect(details.queryByRole('button', { name: copy.channel.archiveTitle })).toBeNull()
  })
})

// §15 item 2 (B3): the sheet opens if the session may change roles or remove; the pair only with setRoles (else
// the role as text), "Remover" only with removePeople; neither → the profile, no sheet.
describe("the person's sheet by the answers (§15 item 2)", () => {
  const combos: Array<[boolean, boolean]> = [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ]
  for (const [setRoles, removePeople] of combos)
    it(`setRoles ${setRoles}, removePeople ${removePeople}`, async () => {
      const v = open({ abilities: { ...ALL_ABILITIES, setRoles, removePeople } })
      v.press(row(v, RAFA.displayName))
      if (!setRoles && !removePeople) {
        await waitFor(() => expect(v.profile()).not.toBeNull())
        expect(v.queryByRole('dialog', { name: RAFA.displayName })).toBeNull()
        return
      }
      const s = personSheet(v, RAFA.displayName)
      expect(s.getByRole('button', { name: copy.channel.openProfile })).toBeTruthy()
      const pair = s.queryByRole('group', { name: fill(copy.channel.roleFor, { name: RAFA.displayName }) })
      expect(pair !== null).toBe(setRoles)
      if (!setRoles)
        expect(v.getByRole('dialog', { name: RAFA.displayName }).querySelector('.person-sheet__role .channel-management-panel__member-role')!.textContent).toBe(copy.channel.roleAdmin)
      expect(s.queryByRole('button', { name: copy.channel.remove }) !== null).toBe(removePeople)
    })
})
