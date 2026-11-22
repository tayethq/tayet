import type { ReactNode } from 'react'
import { BottomSheet, Button } from '../primitives'
import { t, type Key } from '../i18n'

// The install sheet (login-onboarding.md §10.1 item 5; account-access.md §13.2 item 3): one component for the
// sign-in screen ("Continuar no navegador") and "Sua conta" ("Agora não"). The two icons are the artboard's,
// local to the sheet.

// A step whose emphasised words, after their icon, take the place of `marker` in the phrase.
function Step({ phrase, marker, words, icon }: { phrase: Key; marker: string; words: Key; icon: ReactNode }) {
  const [before, after] = t(phrase).split(marker)
  return (
    <span className="install-sheet__text">
      {before}
      {icon} <strong>{t(words)}</strong>
      {after}
    </span>
  )
}

const SVG = {
  className: 'install-sheet__icon',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

export function InstallSheet({
  action,
  onAction,
  onClose,
  returnFocus,
}: {
  action: 'install.continueInBrowser' | 'install.notNow'
  onAction: () => void
  // The scrim and Esc.
  onClose: () => void
  returnFocus: HTMLElement | null
}) {
  const share = (
    <svg {...SVG} role="img" aria-label={t('install.share')}>
      <path d="M12 15V3" />
      <path d="M8 7l4-4 4 4" />
      <path d="M6 11v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-8" />
    </svg>
  )
  const add = (
    <svg {...SVG} aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M12 9v6" />
      <path d="M9 12h6" />
    </svg>
  )
  const steps = [
    <Step key="share" phrase="install.step1" marker="{share}" words="install.share" icon={share} />,
    <Step key="add" phrase="install.step2" marker="{add}" words="install.addToHome" icon={add} />,
    <span key="open" className="install-sheet__text">
      {t('install.step3')}
    </span>,
  ]
  return (
    <BottomSheet ariaLabel={t('install.sheetLabel')} onClose={onClose} returnFocus={returnFocus} padding="form">
      <div className="install-sheet">
        <div className="install-sheet__head">
          <span className="install-sheet__app" aria-hidden="true" />
          <h2 className="install-sheet__title">{t('install.title')}</h2>
        </div>
        <p className="install-sheet__body">{t('install.body')}</p>
        <ol className="install-sheet__steps">
          {steps.map((step, i) => (
            <li key={step.key} className="install-sheet__step">
              <span className="install-sheet__number" aria-hidden="true">
                {i + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
        <Button variant="secondary" className="install-sheet__action" onClick={onAction}>
          {t(action)}
        </Button>
      </div>
    </BottomSheet>
  )
}
