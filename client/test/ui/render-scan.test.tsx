// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, act, waitFor } from '@testing-library/react'
import { Workspace } from '../../src/ui/components/Workspace'
import { MediaProvider } from '../../src/ui/MediaContext'
import { createAcl } from '../../src/acl'
import type {
  Acl,
  AclTelemetry,
  Channel,
  Message,
  User,
  ChannelId,
  UserId,
  MessageId,
  MediaRef,
} from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { HOMESERVER, synapseReachable, mintToken } from '../support/synapse'
import { until } from '../support/until'
import { copy, fill } from '../support/copy'

// ── P1 gate #2 (PLANO-FASE-1-TRADUTORES §4.2): the render-scan the Element doesn't have.
// Mount the UI and scan the rendered DOM for protocol shapes. This is P1 about what reaches the
// user's EYES. The fixture ids deliberately carry REAL protocol shapes (the ADR-008 residual:
// runtime id value IS the protocol id) — so if any component ever rendered an id/author/etc.,
// the scan turns red. Clean fields (names, topics, display names, text) must still render.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const tms = (n: number) => n as unknown as Message['sentAt']

afterEach(cleanup)

describe('DOM render-scan (P1 on screen)', () => {
  const alice: User = { id: uid('@alice:tayet.local'), displayName: 'Alice Anderson', kind: 'member' }
  const bob: User = { id: uid('@bob:tayet.local'), displayName: 'Bob Brown', kind: 'member' }
  const channels: Channel[] = [
    {
      id: cid('!engineering:tayet.local'),
      name: '#engineering',
      kind: 'public',
      topic: 'Where we build things',
      memberCount: 2,
      unread: { count: 3, mentions: 1 },
    },
    {
      id: cid('!random:tayet.local'),
      name: '#random',
      kind: 'private',
      memberCount: 5,
      unread: { count: 0, mentions: 0 },
    },
  ]
  const messages: Message[] = [
    {
      id: mid('$e1:tayet.local'),
      channelId: channels[0]!.id,
      author: alice.id,
      body: { kind: 'text', text: 'Hello team' },
      sentAt: tms(1),
      reactions: [],
      mine: false,
      mentionsMe: false,
    },
    {
      // Consecutive same-author message — collapses into Alice's group (a continuation row, no
      // repeated header/avatar). Exercises the PR-2 grouping in the render-scan.
      id: mid('$e1b:tayet.local'),
      channelId: channels[0]!.id,
      author: alice.id,
      body: { kind: 'text', text: 'Following up here' },
      sentAt: tms(2),
      reactions: [],
      mine: false,
      mentionsMe: false,
    },
    {
      id: mid('$e2:tayet.local'),
      channelId: channels[0]!.id,
      author: bob.id,
      body: { kind: 'text', text: 'Hi Alice' },
      sentAt: tms(2),
      editedAt: tms(3),
      reactions: [],
      mine: false,
      mentionsMe: false,
    },
    {
      id: mid('$e3:tayet.local'),
      channelId: channels[0]!.id,
      author: alice.id,
      body: { kind: 'unsupported', shape: { eventType: 'm.room.message', msgtype: 'm.image' } },
      sentAt: tms(4),
      reactions: [],
      mine: false,
      mentionsMe: false,
    },
    {
      // ADR-015: the `unavailable` placeholder (content whose key is not available — commit 6
      // makes it renderable; the inbound pipeline that emits it is commit 8). Its DOM must be a
      // NEUTRAL product placeholder: no "encrypted"/"key"/"decrypt"/session vocabulary.
      // ADR-057 dec. 7: 'stalled' keeps the promise-free "Message unavailable" copy asserted
      // below; the 'awaited' grade renders in the escrow-recovery integration DOM scan.
      id: mid('$e4:tayet.local'),
      channelId: channels[0]!.id,
      author: bob.id,
      body: { kind: 'unavailable', arrival: 'stalled' },
      sentAt: tms(5),
      reactions: [],
      mine: false,
      mentionsMe: false,
    },
  ]
  const usersById: Record<string, User> = { [alice.id]: alice, [bob.id]: bob }

  it('renders clean domain and leaks NO protocol shape into the DOM', () => {
    const { container } = render(
      <Workspace
        channels={channels}
        selectedChannelId={channels[0]!.id}
        messages={messages}
        usersById={usersById}
        connection="connected"
        onSelectChannel={() => {}}
        onSend={() => {}}
      />,
    )

    // Positive control: the clean, user-facing content IS on screen.
    const text = container.textContent ?? ''
    expect(text).toContain('#engineering')
    expect(text).toContain('Alice Anderson')
    expect(text).toContain('Hello team')
    // The unread badge, found by its element on the #engineering row: the pill shows the mentions
    // (1 in the fixture), not the count (3). A bare digit in the page text matched the timestamps.
    const engineering = Array.from(container.querySelectorAll('button.channel')).find((b) =>
      b.textContent?.includes('#engineering'),
    )
    const pill = engineering?.querySelector('.badge--mention')
    expect(pill?.textContent).toBe('1')
    expect(pill?.getAttribute('aria-label')).toBe(fill(copy.list.mentions.one, { n: 1 }))
    expect(text).toContain(copy.timeline.edited)
    // ADR-015: the unavailable placeholder renders as a normal message body — visible, neutral,
    // never blocking the timeline (P4). The leak-scan below proves no crypto vocabulary leaks.
    expect(text).toContain(copy.timeline.unavailable)

    // P1 gate: scan the FULL rendered HTML (text + attributes) — no mxid/room-id/mxc/m.room.*.
    // The unsupported placeholder must NOT carry the raw msgtype (m.image) either.
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('groups consecutive messages by author — one avatar + header per run (PR-2)', () => {
    const { container } = render(
      <Workspace
        channels={channels}
        selectedChannelId={channels[0]!.id}
        messages={messages}
        usersById={usersById}
        connection="connected"
        onSelectChannel={() => {}}
        onSend={() => {}}
      />,
    )

    // Five messages collapse into four author runs (Alice·Alice → Bob → Alice → Bob).
    expect(container.querySelectorAll('.message').length).toBe(5)
    expect(container.querySelectorAll('.message__group').length).toBe(4)
    // One avatar monogram per group (the continuation row carries no second avatar/header), and its
    // label is the clean two-char initials — never an id (P1).
    const avatars = container.querySelectorAll('.ui-avatar')
    expect(avatars.length).toBe(4)
    expect(avatars[0]!.textContent).toBe('AA') // Alice Anderson
    expect(container.querySelectorAll('.message--cont').length).toBe(1)
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('renders media via the resolved URL, never the raw MediaRef/mxc (ADR-009)', async () => {
    // Adversarial: the MediaRef value is itself a protocol-shaped mxc. The UI must resolve it to
    // the per-session URL and render THAT — never the ref/mxc. The mxc only lives behind resolveMedia.
    const mediaRef = 'mxc://tayet.local/secretfile' as unknown as MediaRef
    const imageMsg: Message = {
      id: mid('$img:tayet.local'),
      channelId: channels[0]!.id,
      author: alice.id,
      body: { kind: 'image', media: mediaRef, alt: 'a diagram' },
      sentAt: tms(5),
      mine: false,
      mentionsMe: false,
      reactions: [],
    }
    const release = vi.fn()
    const resolve = vi.fn(async () => ({ url: 'blob:tayet/resolved', release }))

    const { container, findByRole } = render(
      <MediaProvider resolve={resolve}>
        <Workspace
          channels={channels}
          selectedChannelId={channels[0]!.id}
          messages={[imageMsg]}
          usersById={usersById}
          connection="connected"
          onSelectChannel={() => {}}
          onSend={() => {}}
        />
      </MediaProvider>,
    )

    // By name: the private #random row also carries a role="img" (its lock mark, §8.35).
    const img = (await findByRole('img', { name: 'a diagram' })) as HTMLImageElement
    expect(img.getAttribute('src')).toBe('blob:tayet/resolved')
    expect(resolve).toHaveBeenCalledWith(mediaRef, 'thumbnail')
    await waitFor(() => expect(findProtocolLeaksInText(container.innerHTML)).toEqual([]))
  })

  it('media waiting and failure states leak no protocol shape and no technical copy (§8.21)', async () => {
    // Adversarial: protocol-shaped refs. Neither the waiting line nor the failure line (with its
    // retry) may surface the ref/mxc, the rejection reason, or session/crypto/server vocabulary.
    const fileRef = 'mxc://tayet.local/filesecret' as unknown as MediaRef
    const imageRef = 'mxc://tayet.local/imagesecret' as unknown as MediaRef
    const mediaMsgs: Message[] = [
      {
        id: mid('$file:tayet.local'),
        channelId: channels[0]!.id,
        author: alice.id,
        body: { kind: 'file', media: fileRef, name: 'notes.pdf', size: 1024, mimetype: 'application/pdf' },
        sentAt: tms(7),
        reactions: [],
        mine: false,
        mentionsMe: false,
      },
      {
        id: mid('$pic:tayet.local'),
        channelId: channels[0]!.id,
        author: bob.id,
        body: { kind: 'image', media: imageRef, alt: 'a diagram' },
        sentAt: tms(8),
        reactions: [],
        mine: false,
        mentionsMe: false,
      },
    ]
    const tech = ['token', 'sessão', 'session', 'servidor', 'server', 'descriptograf', 'decrypt', 'chave', 'key']
    const scan = (container: HTMLElement): void => {
      const text = (container.textContent ?? '').toLowerCase()
      for (const term of tech) expect(text).not.toContain(term)
      expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
    }
    const mount = (resolve: () => Promise<{ url: string; release: () => void }>) =>
      render(
        <MediaProvider resolve={resolve}>
          <Workspace
            channels={channels}
            selectedChannelId={channels[0]!.id}
            messages={mediaMsgs}
            usersById={usersById}
            connection="connected"
            onSelectChannel={() => {}}
            onSend={() => {}}
          />
        </MediaProvider>,
      )

    // Waiting: the resolver never settles.
    const waiting = mount(() => new Promise(() => {}))
    expect(waiting.container.textContent).toContain(copy.timeline.downloading)
    scan(waiting.container)
    waiting.unmount()

    // Failure: the resolver rejects with an ACL-internal reason that must not reach the screen.
    const failed = mount(async () => {
      throw new Error('media fetch failed: M_UNKNOWN_TOKEN mxc://tayet.local/filesecret')
    })
    await waitFor(() => expect(failed.getAllByRole('button', { name: copy.timeline.retry })).toHaveLength(2))
    expect(failed.container.textContent).toContain(copy.timeline.downloadFailed)
    scan(failed.container)
  })

  it('renders the author avatar PHOTO via the resolved URL, never the raw MediaRef/mxc (ADR-041 PR-2)', async () => {
    // Adversarial (mirrors the media case above): the User.avatar value is itself a protocol-shaped
    // mxc. The timeline gutter avatar must resolve it to the per-session URL and render THAT <img> —
    // never the ref/mxc. Monogram tests above mount WITHOUT a provider (User sans avatar → monogram);
    // this one supplies an avatar-bearing author + a stub provider, so the photo path lights up.
    const avatarRef = 'mxc://tayet.local/avatarsecret' as unknown as MediaRef
    const carol: User = { id: uid('@carol:tayet.local'), displayName: 'Carol Clark', kind: 'member', avatar: avatarRef }
    const carolMsg: Message = {
      id: mid('$ca:tayet.local'),
      channelId: channels[0]!.id,
      author: carol.id,
      body: { kind: 'text', text: 'Hi from Carol' },
      sentAt: tms(6),
      reactions: [],
      mine: false,
      mentionsMe: false,
    }
    const release = vi.fn()
    const resolve = vi.fn(async () => ({ url: 'blob:tayet/avatar', release }))

    const { container } = render(
      <MediaProvider resolve={resolve}>
        <Workspace
          channels={channels}
          selectedChannelId={channels[0]!.id}
          messages={[carolMsg]}
          usersById={{ [carol.id]: carol }}
          connection="connected"
          onSelectChannel={() => {}}
          onSend={() => {}}
        />
      </MediaProvider>,
    )

    // The gutter avatar (alt="" → not in the a11y tree, so query by class) resolves to the photo.
    await waitFor(() => {
      const photo = container.querySelector('.ui-avatar[data-image="true"] img') as HTMLImageElement | null
      expect(photo?.getAttribute('src')).toBe('blob:tayet/avatar')
    })
    // Resolved only at the group-start, with the thumbnail variant — and the mxc never reaches the DOM.
    expect(resolve).toHaveBeenCalledWith(avatarRef, 'thumbnail')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })
})

// Belt-and-suspenders: the same scan over REAL data from the live Synapse (auto-skips in CI).
const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

describe.skipIf(!SYNAPSE)('DOM render-scan over real Synapse data', () => {
  it('renders real channels without leaking protocol shapes', async () => {
    const token = await mintToken('alice')
    const acl: Acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await acl.connect(token as Parameters<Acl['connect']>[0])
    try {
      // Acquire the precondition from the STREAM, not a one-shot read: the org-channel session join
      // (ADR-045) is fire-and-forget, so a freshly-provisioned alice (e.g. right after dev-stack
      // reset) has an empty getChannels() in the window between connect-resolve and join-complete
      // (~200ms). The channel arrives via channel.added when the join lands; poll until it does. The
      // assertions below are unchanged — only how `real` is acquired.
      const real = await until(
        'org channel visible via getChannels after connect',
        async () => {
          const chs = await acl.getChannels()
          return chs.length > 0 ? chs : undefined
        },
        // Verbatim from the local copy this replaced: poll was 100ms (helper default is 120).
        { pollMs: 100 },
      )
      expect(real.length).toBeGreaterThan(0)
      const first = real[0]!
      const members = await acl.getMembers(first.id)
      const page = await acl.getTimeline(first.id)
      const usersById: Record<string, User> = {}
      for (const { user } of members) usersById[user.id] = user

      let container!: HTMLElement
      act(() => {
        container = render(
          <Workspace
            channels={real}
            selectedChannelId={first.id}
            messages={page.items}
            usersById={usersById}
            connection="connected"
            onSelectChannel={() => {}}
            onSend={() => {}}
          />,
        ).container
      })
      expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
    } finally {
      await acl.disconnect()
    }
  }, 120_000)
})
