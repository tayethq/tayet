// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { NewConversationDialog } from '../../src/ui/components/NewConversationDialog'
import type { NewChannel, User, UserId } from '../../src/acl'
import { copy, fill } from '../support/copy'

// Manifest new-conversation.md §9 on screen: the channel-mode order, the `#` inside the name box, the
// visibility row, the hugging rails and the people chips over the known set.

const uid = (s: string): UserId => s as unknown as UserId

const carol: User = { id: uid('@carol:tayet.local'), displayName: 'Carol Dias', kind: 'member' }
const dan: User = { id: uid('@dan:tayet.local'), displayName: 'Dan Prado', kind: 'member' }

const noopVerb = () => Promise.resolve()

const setup = (
  over: {
    loadKnownContacts?: () => Promise<User[]>
    onCreateChannel?: (input: NewChannel) => Promise<void>
  } = {},
) =>
  render(
    <NewConversationDialog
      onCreateChannel={over.onCreateChannel ?? noopVerb}
      onOpenDirectMessage={noopVerb}
      onOpenGroupConversation={noopVerb}
      loadKnownContacts={over.loadKnownContacts ?? (() => Promise.resolve([carol, dan]))}
      onClose={() => {}}
    />,
  )

const suggest = (name: string) => fill(copy.newConversation.suggestPerson, { name })
const remove = (name: string) => fill(copy.newConversation.removePerson, { name })

afterEach(cleanup)

const css = readFileSync(resolve(__dirname, '../../src/ui/styles.css'), 'utf8')

const rule = (selector: string): string => {
  const start = css.indexOf(`\n${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start))
}

describe('NewConversationDialog — fidelity (new-conversation.md §9)', () => {
  it('orders channel mode as name, description, visibility, people', () => {
    const { getByLabelText, getByText } = setup()
    const order = [
      getByLabelText(copy.newConversation.name),
      getByLabelText(copy.newConversation.topic),
      getByText(copy.newConversation.visibility),
      getByText(copy.newConversation.addPeople, { exact: false }),
    ]
    order.slice(1).forEach((node, i) => {
      expect(order[i]!.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
  })

  it('labels the input inside the name box, next to an aria-hidden #', () => {
    const { getByLabelText } = setup()
    const input = getByLabelText(copy.newConversation.name)
    expect(input.tagName).toBe('INPUT')
    const box = input.closest('.compose-dialog__name')
    expect(box).not.toBeNull()
    const mark = box!.querySelector('.compose-dialog__name-mark')
    expect(mark?.textContent).toBe('#')
    expect(mark?.getAttribute('aria-hidden')).toBe('true')
  })

  it('gives the description its placeholder', () => {
    const { getByLabelText } = setup()
    expect(getByLabelText(copy.newConversation.topic).getAttribute('placeholder')).toBe(
      copy.newConversation.topicPlaceholder,
    )
  })

  it('keeps both rails hugging, and visibility in one row with its label', () => {
    const { container, getByRole } = setup()
    expect(container.querySelector('.ui-segmented--fill')).toBeNull()
    const row = container.querySelector('.compose-dialog__visibility')
    expect(row?.textContent).toContain(copy.newConversation.visibility)
    expect(row?.contains(getByRole('group', { name: copy.newConversation.visibilityLabel }))).toBe(true)
    expect(container.querySelector('.compose-dialog__mode .ui-segmented')).not.toBeNull()
  })

  it('loads the known set on open in channel mode and suggests it', async () => {
    const loadKnownContacts = vi.fn(() => Promise.resolve([carol, dan]))
    const { findByRole, getByRole } = setup({ loadKnownContacts })
    await findByRole('button', { name: suggest('Carol Dias') })
    expect(getByRole('button', { name: suggest('Dan Prado') })).toBeTruthy()
    expect(loadKnownContacts).toHaveBeenCalledTimes(1)
  })

  it('turns a suggestion into a chip and the ✕ back into a suggestion', async () => {
    const { findByRole, getByRole, queryByRole } = setup()
    fireEvent.click(await findByRole('button', { name: suggest('Carol Dias') }))
    expect(getByRole('button', { name: remove('Carol Dias') })).toBeTruthy()
    expect(queryByRole('button', { name: suggest('Carol Dias') })).toBeNull()

    fireEvent.click(getByRole('button', { name: remove('Carol Dias') }))
    expect(getByRole('button', { name: suggest('Carol Dias') })).toBeTruthy()
    expect(queryByRole('button', { name: remove('Carol Dias') })).toBeNull()
  })

  it('sends the selected people as members, and no key without them', async () => {
    const onCreateChannel = vi.fn(async () => {})
    const first = setup({ onCreateChannel })
    fireEvent.change(first.getByLabelText(copy.newConversation.name), { target: { value: 'launch' } })
    fireEvent.click(await first.findByRole('button', { name: suggest('Carol Dias') }))
    fireEvent.click(first.getByRole('button', { name: suggest('Dan Prado') }))
    fireEvent.click(first.getByRole('button', { name: copy.newConversation.createChannel }))
    await waitFor(() =>
      expect(onCreateChannel).toHaveBeenCalledWith({ name: 'launch', kind: 'public', members: [carol.id, dan.id] }),
    )
    cleanup()

    onCreateChannel.mockClear()
    const second = setup({ onCreateChannel })
    fireEvent.change(second.getByLabelText(copy.newConversation.name), { target: { value: 'launch' } })
    await second.findByRole('button', { name: suggest('Carol Dias') })
    fireEvent.click(second.getByRole('button', { name: copy.newConversation.createChannel }))
    await waitFor(() => expect(onCreateChannel).toHaveBeenCalledWith({ name: 'launch', kind: 'public' }))
  })

  it('reads a load failure as muted text, not an alert, and keeps the CTA live', async () => {
    const { findByText, getByLabelText, getByRole, queryByRole } = setup({
      loadKnownContacts: () => Promise.reject(new Error('nope')),
    })
    const failure = await findByText(copy.newConversation.contactsFailed)
    expect(failure.className).toBe('compose-dialog__picker-empty')
    expect(queryByRole('alert')).toBeNull()
    fireEvent.change(getByLabelText(copy.newConversation.name), { target: { value: 'launch' } })
    const cta = getByRole('button', { name: copy.newConversation.createChannel }) as HTMLButtonElement
    expect(cta.disabled).toBe(false)
  })

  it('renders no protocol id with people selected (P1)', async () => {
    const { container, findByRole, getByRole } = setup()
    fireEvent.click(await findByRole('button', { name: suggest('Carol Dias') }))
    fireEvent.click(getByRole('button', { name: suggest('Dan Prado') }))
    expect(container.textContent).not.toMatch(/@\S+:\S+/)
  })

  it('draws the footer border and the 18 monogram in the stylesheet', () => {
    expect(rule('.ui-dialog.compose-dialog .ui-dialog__footer')).toContain('border-top: 1px solid var(--color-border)')
    expect(rule('.compose-dialog__chip-mark')).toContain('width: 18px')
  })

  it('caps the shell at the viewport and scrolls only the body', () => {
    expect(rule('.ui-dialog.compose-dialog')).toContain('max-height: calc(100vh - var(--space-16) * 2)')
    expect(rule('.compose-dialog__fields')).toContain('overflow-y: auto')
  })

  it('hugs the type rail to its content', () => {
    expect(rule('.compose-dialog__mode .ui-segmented')).toContain('width: fit-content')
  })
})
