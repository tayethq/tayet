import type { Channel } from '@tayet/client'
import { Lock } from '../icons'
import { t, GLYPH } from '../i18n'

// The lock's accessible name — the private channel's mark, read where the '#' would be. The
// management entry point composes with it (manageLabel), so the two never drift. The components read
// t() at render; this export keeps the value for the tests that import it (resolved at module load).
export const PRIVATE_MARK = t('channel.privateMark')

// A channel's on-screen name with its kind mark (PLANO-RELEASE-PUBLICA §8.35, §8.66). The ACL contract
// is unchanged: Channel.name of a non-dm channel is '#'+name. The mark is its own span before the
// name — '#' for a public channel, the lock (accessible name PRIVATE_MARK) for a private one — set off
// by the same var(--space-4) margin for both. The label is inline so the container's text-overflow
// cuts the name (an inline-flex box is atomic: the ellipsis never reached it, §8.66). A DM has no mark,
// and neither has a group conversation (ADR-094; workspace.md §22): its name is the people, as it comes.
// An empty name — a group with nobody else, or a DM without a known peer — reads "Só você"
// (`group.alone`, PLANO-CONVERSAS §0.3.4 item 4).
// `hint` is the lock's optional tooltip (the header and the thread subtitle pass it). `lockSize` is the
// lock's edge where the surface draws it smaller than the icon default (workspace.md §6.7: 13 in the
// row, 14 in the header). Copy speaks of ACCESS, never of encryption (P1, ROTEIRO-U2 §0).
export function ChannelLabel({
  channel,
  hint,
  lockSize,
}: {
  channel: Channel
  hint?: string
  lockSize?: number
}) {
  if (channel.kind === 'dm' || channel.kind === 'group') return <>{bareName(channel)}</>
  const bare = bareName(channel)
  if (channel.kind !== 'private') {
    // textContent and accessible name stay '#board' exactly: the mark is a span, not a space.
    return (
      <span className="channel-label">
        <span className="channel-label__mark">{GLYPH.hash}</span>
        {bare}
      </span>
    )
  }
  return (
    <span className="channel-label">
      <PrivateLock hint={hint} size={lockSize} />
      <PrivateMarkSpace />
      {bare}
    </span>
  )
}

// The private mark alone, for a surface that draws its own box around it (the invite chip).
export function PrivateLock({ hint, size }: { hint?: string; size?: number }) {
  return (
    <span className="channel-label__lock" role="img" aria-label={t('channel.privateMark')} title={hint}>
      <Lock size={size} />
    </span>
  )
}

// The conversation's name without its kind mark: the channel's bare name, the DM's person, the group's
// people. Empty in a DM or a group: "Só você".
export function bareName(channel: Channel): string {
  if (channel.kind === 'dm' || channel.kind === 'group') return channel.name || t('group.alone')
  return channel.name.replace(/^#/, '')
}

// The word break of the accessible name ("Canal privado board", not "Canal privadoboard"). Out of the
// flow (visually hidden), so the visible distance is only the mark's margin; a flex chip leaves it out
// of its gap the same way. The break comes from the span being a BLOCK (accname separates non-inline
// children; an abspos box is blockified, and that is what Chromium and Playwright read). The inline
// `display` states it where no stylesheet is loaded (jsdom), so every engine reads the same name; the
// space itself keeps textContent as it was (" board").
export function PrivateMarkSpace() {
  return (
    <span className="channel-label__space" style={{ display: 'block' }}>
      {' '}
    </span>
  )
}

// The management entry point's accessible name (header button and the dialog): the channel as the
// label reads it — "Gerenciar #board", "Gerenciar Canal privado board". A group's is its details
// panel's title, "Detalhes da conversa" (workspace.md §22.1 item 4).
export function manageLabel(channel: Channel): string {
  if (channel.kind === 'group') return t('group.details')
  return channel.kind === 'private'
    ? t('channel.managePrivate', { mark: t('channel.privateMark'), name: channel.name.replace(/^#/, '') })
    : t('channel.manageNamed', { name: channel.name })
}
