// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react'
import { NewConversationDialog, SUBMIT_LOCK_MS } from '../../src/ui/components/NewConversationDialog'
import { Workspace } from '../../src/ui/components/Workspace'
import { StackProvider, type HistoryEnv, type StackHistoryState } from '../../src/ui/stack'
import type { Channel, ChannelId, User, UserId } from '../../src/acl'
import { copy } from '../support/copy'

// PLANO-MOBILE M6 N2 with T1: while a verb of "Nova conversa" is in flight, no path closes the surface, for at
// most SUBMIT_LOCK_MS; past the cap every path closes again and the verb keeps running. Both widths.

const uid = (s: string): UserId => s as unknown as UserId
const carol: User = { id: uid('@carol:tayet.local'), displayName: 'Carol Dias', kind: 'member' }

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
