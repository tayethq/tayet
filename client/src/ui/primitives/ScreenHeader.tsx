import type { ReactNode, Ref } from 'react'
import { Chevron, Close } from '../icons'
import { t } from '../i18n'

// ScreenHeader (composes). The bar on top of every screen of the narrow stack that is not the
// list: back on the left (a touch-floor target with a 20px glyph), an optional leading block, the title
// over an optional subtitle (one line each, cut with an ellipsis) and an optional action on the right,
// with a bottom border and the narrow row height as its minimum.
//
// Back is a plain button: what it does is the caller's (the stack goes back through the browser
// history). `backRef` lets the caller move focus to it when the screen is pushed. The title is a
// heading at `level` (2 by default: the app's h1 is the brand on the list). Without a title, `children`
// take the heading's place (the search screen's field). `glyph: 'close'` draws the ✕ in place of the
// arrow, for a screen that closes rather than goes back ("Nova conversa", new-conversation.md §11.1 item 1).
export function ScreenHeader({
  title,
  subtitle,
  leading,
  action,
  onBack,
  backLabel = t('dialog.back'),
  backRef,
  level = 2,
  titleClassName,
  className,
  glyph = 'back',
  backDisabled,
  children,
}: {
  title?: ReactNode
  subtitle?: ReactNode
  // A block before the heading (the group's numbered block, the agent's avatar).
  leading?: ReactNode
  // A control on the right (e.g. the group's details).
  action?: ReactNode
  onBack: () => void
  backLabel?: string
  backRef?: Ref<HTMLButtonElement>
  level?: 2 | 3
  titleClassName?: string
  className?: string
  glyph?: 'back' | 'close'
  // The back (or close) refused for now (a send in flight, PLANO-MOBILE M6 N2).
  backDisabled?: boolean
  children?: ReactNode
}) {
  const Heading = level === 3 ? 'h3' : 'h2'
  return (
    <header className={className ? `ui-screen-header ${className}` : 'ui-screen-header'}>
      <button
        type="button"
        className="ui-screen-header__back"
        aria-label={backLabel}
        onClick={onBack}
        ref={backRef}
        disabled={backDisabled}
      >
        {glyph === 'close' ? (
          <Close size={20} />
        ) : (
          <span className="ui-screen-header__back-glyph">
            <Chevron size={20} />
          </span>
        )}
      </button>
      {leading}
      {title === undefined ? (
        children
      ) : (
        <div className="ui-screen-header__heading">
          <Heading className={titleClassName ? `ui-screen-header__title ${titleClassName}` : 'ui-screen-header__title'}>
            {title}
          </Heading>
          {subtitle !== undefined && <div className="ui-screen-header__subtitle">{subtitle}</div>}
        </div>
      )}
      {action}
    </header>
  )
}
