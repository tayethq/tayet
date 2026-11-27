import { GLYPH } from './i18n/constants'

// ADR-073 dec. 5: a text body as a notification previews it — spaces collapsed, cut at PREVIEW_MAX with an
// ellipsis. One cut for the live tab (notifier.ts) and the service worker (src/sw), so both say the same.
export const PREVIEW_MAX = 120

export function clip(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim()
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}${GLYPH.ellipsis}` : text
}
