import { useState } from 'react'
import { fireEvent, render } from '@testing-library/react'
import { vi } from 'vitest'
import { Workspace } from '../../src/ui/components/Workspace'
import { StackProvider, useStackScreens } from '../../src/ui/stack'
import { useNarrowWindow } from '../../src/ui/narrow'
import type { AgentFormSlice } from '../../src/ui/useAgentForm'
import type { Channel, ChannelId, Message, MessageId, RosterEntry, User, UserId, UserProfile } from '../../src/acl'
import { fakeHistory } from './history-fake'

// The real Workspace wired to the stack as the App does, for the M8 screens. The ids carry protocol shapes on
// purpose (the render-scans are the proof that none reaches the DOM).

const uid = (s: string) => s as unknown as UserId
const cid = (s: string) => s as unknown as ChannelId
export const ME: User = { id: uid('@marina:tayet.local'), displayName: 'Marina Alves', kind: 'member' }
export const BRUNA: User = { id: uid('@bruna:tayet.local'), displayName: 'Bruna Lima', kind: 'member' }
export const RAFA: User = { id: uid('@rafael:tayet.local'), displayName: 'Rafael Souza', kind: 'member' }
export const ROBO: User = {
  id: uid('@a-abcdefghijkl:tayet.local'),
  displayName: 'Ledger',
  kind: 'agent',
  agentColor: 'argila',
  operatorName: 'Bruna Lima',
}
const unread = { count: 0, mentions: 0 }
export const GROUP: Channel = {
  id: cid('!grupo:tayet.local'),
  name: 'Bruna Lima, Rafael Souza, Ledger',
  kind: 'group',
  memberCount: 4,
  unread,
  participants: [BRUNA.id, RAFA.id, ROBO.id],
  participantAgents: 1,
}
export const GROUP2: Channel = { ...GROUP, id: cid('!outro:tayet.local'), name: 'Rafael Souza', participants: [RAFA.id], participantAgents: 0 }
export const DM: Channel = { id: cid('!dm:tayet.local'), name: 'Bruna Lima', kind: 'dm', memberCount: 2, unread }
export const channel = (i: number): Channel => ({ id: cid(`!c${i}:tayet.local`), name: `#canal-${i}`, kind: 'public', memberCount: 3, unread })
export const ROSTER: RosterEntry[] = [
  { user: RAFA, role: 'admin', state: 'active', self: false },
  { user: ME, role: 'admin', state: 'active', self: true },
  { user: ROBO, role: 'member', state: 'active', self: false },
  { user: BRUNA, role: 'admin', state: 'active', self: false },
]
export const profileOf = (id: UserId): UserProfile => ({ ...[ME, BRUNA, RAFA, ROBO].find((u) => u.id === id)! })

// A promise the test settles.
export function held<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((ok, no) => {
    resolve = ok
    reject = no
  })
  return { promise, resolve, reject }
}

export interface ShellOpts {
  selected?: Channel
  common?: Channel[]
  load?: (id: UserId) => Promise<UserProfile>
  leave?: (id: ChannelId) => Promise<void>
  dm?: (id: UserId) => Promise<void>
  agentForm?: AgentFormSlice
}

export function mountShell(opts: ShellOpts = {}) {
  const h = fakeHistory()
  const common = opts.common ?? []
  const list = [GROUP, GROUP2, DM, ...common]
  const leave = vi.fn(opts.leave ?? (async () => {}))
  const dm = vi.fn(opts.dm ?? (async () => {}))
  const convert = vi.fn(async () => {})
  let select: (id: ChannelId | undefined) => void = () => {}
  let setForm: (f: AgentFormSlice | undefined) => void = () => {}
  const start = opts.selected ?? GROUP
  const message: Message = {
    id: '$m1:tayet.local' as unknown as MessageId,
    channelId: start.id,
    author: BRUNA.id,
    body: { kind: 'text', text: 'Bom dia' },
    sentAt: 1 as never,
    reactions: [],
    mine: false,
    mentionsMe: false,
  }
  function Shell() {
    const narrow = useNarrowWindow()
    const [selected, setSelected] = useState<ChannelId | undefined>(start.id)
    const [managing, setManaging] = useState<Channel>()
    const [agentForm, setAgentForm] = useState(opts.agentForm)
    select = setSelected
    setForm = setAgentForm
    useStackScreens({ narrow, chat: selected !== undefined, thread: false, onPopChat: () => setSelected(undefined), onPopThread: () => {} })
    const verb = async () => {}
    return (
      <Workspace
        narrow={narrow}
        channels={list}
        selectedChannelId={selected}
        messages={[message]}
        usersById={{ [ME.id]: ME, [BRUNA.id]: BRUNA, [ROBO.id]: ROBO }}
        currentUser={ME}
        connection="connected"
        onSelectChannel={setSelected}
        onSend={() => {}}
        managing={managing}
        members={ROSTER}
        onManageChannel={setManaging}
        onCloseManage={() => setManaging(undefined)}
        onUpdateChannel={verb}
        onArchiveChannel={verb}
        onLeaveChannel={leave}
        onConvertToChannel={convert}
        onAddMember={verb}
        onRemoveMember={verb}
        onSetRole={verb}
        loadCandidates={async () => []}
        onOpenDirectMessage={async (user) => {
          await dm(user)
          setSelected(DM.id)
        }}
        isOwnAgent={() => false}
        onLoadUserProfile={opts.load ?? (async (id) => profileOf(id))}
        onLoadCommonChannels={async () => common}
        agentForm={agentForm}
      />
    )
  }
  const view = render(
    <StackProvider env={h.env}>
      <Shell />
    </StackProvider>,
  )
  const c = view.container
  const press = (el: HTMLElement) => {
    el.focus()
    fireEvent.click(el)
  }
  return {
    ...view,
    h,
    leave,
    dm,
    convert,
    press,
    select: (id: ChannelId | undefined) => select(id),
    setForm: (f: AgentFormSlice | undefined) => setForm(f),
    more: () => c.querySelector<HTMLButtonElement>('.ui-screen-header__action, .channel-header__manage')!,
    author: () => c.querySelector<HTMLButtonElement>('.message__author-open:not(.message__author-open--avatar)')!,
    details: () => c.querySelector<HTMLElement>('.group-screen'),
    profile: () => c.querySelector<HTMLElement>('.profile-screen'),
    rows: () => [...c.querySelectorAll<HTMLButtonElement>('.channel-management-panel__member-open')],
    front: () => c.querySelector('.workspace')!.getAttribute('data-stack'),
  }
}
