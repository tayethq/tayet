// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { NewConversationDialog } from '../../src/ui/components/NewConversationDialog'
import type { NewChannel, User, UserId } from '../../src/acl'
import { copy } from '../support/copy'

// Behaviour of the compose dialog (Track U/U3, ADR-029). await-and-close: the verb's Promise is
// owned here — success closes the dialog, a rejection surfaces inline and the dialog STAYS open.

const uid = (s: string): UserId => s as unknown as UserId

const contacts: User[] = [
  { id: uid('@carol:tayet.local'), displayName: 'Carol Dias', kind: 'member' },
  { id: uid('@dan:tayet.local'), displayName: 'Dan Prado', kind: 'member' },
]

const noopVerb = () => Promise.resolve()

function setup(over: {
  onCreateChannel?: (input: NewChannel) => Promise<void>
  onOpenDirectMessage?: (user: UserId) => Promise<void>
  onClose?: () => void
}) {
  return render(
    <NewConversationDialog
      onCreateChannel={over.onCreateChannel ?? noopVerb}
      onOpenDirectMessage={over.onOpenDirectMessage ?? noopVerb}
      onOpenGroupConversation={noopVerb}
      loadKnownContacts={() => Promise.resolve(contacts)}
      onClose={over.onClose ?? (() => {})}
    />,
  )
}

afterEach(cleanup)

describe('NewConversationDialog — behaviour (Track U/U3)', () => {
  it('creates a channel with { name, kind, topic? } and closes on success', async () => {
    const onCreateChannel = vi.fn(async () => {})
    const onClose = vi.fn()
    const { getByRole, getByLabelText } = setup({ onCreateChannel, onClose })

    fireEvent.change(getByLabelText(copy.newConversation.name), { target: { value: '  launch  ' } })
    fireEvent.click(getByRole('button', { name: copy.newConversation.private }))
    fireEvent.change(getByLabelText(copy.newConversation.topic), { target: { value: ' ship it ' } })
    fireEvent.click(getByRole('button', { name: copy.newConversation.createChannel }))

    await waitFor(() =>
      expect(onCreateChannel).toHaveBeenCalledWith({ name: 'launch', kind: 'private', topic: 'ship it' }, expect.any(Function)),
    )
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('omits topic when blank; defaults kind to public', async () => {
    const onCreateChannel = vi.fn(async () => {})
    const { getByRole, getByLabelText } = setup({ onCreateChannel })

    fireEvent.change(getByLabelText(copy.newConversation.name), { target: { value: 'general' } })
    fireEvent.click(getByRole('button', { name: copy.newConversation.createChannel }))

    await waitFor(() => expect(onCreateChannel).toHaveBeenCalledWith({ name: 'general', kind: 'public' }, expect.any(Function)))
  })

  it('keeps the dialog open with an inline error when the verb rejects', async () => {
    const onCreateChannel = vi.fn(async () => {
      throw new Error('nope')
    })
    const onClose = vi.fn()
    const { getByRole, getByLabelText, findByRole } = setup({ onCreateChannel, onClose })

    fireEvent.change(getByLabelText(copy.newConversation.name), { target: { value: 'general' } })
    fireEvent.click(getByRole('button', { name: copy.newConversation.createChannel }))

    await findByRole('alert')
    expect(onClose).not.toHaveBeenCalled()
    // The dialog is still mounted.
    expect(getByRole('dialog', { name: copy.newConversation.title })).toBeTruthy()
  })

  it('opens a DM: loads contacts, selects one, calls onOpenDirectMessage with the id', async () => {
    const onOpenDirectMessage = vi.fn(async () => {})
    const onClose = vi.fn()
    const { getByRole, findByText } = setup({ onOpenDirectMessage, onClose })

    // Switch to DM mode → the contacts loaded on open fill the picker.
    fireEvent.click(getByRole('button', { name: copy.newConversation.dm }))
    await findByText('Carol Dias')

    // Submit is gated until a contact is picked.
    const submit = getByRole('button', { name: copy.newConversation.startConversation }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    fireEvent.click(getByRole('button', { name: /Carol Dias/ }))
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)

    await waitFor(() => expect(onOpenDirectMessage).toHaveBeenCalledWith(uid('@carol:tayet.local'), expect.any(Function)))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('Esc closes the dialog', () => {
    const onClose = vi.fn()
    const { getByRole } = setup({ onClose })
    fireEvent.keyDown(getByRole('dialog', { name: copy.newConversation.title }), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('opens in DM mode when seeded with initialMode="dm" (the "+" intent seed)', async () => {
    const { findByText, queryByLabelText } = render(
      <NewConversationDialog
        onCreateChannel={noopVerb}
        onOpenDirectMessage={noopVerb}
        onOpenGroupConversation={noopVerb}
        loadKnownContacts={() => Promise.resolve(contacts)}
        onClose={() => {}}
        initialMode="dm"
      />,
    )
    // DM mode is active from the start: the contact picker loads, the channel "Name" field is absent.
    await findByText('Carol Dias')
    expect(queryByLabelText(copy.newConversation.name)).toBeNull()
  })
})
