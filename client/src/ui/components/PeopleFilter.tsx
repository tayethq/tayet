import { Close, Search } from '../icons'
import { t } from '../i18n'

// The local name filter (new-conversation.md §6.2, §9 items 10–11): the idiom of the People filter. Enter
// never submits a form from here. Shared by "Nova conversa" and the channel's add-person picker, in both
// widths (channel-management.md §9 item 6, §13.2 item 6); the narrow dress is each screen's.
export function PeopleFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="compose-dialog__filter">
      <span className="compose-dialog__filter-icon" aria-hidden="true">
        <Search />
      </span>
      <input
        className="compose-dialog__filter-input"
        type="text"
        aria-label={t('newConversation.filterPeople')}
        placeholder={t('newConversation.filterPeople')}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.preventDefault()
        }}
      />
      {value.length > 0 && (
        <button
          type="button"
          className="compose-dialog__filter-clear"
          aria-label={t('people.clearFilter')}
          onClick={() => onChange('')}
        >
          <Close />
        </button>
      )}
    </label>
  )
}

// The filter matches the name only, without accents and without case (new-conversation.md §9 item 10;
// channel-management.md §13.1 item 2: never the operator).
const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

export function matchesName(filter: string): (user: { displayName: string }) => boolean {
  const term = fold(filter.trim())
  return (user) => term.length === 0 || fold(user.displayName).includes(term)
}
