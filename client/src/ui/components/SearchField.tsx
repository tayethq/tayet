import { useEffect, useRef, useState } from 'react'
import { Search } from '../icons'
import { t, GLYPH, KEY_HINT } from '../i18n'

// Search entry (manifest workspace.md §8 items 1–3): the field at the top of the sidebar, under the
// brand block. At rest: the lens, "buscar" and the ⌘K hint. With text: the term, the "nesta conversa" chip
// (only when a conversation is open) and ✕. Focused without text: the hint line under the field.
// ⌘K/Ctrl+K anywhere focuses it (U7 — a capture listener on document, so it wins over the editors
// below); Esc clears; Enter opens the first result. Copy is product vocabulary only (§8 item 12).

// The hint names the platform's modifier: ⌘ on Apple keyboards, Ctrl elsewhere.
function shortcutLabel(): string {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform
  return /Mac|iPhone|iPad/.test(platform) ? KEY_HINT.mac : KEY_HINT.other
}

export function SearchField({
  query,
  onQuery,
  scoped,
  onToggleScope,
  onClear,
  onSubmit,
}: {
  query: string
  onQuery: (query: string) => void
  scoped: boolean
  // Absent when no conversation is open — the chip has nothing to narrow to.
  onToggleScope?: () => void
  onClear: () => void
  onSubmit?: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        input.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  const hasText = query.length > 0
  return (
    <div className="search">
      <div className="search__field">
        <span className="search__icon">
          <Search />
        </span>
        <input
          ref={input}
          className="search__input"
          type="text"
          aria-label={t('search.field')}
          placeholder={t('search.placeholder')}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onClear()
            } else if (e.key === 'Enter') {
              e.preventDefault()
              onSubmit?.()
            }
          }}
        />
        {!hasText && (
          <kbd className="search__kbd" aria-hidden="true">
            {shortcutLabel()}
          </kbd>
        )}
        {hasText && onToggleScope && (
          <button
            type="button"
            className="search__chip"
            aria-pressed={scoped}
            title={scoped ? t('search.scopeAll') : t('search.scopeHere')}
            onClick={onToggleScope}
          >
            {scoped ? t('search.scopedOn') : t('search.scoped')}
          </button>
        )}
        {hasText && (
          <button
            type="button"
            className="search__clear"
            aria-label={t('search.clear')}
            title={t('search.clearTitle')}
            onClick={() => {
              onClear()
              input.current?.focus()
            }}
          >
            {GLYPH.clear}
          </button>
        )}
      </div>
      {focused && !hasText && <p className="search__hint">{t('search.hint')}</p>}
    </div>
  )
}
