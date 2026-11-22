// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { NewConversationDialog } from '../../src/ui/components/NewConversationDialog'
import { GROUP_MAX_OTHERS } from '../../src/acl'
import type { NewChannel, User, UserId } from '../../src/acl'
import { copy, fill } from '../support/copy'

// "Nova conversa" on a narrow window (manifest new-conversation.md §11; PLANO-MOBILE M6 N1): a full screen
// with the ✕ in its header and the focus on it, one button in a fixed footer and no "Cancelar", the people of
// the channel mode as the list with selection of the direct-message mode, and a chip that is all one button.

const uid = (s: string): UserId => s as unknown as UserId
const person = (n: string, name: string): User => ({ id: uid(`@p${n}:tayet.local`), displayName: name, kind: 'member' })
const carol = person('1', 'Carol Dias')
const dan = person('2', 'Dan Prado')
const agent: User = { id: uid('@a-agent:tayet.local'), displayName: 'Relatório diário', kind: 'agent', agentColor: 'argila' }
const many: User[] = Array.from({ length: 10 }, (_, i) => person(`m${i}`, `Pessoa ${String(i).padStart(2, '0')}`))

const noop = () => Promise.resolve()

function setup(
  over: {
    contacts?: User[]
    initialMode?: 'channel' | 'dm'
    onCreateChannel?: (input: NewChannel) => Promise<void>
    onOpenGroupConversation?: (users: UserId[]) => Promise<void>
    onClose?: () => void
  } = {},
) {
  return render(
    <NewConversationDialog
      onCreateChannel={over.onCreateChannel ?? noop}
      onOpenDirectMessage={noop}
      onOpenGroupConversation={over.onOpenGroupConversation ?? noop}
      loadKnownContacts={() => Promise.resolve(over.contacts ?? [carol, dan, agent])}
      onClose={over.onClose ?? (() => {})}
      initialMode={over.initialMode ?? 'channel'}
      narrow
    />,
  )
}

const screenOf = (r: ReturnType<typeof render>) => r.container.querySelector<HTMLElement>('.compose-screen')!
const rowOf = (r: ReturnType<typeof render>, name: string): HTMLButtonElement =>
  [...screenOf(r).querySelectorAll<HTMLButtonElement>('.compose-dialog__picker-option')].find(
    (b) => b.querySelector('.compose-dialog__option-name')?.textContent === name,
  )!

afterEach(cleanup)

describe('"Nova conversa" narrow (new-conversation.md §11)', () => {
  it('a screen, not a dialog: the ✕ and the title in the header, focus on the ✕ (N1), one button and no "Cancelar"', async () => {
    const r = setup()
    expect(r.container.querySelector('.ui-dialog')).toBeNull()
    const s = screenOf(r)
    const close = within(s).getByRole('button', { name: copy.newConversation.close })
    expect(document.activeElement).toBe(close)
    expect(within(s).getByRole('heading', { name: copy.newConversation.title })).toBeTruthy()
    expect(within(s).queryByRole('button', { name: copy.newConversation.cancel })).toBeNull()
    const footer = s.querySelector<HTMLElement>('.compose-screen__footer')!
    expect(footer.querySelectorAll('button')).toHaveLength(1)
    // "Criar canal" with the name empty: disabled by the Button's rule.
    expect((within(footer).getByRole('button', { name: copy.newConversation.createChannel }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('the ✕ and Esc close the screen', () => {
    const onClose = vi.fn()
    const r = setup({ onClose })
    fireEvent.click(within(screenOf(r)).getByRole('button', { name: copy.newConversation.close }))
    fireEvent.keyDown(screenOf(r), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('channel mode: name, description, visibility, then the people as the list with selection — no dashed suggestions, no limit', async () => {
    const onCreateChannel = vi.fn((_input: NewChannel) => Promise.resolve())
    const r = setup({ contacts: many, onCreateChannel })
    await waitFor(() => expect(rowOf(r, 'Pessoa 00')).toBeTruthy())
    const s = screenOf(r)
    expect(s.querySelector('.compose-dialog__suggest')).toBeNull()
    const order = [...s.querySelectorAll('#compose-name, #compose-topic, .compose-dialog__visibility, .compose-dialog__people')]
    expect(order.map((el) => el.id || el.className)).toEqual(['compose-name', 'compose-topic', 'compose-dialog__visibility', 'compose-dialog__people'])
    // Past GROUP_MAX_OTHERS: a channel takes them all.
    for (const u of many) fireEvent.click(rowOf(r, u.displayName))
    expect(many.length).toBeGreaterThan(GROUP_MAX_OTHERS)
    expect([...s.querySelectorAll('.compose-dialog__picker-option')].every((b) => !(b as HTMLButtonElement).disabled)).toBe(true)
    expect(s.querySelector('.compose-dialog__limit')).toBeNull()
    // The chips come before the filter.
    const people = s.querySelector('.compose-dialog__people')!
    expect(people.querySelector('.compose-dialog__chips')!.compareDocumentPosition(people.querySelector('.compose-dialog__filter')!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    fireEvent.change(s.querySelector('#compose-name')!, { target: { value: 'obra' } })
    fireEvent.click(within(s).getByRole('button', { name: copy.newConversation.createChannel }))
    await waitFor(() => expect(onCreateChannel).toHaveBeenCalledTimes(1))
    expect(onCreateChannel.mock.calls[0]?.[0].members).toHaveLength(many.length)
  })

  it('a chip is all one button that removes the person; its ✕ is decorative', async () => {
    const r = setup({ initialMode: 'dm' })
    await waitFor(() => expect(rowOf(r, 'Carol Dias')).toBeTruthy())
    fireEvent.click(rowOf(r, 'Carol Dias'))
    const chip = within(screenOf(r)).getByRole('button', { name: fill(copy.newConversation.removePerson, { name: 'Carol Dias' }) })
    expect(chip.classList.contains('compose-dialog__chip')).toBe(true)
    expect(chip.querySelector('.compose-dialog__chip-remove')!.getAttribute('aria-hidden')).toBe('true')
    expect(chip.querySelector('button')).toBeNull()
    fireEvent.click(chip)
    expect(rowOf(r, 'Carol Dias').getAttribute('aria-pressed')).toBe('false')
  })

  it('direct-message mode: the agent at the end, the limit line and the rows disabled at the limit', async () => {
    const onOpenGroupConversation = vi.fn(noop)
    const r = setup({ initialMode: 'dm', contacts: [...many, agent], onOpenGroupConversation })
    await waitFor(() => expect(rowOf(r, 'Pessoa 00')).toBeTruthy())
    expect(rowOf(r, agent.displayName).querySelector('.agent-avatar')).not.toBeNull()
    for (const u of many.slice(0, GROUP_MAX_OTHERS)) fireEvent.click(rowOf(r, u.displayName))
    const s = screenOf(r)
    expect(within(s).getByText(copy.group.limit)).toBeTruthy()
    expect(rowOf(r, 'Pessoa 09').disabled).toBe(true)
    fireEvent.click(within(s).getByRole('button', { name: copy.newConversation.startConversation }))
    await waitFor(() => expect(onOpenGroupConversation).toHaveBeenCalledTimes(1))
  })

  it('"Abrir conversa" is disabled without a pick; the filter with no match says so', async () => {
    const r = setup({ initialMode: 'dm' })
    await waitFor(() => expect(rowOf(r, 'Carol Dias')).toBeTruthy())
    const s = screenOf(r)
    expect((within(s).getByRole('button', { name: copy.newConversation.startConversation }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(within(s).getByRole('textbox', { name: copy.newConversation.filterPeople }), { target: { value: 'zzz' } })
    expect(within(s).getByText(fill(copy.people.noResults, { term: 'zzz' }))).toBeTruthy()
    fireEvent.click(within(s).getByRole('button', { name: copy.people.clearFilter }))
    expect(rowOf(r, 'Carol Dias')).toBeTruthy()
  })

  it('on a wide window the dialog is unchanged: the Dialog, "Cancelar" and the focus on the name', () => {
    const r = render(
      <NewConversationDialog
        onCreateChannel={noop}
        onOpenDirectMessage={noop}
        onOpenGroupConversation={noop}
        loadKnownContacts={() => Promise.resolve([carol])}
        onClose={() => {}}
      />,
    )
    expect(r.container.querySelector('.ui-dialog')).not.toBeNull()
    expect(r.container.querySelector('.compose-screen')).toBeNull()
    expect(r.getByRole('button', { name: copy.newConversation.cancel })).toBeTruthy()
    expect(document.activeElement?.id).toBe('compose-name')
  })
})
