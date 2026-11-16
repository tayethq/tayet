// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, within, waitFor } from '@testing-library/react'
import { ChannelList } from '../../src/ui/components/ChannelList'
import { MediaProvider } from '../../src/ui/MediaContext'
import type { Channel, ChannelId, MediaRef, Presence, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { channelLabel } from '../support/channel-label'

// Track U/U3 (F3): the sectioned channel list. Two claims:
//   • Grouping — non-dm channels land under "Channels", dm under "Direct messages"; an empty section
//     is omitted. The names render verbatim from the translate layer (a channel is already '#'+name,
//     a DM is the peer's clean displayName) — F3 adds no '#'.
//   • P1 — the channel.id is protocol-shaped on purpose (the ADR-008 residual: the id value IS the
//     room id). It must live ONLY in the React key + click payload, never on screen. The DM's clean
//     name is a person's name; the underlying room id never surfaces.
// PR-β (manifest workspace §2/§7): a DM row carries the peer's avatar (photo > monogram) + the
// presence dot (online only); a CHANNEL row never grows an avatar or a dot. Channel.peer is
// mxid-shaped on purpose (ADR-008 residual) — it feeds only the presenceOf lookup and the React
// key/payload, never an attribute or text (the innerHTML scan below is the proof).

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mref = (s: string): MediaRef => s as unknown as MediaRef

const channels: Channel[] = [
  {
    id: cid('!engineering:tayet.local'), // protocol-shaped on purpose
    name: '#engineering',
    kind: 'public',
    memberCount: 3,
    unread: { count: 0, mentions: 0 },
  },
  {
    id: cid('!random:tayet.local'),
    name: '#random',
    kind: 'private',
    memberCount: 2,
    unread: { count: 0, mentions: 0 },
  },
  {
    id: cid('!dmcarol:tayet.local'),
    name: 'Carol Dias', // a DM renders the peer's clean displayName, never '#', never the room id
    kind: 'dm',
    memberCount: 2,
    unread: { count: 0, mentions: 0 },
  },
]

afterEach(cleanup)

describe('ChannelList — sectioned by kind (Track U/U3, F3)', () => {
  it('groups channels vs DMs, renders clean names, leaks no protocol shape', () => {
    const { container, getByRole } = render(
      <ChannelList channels={channels} onSelect={() => {}} onCompose={() => {}} />,
    )

    const channelsSection = getByRole('region', { name: 'Canais' })
    const dmsSection = getByRole('region', { name: 'Mensagens diretas' })

    // #engineering + #random (private) under Canais; Carol Dias under Mensagens diretas.
    expect(within(channelsSection).getByText(channelLabel('#engineering'))).toBeTruthy()
    // #random is private: the lock takes the '#' slot (§8.35) — the name renders without it.
    expect(within(channelsSection).getByText('random')).toBeTruthy()
    expect(within(dmsSection).getByText('Carol Dias')).toBeTruthy()
    // The DM is NOT in the Channels section (and vice-versa).
    expect(within(channelsSection).queryByText('Carol Dias')).toBeNull()
    expect(within(dmsSection).queryByText(channelLabel('#engineering'))).toBeNull()

    // P1: no protocol shape anywhere in the rendered list (text + attributes).
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('keeps both sections present; an empty one shows a quiet empty-state', () => {
    const { getByRole } = render(
      <ChannelList channels={[channels[2]!]} onSelect={() => {}} onCompose={() => {}} />,
    )
    // Both sections render even when one has no items — the "+" stays a stable compose entry.
    const channelsSection = getByRole('region', { name: 'Canais' })
    const dmsSection = getByRole('region', { name: 'Mensagens diretas' })
    // The DM lands under Mensagens diretas; Canais is empty → the quiet empty-state, not an item.
    expect(within(dmsSection).getByText('Carol Dias')).toBeTruthy()
    expect(within(channelsSection).getByText('Nenhuma conversa ainda')).toBeTruthy()
  })
})

// ── PR-β: DM rows — peer avatar + presence dot (manifest workspace §2/§7) ─────────────────────────

const carolId = uid('@carol:tayet.local') // mxid-shaped on purpose: any DOM leak turns red below
const CAROL_AVATAR = mref('mxc://tayet.local/carolphoto') // ditto (the mxc pattern)

const dmWithPeer: Channel = {
  id: cid('!dmcarol:tayet.local'),
  name: 'Carol Dias',
  kind: 'dm',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
  peer: carolId,
  peerAvatar: CAROL_AVATAR,
}

const presenceFor =
  (value: Presence) =>
  (u: UserId): Presence =>
    u === carolId ? value : 'offline'

describe('ChannelList — DM presence dot + peer avatar (PR-β, workspace §2/§7)', () => {
  it('DM online shows the dot; offline shows none; peer never reaches the DOM', () => {
    const online = render(
      <ChannelList channels={[dmWithPeer]} onSelect={() => {}} presenceOf={presenceFor('online')} />,
    )
    expect(online.container.querySelector('.ui-avatar__dot')).toBeTruthy()
    // P1: the mxid-shaped peer feeds only the presenceOf lookup — text + attributes stay clean.
    expect(findProtocolLeaksInText(online.container.innerHTML)).toEqual([])
    cleanup()

    const offline = render(
      <ChannelList channels={[dmWithPeer]} onSelect={() => {}} presenceOf={presenceFor('offline')} />,
    )
    expect(offline.container.querySelector('.ui-avatar__dot')).toBeNull()
    expect(findProtocolLeaksInText(offline.container.innerHTML)).toEqual([])
  })

  it('channel rows never grow an avatar or a dot; a peerless DM keeps the monogram, no dot', () => {
    const { getByRole, container } = render(
      <ChannelList
        channels={[channels[0]!, channels[2]!]} // #engineering + the peerless DM fixture
        onSelect={() => {}}
        presenceOf={presenceFor('online')}
      />,
    )
    const channelsSection = getByRole('region', { name: 'Canais' })
    expect(channelsSection.querySelector('.ui-avatar')).toBeNull()
    expect(channelsSection.querySelector('.ui-avatar__dot')).toBeNull()
    // DM without peer (malformed m.direct edge): monogram from the name, no dot — the row renders.
    const dmsSection = getByRole('region', { name: 'Mensagens diretas' })
    expect(within(dmsSection).getByText('Carol Dias')).toBeTruthy()
    expect(dmsSection.querySelector('.ui-avatar')).toBeTruthy()
    expect(dmsSection.querySelector('.ui-avatar__dot')).toBeNull()
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('peerAvatar resolves to the photo via useMedia; without a provider the monogram stands', async () => {
    // The profile-photo harness idiom: a MediaProvider stub resolving to a blob URL.
    const release = vi.fn()
    const resolve = vi.fn(async () => ({ url: 'blob:tayet/carol-thumb', release }))
    const { container } = render(
      <MediaProvider resolve={resolve}>
        <ChannelList channels={[dmWithPeer]} onSelect={() => {}} presenceOf={presenceFor('online')} />
      </MediaProvider>,
    )
    const img = await waitFor(() => {
      const el = container.querySelector('.ui-avatar__img') as HTMLImageElement | null
      if (!el) throw new Error('sem img ainda')
      return el
    })
    expect(img.getAttribute('src')).toBe('blob:tayet/carol-thumb')
    // P1: the mr_*/mxc stays behind useMedia, never in the DOM.
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
    cleanup()

    // No provider → useMedia yields undefined → the canonical monogram fallback (ADR-036 dec. 5).
    const bare = render(
      <ChannelList channels={[dmWithPeer]} onSelect={() => {}} presenceOf={presenceFor('online')} />,
    )
    expect(bare.container.querySelector('.ui-avatar__img')).toBeNull()
    expect(within(bare.container).getByText('C')).toBeTruthy()
  })
})
