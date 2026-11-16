import type { ReactNode } from 'react'
import { Button, Dialog } from '../primitives'
import { t } from '../i18n'

// What the channel's management panel and the group's details panel share (channel-management.md §10.1
// items 1, 4 and 5): the casca and the confirm. Local to these two surfaces, not a tier primitive
// (ADR-036 dec. 3). Each panel owns its own view-state machine (ADR-038): the casca swaps body, title
// and footer in ONE Dialog, never nesting another one, and Esc goes where the panel's onClose says
// (back to the main view from a confirm or the picker; closing from the main view).

// The casca (channel-management.md §2, §4.1, §6): on the main view the 448 seam with the header and
// the pinned actions under the divider; on a sub-view (confirm, picker) the plain `gestao` Dialog.
export function ManageShell({
  main,
  title,
  ariaLabel,
  onClose,
  closeLabel,
  footer,
  actions,
  children,
}: {
  main: boolean
  title: ReactNode
  ariaLabel?: string
  onClose: () => void
  closeLabel?: string
  // The sub-view's footer (the confirm's buttons, the picker's Close).
  footer?: ReactNode
  // The main view's high-consequence verbs, side by side, pinned to the modal foot (sibling of the
  // scrolling body, never inside it).
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <Dialog
      className={`channel-management-panel${main ? ' channel-management-panel--main' : ''}`}
      size={main ? 'cotidiano' : 'gestao'}
      title={title}
      onClose={onClose}
      closeLabel={closeLabel}
      ariaLabel={ariaLabel}
      footer={main ? undefined : footer}
    >
      <div className="channel-management-panel__body">{children}</div>
      {main && actions && <div className="channel-management-panel__footer">{actions}</div>}
    </Dialog>
  )
}

// The confirm (channel-management.md §9 items 1–3, §6.1): a dot and the title; the body; an optional
// field between the body and the buttons (converting a group, §10.1 item 4); the inline error under
// them. The dot and the action share a tone: `primary` for a verb that removes nobody (archive is
// reversible; converting cannot be undone but keeps everyone), `danger` for leave and remove.
export type ConfirmTone = 'primary' | 'danger'

export function ConfirmTitle({ tone, children }: { tone: ConfirmTone; children: ReactNode }) {
  return (
    <span className="manage-dialog__title">
      <span className="manage-dialog__dot" data-tone={tone} aria-hidden="true" />
      {children}
    </span>
  )
}

export function ConfirmBody({ body, failed, children }: { body: string; failed: boolean; children?: ReactNode }) {
  return (
    <>
      <p className="manage-dialog__body">{body}</p>
      {children}
      {failed && (
        <p className="manage-dialog__error" role="alert">
          {t('channel.failed')}
        </p>
      )}
    </>
  )
}

// Cancel and the action. While pending, Cancel is disabled and the action reads "Aguarde…" busy.
// `focusCancel`: the non-destructive Cancel takes initial focus when the footer mounts (the footer
// remounts each time a confirm opens); a confirm with a field focuses the field instead.
export function ConfirmFooter({
  tone,
  action,
  pending,
  disabled = false,
  focusCancel = true,
  onCancel,
  onConfirm,
}: {
  tone: ConfirmTone
  action: string
  pending: boolean
  disabled?: boolean
  focusCancel?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <>
      <Button variant="secondary" size="gestao" autoFocus={focusCancel} onClick={onCancel} disabled={pending}>
        {t('channel.cancel')}
      </Button>
      <Button
        variant={tone === 'primary' ? 'fill' : 'danger-fill'}
        size="gestao"
        onClick={onConfirm}
        disabled={pending || disabled}
        aria-busy={pending || undefined}
      >
        {pending ? t('channel.working') : action}
      </Button>
    </>
  )
}
