import { useLayoutEffect, useRef, useState } from 'react'
import { BottomSheet, Button, Sweep } from '../primitives'
import type { ResetStatus } from './ResetAccessBanner'
import { t } from '../i18n'

// The reset on the narrow window (account-access.md §13.2 item 5): the four states of §10 in a bottom sheet.
// Closing it while it waits closes the sheet and the reset goes on. The first focus is never the danger.
export function ResetSheet({
  status,
  onReset,
  onSignOut,
  onClose,
}: {
  status: ResetStatus
  onReset: () => void
  onSignOut: () => void
  onClose: () => void
}) {
  const [opener] = useState(() => document.activeElement as HTMLElement | null)
  const panel = useRef<HTMLDivElement | null>(null)
  // Also on each state: the button that had the focus leaves with its state, and Esc is heard on the panel.
  useLayoutEffect(() => {
    panel.current?.querySelector<HTMLElement>('[data-first-focus]')?.focus()
  }, [status])
  return (
    <BottomSheet
      role="alertdialog"
      ariaLabel={t('account.resetTitle')}
      onClose={onClose}
      returnFocus={opener}
      padding="form"
      panelRef={panel}
    >
      <div className="reset-sheet">
        <h2 className="reset-sheet__title">
          <span className="account-settings__confirm-dot" aria-hidden="true" />
          {t('account.resetTitle')}
        </h2>
        {status === 'idle' ? (
          <>
            <p className="reset-sheet__text">{t('account.resetWarning')}</p>
            <p className="reset-sheet__caveat">{t('account.resetCaveat')}</p>
          </>
        ) : (
          <p className="reset-sheet__text" role="status" tabIndex={-1} data-first-focus={status === 'pending' ? '' : undefined}>
            {t(status === 'pending' ? 'account.resetPending' : status === 'done' ? 'account.resetDone' : 'account.resetNotDone')}
          </p>
        )}
        {status === 'pending' ? (
          <span className="reset-sheet__sweep">
            <Sweep />
          </span>
        ) : (
          <div className="reset-sheet__actions">
            {status === 'done' ? (
              <Button variant="fill" data-first-focus="" onClick={onSignOut}>
                {t('account.resetSignInAgain')}
              </Button>
            ) : (
              <>
                <Button variant="danger-fill" onClick={onReset}>
                  {status === 'notDone' ? t('account.resetTryAgain') : t('account.reset')}
                </Button>
                <Button variant="secondary" data-first-focus="" onClick={onClose}>
                  {t('account.cancel')}
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </BottomSheet>
  )
}
