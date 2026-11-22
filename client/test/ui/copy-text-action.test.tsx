// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { Timeline, COPIED_MS } from '../../src/ui/components/Timeline'
import { ThreadPanel } from '../../src/ui/components/ThreadPanel'
import type { ChannelId, MediaRef, Message, MessageId, User, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'

// "Copiar texto" on the wide action bar (manifest workspace.md §25.1 items 1, 2, 4 and 5; PLANO-MOBILE
// §0.12.2 R9, M3a): the icon button after "Responder na thread" and before "Editar"; a copy that worked
// swaps it for the check and "Copiado" (role="status") for COPIED_MS, then the button comes back; a refused
// copy changes nothing on screen and logs nothing (N8 a); no action on image, file, pending, unavailable and
// unsupported (N4 a). Fixtures carry protocol-shaped ids — none reaches the clipboard or the DOM.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const tms = (n: number) => n as unknown as Message['sentAt']
const media = 'mr_abcdef' as unknown as MediaRef

const me: User = { id: uid('@me:tayet.local'), displayName: 'Me Myself', kind: 'member' }
const usersById = { [me.id]: me }

function msg(over: Partial<Message> = {}): Message {
  return {
    id: mid('$m1:tayet.local'),
    channelId: cid('!room:tayet.local'),
    author: me.id,
    body: {
      kind: 'text',
      text: 'plain fallback',
      rich: [{ t: 'p', children: [{ t: 'text', text: 'oi ' }, { t: 'strong', children: [{ t: 'text', text: '@Alice' }] }] }],
    },
    sentAt: tms(1),
    reactions: [],
    mine: true,
    mentionsMe: false,
    status: 'sent',
    ...over,
  }
}

const writeText = vi.fn<(text: string) => Promise<void>>()
beforeEach(() => {
  writeText.mockReset()
  writeText.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const flush = () => act(async () => {})

describe('the copy button on the bar', () => {
  it('sits after "Responder na thread" and before "Editar"', () => {
    const { container } = render(
      <Timeline messages={[msg()]} usersById={usersById} onReact={() => {}} onReply={() => {}} onOpenThread={() => {}} onEdit={() => {}} onDelete={() => {}} />,
    )
    const labels = Array.from(container.querySelectorAll('.message__actions button[aria-label]')).map((b) => b.getAttribute('aria-label'))
    expect(labels).toEqual(['Reagir', 'Responder', 'Responder na thread', 'Copiar texto', 'Editar mensagem', 'Apagar mensagem'])
    const button = container.querySelector('.message__copy-open')!
    expect(button.getAttribute('title')).toBe('Copiar texto')
  })

  it('copies the Markdown, shows "Copiado" with role="status" for COPIED_MS, then the button comes back', async () => {
    vi.useFakeTimers()
    const { getByLabelText, queryByLabelText, queryByRole, container } = render(<Timeline messages={[msg()]} usersById={usersById} />)
    fireEvent.click(getByLabelText('Copiar texto'))
    await flush()
    expect(writeText).toHaveBeenCalledWith('oi **@Alice**')
    expect(queryByRole('status')?.textContent).toBe('Copiado')
    expect(queryByLabelText('Copiar texto')).toBeNull()
    // The bar stays shown while "Copiado" is on it.
    expect(container.querySelector('.message__actions--copied')).not.toBeNull()
    act(() => vi.advanceTimersByTime(COPIED_MS - 1))
    expect(queryByRole('status')).not.toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(queryByRole('status')).toBeNull()
    expect(queryByLabelText('Copiar texto')).not.toBeNull()
    expect(container.querySelector('.message__actions--copied')).toBeNull()
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
    expect(findProtocolLeaksInText(writeText.mock.calls[0]![0])).toEqual([])
  })

  it('the button comes back with the focus when the keyboard had it', async () => {
    vi.useFakeTimers()
    const { getByLabelText } = render(<Timeline messages={[msg()]} usersById={usersById} />)
    const button = getByLabelText('Copiar texto')
    button.focus()
    fireEvent.click(button)
    await flush()
    act(() => vi.advanceTimersByTime(COPIED_MS))
    expect(document.activeElement).toBe(getByLabelText('Copiar texto'))
  })

  it('a refused copy changes nothing on screen and logs nothing (N8 a)', async () => {
    writeText.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { getByLabelText, queryByRole, container } = render(<Timeline messages={[msg()]} usersById={usersById} />)
    const before = container.innerHTML
    fireEvent.click(getByLabelText('Copiar texto'))
    await flush()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(queryByRole('status')).toBeNull()
    expect(container.innerHTML).toBe(before)
    expect(error).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('a clipboard that is not there (insecure context) is a refusal too', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    const { getByLabelText, queryByRole } = render(<Timeline messages={[msg()]} usersById={usersById} />)
    fireEvent.click(getByLabelText('Copiar texto'))
    await flush()
    expect(queryByRole('status')).toBeNull()
    expect(getByLabelText('Copiar texto')).toBeTruthy()
  })

  it('a message not sent keeps the action', () => {
    const { queryByLabelText } = render(<Timeline messages={[msg({ status: 'failed' })]} usersById={usersById} />)
    expect(queryByLabelText('Copiar texto')).not.toBeNull()
  })

  it('is on the thread panel too, root and replies', () => {
    const root = msg({ id: mid('$root:tayet.local') })
    const reply = msg({ id: mid('$r1:tayet.local'), threadParent: root.id, body: { kind: 'text', text: 'resposta' } })
    const { getAllByLabelText } = render(<ThreadPanel root={root} messages={[reply]} usersById={usersById} onClose={() => {}} onSend={() => {}} />)
    expect(getAllByLabelText('Copiar texto')).toHaveLength(2)
  })
})

describe('no copy action (§25.1 item 5, N4 a)', () => {
  const cases: Array<[string, Partial<Message>]> = [
    ['image', { body: { kind: 'image', media } }],
    ['file', { body: { kind: 'file', media, name: 'a.pdf', size: 1, mimetype: 'application/pdf' } }],
    ['pending', { status: 'pending' }],
    ['unavailable', { body: { kind: 'unavailable', arrival: 'stalled' } }],
    ['unsupported', { body: { kind: 'unsupported', shape: { eventType: 'x.custom' } } }],
  ]
  for (const [name, over] of cases) {
    it(name, () => {
      const { queryByLabelText } = render(<Timeline messages={[msg(over)]} usersById={usersById} onReact={() => {}} />)
      expect(queryByLabelText('Copiar texto')).toBeNull()
    })
  }
})
