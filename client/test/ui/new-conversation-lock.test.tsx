// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react'
import { NewConversationDialog, SUBMIT_LOCK_MS } from '../../src/ui/components/NewConversationDialog'
import { Workspace } from '../../src/ui/components/Workspace'
import { StackProvider, type HistoryEnv, type StackHistoryState } from '../../src/ui/stack'
import { useState } from 'react'
import { useChat } from '../../src/ui/useChat'
import type { Acl, Channel, ChannelId, DomainEvent, User, UserId } from '../../src/acl'
import { copy } from '../support/copy'

// PLANO-MOBILE M6 N2 with T1: while a verb of "Nova conversa" is in flight, no path closes the surface, for at
// most SUBMIT_LOCK_MS; past the cap every path closes again and the verb keeps running. Both widths.

const uid = (s: string): UserId => s as unknown as UserId
const carol: User = { id: uid('@carol:tayet.local'), displayName: 'Carol Dias', kind: 'member' }
const dave: User = { id: uid('@dave:tayet.local'), displayName: 'Dave Lima', kind: 'member' }

function deferred() {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

async function sending(narrow: boolean) {
  const verb = deferred()
  const onClose = vi.fn()
  const r = render(
    <NewConversationDialog
      onCreateChannel={() => Promise.resolve()}
      onOpenDirectMessage={() => verb.promise}
      onOpenGroupConversation={() => Promise.resolve()}
      loadKnownContacts={() => Promise.resolve([carol])}
      onClose={onClose}
      initialMode="dm"
      narrow={narrow}
    />,
  )
  const row = await r.findByRole('button', { name: 'Carol Dias' })
  vi.useFakeTimers()
  fireEvent.click(row)
  fireEvent.click(r.getByRole('button', { name: copy.newConversation.startConversation }))
  const surface = r.container.querySelector<HTMLElement>(narrow ? '.compose-screen' : '.ui-dialog')!
  const close = within(surface).getByRole('button', { name: copy.newConversation.close }) as HTMLButtonElement
  return { r, verb, onClose, surface, close }
}

describe.each([
  ['narrow', true],
  ['wide', false],
])('the send lock, %s', (_label, narrow) => {
  it('before the cap no path closes; past it every path closes, and the action stays sending', async () => {
    const { r, onClose, surface, close } = await sending(narrow)
    expect(close.disabled).toBe(true)
    fireEvent.keyDown(surface, { key: 'Escape' })
    fireEvent.click(close)
    expect(onClose).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(SUBMIT_LOCK_MS - 1))
    expect(close.disabled).toBe(true)
    act(() => void vi.advanceTimersByTime(1))
    expect(close.disabled).toBe(false)
    expect(r.getByRole('button', { name: copy.newConversation.opening })).toBeTruthy()
    fireEvent.keyDown(surface, { key: 'Escape' })
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('a verb that settles before the cap unlocks at once: success closes, failure opens the paths again', async () => {
    const ok = await sending(narrow)
    await act(async () => ok.verb.resolve())
    expect(ok.onClose).toHaveBeenCalledTimes(1)
    cleanup()
    vi.useRealTimers()
    const ko = await sending(narrow)
    await act(async () => ko.verb.reject(new Error('refused')))
    expect(ko.close.disabled).toBe(false)
    expect(ko.r.getByRole('alert').textContent).toBe(copy.newConversation.failed)
    fireEvent.click(ko.close)
    expect(ko.onClose).toHaveBeenCalledTimes(1)
  })

  it('closed past the cap: a late success does not close again, a late failure leaves no console error', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const late = await sending(narrow)
    act(() => void vi.advanceTimersByTime(SUBMIT_LOCK_MS))
    fireEvent.click(late.close)
    expect(late.onClose).toHaveBeenCalledTimes(1)
    late.r.unmount()
    await act(async () => late.verb.resolve())
    expect(late.onClose).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
    const lateFail = await sending(narrow)
    act(() => void vi.advanceTimersByTime(SUBMIT_LOCK_MS))
    fireEvent.click(lateFail.close)
    lateFail.r.unmount()
    await act(async () => lateFail.verb.reject(new Error('refused')))
    expect(lateFail.onClose).toHaveBeenCalledTimes(1)
    expect(errors).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

// The system's back on the narrow screen goes through the stack: refused while the lock holds, back past the cap.
function fakeHistory() {
  const entries: unknown[] = [null]
  let index = 0
  const listeners = new Set<(s: unknown) => void>()
  const env: HistoryEnv = {
    state: () => entries[index],
    push: (s: StackHistoryState) => {
      entries.splice(index + 1)
      entries.push(s)
      index = entries.length - 1
    },
    go: (d) => {
      index = Math.max(0, index + d)
      queueMicrotask(() => listeners.forEach((fn) => fn(entries[index])))
    },
    back: () => env.go(-1),
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
  const press = () =>
    act(async () => {
      index = Math.max(0, index - 1)
      listeners.forEach((fn) => fn(entries[index]))
    })
  return { env, press, depth: () => index }
}

describe('the send lock and the system back (narrow)', () => {
  it('the back is refused while the lock holds, the entry comes back; past the cap the back closes', async () => {
    const h = fakeHistory()
    const verb = deferred()
    const channels: Channel[] = [
      { id: '!a:tayet.local' as unknown as ChannelId, name: '#all', kind: 'public', memberCount: 1, unread: { count: 0, mentions: 0 } },
    ]
    const r = render(
      <StackProvider env={h.env}>
        <Workspace
          narrow
          channels={channels}
          messages={[]}
          usersById={{}}
          connection="connected"
          onSelectChannel={() => {}}
          onSend={() => {}}
          onCreateChannel={() => Promise.resolve()}
          onOpenDirectMessage={() => verb.promise}
          onOpenGroupConversation={() => Promise.resolve()}
          loadKnownContacts={() => Promise.resolve([carol])}
        />
      </StackProvider>,
    )
    await waitFor(() => expect(r.container.querySelector('.sidebar__compose')).not.toBeNull())
    fireEvent.click(r.container.querySelector('.sidebar__compose')!)
    await waitFor(() => expect(h.depth()).toBe(1))
    fireEvent.click(within(r.container.querySelector('.compose-screen')!).getByRole('button', { name: copy.newConversation.dm }))
    fireEvent.click(await r.findByRole('button', { name: 'Carol Dias' }))
    vi.useFakeTimers()
    fireEvent.click(r.getByRole('button', { name: copy.newConversation.startConversation }))
    await h.press()
    expect(r.container.querySelector('.compose-screen')).not.toBeNull()
    expect(h.depth()).toBe(1)
    act(() => void vi.advanceTimersByTime(SUBMIT_LOCK_MS))
    await h.press()
    expect(r.container.querySelector('.compose-screen')).toBeNull()
    expect(h.depth()).toBe(0)
  })
})

// Issue #421, lote "Nova conversa" (F4; manifest new-conversation.md §14): on the wide screen "Cancelar" follows the
// lock like Esc and the ×. Past the cap it closes; the verb keeps running and the action stays sending.
describe('"Cancelar" on the wide screen follows the lock', () => {
  it('disabled before the cap; past it, it closes', async () => {
    const { r, onClose } = await sending(false)
    const cancel = r.getByRole('button', { name: copy.newConversation.cancel }) as HTMLButtonElement
    expect(cancel.disabled).toBe(true)
    fireEvent.click(cancel)
    act(() => void vi.advanceTimersByTime(SUBMIT_LOCK_MS - 1))
    expect(cancel.disabled).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(1))
    expect(cancel.disabled).toBe(false)
    expect(r.getByRole('button', { name: copy.newConversation.opening })).toBeTruthy()
    fireEvent.click(cancel)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// F4: a verb that succeeds after the person closed past the cap puts the conversation in the list (channel.added)
// and leaves the selection where the person is. The three verbs, through useChat as App wires them; for the direct
// message also the immediate path (the conversation already in the list, no channel.added).
const cidOf = (s: string): ChannelId => s as unknown as ChannelId
const HERE = cidOf('!here:tayet.local')
const KNOWN_DM = cidOf('!knowndm:tayet.local')
const NEW_ROOM = cidOf('!new:tayet.local')
const listed = (id: ChannelId, name: string, kind: Channel['kind']): Channel => ({
  id,
  name,
  kind,
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
})

function chatAcl(verbs: { create: Promise<ChannelId>; dm: Promise<ChannelId>; group: Promise<ChannelId> }) {
  const stream: { emit?: (e: DomainEvent) => void } = {}
  const acl = {
    getChannels: async () => [listed(HERE, '#here', 'public'), listed(KNOWN_DM, 'Carol Dias', 'dm')],
    getArchivedChannels: async () => [],
    getChannel: async () => undefined,
    getMembers: async () => [],
    getDevices: async () => [],
    currentUser: async () => ({ id: uid('@me:tayet.local'), displayName: 'Me' }),
    getThreadUnread: async () => ({ unread: false }),
    getTimeline: async () => ({ items: [] }),
    listPanels: async () => [],
    listCommands: async () => [],
    listOwnAgents: () => [],
    getPresence: () => 'offline' as const,
    getConnectionState: () => 'connected' as const,
    getChannelAbilities: () => ({ rename: false, editTopic: false, addPeople: false, removePeople: false, setRoles: false, archive: false }),
    subscribe: (handler: (e: DomainEvent) => void) => {
      stream.emit = handler
      return () => {}
    },
    subscribeChannel: () => () => {},
    markRead: async () => {},
    acknowledgeAccess: () => {},
    isOrgAdmin: async () => false,
    createChannel: () => verbs.create,
    openDirectMessage: () => verbs.dm,
    openGroupConversation: () => verbs.group,
  } as unknown as Acl
  return { acl, stream }
}

function ChatWithDialog({ acl, mode }: { acl: Acl; mode: 'channel' | 'dm' }) {
  const chat = useChat(acl)
  const [open, setOpen] = useState(true)
  return (
    <>
      <output data-testid="selected">{String(chat.selectedId ?? '')}</output>
      <output data-testid="listed">{chat.channels.map((c) => String(c.id)).join(' ')}</output>
      {open && (
        <NewConversationDialog
          onCreateChannel={chat.createChannel}
          onOpenDirectMessage={chat.openDirectMessage}
          onOpenGroupConversation={chat.openGroupConversation}
          loadKnownContacts={() => Promise.resolve([carol, dave])}
          onClose={() => setOpen(false)}
          initialMode={mode}
        />
      )}
    </>
  )
}

describe('a late success after closing past the cap does not take the selection', () => {
  it.each([
    ['createChannel', 'create', NEW_ROOM],
    ['openDirectMessage, a new conversation', 'dm', NEW_ROOM],
    ['openDirectMessage, a conversation already in the list', 'dm', KNOWN_DM],
    ['openGroupConversation', 'group', NEW_ROOM],
  ] as const)('%s', async (_label, verb, returned) => {
    const settle = { create: deferred(), dm: deferred(), group: deferred() }
    let answer: ChannelId = returned
    const promised = (d: ReturnType<typeof deferred>) => d.promise.then(() => answer)
    const { acl, stream } = chatAcl({ create: promised(settle.create), dm: promised(settle.dm), group: promised(settle.group) })
    const r = render(<ChatWithDialog acl={acl} mode={verb === 'create' ? 'channel' : 'dm'} />)
    await waitFor(() => expect(r.getByTestId('selected').textContent).toBe(String(HERE)))
    if (verb === 'create') {
      fireEvent.change(r.getByLabelText(copy.newConversation.name), { target: { value: 'novo' } })
    } else {
      fireEvent.click(await r.findByRole('button', { name: 'Carol Dias' }))
      if (verb === 'group') fireEvent.click(r.getByRole('button', { name: 'Dave Lima' }))
    }
    vi.useFakeTimers()
    const action = verb === 'create' ? copy.newConversation.createChannel : copy.newConversation.startConversation
    fireEvent.click(r.getByRole('button', { name: action }))
    act(() => void vi.advanceTimersByTime(SUBMIT_LOCK_MS))
    fireEvent.click(r.getByRole('button', { name: copy.newConversation.cancel }))
    expect(r.container.querySelector('.ui-dialog')).toBeNull()
    vi.useRealTimers()
    answer = returned
    await act(async () => settle[verb].resolve())
    if (returned === NEW_ROOM)
      await act(async () => stream.emit?.({ t: 'channel.added', channel: listed(NEW_ROOM, '#novo', 'private') }))
    await waitFor(() => expect(r.getByTestId('listed').textContent).toContain(String(returned)))
    expect(r.getByTestId('selected').textContent).toBe(String(HERE))
  })

  it('control: a success before the cap still selects the conversation', async () => {
    const settle = deferred()
    const { acl, stream } = chatAcl({
      create: settle.promise.then(() => NEW_ROOM),
      dm: new Promise(() => {}),
      group: new Promise(() => {}),
    })
    const r = render(<ChatWithDialog acl={acl} mode="channel" />)
    await waitFor(() => expect(r.getByTestId('selected').textContent).toBe(String(HERE)))
    fireEvent.change(r.getByLabelText(copy.newConversation.name), { target: { value: 'novo' } })
    fireEvent.click(r.getByRole('button', { name: copy.newConversation.createChannel }))
    await act(async () => settle.resolve())
    await act(async () => stream.emit?.({ t: 'channel.added', channel: listed(NEW_ROOM, '#novo', 'private') }))
    await waitFor(() => expect(r.getByTestId('selected').textContent).toBe(String(NEW_ROOM)))
  })
})
