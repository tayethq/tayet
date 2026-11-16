import { useRef } from 'react'
import type { ReactNode } from 'react'
import type { Size } from './types'
import { trapFocusKeyDown } from '../focus-trap'
import { t, GLYPH } from '../i18n'

// Dialog (composes, ADR-036). The shared modal shell: scrim + raised surface + bordered card with
// header (title + optional close) / body (children) / optional footer slots. Reuses the shared focus
// trap (Esc closes, Tab/Shift+Tab cycle within the surface) — it does not reinvent it.
//
// The scrim is absolute-within-a-positioned-ancestor (never fixed), anchored by the chrome that
// mounts the dialog. Which control takes initial focus is the caller's concern. The close button is
// rendered only when a `closeLabel` is given; `onClose` always backs Esc.
//
// `size` follows the tier convention (a density step, never a loose width): `cotidiano` is the
// all-user shell (PR-1a compose — 360px, space-12 gap); `gestao` is the denser management shell
// (PR-1b confirm/picker — max 320px, space-8 gap). Width/gap ride a data-size attribute resolved by
// token, not a per-surface class.
//
// Generalised for the management overlays (PR-1b): the confirm composes header+body+footer
// (Cancel + danger-fill confirm); the add-member picker composes header+body+footer with a single
// Close action. Both omit `closeLabel` — they have no × today and lean on `onClose` for Esc, with
// initial focus riding `autoFocus` on the footer's non-destructive control.

export function Dialog({
  ariaLabel,
  title,
  onBack,
  backLabel,
  onClose,
  closeLabel,
  footer,
  size = 'cotidiano',
  className,
  role = 'dialog',
  children,
}: {
  ariaLabel?: string
  // A node title (e.g. ChannelLabel) names the dialog through `ariaLabel`.
  title: ReactNode
  // Afordância de drill-in (addendum ADR-038): quando dado, renderiza um botão de voltar à esquerda
  // do título. Opcional → zero mudança pros consumidores atuais. 2º consumidor previsto: "Editar" do
  // perfil.
  onBack?: () => void
  backLabel?: string
  onClose: () => void
  closeLabel?: string
  footer?: ReactNode
  size?: Size
  // Optional surface modifier appended to the root class (e.g. the manage-modal sizing, ADR-038).
  // Default undefined → zero change for existing consumers.
  className?: string
  // A confirmation that interrupts a destructive action is announced as an alert.
  role?: 'dialog' | 'alertdialog'
  children: ReactNode
}) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  return (
    <div className="ui-dialog__scrim" role="presentation">
      <div
        ref={surfaceRef}
        className={`ui-dialog${className ? ' ' + className : ''}`}
        data-size={size}
        role={role}
        aria-modal="true"
        aria-label={ariaLabel ?? (typeof title === 'string' ? title : undefined)}
        onKeyDown={(e) => trapFocusKeyDown(e, surfaceRef.current, onClose)}
      >
        <header className="ui-dialog__header">
          {onBack && (
            <button
              type="button"
              className="ui-dialog__back"
              onClick={onBack}
              aria-label={backLabel ?? t('dialog.back')}
            >
              {GLYPH.back}
            </button>
          )}
          <h3 className="ui-dialog__title">{title}</h3>
          {closeLabel && (
            <button
              type="button"
              className="ui-dialog__close"
              onClick={onClose}
              aria-label={closeLabel}
            >
              {GLYPH.close}
            </button>
          )}
        </header>
        {children}
        {footer && <div className="ui-dialog__footer">{footer}</div>}
      </div>
    </div>
  )
}
