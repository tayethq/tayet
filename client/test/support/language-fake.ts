import type { LanguageState } from '../../src/ui/useLanguage'

// The language row at rest, on Automatic: for tests that render "Your account" for something else.
export const idleLanguage: LanguageState = {
  choice: 'auto',
  shown: 'auto',
  status: 'idle',
  onChange: () => {},
  onDismissFailure: () => {},
}
