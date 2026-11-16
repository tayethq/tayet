import { Button, Sweep } from '../primitives'
import { t } from '../i18n'

// Where the reset stands (ADR-082): the verb's Promise, as the UI reads it.
export type ResetStatus = 'idle' | 'pending' | 'done' | 'notDone'

// Actionable "this session needs you" banner (ADR-019 §1 — the device.attention response). Unlike
// the PASSIVE NewAccessBanner (ADR-018), this OFFERS the reset: the ACL raised device.attention
// because the background recovery hit the interactive wall and needs the user. It also carries the
// states of a running reset (ADR-082) when the account surface is closed. Product vocabulary
// only — "acesso", never "dispositivo"/crypto/"seguro"-as-state (P1/ADR-015; the DOM render-scan is
// fail-closed against it). Pure presentational: `present` and `status` drive what shows, `onReset`
// calls the single barrel verb. The MAS approval page is outside our DOM — this is only the entry copy.
// Forma (workspace.md §14 item 2, §6.7, §16; A3-5): danger (border and title) only where the action is
// risky — `idle` and `notDone`, with the `danger-fill` Button; `done` with the primary; `pending` has no
// button, only the sweep (120 wide).
export function ResetAccessBanner({
  present,
  status = 'idle',
  onReset,
  onSignOut,
}: {
  present: boolean
  status?: ResetStatus
  onReset: () => void
  onSignOut?: () => void
}) {
  if (!present && status === 'idle') return null
  const danger = status === 'idle' || status === 'notDone'
  return (
    <div
      className="reset-access-banner"
      role="region"
      aria-label={t('account.resetBannerLabel')}
      data-danger={danger ? 'true' : 'false'}
    >
      <div className="reset-access-banner__text">
        {status === 'idle' ? (
          <>
            <strong className="reset-access-banner__title">{t('account.resetBannerTitle')}</strong>
            <span className="reset-access-banner__detail">
              {t('account.resetBannerDetail')}
            </span>
          </>
        ) : (
          <strong className="reset-access-banner__title" role="status">
            {status === 'pending'
              ? t('account.resetPending')
              : status === 'done'
                ? t('account.resetDone')
                : t('account.resetNotDone')}
          </strong>
        )}
      </div>
      {status === 'pending' && (
        <span className="reset-access-banner__sweep">
          <Sweep />
        </span>
      )}
      {status === 'idle' && (
        <Button variant="danger-fill" size="gestao" className="reset-access-banner__action" onClick={onReset}>
          {t('account.reset')}
        </Button>
      )}
      {status === 'notDone' && (
        <Button variant="danger-fill" size="gestao" className="reset-access-banner__action" onClick={onReset}>
          {t('account.resetTryAgain')}
        </Button>
      )}
      {status === 'done' && (
        <Button variant="fill" size="gestao" className="reset-access-banner__action" onClick={onSignOut}>
          {t('account.resetSignInAgain')}
        </Button>
      )}
    </div>
  )
}
