import { useCallback, useRef, useState } from 'react'
import type { Acl } from '@tayet/client'
import { type Locale, storedLocale } from './i18n'
import { LANGUAGE_SAVE_TIMEOUT_MS, saveCopy, withTimeout } from './language'

// The language row of "Your account". The boot has already made this device's copy equal to the
// account, so the copy is the current choice. A change is written to the account first, then to the
// copy, then the page reloads in the new language: nothing changes before the server confirms.

export type LanguageChoice = 'auto' | Locale
export type LanguageStatus = 'idle' | 'saving' | 'failed'

export interface LanguageState {
  // The account's choice as this device knows it (the subtitle reads this one).
  choice: LanguageChoice
  // What the control shows: the choice being written while saving, else the choice.
  shown: LanguageChoice
  status: LanguageStatus
  onChange: (next: LanguageChoice) => void
  // Back to idle after a failure; "Your account" calls it when it closes.
  onDismissFailure: () => void
}

export function useLanguage(
  acl: Pick<Acl, 'setAccountPreferences'>,
  reload: () => void = () => window.location.reload(),
): LanguageState {
  // Set once: a confirmed change reloads the page, which reads the new copy.
  const [choice] = useState<LanguageChoice>(() => storedLocale() ?? 'auto')
  const [pending, setPending] = useState<LanguageChoice | undefined>(undefined)
  const [status, setStatus] = useState<LanguageStatus>('idle')
  const busy = useRef(false)

  const onChange = useCallback(
    (next: LanguageChoice) => {
      if (busy.current || next === choice) return
      busy.current = true
      setPending(next)
      setStatus('saving')
      const locale = next === 'auto' ? null : next
      withTimeout(acl.setAccountPreferences({ language: locale ?? '' }), LANGUAGE_SAVE_TIMEOUT_MS)
        .then(() => {
          if (!saveCopy(locale)) throw new Error('copy')
          reload()
        })
        .catch((e: unknown) => {
          console.error('[language]', e)
          busy.current = false
          setPending(undefined)
          setStatus('failed')
        })
    },
    [acl, choice, reload],
  )

  const onDismissFailure = useCallback(() => setStatus((s) => (s === 'failed' ? 'idle' : s)), [])

  return { choice, shown: pending ?? choice, status, onChange, onDismissFailure }
}
