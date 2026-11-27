// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { NewConversationDialog } from '../../src/ui/components/NewConversationDialog'
import { GROUP_MAX_OTHERS } from '../../src/acl'
import type { NewChannel, User, UserId } from '../../src/acl'
import { copy, fill } from '../support/copy'

// Manifest new-conversation.md §10 (ADR-094 dec. 7, 8, 11): the direct-message mode is a multi-select.
// One pick opens the DM, two or more the group (ids in the order picked); at GROUP_MAX_OTHERS the rest
// disable and the limit line shows; the session's own agent is offered like a person and counts.
// Plus the local filter (§9 items 10–11) and the DM list's header (§10.2, owner adjudication 12/Nov).

const uid = (s: string): UserId => s as unknown as UserId

const person = (n: string, name: string): User => ({ id: uid(`@p${n}:tayet.local`), displayName: name, kind: 'member' })
const carol = person('1', 'Carol Dias')
const dan = person('2', 'Dan Prado')
const ema = person('3', 'Éma Luz')
const agent: User = { id: uid('@a-agent:tayet.local'), displayName: 'Relatório diário', kind: 'agent', agentColor: 'argila' }
const many: User[] = Array.from({ length: 10 }, (_, i) => person(`m${i}`, `Pessoa ${String(i).padStart(2, '0')}`))

const noopVerb = () => Promise.resolve()

function setup(
  over: {
    contacts?: User[]
    onOpenDirectMessage?: (user: UserId) => Promise<void>
    onOpenGroupConversation?: (users: UserId[]) => Promise<void>
    onCreateChannel?: (input: NewChannel) => Promise<void>
    onClose?: () => void
    initialMode?: 'channel' | 'dm'
  } = {},
) {
  return render(
    <NewConversationDialog
      onCreateChannel={over.onCreateChannel ?? noopVerb}
      onOpenDirectMessage={over.onOpenDirectMessage ?? noopVerb}
      onOpenGroupConversation={over.onOpenGroupConversation ?? noopVerb}
      loadKnownContacts={() => Promise.resolve(over.contacts ?? [carol, dan, ema, agent])}
      onClose={over.onClose ?? (() => {})}
      initialMode={over.initialMode ?? 'dm'}
    />,
  )
}

const rows = (r: ReturnType<typeof render>) =>
  r.getByRole('list', { name: copy.newConversation.to }).querySelectorAll('button')
const rowOf = (r: ReturnType<typeof render>, name: string): HTMLButtonElement =>
  [...rows(r)].find((b) => b.querySelector('.compose-dialog__option-name')?.textContent === name) as HTMLButtonElement
const chipRemove = (name: string) => fill(copy.newConversation.removePerson, { name })
const chipNames = (r: ReturnType<typeof render>) =>
  [...r.container.querySelectorAll('.compose-dialog__dm-chips .compose-dialog__chip-remove')].map((b) => b.getAttribute('aria-label'))
const cta = (r: ReturnType<typeof render>) =>
  r.getByRole('button', { name: copy.newConversation.startConversation }) as HTMLButtonElement

afterEach(cleanup)

describe('NewConversationDialog — group multi-select (new-conversation.md §10)', () => {
  it('toggles a pick by the row and by the chip ✕; chips in the order picked; aria-pressed', async () => {
    const r = setup()
    await r.findByText('Carol Dias')
    expect(r.container.querySelector('.compose-dialog__dm-chips')).toBeNull()

    fireEvent.click(rowOf(r, 'Dan Prado'))
    fireEvent.click(rowOf(r, 'Carol Dias'))
    expect(rowOf(r, 'Dan Prado').getAttribute('aria-pressed')).toBe('true')
    expect(rowOf(r, 'Carol Dias').getAttribute('aria-pressed')).toBe('true')
    expect(rowOf(r, 'Éma Luz').getAttribute('aria-pressed')).toBe('false')
    expect(chipNames(r)).toEqual([chipRemove('Dan Prado'), chipRemove('Carol Dias')])
    expect(rowOf(r, 'Dan Prado').querySelector('.compose-dialog__check')?.getAttribute('aria-hidden')).toBe('true')

    fireEvent.click(rowOf(r, 'Dan Prado'))
    expect(rowOf(r, 'Dan Prado').getAttribute('aria-pressed')).toBe('false')
    expect(rowOf(r, 'Dan Prado').querySelector('.compose-dialog__check')).toBeNull()
    expect(chipNames(r)).toEqual([chipRemove('Carol Dias')])

    fireEvent.click(r.getByRole('button', { name: chipRemove('Carol Dias') }))
    expect(rowOf(r, 'Carol Dias').getAttribute('aria-pressed')).toBe('false')
    expect(r.container.querySelector('.compose-dialog__dm-chips')).toBeNull()
  })

  it('one pick opens the direct message; two open the group with the ids in the order picked', async () => {
    const onOpenDirectMessage = vi.fn(async () => {})
    const onOpenGroupConversation = vi.fn(async () => {})
    const onClose = vi.fn()
    const first = setup({ onOpenDirectMessage, onOpenGroupConversation, onClose })
    await first.findByText('Carol Dias')
    expect(cta(first).disabled).toBe(true)
    fireEvent.click(rowOf(first, 'Carol Dias'))
    expect(cta(first).disabled).toBe(false)
    fireEvent.click(cta(first))
    await waitFor(() => expect(onOpenDirectMessage).toHaveBeenCalledWith(carol.id, expect.any(Function)))
    expect(onOpenGroupConversation).not.toHaveBeenCalled()
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    cleanup()

    onOpenDirectMessage.mockClear()
    const second = setup({ onOpenDirectMessage, onOpenGroupConversation })
    await second.findByText('Carol Dias')
    fireEvent.click(rowOf(second, 'Éma Luz'))
    fireEvent.click(rowOf(second, 'Carol Dias'))
    fireEvent.click(cta(second))
    await waitFor(() => expect(onOpenGroupConversation).toHaveBeenCalledWith([ema.id, carol.id], expect.any(Function)))
    expect(onOpenDirectMessage).not.toHaveBeenCalled()
  })

  it(`at ${GROUP_MAX_OTHERS} picks the rest disable and the limit line shows; undoing one re-enables`, async () => {
    const r = setup({ contacts: many })
    await r.findByText('Pessoa 00')
    expect(r.queryByText(copy.group.limit)).toBeNull()
    for (const u of many.slice(0, GROUP_MAX_OTHERS - 1)) fireEvent.click(rowOf(r, u.displayName))
    expect(r.queryByText(copy.group.limit)).toBeNull() // no counter before the limit
    expect(rowOf(r, 'Pessoa 09').disabled).toBe(false)
    fireEvent.click(rowOf(r, many[GROUP_MAX_OTHERS - 1]!.displayName))

    expect(r.getByText(copy.group.limit)).toBeTruthy()
    for (const u of many.slice(GROUP_MAX_OTHERS)) expect(rowOf(r, u.displayName).disabled).toBe(true)
    for (const u of many.slice(0, GROUP_MAX_OTHERS)) expect(rowOf(r, u.displayName).disabled).toBe(false)
    // The limit line sits under the "Sua equipe" header, before the rows.
    const header = r.getByRole('heading', { name: copy.newConversation.to })
    const limit = r.getByText(copy.group.limit)
    expect(header.compareDocumentPosition(limit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(limit.compareDocumentPosition(rowOf(r, 'Pessoa 00')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(r.getByRole('button', { name: chipRemove('Pessoa 03') }))
    expect(r.queryByText(copy.group.limit)).toBeNull()
    for (const u of many) expect(rowOf(r, u.displayName).disabled).toBe(false)
  })

  it('the own agent is pickable with people, counts toward the limit, and its chip carries the AgentAvatar', async () => {
    const onOpenGroupConversation = vi.fn(async () => {})
    const r = setup({ contacts: [agent, ...many], onOpenGroupConversation })
    await r.findByText('Relatório diário')
    fireEvent.click(rowOf(r, 'Relatório diário'))
    const chip = r.getByRole('button', { name: chipRemove('Relatório diário') }).closest('.compose-dialog__chip')!
    expect(chip.querySelector('[data-agent-avatar]')).not.toBeNull()
    expect(chip.querySelector('.compose-dialog__chip-mark')).toBeNull()
    expect(chip.textContent).toContain('Relatório diário') // the whole name
    for (const u of many.slice(0, GROUP_MAX_OTHERS - 1)) fireEvent.click(rowOf(r, u.displayName))
    expect(r.getByText(copy.group.limit)).toBeTruthy() // agent + 7 people = 8
    expect(rowOf(r, many[GROUP_MAX_OTHERS - 1]!.displayName).disabled).toBe(true)
    fireEvent.click(cta(r))
    await waitFor(() =>
      expect(onOpenGroupConversation).toHaveBeenCalledWith([agent.id, ...many.slice(0, GROUP_MAX_OTHERS - 1).map((u) => u.id)], expect.any(Function)),
    )
  })

  it('the filter narrows the rows, not the chips; no match reads "Ninguém encontrado"', async () => {
    const r = setup()
    await r.findByText('Carol Dias')
    fireEvent.click(rowOf(r, 'Carol Dias'))
    const field = r.getByRole('textbox', { name: copy.newConversation.filterPeople })
    expect(field.getAttribute('placeholder')).toBe(copy.newConversation.filterPeople)

    fireEvent.change(field, { target: { value: 'ema' } }) // no accent, no case
    expect(rowOf(r, 'Éma Luz')).toBeTruthy()
    expect(rowOf(r, 'Carol Dias')).toBeUndefined()
    expect(r.getByRole('button', { name: chipRemove('Carol Dias') })).toBeTruthy()

    fireEvent.change(field, { target: { value: 'zzz' } })
    expect(r.getByText(fill(copy.people.noResults, { term: 'zzz' }))).toBeTruthy()
    expect(r.queryByRole('list', { name: copy.newConversation.to })).toBeNull()
    expect(r.getByRole('button', { name: chipRemove('Carol Dias') })).toBeTruthy()

    fireEvent.click(r.getByRole('button', { name: copy.people.clearFilter }))
    expect((field as HTMLInputElement).value).toBe('')
    expect(rowOf(r, 'Dan Prado')).toBeTruthy()
  })

  it('a rejected verb keeps the dialog open, the pick intact, and shows the inline error', async () => {
    const onOpenGroupConversation = vi.fn(async () => {
      throw new Error('nope')
    })
    const onClose = vi.fn()
    const r = setup({ onOpenGroupConversation, onClose })
    await r.findByText('Carol Dias')
    fireEvent.click(rowOf(r, 'Carol Dias'))
    fireEvent.click(rowOf(r, 'Dan Prado'))
    fireEvent.click(cta(r))
    expect((await r.findByRole('alert')).textContent).toBe(copy.newConversation.failed)
    expect(onClose).not.toHaveBeenCalled()
    expect(r.getByRole('dialog', { name: copy.newConversation.title })).toBeTruthy()
    expect(chipNames(r)).toEqual([chipRemove('Carol Dias'), chipRemove('Dan Prado')])
    expect(rowOf(r, 'Carol Dias').getAttribute('aria-pressed')).toBe('true')
    expect(cta(r).disabled).toBe(false)
  })

  it('switching modes never mixes the two picks', async () => {
    const onCreateChannel = vi.fn(async () => {})
    const onOpenGroupConversation = vi.fn(async () => {})
    const r = setup({ onCreateChannel, onOpenGroupConversation, initialMode: 'channel' })
    fireEvent.click(await r.findByRole('button', { name: fill(copy.newConversation.suggestPerson, { name: 'Éma Luz' }) }))

    fireEvent.click(r.getByRole('button', { name: copy.newConversation.dm }))
    await r.findByText('Carol Dias')
    expect(r.container.querySelector('.compose-dialog__dm-chips')).toBeNull()
    expect(rowOf(r, 'Éma Luz').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(rowOf(r, 'Carol Dias'))
    fireEvent.click(rowOf(r, 'Dan Prado'))

    fireEvent.click(r.getByRole('button', { name: copy.newConversation.channel }))
    expect(r.queryByRole('button', { name: chipRemove('Carol Dias') })).toBeNull()
    expect(r.getByRole('button', { name: chipRemove('Éma Luz') })).toBeTruthy()
    fireEvent.change(r.getByLabelText(copy.newConversation.name), { target: { value: 'launch' } })
    fireEvent.click(r.getByRole('button', { name: copy.newConversation.createChannel }))
    await waitFor(() => expect(onCreateChannel).toHaveBeenCalledWith({ name: 'launch', kind: 'public', members: [ema.id] }, expect.any(Function)))
    expect(onOpenGroupConversation).not.toHaveBeenCalled()
  })

  it('channel mode: the filter narrows the suggestions, keeps the chips, and reads "Ninguém encontrado"', async () => {
    const r = setup({ initialMode: 'channel' })
    fireEvent.click(await r.findByRole('button', { name: fill(copy.newConversation.suggestPerson, { name: 'Carol Dias' }) }))
    const field = r.getByRole('textbox', { name: copy.newConversation.filterPeople })
    fireEvent.change(field, { target: { value: 'DAN' } })
    expect(r.getByRole('button', { name: fill(copy.newConversation.suggestPerson, { name: 'Dan Prado' }) })).toBeTruthy()
    expect(r.queryByRole('button', { name: fill(copy.newConversation.suggestPerson, { name: 'Éma Luz' }) })).toBeNull()
    expect(r.getByRole('button', { name: chipRemove('Carol Dias') })).toBeTruthy()
    fireEvent.change(field, { target: { value: 'zzz' } })
    expect(r.getByText(fill(copy.people.noResults, { term: 'zzz' }))).toBeTruthy()
    // Enter in the filter never submits the form.
    fireEvent.change(r.getByLabelText(copy.newConversation.name), { target: { value: 'x' } })
    expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(false)
  })

  it('renders no protocol id with a group picked (P1)', async () => {
    const r = setup()
    await r.findByText('Carol Dias')
    fireEvent.click(rowOf(r, 'Carol Dias'))
    fireEvent.click(rowOf(r, 'Relatório diário'))
    expect(r.container.innerHTML).not.toMatch(/@\S+:\S+/)
    for (const el of r.container.querySelectorAll('[title], [aria-label]')) {
      expect(`${el.getAttribute('title') ?? ''} ${el.getAttribute('aria-label') ?? ''}`).not.toMatch(/@|tayet\.local/)
    }
    within(r.getByRole('dialog')).getByRole('heading', { name: copy.newConversation.to })
  })
})

const css = readFileSync(resolve(__dirname, '../../src/ui/styles.css'), 'utf8')
// The LAST rule of a selector: "Sua equipe" shares the section-title rule and adds its padding after.
const rule = (selector: string): string => {
  const start = css.lastIndexOf(`\n${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start))
}

describe('NewConversationDialog — group stylesheet (new-conversation.md §10.2)', () => {
  it('the selected, hovered and disabled rows', () => {
    expect(rule(".compose-dialog__picker-option[aria-pressed='true']")).toContain('background: var(--color-accent-wash)')
    expect(rule(".compose-dialog__picker-option:hover:not(:disabled):not([aria-pressed='true'])")).toContain(
      'background: var(--color-bg)',
    )
    expect(rule('.compose-dialog__picker-option:disabled')).toContain('opacity: 0.45')
    expect(rule('.compose-dialog__check')).toContain('width: 14px')
  })

  it('the DM list body, header, chip strip and limit line', () => {
    expect(rule('.compose-dialog__fields--dm')).toContain('padding: var(--space-8) var(--space-8) var(--space-8)')
    expect(rule('.compose-dialog__team-title')).toContain('padding: var(--space-8) var(--space-12) var(--space-4)')
    expect(css).toContain('.channel-list__section-title,\n.compose-dialog__team-title {')
    expect(rule('.compose-dialog__dm-chips')).toContain('padding: var(--space-4) var(--space-8) var(--space-8)')
    expect(rule('.compose-dialog__limit')).toContain('padding: 2px var(--space-12) var(--space-8)')
    expect(rule('.compose-dialog__chip > .agent-avatar > .agent-avatar__box')).toContain('width: 18px')
  })
})
