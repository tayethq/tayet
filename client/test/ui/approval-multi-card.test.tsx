// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, within } from '@testing-library/react'
import { Timeline } from '../../src/ui/components/Timeline'
import { ThreadPanel } from '../../src/ui/components/ThreadPanel'
import type { Message, MessageBody, MessageId, ChannelId, User, UserId } from '../../src/acl'
import { getLocale } from '../../src/ui/i18n'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'

// A card that asks for several answers, on screen: the seven states of the design (waiting, partial,
// you, sending, failed, done, closed), the answer not readable yet, the thread, and the click.

const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const cid = (s: string): ChannelId => s as unknown as ChannelId
const tms = (n: number) => n as unknown as Message['sentAt']

const AGENT: User = { id: uid('@a-abcdefghijkl:tayet.local'), displayName: 'Publicação', kind: 'agent', agentColor: 'ardosia' }
const RAFA: User = { id: uid('@rafa:tayet.local'), displayName: 'Rafael Souza', kind: 'member' }
const ME: User = { id: uid('@me:tayet.local'), displayName: 'Marina', kind: 'member' }
const usersById: Record<string, User> = { [AGENT.id]: AGENT, [RAFA.id]: RAFA, [ME.id]: ME }

const AT1 = new Date(2026, 10, 18, 9, 31).getTime()
const AT2 = new Date(2026, 10, 18, 9, 34).getTime()
const hm = (at: number) => new Date(at).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit', hour12: false })

type Approval = Extract<MessageBody, { kind: 'approval' }>
type Multi = Extract<Approval['state'], { kind: 'multi' }>
const OPTIONS: Approval['options'] = [
  { id: 'approve', label: 'Aprovar', style: 'primary' },
  { id: 'reject', label: 'Recusar' },
]
const card = (state: Approval['state']): Message => ({
  id: mid('$card'),
  channelId: cid('!r:tayet.local'),
  author: AGENT.id,
  body: { kind: 'approval', text: 'Publicar o layout novo?', options: OPTIONS, state },
  sentAt: tms(AT1 - 60_000),
  reactions: [],
  mine: false,
  mentionsMe: false,
})
const rafa = { by: RAFA.id, at: tms(AT1), option: 'approve' }
const mine = { by: ME.id, at: tms(AT2), option: 'approve' }
const multi = (answers: Multi['answers'], over: Partial<Multi> = {}): Multi => ({ kind: 'multi', needed: 2, answers, closed: false, ...over })

afterEach(cleanup)

const mount = (m: Message, onAnswer?: (message: Message, option: string) => void) =>
  render(<Timeline messages={[m]} usersById={usersById} selfId={ME.id} onAnswer={onAnswer} />)

const group = (r: ReturnType<typeof mount>) => r.getByRole('group', { name: copy.approval.title })
const buttons = (g: HTMLElement) => within(g).queryAllByRole('button').filter((b) => b.closest('.approval__options'))
const rows = (g: HTMLElement) => [...g.querySelectorAll('.approval__answers > .approval__footer')].map((el) => el.textContent)
const counter = (g: HTMLElement) => g.querySelector('.approval__count')?.textContent

describe('a card that asks for several answers — the seven states', () => {
  it('waiting: the buttons, no lines, the counter with zero answers', () => {
    const r = mount(card(multi([])), () => {})
    const g = group(r)
    expect(buttons(g).map((b) => b.textContent)).toEqual(['Aprovar', 'Recusar'])
    expect(buttons(g).map((b) => b.getAttribute('data-variant'))).toEqual(['fill', 'secondary'])
    expect(g.querySelector('.approval__answers')).toBeNull()
    expect(counter(g)).toBe(fill(copy.approval.needs, { n: 2 }))
    expect(findProtocolLeaksInText(r.container.innerHTML)).toEqual([])
  })

  it('partial: another person’s line, the buttons, the counter from the first answer', () => {
    const g = group(mount(card(multi([rafa])), () => {}))
    expect(buttons(g)).toHaveLength(2)
    expect(rows(g)).toEqual([`Aprovar${fill(copy.approval.answered, { name: 'Rafael Souza', time: hm(AT1) })}`])
    expect(counter(g)).toBe(fill(copy.approval.progress, { k: 1, n: 2 }))
  })

  it('you: the viewer’s own line with "Você", no buttons, the counter', () => {
    const g = group(mount(card(multi([{ ...mine, at: tms(AT1) }])), () => {}))
    expect(buttons(g)).toHaveLength(0)
    expect(rows(g)).toEqual([`Aprovar${fill(copy.approval.answered, { name: copy.timeline.you, time: hm(AT1) })}`])
    expect(counter(g)).toBe(fill(copy.approval.progress, { k: 1, n: 2 }))
  })

  it('sending: the other line, the viewer’s dimmed pill with "Enviando…" last, no buttons, the counter without it', () => {
    const g = group(mount(card(multi([rafa], { own: { status: 'sending', option: 'approve' } })), () => {}))
    expect(buttons(g)).toHaveLength(0)
    const lines = g.querySelectorAll('.approval__answers > .approval__footer')
    expect(lines).toHaveLength(2)
    expect(lines[1]!.querySelector('.approval__pill--sending')?.textContent).toBe('Aprovar')
    expect(lines[1]!.textContent).toContain(copy.timeline.sending)
    expect(counter(g)).toBe(fill(copy.approval.progress, { k: 1, n: 2 }))
  })

  it('failed: muted pill, "Não enviado", the separator and "Tentar de novo", which answers again with the same option', () => {
    const onAnswer = vi.fn()
    const m = card(multi([rafa], { own: { status: 'failed', option: 'reject' } }))
    const g = group(mount(m, onAnswer))
    expect(buttons(g)).toHaveLength(0)
    const own = g.querySelectorAll('.approval__answers > .approval__footer')[1]!
    expect(own.querySelector('.approval__pill--failed')?.textContent).toBe('Recusar')
    expect(own.querySelector('.message__status--failed')?.textContent).toBe(copy.timeline.failed)
    fireEvent.click(within(own as HTMLElement).getByRole('button', { name: copy.timeline.retry }))
    expect(onAnswer).toHaveBeenCalledWith(m, 'reject')
    expect(counter(g)).toBe(fill(copy.approval.progress, { k: 1, n: 2 }))
  })

  it('done: the two lines, no counter, no buttons, no "Pedido encerrado" — closed or not', () => {
    for (const closed of [false, true]) {
      const r = mount(card(multi([rafa, mine], { closed })), () => {})
      const g = group(r)
      expect(buttons(g)).toHaveLength(0)
      expect(rows(g)).toEqual([
        `Aprovar${fill(copy.approval.answered, { name: 'Rafael Souza', time: hm(AT1) })}`,
        `Aprovar${fill(copy.approval.answered, { name: copy.timeline.you, time: hm(AT2) })}`,
      ])
      expect(g.querySelector('.approval__count')).toBeNull()
      expect(g.textContent).not.toContain(copy.approval.closed)
      cleanup()
    }
  })

  it('closed short of N: the answers that came and "Pedido encerrado", no buttons', () => {
    const g = group(mount(card(multi([{ ...rafa, option: 'reject' }], { closed: true })), () => {}))
    expect(buttons(g)).toHaveLength(0)
    expect(rows(g)).toEqual([`Recusar${fill(copy.approval.answered, { name: 'Rafael Souza', time: hm(AT1) })}`])
    expect(counter(g)).toBe(copy.approval.closed)
  })

  it('closed with no answer: only "Pedido encerrado"', () => {
    const g = group(mount(card(multi([], { closed: true })), () => {}))
    expect(buttons(g)).toHaveLength(0)
    expect(g.querySelector('.approval__answers')).toBeNull()
    expect(counter(g)).toBe(copy.approval.closed)
  })
})

describe('a card that asks for several answers — details', () => {
  it('an answer not readable yet: the line without the pill, the no-option text, and it counts', () => {
    const g = group(mount(card(multi([{ by: RAFA.id, at: tms(AT1) }], { needed: 3 })), () => {}))
    const line = g.querySelector('.approval__answers > .approval__footer')!
    expect(line.querySelector('.approval__pill')).toBeNull()
    expect(line.textContent).toBe(fill(copy.approval.answeredNoOption, { name: 'Rafael Souza', time: hm(AT1) }))
    expect(counter(g)).toBe(fill(copy.approval.progress, { k: 1, n: 3 }))
  })

  it('more than two answers: one line each, in the given order', () => {
    const third = { by: AGENT.id, at: tms(AT2), option: 'reject' }
    const g = group(mount(card(multi([rafa, { ...mine, at: tms(AT1) }, third], { needed: 4 })), () => {}))
    expect(g.querySelectorAll('.approval__answers > .approval__footer')).toHaveLength(3)
    expect(counter(g)).toBe(fill(copy.approval.progress, { k: 3, n: 4 }))
  })

  it('a click answers with the option and makes the footer a polite live region', () => {
    const onAnswer = vi.fn()
    const m = card(multi([rafa]))
    const r = mount(m, onAnswer)
    const g = group(r)
    fireEvent.click(buttons(g)[1]!)
    expect(onAnswer).toHaveBeenCalledWith(m, 'reject')
    expect(g.querySelector('.approval__slot')?.getAttribute('aria-live')).toBe('polite')
    expect(document.activeElement).toBe(g)
  })

  it('without the answer verb the buttons are disabled', () => {
    const g = group(mount(card(multi([]))))
    expect(buttons(g).every((b) => (b as HTMLButtonElement).disabled)).toBe(true)
  })

  it('the same card in the thread', () => {
    const root = card(multi([rafa]))
    const { container } = render(<ThreadPanel root={root} messages={[]} usersById={usersById} selfId={ME.id} onClose={() => {}} onSend={() => {}} />)
    const c = container.querySelector('.thread-panel .approval')!
    expect(c.querySelectorAll('.approval__answers > .approval__footer')).toHaveLength(1)
    expect(c.querySelector('.approval__count')?.textContent).toBe(fill(copy.approval.progress, { k: 1, n: 2 }))
  })
})
