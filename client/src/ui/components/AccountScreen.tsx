import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Dialog, ScreenHeader } from '../primitives'
import { t } from '../i18n'

// One full screen of "Sua conta" on the narrow window (account-access.md §13.2, edit-profile.md §9): back and
// the title, the body that scrolls and, where there is one, the fixed footer. Local to the account surface,
// not a primitive. A screen under another stays mounted (its scroll survives), hidden and inert.
export function AccountScreen({
  title,
  onBack,
  covered = false,
  behind = false,
  footer,
  children,
}: {
  title: string
  // The header's back and Esc: one step.
  onBack: () => void
  // Another screen is in front.
  covered?: boolean
  // A dialog is over it: painted, out of reach.
  behind?: boolean
  footer?: ReactNode
  children: ReactNode
}) {
  const backRef = useRef<HTMLButtonElement>(null)
  // Read at the first render, before the screen that had the focus turns inert.
  const [opener] = useState(() => document.activeElement)
  // Also when the dialog over it closes: without it the focus is on the body, where Esc is not heard.
  useLayoutEffect(() => {
    if (!behind) backRef.current?.focus()
  }, [behind])
  // After the commit, when what is under is no longer inert. A window that widened puts a modal in its place:
  // the focus is then the modal's.
  useEffect(
    () => () => {
      if (opener instanceof HTMLElement && opener.isConnected && !document.querySelector('[aria-modal="true"]')) opener.focus()
    },
    [opener],
  )
  return (
    <section
      className="account-screen"
      aria-label={title}
      data-stack-covered={covered ? '' : undefined}
      inert={covered || behind}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        onBack()
      }}
    >
      <ScreenHeader className="account-screen__header" onBack={onBack} backRef={backRef} title={title} />
      <div className="account-screen__body">{children}</div>
      {footer && <div className="account-screen__footer">{footer}</div>}
    </section>
  )
}

// A view of "Sua conta" that exists in both widths: the dialog's drill-in on a wide window, a screen on a
// narrow one.
export function AccountSurface({
  narrow,
  name,
  title,
  onBack,
  onClose,
  footer,
  children,
}: {
  narrow: boolean
  name: 'access' | 'profile'
  title: string
  onBack: () => void
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
}) {
  return narrow ? (
    <AccountScreen title={title} onBack={onBack} footer={footer}>
      {children}
    </AccountScreen>
  ) : (
    <Dialog
      className={`account-settings-dialog account-settings-dialog--${name}`}
      title={title}
      onBack={onBack}
      backLabel={t('dialog.back')}
      onClose={onClose}
      closeLabel={t('dialog.close')}
      footer={footer}
    >
      {children}
    </Dialog>
  )
}
