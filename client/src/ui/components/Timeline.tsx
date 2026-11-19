import { useEffect, useId, useLayoutEffect, useRef, useState, type AnimationEvent, type CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import type { AgentColor, Message, MessageBody, MessageId, Presence, RichDoc, User, UserId } from '@tayet/client'
import { QuickReact, Reactions } from './Reactions'
import { RichText } from './RichText'
import { Avatar, Button, Sweep, type ButtonVariant } from '../primitives'
import { AgentAvatar } from './AgentAvatar'
import { resolveAuthor, initialsOf } from '../author'
import { Reply, Thread, Edit, Trash } from '../icons'
import { useMedia } from '../MediaContext'
import { RichComposer } from '../composer/RichComposer'
import { richDocToHTML, escapeToParagraph } from '../composer/rich-to-html'
import type { ComposeResult } from '../compose'
import { t, GLYPH, getLocale } from '../i18n'

// Avatar monogram derived from a clean display name (P1: never an id) — lives in author.ts since the
// composer's suggestion popup shows it too; re-exported for the existing importers.
export { initialsOf }

// Wall-clock label for a message (HH:MM, 24 h). Derived from the clean domain timestamp — never an
// id. The catalog's locale, never the browser's (ADR-080 D3): the gutter is sized for "HH:MM".
export function timeOf(sentAt: Message['sentAt']): string {
  return new Date(sentAt as unknown as number).toLocaleTimeString(getLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

// The device-local calendar day of a timestamp: the identity of a day divider and of a day break in
// the grouping (manifest workspace.md §10 item 1). Local year/month/day, never a 24 h difference.
function dayKeyOf(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

const dayOf = (m: Message): string => dayKeyOf(m.sentAt as unknown as number)

// Day divider label (manifest workspace.md §10 item 2), in the catalog's locale (ADR-080 D3): the
// format has no catalog key, it is Intl's. Computed at render (it does not tick on its own).
export function dayLabelOf(sentAt: Message['sentAt'], now: number = Date.now()): string {
  const at = sentAt as unknown as number
  const today = new Date(now)
  if (dayKeyOf(at) === dayKeyOf(now)) return t('timeline.dayToday')
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (dayKeyOf(at) === dayKeyOf(yesterday.getTime())) return t('timeline.dayYesterday')
  const sameYear = new Date(at).getFullYear() === today.getFullYear()
  return new Intl.DateTimeFormat(getLocale(), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: sameYear ? undefined : 'numeric',
  }).format(at)
}

// Suffix of a thread summary (manifest workspace.md §11 item 6): the time when the latest reply is
// from today (device-local day), else its short date in the catalog's locale (ADR-080 D3). Computed
// at render (it does not tick on its own).
export function lastReplyOf(at: Message['sentAt'], now: number = Date.now()): string {
  const when = at as unknown as number
  if (dayKeyOf(when) === dayKeyOf(now)) return t('timeline.lastReplyAt', { time: timeOf(at) })
  return t('timeline.lastReplyOn', { date: shortDateOf(at, now) })
}

// The pinned panel's "atualizado às/em" (manifest workspace.md §17.4): the same two formatters as the
// thread summary (§11 item 6) — the time when it is from today (device-local day), else the short date.
export function updatedOf(at: Message['sentAt'], now: number = Date.now()): string {
  const when = at as unknown as number
  if (dayKeyOf(when) === dayKeyOf(now)) return t('panel.updatedAt', { time: timeOf(at) })
  return t('panel.updatedOn', { date: shortDateOf(at, now) })
}

// The short date of §11 item 6: day and short month in the catalog's locale, plus the year when it is
// not this year's.
function shortDateOf(at: Message['sentAt'], now: number): string {
  const when = at as unknown as number
  const sameYear = new Date(when).getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(getLocale(), {
    day: 'numeric',
    month: 'short',
    year: sameYear ? undefined : 'numeric',
  }).format(when)
}

// Relative label for a moment ("agora há pouco", "há 5 minutos", "ontem"), no locale do catálogo
// (ADR-080 D3). Derived from the clean domain timestamp; computed at render (it does not tick on its
// own).
export function relativeTimeOf(at: Message['sentAt'], now: number = Date.now()): string {
  const seconds = Math.round(((at as unknown as number) - now) / 1000)
  if (seconds > -60) return t('timeline.justNow')
  const relative = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' })
  const minutes = Math.round(seconds / 60)
  if (minutes > -60) return relative.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours > -24) return relative.format(hours, 'hour')
  return relative.format(Math.round(hours / 24), 'day')
}

// Short, protocol-free excerpt of a message body for the quoted reply preview (and the composer's
// reply indicator). Always derived from clean domain fields — never an id.
export function excerptOf(body: MessageBody): string {
  switch (body.kind) {
    // ADR-091: a card is quoted by the text of its request.
    case 'text':
    case 'approval': {
      const flat = body.text.replace(/\s+/g, ' ').trim()
      return flat.length > 80 ? `${flat.slice(0, 79)}${GLYPH.ellipsis}` : flat
    }
    case 'image':
      return `${GLYPH.image} ${body.alt ?? t('timeline.image')}`
    case 'file':
      return `${GLYPH.file} ${body.name}`
    case 'unsupported':
      return t('timeline.unsupported')
    case 'unavailable':
      // ADR-057 dec. 7: graduated but still neutral — 'awaited' reads as in-flight; 'stalled'
      // keeps the promise-free label. PR-5 lean (proposta p/ ratificação no PR): 'lost' mantém
      // a MESMA copy de 'stalled' — a distinção é de contrato, não de superfície, nesta fatia.
      return body.arrival === 'awaited' ? t('timeline.awaited') : t('timeline.unavailable')
  }
}

// The quoted preview of a reply's target, resolved by the PARENT against the already-loaded
// timeline (PLANO-FASE-1-REPLY §0.5 — no new read verb; lookup by id in useChat's state). `loaded: false`
// is the degraded preview: target outside the loaded window → a neutral, non-clickable label.
// `onJump` (only when loaded) scrolls to the target row. The UI never decides what is a reply —
// it only renders Message.replyTo (ADR-007).
export interface QuotedPreview {
  loaded: boolean
  author?: string
  // ADR-086: the quoted author is an agent — the preview carries the agent avatar beside the name.
  authorAgent?: AgentColor
  excerpt?: string
  onJump?: () => void
}

// Image body: lazily resolves a MediaRef → blob URL (ADR-009). Shows alt text while pending; on
// failure the alt placeholder stays and offers a retry (ADR-007 §3 — visible, never a silent drop).
// With the domain's dimensions (§8.27 B) the box is reserved BEFORE the bytes arrive: the <img>
// carries width/height and the CSS fits it by aspect ratio (--image-ratio), and the pending state
// is a box of the same shape — so the timeline does not grow when the image loads. Without
// dimensions the Timeline re-anchors to the bottom when the row grows (see Timeline).
function ImageBody({ body }: { body: Extract<MessageBody, { kind: 'image' }> }) {
  const media = useMedia(body.media, 'thumbnail')
  const sized = body.width !== undefined && body.height !== undefined && body.width > 0 && body.height > 0
  const ratioStyle = sized ? ({ '--image-ratio': body.width! / body.height! } as CSSProperties) : undefined
  if (media.status === 'ready' && media.url) {
    return (
      <img
        className={sized ? 'message__image message__image--sized' : 'message__image'}
        src={media.url}
        alt={body.alt ?? t('timeline.imageAlt')}
        width={sized ? body.width : undefined}
        height={sized ? body.height : undefined}
        style={ratioStyle}
      />
    )
  }
  if (sized && media.status !== 'failed') {
    return (
      <span className="message__image message__image--sized message__image--pending" style={ratioStyle} role="img" aria-label={body.alt ?? t('timeline.image')} />
    )
  }
  return (
    <span className="message__body">
      {GLYPH.image} {body.alt ?? t('timeline.image')}
      {media.status === 'failed' && (
        <button type="button" className="message__retry" onClick={media.retry}>
          {t('timeline.retry')}
        </button>
      )}
    </span>
  )
}

// File body: resolves to a downloadable object URL. Waiting and failure are distinct on screen —
// a neutral "downloading" indicator vs. a failure line with a retry.
function FileBody({ body }: { body: Extract<MessageBody, { kind: 'file' }> }) {
  const media = useMedia(body.media)
  if (media.status === 'ready' && media.url) {
    return (
      <a className="message__file" href={media.url} download={body.name}>
        {GLYPH.file} {body.name}
      </a>
    )
  }
  return (
    <span className="message__body">
      {GLYPH.file} {body.name}{' '}
      {media.status === 'failed' ? (
        <>
          <span className="message__status message__status--failed">{t('timeline.downloadFailed')}</span>
          <button type="button" className="message__retry" onClick={media.retry}>
            {t('timeline.retry')}
          </button>
        </>
      ) : (
        <span className="message__status">
          <span className="message__spinner" aria-hidden="true" />
          {t('timeline.downloading')}
        </span>
      )}
    </span>
  )
}

type ApprovalBody = Extract<MessageBody, { kind: 'approval' }>
type ApprovalOptionStyle = ApprovalBody['options'][number]['style']

// Manifest workspace.md §17.3: the option's style → the Button primitive's role.
const APPROVAL_VARIANT: Record<NonNullable<ApprovalOptionStyle>, ButtonVariant> = { primary: 'fill', danger: 'danger' }

// ADR-091 (Proposto); manifest workspace.md §17.1 and §18. The approval card, inside the agent's normal
// row: label · request · footer. Local to this surface (one consumer, MessageRow — the ThreadPanel
// renders through it too; below the ADR-036 dec. 3 bar). The footer follows the state the ACL
// aggregated — the answer line ("{name} às {hora}") comes from the answer's real author, never from text
// the agent wrote (P6). Pending: one click answers (§17.1 item 4); the viewer's own answer folds in as
// 'sending' (item 5) or 'failed' (item 6) while the card is open — the ACL decides, the card only shows.
// Accessibility: the clicked control goes away with the state, so the click moves focus to the card's
// group first (programmatic, no ring — the account-settings subtitle's precedent); from the click on, the
// footer is a polite live region, so the new state is announced without taking the focus. Only after
// the viewer's own click: a card resolving on load (or by someone else) is not announced.
function ApprovalCard({
  body,
  usersById,
  selfId,
  onAnswer,
  formReply,
}: {
  body: ApprovalBody
  usersById: Record<string, User>
  selfId?: UserId
  onAnswer?: (option: string) => void
  // ADR-103 (Proposto): who answered a form the agent opened from this card (§26 item 8).
  formReply?: Message['formReply']
}) {
  const labelId = useId()
  const groupRef = useRef<HTMLDivElement>(null)
  const [engaged, setEngaged] = useState(false)
  const state = body.state
  const answer = (option: string): void => {
    if (!onAnswer) return
    // The live region first (its own commit), so the state that follows is announced; then the focus.
    if (!engaged) flushSync(() => setEngaged(true))
    groupRef.current?.focus()
    onAnswer(option)
  }
  const labelOf = (option: string): string => body.options.find((o) => o.id === option)?.label ?? ''
  let footer
  switch (state.kind) {
    case 'open':
      footer = (
        <div className="approval__options">
          {body.options.map((o) => (
            <Button
              key={o.id}
              size="gestao"
              variant={o.style ? APPROVAL_VARIANT[o.style] : 'secondary'}
              disabled={!onAnswer}
              onClick={onAnswer ? () => answer(o.id) : undefined}
            >
              {o.label}
            </Button>
          ))}
        </div>
      )
      break
    // §17.1 item 5, the idiom of §10 item 5: the chosen option's pill dimmed, "Enviando…" legible.
    case 'sending':
      footer = (
        <div className="approval__footer">
          <span className="approval__pill approval__pill--sending">{labelOf(state.option)}</span>
          <span className="approval__by">{t('timeline.sending')}</span>
        </div>
      )
      break
    // §17.1 item 6, the idiom of §10 item 6: muted pill, "Não enviado" in danger · muted separator ·
    // "Tentar de novo", the timeline row's retry recipe — it answers again with the same option.
    case 'failed':
      footer = (
        <div className="approval__footer">
          <span className="approval__pill approval__pill--failed">{labelOf(state.option)}</span>
          <span className="message__status--failed">{t('timeline.failed')}</span>
          {onAnswer && (
            <>
              <span aria-hidden="true">{GLYPH.dot}</span>
              <button type="button" className="message__retry-inline" onClick={() => answer(state.option)}>
                {t('timeline.retry')}
              </button>
            </>
          )}
        </div>
      )
      break
    case 'answered': {
      const name =
        selfId !== undefined && state.by === selfId
          ? t('timeline.you')
          : resolveAuthor({ author: state.by }, usersById, t('timeline.someone')).name
      const time = timeOf(state.at)
      const option = state.option !== undefined ? body.options.find((o) => o.id === state.option) : undefined
      footer = (
        <div className="approval__footer">
          {option ? (
            <>
              <span className="approval__pill">{option.label}</span>
              <span className="approval__by">{t('approval.answered', { name, time })}</span>
            </>
          ) : (
            <span className="approval__by">{t('approval.answeredNoOption', { name, time })}</span>
          )}
        </div>
      )
      break
    }
    case 'closed':
      footer = (
        <div className="approval__footer">
          <span className="approval__by">{t('approval.closed')}</span>
        </div>
      )
      break
    case 'multi':
      footer = <MultiApprovalFooter state={state} options={body.options} usersById={usersById} selfId={selfId} onAnswer={onAnswer ? answer : undefined} />
      break
  }
  return (
    <div className="approval" role="group" aria-labelledby={labelId} ref={groupRef} tabIndex={-1}>
      <span className="approval__label" id={labelId}>
        {t('approval.title')}
      </span>
      {body.request ? <RichText doc={body.request} /> : <span className="message__body">{body.text}</span>}
      <div className="approval__slot" aria-live={engaged ? 'polite' : undefined} aria-atomic={engaged ? true : undefined}>
        {footer}
        {formReply && <span className="approval__form-reply">{formReplyLine(formReply, usersById, selfId)}</span>}
      </div>
    </div>
  )
}

type MultiState = Extract<ApprovalBody['state'], { kind: 'multi' }>

// A card that asks for several answers: the buttons only for a viewer who can still answer (the card not
// closed, not complete, no answer of the viewer counted, none in flight); one line per answer in the
// server's order, with "Você" for the viewer's own and no pill for an answer not readable yet; the viewer's
// own answer in flight or not sent as the last line, in the idiom of the single-answer card; the counter
// while the card still takes answers; "Pedido encerrado" when it was closed short of the answers it asks
// for. A complete card shows only its lines. The answer line names the answer's real author, never text
// the agent wrote.
function MultiApprovalFooter({
  state,
  options,
  usersById,
  selfId,
  onAnswer,
}: {
  state: MultiState
  options: ApprovalBody['options']
  usersById: Record<string, User>
  selfId?: UserId
  onAnswer?: (option: string) => void
}) {
  const complete = state.answers.length >= state.needed
  const answeredBySelf = selfId !== undefined && state.answers.some((a) => a.by === selfId)
  const buttons = !state.closed && !complete && !answeredBySelf && state.own === undefined
  const own = state.own
  const ownLabel = own ? (options.find((o) => o.id === own.option)?.label ?? '') : ''
  const lines = state.answers.length > 0 || own !== undefined
  return (
    <div className="approval__multi">
      {buttons && (
        <div className="approval__options">
          {options.map((o) => (
            <Button
              key={o.id}
              size="gestao"
              variant={o.style ? APPROVAL_VARIANT[o.style] : 'secondary'}
              disabled={!onAnswer}
              onClick={onAnswer ? () => onAnswer(o.id) : undefined}
            >
              {o.label}
            </Button>
          ))}
        </div>
      )}
      {lines && (
        <div className="approval__answers">
          {state.answers.map((a) => {
            const name = selfId !== undefined && a.by === selfId ? t('timeline.you') : resolveAuthor({ author: a.by }, usersById, t('timeline.someone')).name
            const time = timeOf(a.at)
            const option = a.option !== undefined ? options.find((o) => o.id === a.option) : undefined
            return (
              <div className="approval__footer" key={a.by}>
                {option ? (
                  <>
                    <span className="approval__pill">{option.label}</span>
                    <span className="approval__by">{t('approval.answered', { name, time })}</span>
                  </>
                ) : (
                  <span className="approval__by">{t('approval.answeredNoOption', { name, time })}</span>
                )}
              </div>
            )
          })}
          {own?.status === 'sending' && (
            <div className="approval__footer">
              <span className="approval__pill approval__pill--sending">{ownLabel}</span>
              <span className="approval__by">{t('timeline.sending')}</span>
            </div>
          )}
          {own?.status === 'failed' && (
            <div className="approval__footer">
              <span className="approval__pill approval__pill--failed">{ownLabel}</span>
              <span className="message__status--failed">{t('timeline.failed')}</span>
              {onAnswer && (
                <>
                  <span aria-hidden="true">{GLYPH.dot}</span>
                  <button type="button" className="message__retry-inline" onClick={() => onAnswer(own.option)}>
                    {t('timeline.retry')}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {!complete && (
        <span className="approval__count">
          {state.closed
            ? t('approval.closed')
            : state.answers.length === 0
              ? t('approval.needs', { n: state.needed })
              : t('approval.progress', { k: state.answers.length, n: state.needed })}
        </span>
      )}
    </div>
  )
}

// ADR-103 (Proposto), workspace.md §26 item 8 (fork I5): "{nome} respondeu às {hora}", "Você" for the
// viewer. The name comes from the answer's real author, never from text the agent wrote (P6).
function formReplyLine(reply: NonNullable<Message['formReply']>, usersById: Record<string, User>, selfId?: UserId): string {
  const name = selfId !== undefined && reply.by === selfId ? t('timeline.you') : resolveAuthor({ author: reply.by }, usersById, t('timeline.someone')).name
  return t('form.replied', { name, time: timeOf(reply.at) })
}

// 'unsupported' is the visible branded D3 placeholder (ADR-007 §3 — content-carrying
// degradation is never a silent drop). `usersById`/`selfId` only serve the approval card's answer line.
function MessageBodyView({
  body,
  usersById = {},
  selfId,
  onAnswer,
  command,
  formReply,
}: {
  body: MessageBody
  usersById?: Record<string, User>
  selfId?: UserId
  onAnswer?: (option: string) => void
  formReply?: Message['formReply']
  // ADR-093 (Proposto): the message's `/` command — its chip replaces the leading "/nome" (§21.1 item 8).
  command?: Message['command']
}) {
  switch (body.kind) {
    case 'text': {
      // ADR-012: prefer the structured RichDoc (rendered via JSX, never raw HTML injection); fall
      // back to the plain text when the message carried no formatting.
      // PLANO-AGENTES §0.3.24 item 5: with Message.command the leading "/nome" is drawn as the chip and the
      // arguments stay text. The ACL guarantees the shown text starts with "/nome"; a rich body whose first
      // run does not (never produced by the composer) renders as it is.
      const prefix = command ? `/${command.name}` : undefined
      const chip = prefix ? <span className="message__command">{prefix}</span> : null
      if (body.rich) {
        const rest = prefix ? richWithoutPrefix(body.rich, prefix) : undefined
        return rest ? <RichText doc={rest} lead={chip} /> : <RichText doc={body.rich} />
      }
      return prefix && body.text.startsWith(prefix) ? (
        <span className="message__body">
          {chip}
          {body.text.slice(prefix.length)}
        </span>
      ) : (
        <span className="message__body">{body.text}</span>
      )
    }
    case 'approval':
      return <ApprovalCard body={body} usersById={usersById} selfId={selfId} onAnswer={onAnswer} formReply={formReply} />
    case 'image':
      return <ImageBody body={body} />
    case 'file':
      return <FileBody body={body} />
    case 'unsupported':
      return <span className="message__body message__body--unsupported">{t('timeline.unsupported')}</span>
    // ADR-015: neutral product placeholder — no technical term ("encrypted", "key", "decrypt"
    // never reach the DOM; the render-scan sweeps for them). Same visual treatment as a message
    // body; it never blocks the timeline (P4). Transient: an upgrade arrives as message.edited.
    // ADR-057 dec. 7: the copy graduates with `arrival`, neutral and transitory —
    // 'awaited' ("pode ainda chegar") reads as in-flight; 'stalled' ("não chega por este canal")
    // keeps the promise-free label. PR-5 lean (proposta p/ ratificação no corpo do PR): 'lost'
    // (veredito definitivo, custódia consultada) usa a MESMA copy de 'stalled' — a distinção é
    // de contrato, não de superfície, nesta fatia.
    case 'unavailable':
      return (
        <span className="message__body message__body--unavailable">
          {body.arrival === 'awaited' ? t('timeline.awaited') : t('timeline.unavailable')}
        </span>
      )
  }
}

// The RichDoc without the leading "/nome" of a command, when its first block is a paragraph whose first run
// is text starting with it; undefined otherwise.
function richWithoutPrefix(doc: RichDoc, prefix: string): RichDoc | undefined {
  const [first, ...blocks] = doc
  if (!first || first.t !== 'p') return undefined
  const [lead, ...inline] = first.children
  if (!lead || lead.t !== 'text' || !lead.text.startsWith(prefix)) return undefined
  const remaining = lead.text.slice(prefix.length)
  return [{ t: 'p', children: remaining ? [{ t: 'text', text: remaining }, ...inline] : inline }, ...blocks]
}

// One rendered message. Author is resolved to a clean display name via the members map; if unknown
// we show a neutral label — NEVER the author's opaque id (P1). message.id lives only in the React
// key. Send status (ADR-010) renders as a dimmed 'pending' body or a muted 'failed' body with Retry.
// Shared by the main Timeline and the ThreadPanel so both render identically and pass the same P1
// render-scan. `onOpenThread` (only meaningful on a main-timeline message) surfaces the
// "Reply in thread" affordance; the UI passes a domain Message and never routes by protocol.
export function MessageRow({
  message: m,
  usersById,
  onRetry,
  onReact,
  onOpenThread,
  onEdit,
  onDelete,
  onReply,
  onOpenProfile,
  quoted,
  rowRef,
  isGroupStart = true,
  avatarLabel,
  mine,
  presence,
  threadUnread = false,
  highlighted = false,
  onHighlightEnd,
  selfId,
  onAnswer,
}: {
  message: Message
  usersById: Record<string, User>
  onRetry?: (message: Message) => void
  onReact?: (message: Message, emoji: string) => void
  onOpenThread?: (message: Message) => void
  // Edit one's OWN text message. The rich edit editor (ADR-051 PR-5b) produces the ComposeResult
  // ({text, rich?}) directly — no markdown parse downstream — which useChat hands to the ACL's
  // editMessage. Shown only when the message is mine (ADR-012 slice).
  onEdit?: (message: Message, body: ComposeResult) => void
  // Delete one's OWN message (ADR-075), after an inline two-step confirmation in the action bar.
  onDelete?: (message: Message) => void
  // Start a reply to this message (main timeline only — same scoping as the thread affordance).
  onReply?: (message: Message) => void
  // Perfil-de-outro (ADR-043, Slice 2 PR-2): abre o perfil do AUTOR. Recebe o UserId opaco (m.author)
  // — direto, sem cast — e o repassa ao Workspace, que mostra o UserProfileDialog. Optional-chained:
  // quando ausente (harness bare), o click é no-op. Só faz sentido no header (isGroupStart).
  onOpenProfile?: (user: UserId) => void
  // Quoted preview of this message's reply target, resolved by the parent (see QuotedPreview).
  quoted?: QuotedPreview
  // Lets the parent track the rendered row for scroll-to-target — by ref, never an id in the DOM
  // (the render-scan sweeps innerHTML, so a protocol-shaped id in an attribute would be a leak).
  rowRef?: (el: HTMLElement | null) => void
  // ── Optional group context (the main Timeline supplies these; the ThreadPanel does NOT, so it
  //    keeps the flat author-per-message layout — same component, default = current behaviour).
  // First message of a consecutive-same-author run → renders avatar + header; a continuation
  // renders body-only with a muted timestamp in the gutter.
  isGroupStart?: boolean
  // Two-char monogram for the gutter avatar, derived from the clean display name (P1). Its presence
  // is what switches MessageRow into the grouped gutter layout.
  avatarLabel?: string
  // This run is the viewer's own (the accent avatar). Opt-in: the harness bare omits it.
  mine?: boolean
  // Presença do autor no avatar de group-start (ADR-056 rollout, §8.4). Opt-in como `mine`: o
  // ThreadPanel e o harness bare a omitem → o Avatar fica byte-idêntico (ADR-036 addendum).
  presence?: Presence
  // This message's thread has a reply the viewer has not read (ADR-067), from getThreadUnread via the
  // parent. Drives the marker on the thread summary; false / absent → no marker.
  threadUnread?: boolean
  // The target of a search jump (manifest workspace.md §8 item 9): `data-highlight` on the row, which
  // the CSS pulses on color-highlight-wash for motion-duration-linger; the attribute drops when the
  // animation ends (onHighlightEnd). A flag, never an id, in the DOM (P1).
  highlighted?: boolean
  onHighlightEnd?: () => void
  // The viewer's own id, opaque, only to read an approval card's answer as "Você" (§17.1 item 7).
  selfId?: UserId
  // Answer an approval card with one of its options (ADR-091 dec. 14) — absent, its buttons stay disabled.
  onAnswer?: (message: Message, option: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const cancelDeleteRef = useRef<HTMLButtonElement>(null)
  // Foto do autor (ADR-041 PR-2): resolve o avatar opaco do autor → URL só no group-start (uma
  // continuação passa undefined → useMedia é no-op). O Avatar cai pro monograma sem foto. P1: o
  // mr_*/mxc fica aqui+ACL, nunca no DOM (render-scan prova).
  const authorAvatar = useMedia(isGroupStart ? usersById[m.author]?.avatar : undefined, 'thumbnail').url
  // Only a settled, own, text message is editable (rich caption on media is out of scope, §8).
  // ADR-093 (Proposto), PLANO-AGENTES §0.3.24 item 7: a command message offers no edit (delete stays).
  const canEdit =
    !!onEdit && m.mine === true && m.body.kind === 'text' && m.status !== 'pending' && m.command === undefined
  // ADR-075: own, sent, and not a thread root with replies (without a tombstone they would be
  // orphaned). Any body kind. A failed message never reached the server — redacting it would 404 and
  // the UI swallows it; a local discard verb is a trigger (§8.52).
  // ADR-091: a card's line offers neither Edit nor Delete (manifest workspace.md §17.1).
  const canDelete =
    !!onDelete &&
    m.body.kind !== 'approval' &&
    m.mine === true &&
    (m.status === undefined || m.status === 'sent') &&
    !(m.threadSummary && m.threadSummary.replyCount > 0)
  // The confirmation opens on the safe choice: focus lands on "Cancelar", which also keeps the bar
  // shown (focus-within) and lets Esc reach the confirmation's key handler.
  useEffect(() => {
    if (confirmingDelete) cancelDeleteRef.current?.focus()
  }, [confirmingDelete])

  // The editor seeds itself from the message's HTML (initialHTML below), so startEdit only flips the
  // mode — no draft string to prime.
  const startEdit = (): void => setEditing(true)

  // PLANO-AGENTES §0.3.11: the member map, else the portrait at the event (an author who left).
  const resolved = resolveAuthor(m, usersById, t('timeline.someone'))
  const author = resolved.name
  // One's own header reads "Você" (§11 item 7); the profile button's name stays the display name.
  const authorLabel = m.mine === true ? t('timeline.you') : author
  // ADR-086: an agent's avatar is the mark (glyph + colour + blue indicator), never the monogram.
  const authorAgent = resolved.agentColor
  // Only the row's own highlight animation ends it — not a spinner or a reaction inside the row.
  const endHighlight = (e: AnimationEvent<HTMLElement>): void => {
    if (e.target === e.currentTarget && HIGHLIGHT_ANIMATIONS.has(e.animationName)) onHighlightEnd?.()
  }
  // The gutter layout is active only when the parent supplied an avatar label (the Timeline does;
  // the ThreadPanel does not — it falls through to the flat layout below).
  const grouped = avatarLabel !== undefined

  const className = [
    'message',
    grouped ? 'message--grouped' : null,
    grouped && !isGroupStart ? 'message--cont' : null,
    mine ? 'message--mine' : null,
    m.mentionsMe ? 'message--mentions-me' : null,
    m.status ? `message--${m.status}` : null,
  ]
    .filter(Boolean)
    .join(' ')

  // Shared body/affordance fragments — identical in both layouts; only their wrapping differs.
  const quotedBlock = quoted ? (
    quoted.loaded ? (
      <button type="button" className="message__quote" onClick={quoted.onJump} aria-label={t('timeline.repliedMessage')}>
        {quoted.authorAgent !== undefined && <AgentAvatar color={quoted.authorAgent} size="gestao" />}
        <span className="message__quote-author">{quoted.author}</span>
        <span className="message__quote-text">{quoted.excerpt}</span>
      </button>
    ) : (
      // Degraded preview: the target is outside the loaded window. Neutral label, NOT clickable
      // (jump-with-backfill is deferred — PLANO-FASE-1-REPLY §0.5/§8).
      <span className="message__quote message__quote--unavailable">{t('timeline.earlierMessage')}</span>
    )
  ) : null

  // Edit surface (ADR-051 PR-5b): the WYSIWYG island in edit mode replaces the old single-line
  // <input>. It seeds from the message's rich (richDocToHTML) or, for a plain message, its escaped
  // text (escapeToParagraph) — so a FORMATTED message re-opens WITH its formatting and saves the rich
  // (no flatten). Save hands the ComposeResult to onEdit; Cancel/Esc drops the edit. onSend is unused
  // in edit mode (a required prop) — a no-op. No `users` → no mention picker (parity: editMessage
  // carries no mentions). Rendered only for a text body (canEdit already guarantees it).
  const bodyBlock =
    editing && m.body.kind === 'text' ? (
      <span className="message__edit">
        <RichComposer
          onSend={() => {}}
          initialHTML={m.body.rich ? richDocToHTML(m.body.rich) : escapeToParagraph(m.body.text)}
          onSave={(body) => {
            setEditing(false)
            onEdit?.(m, body)
          }}
          onCancel={() => setEditing(false)}
        />
      </span>
    ) : (
      <MessageBodyView
        body={m.body}
        usersById={usersById}
        selfId={selfId}
        onAnswer={onAnswer ? (option) => onAnswer(m, option) : undefined}
        command={m.command}
        formReply={m.formReply}
      />
    )

  // Always this wrapper, in every state: the send states dim the body alone (§10 items 5–6), and a
  // wrapper that came and went with the status would remount the body when the message settles.
  const contentBlock = (
    <div className="message__content">
      {quotedBlock}
      {bodyBlock}
    </div>
  )

  // A card's close is an edit of its author; the card shows the close, never "(editada)" (§17.1).
  const editedBlock = m.editedAt !== undefined && m.body.kind !== 'approval' ? <span className="message__edited">{t('timeline.edited')}</span> : null
  const editOpenBlock =
    canEdit && !editing ? (
      <button type="button" className="message__edit-open" onClick={startEdit} title={t('timeline.editMessage')} aria-label={t('timeline.editMessage')}>
        <Edit />
      </button>
    ) : null

  const deleteOpenBlock =
    canDelete && !editing && !confirmingDelete ? (
      <button
        type="button"
        className="message__delete-open"
        onClick={() => setConfirmingDelete(true)}
        title={t('timeline.deleteMessage')}
        aria-label={t('timeline.deleteMessage')}
      >
        <Trash />
      </button>
    ) : null

  // Calm send/fail states (C6, manifest workspace.md §10 items 5–6): no spinner, no alert background.
  // "Failed" and its Retry stay visible under the body, always — never only on hover.
  const statusBlock = (
    <>
      {m.status === 'pending' && <span className="message__status message__status--send">{t('timeline.sending')}</span>}
      {m.status === 'failed' && (
        <span className="message__status message__status--send">
          <span className="message__status--failed">{t('timeline.failed')}</span>
          {onRetry && (
            <>
              <span aria-hidden="true">{GLYPH.dot}</span>
              <button type="button" className="message__retry-inline" onClick={() => onRetry(m)}>
                {t('timeline.retry')}
              </button>
            </>
          )}
        </span>
      )}
    </>
  )

  // Under the body when the message mentions the viewer (manifest workspace.md §11 item 1).
  const mentionBlock = m.mentionsMe ? (
    <span className="message__mention">
      <span className="message__mention-dot" aria-hidden="true" />
      {t('timeline.mentionsYou')}
    </span>
  ) : null

  // ADR-093 (Proposto), workspace.md §21.1 item 8: "comando para {agente}" under the body of a command
  // message, where "menção a você" sits — in a continuation and in the thread too.
  // ADR-103 (Proposto), §26 item 8: who answered a form the agent opened from the command, under that line.
  const commandBlock = m.command ? (
    <>
      <span className="message__command-line">
        {t('timeline.commandFor', { agent: usersById[m.command.agent]?.displayName ?? t('timeline.someone') })}
      </span>
      {m.formReply && <span className="message__form-reply">{formReplyLine(m.formReply, usersById, selfId)}</span>}
    </>
  ) : null

  // Only with a reaction: a message without one reserves no line (§11 items 2 and 8, #277).
  const reactionsBlock = onReact ? <Reactions reactions={m.reactions} onToggle={(emoji) => onReact(m, emoji)} /> : null

  // Never on a pending message: a reaction needs a real target, like reply and thread below.
  const reactOpenBlock =
    onReact && m.status !== 'pending' ? (
      <QuickReact className="message__react-open" onPick={(emoji) => onReact(m, emoji)} />
    ) : null

  // Reply affordance: main timeline only and never on a pending message — the target needs a REAL
  // event id (PLANO-FASE-1-REPLY §6); the ACL still fails loud if called. Mirrors the thread affordance.
  const replyOpenBlock =
    onReply && m.threadParent === undefined && m.status !== 'pending' ? (
      <button type="button" className="message__reply-open" onClick={() => onReply(m)} title={t('timeline.reply')} aria-label={t('timeline.reply')}>
        <Reply />
      </button>
    ) : null
  // Only main-timeline messages open a thread (a thread reply has a threadParent).
  const threadOpenBlock =
    onOpenThread && m.threadParent === undefined && m.status !== 'pending' ? (
      <button type="button" className="message__thread-open" onClick={() => onOpenThread(m)} title={t('timeline.replyInThread')} aria-label={t('timeline.replyInThread')}>
        <Thread />
      </button>
    ) : null

  // Thread summary (ADR-066): under a main-timeline root that has replies — "N replies", when the
  // latest one was sent, and the unread marker: a dot without a number named "Unread replies"
  // (ADR-067 — a boolean, the same in encrypted and cleartext rooms). Opens the thread through the
  // SAME path as "Reply in thread". Only where a thread can be opened (the ThreadPanel's root
  // rendering passes no onOpenThread → no summary there).
  const summary = m.threadSummary
  const threadSummaryBlock =
    onOpenThread && summary && m.threadParent === undefined ? (
      <button type="button" className="message__thread-summary" onClick={() => onOpenThread(m)}>
        <span>
          {t('timeline.replies', { n: summary.replyCount })}{' '}
          <span className="message__thread-last">
            {GLYPH.dot} {lastReplyOf(summary.latestReplyAt)}
          </span>
        </span>
        {threadUnread && <span className="unread-dot" role="img" aria-label={t('timeline.unreadReplies')} />}
      </button>
    ) : null

  // Action bar (OG-6, manifest workspace.md §11 item 4): the per-message affordances in one card
  // revealed on hover and focus — React · Reply · Thread, then Edit · Delete on one's own. Touch
  // fallback is deferred to Fase 3 with OG-5.
  // While a delete is being confirmed (ADR-075 dec. 4) the bar holds only the question and its two
  // answers, in the edit mode's inline idiom; it stays shown without hover. Esc cancels.
  const actionsBlock =
    confirmingDelete && canDelete ? (
      <span
        className="message__actions message__actions--confirming"
        onKeyDown={(e) => {
          if (e.key === 'Escape') setConfirmingDelete(false)
        }}
      >
        <span className="message__delete-question">{t('timeline.deleteQuestion')}</span>
        <button
          type="button"
          className="message__delete-confirm"
          onClick={() => {
            setConfirmingDelete(false)
            onDelete?.(m)
          }}
        >
          {t('timeline.delete')}
        </button>
        <button
          type="button"
          className="message__delete-cancel"
          ref={cancelDeleteRef}
          onClick={() => setConfirmingDelete(false)}
        >
          {t('timeline.cancel')}
        </button>
      </span>
    ) : reactOpenBlock || editOpenBlock || deleteOpenBlock || replyOpenBlock || threadOpenBlock ? (
      <span className="message__actions">
        {reactOpenBlock}
        {replyOpenBlock}
        {threadOpenBlock}
        {editOpenBlock}
        {deleteOpenBlock}
      </span>
    ) : null

  // Flat layout (ThreadPanel and any caller that supplies no group context) — unchanged.
  if (!grouped) {
    return (
      <article
        ref={rowRef}
        className={className}
        aria-busy={m.status === 'pending' ? 'true' : undefined}
        data-highlight={highlighted ? 'true' : undefined}
        onAnimationEnd={highlighted ? endHighlight : undefined}
      >
        {authorAgent !== undefined && <AgentAvatar color={authorAgent} size="gestao" />}
        <span className="message__author">{authorLabel}</span>
        {contentBlock}
        {editedBlock}
        {statusBlock}
        {commandBlock}
        {mentionBlock}
        {reactionsBlock}
        {threadSummaryBlock}
        {actionsBlock}
      </article>
    )
  }

  // Grouped layout: an avatar/timestamp gutter beside a content column. The first row of a run
  // carries the avatar + author header; continuations carry only a muted timestamp in the gutter.
  return (
    <article
        ref={rowRef}
        className={className}
        aria-busy={m.status === 'pending' ? 'true' : undefined}
        data-highlight={highlighted ? 'true' : undefined}
        onAnimationEnd={highlighted ? endHighlight : undefined}
      >
      <span className="message__avatar">
        {isGroupStart ? (
          // Afordância de perfil-de-outro (ADR-043): o avatar do autor abre o perfil. O Avatar é
          // decorativo (aria-hidden); o aria-label do botão carrega o NOME limpo, nunca o id (P1).
          <button
            type="button"
            className="message__author-open message__author-open--avatar"
            onClick={() => onOpenProfile?.(m.author)}
            aria-label={t('timeline.viewProfile', { name: author })}
          >
            {authorAgent !== undefined ? (
              <AgentAvatar color={authorAgent} />
            ) : (
              <Avatar label={avatarLabel} src={authorAvatar} size="cotidiano" variant={mine ? 'accent' : 'greige'} presence={presence} />
            )}
          </button>
        ) : m.status === 'pending' ? (
          <span className="message__time-rail" aria-hidden="true">{GLYPH.dot}</span>
        ) : m.status === 'failed' ? (
          <span className="message__time-rail message__time-rail--failed" aria-hidden="true">{GLYPH.failed}</span>
        ) : (
          <span className="message__time-rail">{timeOf(m.sentAt)}</span>
        )}
      </span>
      <div className="message__main">
        {isGroupStart && (
          <span className="message__meta">
            {/* O nome do autor também abre o perfil (ADR-043). aria-label com o nome limpo (P1). */}
            <button
              type="button"
              className="message__author-open"
              onClick={() => onOpenProfile?.(m.author)}
              aria-label={t('timeline.viewProfile', { name: author })}
            >
              <span className="message__author">{authorLabel}</span>
            </button>
            <span className="message__timestamp">{timeOf(m.sentAt)}</span>
          </span>
        )}
        {contentBlock}
        {editedBlock}
        {statusBlock}
        {commandBlock}
        {mentionBlock}
        {reactionsBlock}
        {threadSummaryBlock}
        {actionsBlock}
      </div>
    </article>
  )
}

// The keyframes that end a row's highlight (styles.css): the pulse, or under reduced motion the fade
// that follows the solid hold.
const HIGHLIGHT_ANIMATIONS = new Set(['highlight-linger', 'highlight-out'])

// How close to the bottom still counts as "at the bottom" — absorbs sub-pixel scroll positions
// (zoom, fractional row heights), so a reader at the end is not mistaken for one reading history.
const BOTTOM_SLACK_PX = 8

// Main timeline.
export function Timeline({
  messages,
  usersById,
  onRetry,
  onReact,
  onOpenThread,
  onEdit,
  onDelete,
  onReply,
  onOpenProfile,
  presenceOf,
  threadUnreadOf,
  onLoadOlder,
  jumping = false,
  highlight,
  onHighlightEnd,
  selfId,
  onAnswer,
}: {
  messages: Message[]
  usersById: Record<string, User>
  onRetry?: (message: Message) => void
  onReact?: (message: Message, emoji: string) => void
  onOpenThread?: (message: Message) => void
  onEdit?: (message: Message, body: ComposeResult) => void
  onDelete?: (message: Message) => void
  onReply?: (message: Message) => void
  // Perfil-de-outro (ADR-043): repassado a cada MessageRow pra abrir o perfil do autor (mesmo
  // caminho de onReply/onOpenThread). Só o header (isGroupStart) o usa.
  onOpenProfile?: (user: UserId) => void
  // Presença de linha (ADR-056 rollout, §8.4): leitura síncrona mapa-primeiro composta pelo
  // Workspace (presenceByUser[id] ?? onGetPresence(id) — caminho (b)). Opcional: o harness bare a
  // omite e o avatar de group-start fica sem a prop (DOM byte-idêntico, ADR-036 addendum).
  presenceOf?: (user: UserId) => Presence
  // Whether a root's thread has an unread reply (ADR-067), composed by the Workspace from useChat's
  // per-root map. Optional: absent → no marker.
  threadUnreadOf?: (root: Message) => boolean
  // The viewer's own id, opaque — an approval card's answer by the viewer reads "Você" (§17.1 item 7).
  selfId?: UserId
  // Answer an approval card (ADR-091 dec. 14), repassed to each MessageRow.
  onAnswer?: (message: Message, option: string) => void
  onLoadOlder?: () => void
  // A search jump in flight (manifest workspace.md §8 item 10): the sticky pill on top, and the rows
  // inert while it lasts — the timeline does not dim (§6.1).
  jumping?: boolean
  // The row a jump reached (§8 item 9): scrolled to the centre and highlighted.
  highlight?: { id: MessageId; seq: number }
  onHighlightEnd?: () => void
}) {
  // Rendered rows by message id, for the quoted preview's scroll-to-target. Kept in memory only —
  // ids never reach a DOM attribute (the render-scan sweeps innerHTML).
  const rowsById = useRef(new Map<string, HTMLElement>())

  // Bottom anchoring (§8.27 B). The timeline opens at its latest message and stays there while the
  // reader is at the bottom: new messages, and rows that grow after render (an image without
  // dimensions loading), re-anchor it. A reader who scrolled up to read history is never pulled
  // down — `atBottom` flips off on their scroll and only their own scroll back turns it on. The
  // Workspace remounts the Timeline per channel, so each conversation opens anchored.
  const scrollerRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  // Last scrollTop seen, so a scroll event can tell the reader moving UP from content growing below.
  // Growth alone never lets go of the bottom: the scroll event of our own anchoring can be dispatched
  // after the next row already grew (an image decoding), and reading only "distance to bottom" there
  // would mistake that growth for the reader leaving (the reload race measured in §8.27).
  const lastTop = useRef(0)
  const onScroll = (): void => {
    const el = scrollerRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX) atBottom.current = true
    else if (el.scrollTop < lastTop.current) atBottom.current = false
    lastTop.current = el.scrollTop
  }
  const anchor = (): void => {
    const el = scrollerRef.current
    if (!el || !atBottom.current) return
    el.scrollTop = el.scrollHeight
    lastTop.current = el.scrollTop
  }
  const anchorRef = useRef(anchor)
  anchorRef.current = anchor
  // Before paint, so a new message never flashes above the fold.
  useLayoutEffect(() => anchorRef.current(), [messages])
  // Growth after render (image load, late decrypt, a reaction row) and viewport changes (composer
  // growing): observe the scroller and every row group. observe() is idempotent per element, so the
  // re-run on each messages change only adds the new groups.
  const observer = useRef<ResizeObserver | null>(null)
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => anchorRef.current())
    observer.current = ro
    return () => {
      ro.disconnect()
      observer.current = null
    }
  }, [])
  useEffect(() => {
    const el = scrollerRef.current
    const ro = observer.current
    if (!el || !ro) return
    ro.observe(el)
    for (const child of Array.from(el.children)) ro.observe(child)
  }, [messages])

  // A jump reached a row: centre it and let go of the bottom, so neither the anchoring nor a row that
  // grows afterwards pulls the reader away from it.
  useEffect(() => {
    if (!highlight) return
    const row = rowsById.current.get(highlight.id)
    if (!row) return
    atBottom.current = false
    row.scrollIntoView?.({ block: 'center' })
    lastTop.current = scrollerRef.current?.scrollTop ?? 0
  }, [highlight])

  // Resolve a reply's quoted preview against the ALREADY-LOADED timeline (PLANO-FASE-1-REPLY §0.5 —
  // lookup by id, no new read verb). Outside the window → degraded preview; loaded → clickable,
  // scrolls to the target row.
  const quotedFor = (m: Message): QuotedPreview | undefined => {
    if (m.replyTo === undefined) return undefined
    const target = messages.find((t) => t.id === m.replyTo)
    if (!target) return { loaded: false }
    const quotedAuthor = resolveAuthor(target, usersById, t('timeline.someone'))
    return {
      loaded: true,
      author: quotedAuthor.name,
      authorAgent: quotedAuthor.agentColor,
      excerpt: excerptOf(target.body),
      onJump: () => rowsById.current.get(target.id)?.scrollIntoView({ block: 'center' }),
    }
  }

  // Collapse consecutive messages from the same author into a group (author-change only — no time
  // break, owner decision 1). A day break is not a time window: the first message of a new local day
  // opens a group under its divider (manifest workspace.md §10 item 3). Each group renders as one
  // block: avatar + header on the first row, body-only continuations after it.
  const groups: Message[][] = []
  for (const m of messages) {
    const last = groups[groups.length - 1]
    if (last && last[0]!.author === m.author && dayOf(last[0]!) === dayOf(m)) last.push(m)
    else groups.push([m])
  }
  // The divider's key is its day, so loading older messages does not remount it. A clock skew between
  // senders can bring a day back, hence the occurrence count (a React key must stay unique).
  const dayCounts = new Map<string, number>()
  let previousDay: string | undefined

  return (
    <div className="timeline" role="log" aria-label={t('timeline.messages')} ref={scrollerRef} onScroll={onScroll}>
      {jumping && (
        <div className="timeline__jump" role="status">
          <Sweep />
          <span className="timeline__jump-text">{t('timeline.opening')}</span>
        </div>
      )}
      {onLoadOlder && (
        <button type="button" className="timeline__older" onClick={onLoadOlder} inert={jumping || undefined}>
          {t('timeline.loadOlder')}
        </button>
      )}
      {messages.length === 0 && <p className="timeline__empty">{t('timeline.empty')}</p>}
      {groups.flatMap((group) => {
        const first = group[0]!
        const day = dayOf(first)
        const opensDay = day !== previousDay
        previousDay = day
        const dayCount = opensDay ? (dayCounts.get(day) ?? 0) + 1 : 0
        if (opensDay) dayCounts.set(day, dayCount)
        const dayLabel = dayLabelOf(first.sentAt)
        // Author + avatar label come from the clean display name — never an id (P1).
        const avatarLabel = initialsOf(resolveAuthor(first, usersById, t('timeline.someone')).name)
        const groupBlock = (
          <div className="message__group" key={first.id} inert={jumping || undefined}>
            {group.map((m, idx) => (
              <MessageRow
                key={m.id}
                message={m}
                usersById={usersById}
                onRetry={onRetry}
                onReact={onReact}
                onOpenThread={onOpenThread}
                onEdit={onEdit}
                onDelete={onDelete}
                onReply={onReply}
                onOpenProfile={onOpenProfile}
                quoted={quotedFor(m)}
                isGroupStart={idx === 0}
                avatarLabel={avatarLabel}
                mine={m.mine === true}
                presence={presenceOf?.(m.author)}
                threadUnread={m.threadSummary ? threadUnreadOf?.(m) : undefined}
                highlighted={highlight?.id === m.id}
                onHighlightEnd={onHighlightEnd}
                selfId={selfId}
                onAnswer={onAnswer}
                rowRef={(el) => {
                  if (el) rowsById.current.set(m.id, el)
                  else rowsById.current.delete(m.id)
                }}
              />
            ))}
          </div>
        )
        if (!opensDay) return [groupBlock]
        return [
          <div className="timeline__day" key={`${day}/${dayCount}`} role="separator" aria-label={dayLabel} inert={jumping || undefined}>
            <span className="timeline__day-rule" aria-hidden="true" />
            <span className="timeline__day-label" aria-hidden="true">{dayLabel}</span>
            <span className="timeline__day-rule" aria-hidden="true" />
          </div>,
          groupBlock,
        ]
      })}
    </div>
  )
}
