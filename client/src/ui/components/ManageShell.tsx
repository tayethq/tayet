import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Presence, User } from '@tayet/client'
import { Avatar, BottomSheet, Button, Dialog } from '../primitives'
import { AgentAvatar, agentColorOf } from './AgentAvatar'
import { useMedia } from '../MediaContext'
import { t } from '../i18n'

// What the channel's management panel and the group's details panel share (channel-management.md §10.1
// items 1, 4 and 5): the casca and the confirm. Local to these two surfaces, not a tier primitive
// (ADR-036 dec. 3). Each panel owns its own view-state machine (ADR-038): the casca swaps body, title
// and footer in ONE Dialog, never nesting another one, and Esc goes where the panel's onClose says
// (back to the main view from a confirm or the picker; closing from the main view).

// The casca (channel-management.md §2, §4.1, §6): on the main view the 448 seam with the header and
// the pinned actions under the divider; on a confirm the plain `gestao` Dialog; the picker wears the
// `compose-dialog` casca, 360 (§6.1, §9 item 4).
export function ManageShell({
  main,
  picker = false,
  title,
  ariaLabel,
  onClose,
  closeLabel,
  footer,
  actions,
  children,
}: {
  main: boolean
  picker?: boolean
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
      className={`channel-management-panel${main ? ' channel-management-panel--main' : picker ? ' compose-dialog channel-management-panel--picker' : ''}`}
      size={main || picker ? 'cotidiano' : 'gestao'}
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

// The confirm on the narrow window (channel-management.md §11.1 item 4, §12 items 3–4, §13.2 item 8): a sheet
// held to the bottom, an alert of its own on the stack, the title, the body and, stacked, the action and Cancel;
// the confirm's failure under them. The first focus is never the action, and it moves to Cancel while the
// action waits disabled, so Esc is still heard.
export function ConfirmSheet({
  title,
  body,
  action,
  tone,
  pending,
  failed,
  onConfirm,
  onClose,
}: {
  title: string
  body: string
  action: string
  tone: ConfirmTone
  pending: boolean
  failed: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const [opener] = useState(() => document.activeElement as HTMLElement | null)
  const panel = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    panel.current?.querySelector<HTMLElement>('[data-first-focus]')?.focus()
  }, [pending])
  return (
    <BottomSheet role="alertdialog" ariaLabel={title} onClose={onClose} returnFocus={opener} padding="form" panelRef={panel}>
      <div className="leave-sheet">
        <h2 className="leave-sheet__title">{title}</h2>
        <p className="leave-sheet__text">{body}</p>
        <div className="leave-sheet__actions">
          <Button
            variant={tone === 'primary' ? 'fill' : 'danger-fill'}
            onClick={onConfirm}
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? t('channel.working') : action}
          </Button>
          <Button variant="secondary" data-first-focus="" onClick={onClose}>
            {t('channel.cancel')}
          </Button>
        </div>
        {failed && (
          <p className="manage-dialog__error" role="alert">
            {t('channel.failed')}
          </p>
        )}
      </div>
    </BottomSheet>
  )
}

// A person in a row of the roster, the picker or the group's participants: the agent avatar (ADR-086: no
// photo, never presence) or the person's, on the reader's own in accent (ADR-081). `photo: false` keeps the
// picker's monogram.
export function MemberAvatar({
  user,
  self = false,
  presence,
  photo = true,
}: {
  user: User
  self?: boolean
  presence?: Presence
  photo?: boolean
}) {
  const agent = agentColorOf(user)
  const src = useMedia(photo ? user.avatar : undefined, 'thumbnail').url
  if (agent !== undefined) return <AgentAvatar color={agent} size="gestao" />
  return (
    <Avatar
      size="gestao"
      variant={self ? 'accent' : 'greige'}
      label={user.displayName.slice(0, 1)}
      src={src}
      presence={presence}
    />
  )
}

// The name, "· você" on the reader's own, and an agent's operator on a second line (channel-management.md
// §13.1 items 1, 2 and 4; §10.5 item 3): `agent.operatedBy` with `operatorName`, none without it.
export function MemberName({ user, self = false }: { user: User; self?: boolean }) {
  const operator = agentColorOf(user) !== undefined ? user.operatorName : undefined
  return (
    <span className="channel-management-panel__member-name">
      <span className="channel-management-panel__member-label">{user.displayName}</span>
      {self && <span className="channel-management-panel__member-you"> {t('channel.you')}</span>}
      {operator !== undefined && (
        <span className="channel-management-panel__member-sub" data-agent-operator="">
          {t('agent.operatedBy', { name: operator })}
        </span>
      )}
    </span>
  )
}
