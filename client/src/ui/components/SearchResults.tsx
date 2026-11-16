import { useId } from 'react'
import type { Channel, MessageId } from '@tayet/client'
import { Avatar, Sweep } from '../primitives'
import { Thread } from '../icons'
import { ChannelLabel } from './ChannelLabel'
import { AgentAvatar, peerAgentColorOf } from './AgentAvatar'
import { initialsOf } from './Timeline'
import type { ResolvedHit } from '../useSearch'
import { t, GLYPH, getLocale } from '../i18n'

// Search results (manifest workspace.md §8 items 4–7, 11): while there is a query they take the place
// of the list's sections, in the same scroll and rhythm. Header "N resultados" + "limpar"; a flat list,
// newest first; the "Preparando a busca…" bar on top while the index fills; "Nada encontrado" when the
// query found nothing. A hit is a row button (the channel-row idiom): monogram, author · conversation,
// date, the excerpt with the term in <mark>, "em thread" when it lives in one, and the inline failure
// of a jump. Nothing here renders an id (P1): the excerpt and names are the only text.

const DAY_MS = 24 * 60 * 60 * 1000

// The date column (§8 item 5, the timeline's ruler): today → "hoje 9:18"; this week → "ter 16:40";
// older → "12 out". pt-BR short names without the trailing dot.
export function whenOf(sentAt: number, now: number = Date.now()): string {
  const at = new Date(sentAt)
  const time = at.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  if (sentAt >= midnight.getTime()) return t('search.today', { time })
  if (sentAt >= midnight.getTime() - 6 * DAY_MS) {
    const weekday = at.toLocaleDateString(getLocale(), { weekday: 'short' }).replace('.', '')
    return `${weekday} ${time}`
  }
  const day = at.getDate()
  const month = at.toLocaleDateString(getLocale(), { month: 'short' }).replace('.', '')
  return at.getFullYear() === midnight.getFullYear() ? `${day} ${month}` : `${day} ${month} ${at.getFullYear()}`
}

export function resultsLabel(n: number): string {
  return t('search.results', { n })
}

export function SearchResults({
  hits,
  searched,
  preparing,
  channels,
  selected,
  failed,
  onPick,
  onClear,
}: {
  hits: ResolvedHit[]
  searched: string
  preparing: boolean
  channels: Channel[]
  // The hit last opened (it stays selected, §8 item 9) and the one whose jump failed (§8 item 11).
  selected?: MessageId
  failed?: MessageId
  onPick: (hit: ResolvedHit) => void
  onClear: () => void
}) {
  return (
    <section className="search-results" role="region" aria-label={t('search.region')}>
      {preparing && (
        <div className="search-results__preparing" role="status">
          <Sweep />
          <p className="search-results__note">{t('search.preparing')}</p>
        </div>
      )}
      {hits.length > 0 ? (
        <>
          <div className="channel-list__section-header">
            <h2 className="channel-list__section-title">{resultsLabel(hits.length)}</h2>
            <button type="button" className="channel-list__section-add search-results__clear" onClick={onClear}>
              {t('search.clearShort')}
            </button>
          </div>
          <ul>
            {hits.map((resolved) => (
              <HitRow
                key={resolved.hit.message.id}
                resolved={resolved}
                channel={channels.find((c) => c.id === resolved.hit.channel)}
                selected={resolved.hit.message.id === selected}
                failed={resolved.hit.message.id === failed}
                onPick={onPick}
              />
            ))}
          </ul>
        </>
      ) : (
        searched !== '' && (
          <div className="search-results__empty">
            <p className="search-results__empty-title">{t('search.nothingFound', { query: searched })}</p>
            <p className="search-results__note">{t('search.partial')}</p>
          </div>
        )
      )}
    </section>
  )
}

function HitRow({
  resolved,
  channel,
  selected,
  failed,
  onPick,
}: {
  resolved: ResolvedHit
  channel?: Channel
  selected: boolean
  failed: boolean
  onPick: (hit: ResolvedHit) => void
}) {
  const { hit, author } = resolved
  // ADR-086: an agent author's result carries the agent avatar (glyph + colour + indicator).
  const authorAgent = resolved.authorAgent
  const whereAgent = peerAgentColorOf(channel)
  const { before, match, after } = hit.excerpt
  // The button's name is author + excerpt (U4); the failure line is its description.
  const failureId = useId()
  return (
    <li>
      <button
        type="button"
        className={selected ? 'search-hit search-hit--selected' : 'search-hit'}
        aria-current={selected ? 'true' : undefined}
        aria-label={`${author}: ${before}${match}${after}`}
        aria-describedby={failed ? failureId : undefined}
        onClick={() => onPick(resolved)}
      >
        {authorAgent !== undefined ? (
          <AgentAvatar color={authorAgent} />
        ) : (
          <Avatar label={initialsOf(author)} size="cotidiano" variant={hit.message.mine ? 'accent' : 'greige'} />
        )}
        <span className="search-hit__main">
          <span className="search-hit__meta">
            <span className="search-hit__author">{author}</span>
            {/* In a DM the peer's messages omit the conversation (it repeats the author): manifest workspace.md §4.7 (24/Out). */}
            {channel && !(channel.kind === 'dm' && !hit.message.mine) && (
              <span className="search-hit__where">
                {GLYPH.dot} {whereAgent !== undefined && <AgentAvatar color={whereAgent} size="gestao" />}
                <ChannelLabel channel={channel} />
              </span>
            )}
            <span className="search-hit__when">{whenOf(hit.message.sentAt as unknown as number)}</span>
          </span>
          <span className="search-hit__excerpt">
            {before}
            <mark>{match}</mark>
            {after}
          </span>
          {hit.message.threadParent !== undefined && (
            <span className="search-hit__thread">
              <Thread size={12} />
              {t('search.inThread')}
            </span>
          )}
          {failed && <span id={failureId} className="search-hit__failed">{t('search.openFailed')}</span>}
        </span>
      </button>
    </li>
  )
}
