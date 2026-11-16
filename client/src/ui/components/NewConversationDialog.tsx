import { useEffect, useRef, useState } from 'react'
import { GROUP_MAX_OTHERS } from '@tayet/client'
import type { NewChannel, Presence, User, UserId } from '@tayet/client'
import { Avatar, Button, Dialog, Field, Segmented } from '../primitives'
import { Close, Search } from '../icons'
import { AgentAvatar, agentColorOf } from './AgentAvatar'
import { t, GLYPH } from '../i18n'

// New-conversation dialog (Track U/U3, ADR-029). The first CREATION surface in the UI, mounted at
// workspace level (the sidebar chrome), distinct from the per-channel ChannelManagementPanel. F1
// combined: ONE entry point whose internal segmented selector picks Channel vs Direct message.
//
// Consistency model = await-and-close (the removeMember idiom of U2): each verb's Promise is awaited
// here; on success onClose() (the new room is selected by useChat on its channel.added — seam S1, no
// optimistic insert), on failure an inline error and the dialog STAYS open with what was picked. The
// verbs' Promises are owned here — App/useChat hand them through without a .catch.
//
// Direct-message mode is a multi-select (ADR-094; manifest new-conversation.md §10): one person opens
// the direct message (onOpenDirectMessage), two to GROUP_MAX_OTHERS open the group conversation
// (onOpenGroupConversation, ids in the order they were picked). At the limit the rows not picked are
// disabled and the limit line shows; the session's own agent is offered like a person and counts.
//
// P1 (ADR-007/ADR-008): renders ONLY clean product vocabulary. `mode` is Channel|Direct message — a
// DM is a PATH, never a kind. The channel kind selector offers Public|Private only ('dm' is not a
// creation kind). The pickers render displayName; user.id lives ONLY in the React key + the verbs'
// payload, never on screen.
//
// Composition (ADR-036): the shell + form controls are the component tier's primitives (Dialog,
// Field, Segmented, Button, Avatar). The Dialog owns the scrim/surface/header and the shared focus
// trap. The contact picker, the people chips and the name filter stay compose-specific one-offs (not
// primitives, below the ADR-036 dec. 3 bar); the picker's options compose Avatar.

type Mode = 'channel' | 'dm'
type Kind = NewChannel['kind'] // 'public' | 'private'

// The filter matches the name without accents and without case (§9 item 10).
const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

export function NewConversationDialog({
  onCreateChannel,
  onOpenDirectMessage,
  onOpenGroupConversation,
  loadKnownContacts,
  onClose,
  initialMode,
  presenceOf,
}: {
  onCreateChannel: (input: NewChannel) => Promise<void>
  onOpenDirectMessage: (user: UserId) => Promise<void>
  onOpenGroupConversation: (users: UserId[]) => Promise<void>
  loadKnownContacts: () => Promise<User[]>
  onClose: () => void
  // Compose intent seeded by the ChannelList "+" (Track U/U3, F3): which mode the dialog opens in.
  // The dialog is remounted per open (Workspace unmounts on close), so this seeds fresh each time.
  initialMode?: Mode
  // Line presence on the picker rows (ADR-056 rollout, §8.4; cluster spec new-conversation.md §7).
  // Synchronous map-first read composed by the Workspace. Optional: absent (bare harness) → the
  // Avatar gets no prop and stays byte-identical (ADR-036 addendum).
  presenceOf?: (user: UserId) => Presence
}) {
  const [mode, setMode] = useState<Mode>(initialMode ?? 'channel')

  // Channel-mode fields.
  const [name, setName] = useState('')
  const [kind, setKind] = useState<Kind>('public')
  const [topic, setTopic] = useState('')

  // The known set feeds both modes (new-conversation.md §9 item 7): the DM picker and channel-mode
  // "Adicionar pessoas". Loaded once when the dialog opens.
  const [contacts, setContacts] = useState<User[]>([])
  const [contactsLoading, setContactsLoading] = useState(false)
  const [contactsError, setContactsError] = useState(false)
  // Each mode keeps its own pick: the channel's members and the DM's people never mix.
  const [members, setMembers] = useState<User[]>([])
  const [selected, setSelected] = useState<User[]>([])
  const [filter, setFilter] = useState('')
  const loadedContacts = useRef(false)

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(false)

  const nameRef = useRef<HTMLInputElement>(null)
  const modeRef = useRef<HTMLDivElement>(null)
  const initialModeRef = useRef<Mode>(initialMode ?? 'channel')

  // a11y: focus enters the dialog on open. Channel mode lands on the name field (its first input);
  // DM mode lands on the first focusable of the mode selector — otherwise focus stays OUTSIDE the
  // dialog's focus trap. Reads refs only, so the effect stays [] (lint-safe) and never re-runs on
  // mode change.
  useEffect(() => {
    if (initialModeRef.current === 'channel') {
      nameRef.current?.focus()
    } else {
      modeRef.current?.querySelector<HTMLElement>('button, [role="radio"], input')?.focus()
    }
  }, [])

  // Contact load on open, once. load/empty/error states mirror the U2 picker; loadKnownContacts is
  // the raw union of visible members (no directory verb).
  useEffect(() => {
    if (loadedContacts.current) return
    loadedContacts.current = true
    setContactsLoading(true)
    setContactsError(false)
    loadKnownContacts()
      .then(setContacts)
      .catch(() => setContactsError(true))
      .finally(() => setContactsLoading(false))
  }, [loadKnownContacts])

  function switchMode(next: Mode) {
    setMode(next)
    setFilter('')
    setSubmitError(false)
  }

  function addMember(user: User) {
    setMembers((current) => [...current, user])
  }

  function removeMember(user: User) {
    setMembers((current) => current.filter((member) => member.id !== user.id))
  }

  // DM mode: a row (or a chip's ✕) toggles; the pick keeps the order of selection. Past the limit a
  // new pick is refused (the rows are disabled anyway).
  function toggleSelected(user: User) {
    setSelected((current) =>
      current.some((u) => u.id === user.id)
        ? current.filter((u) => u.id !== user.id)
        : current.length >= GROUP_MAX_OTHERS
          ? current
          : [...current, user],
    )
    setSubmitError(false)
  }

  const term = fold(filter.trim())
  const matches = (user: User) => term.length === 0 || fold(user.displayName).includes(term)
  const suggestions = contacts.filter((user) => !members.some((member) => member.id === user.id) && matches(user))
  const rows = contacts.filter(matches)
  const full = selected.length >= GROUP_MAX_OTHERS

  const trimmedName = name.trim()
  const canSubmit = !submitting && (mode === 'channel' ? trimmedName.length > 0 : selected.length > 0)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setSubmitError(false)
    try {
      if (mode === 'channel') {
        const input: NewChannel = { name: trimmedName, kind }
        const trimmedTopic = topic.trim()
        if (trimmedTopic.length > 0) input.topic = trimmedTopic
        if (members.length > 0) input.members = members.map((user) => user.id)
        await onCreateChannel(input)
      } else if (selected.length === 1) {
        await onOpenDirectMessage(selected[0]!.id)
      } else {
        await onOpenGroupConversation(selected.map((user) => user.id))
      }
      onClose() // await-and-close: success closes; useChat selects the room on its channel.added.
    } catch {
      setSubmitError(true) // inline error; the dialog stays open, the pick intact, nothing inserted.
      setSubmitting(false)
    }
  }

  const submitLabel =
    mode === 'channel'
      ? submitting
        ? t('newConversation.creating')
        : t('newConversation.createChannel')
      : submitting
        ? t('newConversation.opening')
        : t('newConversation.startConversation')

  const filterField = <PeopleFilter value={filter} onChange={setFilter} />

  return (
    <Dialog
      className="compose-dialog"
      title={t('newConversation.title')}
      onClose={onClose}
      closeLabel={t('newConversation.close')}
    >
      {/* Mode selector (F1 combined). A DM is a PATH, not a kind (P1). The inert ref wrapper lets the
          open effect focus INTO the dialog when DM mode has no text field to land on. */}
      <div ref={modeRef} className="compose-dialog__mode">
        <Segmented
          ariaLabel={t('newConversation.type')}
          value={mode}
          options={[
            { value: 'channel', label: t('newConversation.channel') },
            { value: 'dm', label: t('newConversation.dm') },
          ]}
          onChange={switchMode}
        />
      </div>

      <form className="compose-dialog__form" onSubmit={handleSubmit}>
        <div className={mode === 'dm' ? 'compose-dialog__fields compose-dialog__fields--dm' : 'compose-dialog__fields'}>
          {mode === 'channel' ? (
            <>
              <Field label={t('newConversation.name')} htmlFor="compose-name">
                <div className="compose-dialog__name">
                  <span className="compose-dialog__name-mark" aria-hidden="true">
                    {GLYPH.hash}
                  </span>
                  <input
                    id="compose-name"
                    ref={nameRef}
                    className="compose-dialog__name-input"
                    value={name}
                    aria-invalid={trimmedName.length === 0}
                    onChange={(e) => {
                      setName(e.target.value)
                      setSubmitError(false)
                    }}
                  />
                </div>
              </Field>

              <Field
                label={t('newConversation.topic')}
                htmlFor="compose-topic"
                inputProps={{
                  value: topic,
                  placeholder: t('newConversation.topicPlaceholder'),
                  onChange: (e) => {
                    setTopic(e.target.value)
                    setSubmitError(false)
                  },
                }}
              />

              {/* Kind selector: Public | Private only — 'dm' is not a creation kind (P1). */}
              <div className="compose-dialog__visibility">
                <span className="compose-dialog__visibility-label">{t('newConversation.visibility')}</span>
                <Segmented
                  ariaLabel={t('newConversation.visibilityLabel')}
                  value={kind}
                  options={[
                    { value: 'public', label: t('newConversation.public') },
                    { value: 'private', label: t('newConversation.private') },
                  ]}
                  onChange={setKind}
                />
              </div>

              {/* Adicionar pessoas (§9 items 7 and 10). People are optional: a load failure is muted,
                  not an alert, and the CTA stays live. The filter narrows the suggestions; the chips
                  stay. P1: displayName only; user.id in key + payload. */}
              <div className="compose-dialog__people">
                <span className="compose-dialog__people-label">
                  {t('newConversation.addPeople')}{' '}
                  <span className="compose-dialog__people-hint">
                    {GLYPH.dot} {t('newConversation.addPeopleHint')}
                  </span>
                </span>
                {filterField}
                {contactsError ? (
                  <p className="compose-dialog__picker-empty">{t('newConversation.contactsFailed')}</p>
                ) : !contactsLoading && contacts.length === 0 ? (
                  <p className="compose-dialog__picker-empty">{t('newConversation.noContacts')}</p>
                ) : (
                  <>
                    <div className="compose-dialog__chips">
                      {members.map((user) => (
                        <PersonChip key={user.id} user={user} onRemove={() => removeMember(user)} />
                      ))}
                      {suggestions.map((user) => (
                        <button
                          key={user.id}
                          type="button"
                          className="compose-dialog__suggest"
                          aria-label={t('newConversation.suggestPerson', { name: user.displayName })}
                          onClick={() => addMember(user)}
                        >
                          <span aria-hidden="true">{GLYPH.plus}</span>{' '}
                          {agentColorOf(user) !== undefined && <AgentAvatar color={agentColorOf(user)!} size="gestao" />}
                          {user.displayName}
                        </button>
                      ))}
                    </div>
                    {term.length > 0 && suggestions.length === 0 && !contactsLoading && (
                      <p className="compose-dialog__no-results">{t('people.noResults', { term: filter.trim() })}</p>
                    )}
                  </>
                )}
              </div>
            </>
          ) : (
            // DM mode (§10.1): the picked people as chips over the filter, then "Sua equipe" with the
            // limit line and the rows. P1: displayName only; user.id in key + payload. The filter is
            // local to the known set — no directory affordance (ADR-029 dec. 3).
            <>
              {selected.length > 0 && (
                <div className="compose-dialog__dm-chips">
                  {selected.map((user) => (
                    <PersonChip key={user.id} user={user} onRemove={() => toggleSelected(user)} />
                  ))}
                </div>
              )}
              <div className="compose-dialog__dm-filter">{filterField}</div>
              <h3 id="compose-team" className="compose-dialog__team-title">
                {t('newConversation.to')}
              </h3>
              {contactsLoading ? (
                <p className="compose-dialog__dm-note">{t('newConversation.loading')}</p>
              ) : contactsError ? (
                <p className="compose-dialog__error compose-dialog__dm-note" role="alert">
                  {t('newConversation.contactsFailed')}
                </p>
              ) : contacts.length === 0 ? (
                <p className="compose-dialog__dm-note">{t('newConversation.noContacts')}</p>
              ) : (
                <>
                  {full && <p className="compose-dialog__limit">{t('group.limit')}</p>}
                  {rows.length === 0 ? (
                    <p className="compose-dialog__dm-note">{t('people.noResults', { term: filter.trim() })}</p>
                  ) : (
                    <ul className="compose-dialog__picker-list" aria-labelledby="compose-team">
                      {rows.map((user) => {
                        const on = selected.some((u) => u.id === user.id)
                        return (
                          <li key={user.id}>
                            <button
                              type="button"
                              className="compose-dialog__picker-option"
                              aria-pressed={on}
                              disabled={full && !on}
                              onClick={() => toggleSelected(user)}
                            >
                              {/* Densidade gestão (manifesto new-conversation.md §2/§7 item 1). */}
                              {agentColorOf(user) !== undefined ? (
                                <AgentAvatar color={agentColorOf(user)!} size="gestao" />
                              ) : (
                                <Avatar
                                  size="gestao"
                                  label={user.displayName.slice(0, 1)}
                                  presence={presenceOf?.(user.id)}
                                />
                              )}
                              <span className="compose-dialog__option-name">{user.displayName}</span>
                              {on && <CheckMark />}
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </>
              )}
            </>
          )}

          {submitError && (
            <p className="compose-dialog__error" role="alert">
              {t('newConversation.failed')}
            </p>
          )}
        </div>

        <div className="ui-dialog__footer">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {t('newConversation.cancel')}
          </Button>
          <Button variant="fill" type="submit" disabled={!canSubmit}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

// A picked person (§6.1, §10.2): the initial — or, for an agent, the agent avatar at 18 — the name and
// the ✕ that undoes the pick. The same chip in both modes.
function PersonChip({ user, onRemove }: { user: User; onRemove: () => void }) {
  const agent = agentColorOf(user)
  return (
    <span className="compose-dialog__chip">
      {agent !== undefined ? (
        // ADR-086: an agent's chip carries the agent avatar in place of the initial.
        <AgentAvatar color={agent} size="gestao" />
      ) : (
        <span className="compose-dialog__chip-mark" aria-hidden="true">
          {user.displayName.slice(0, 1)}
        </span>
      )}
      {user.displayName}
      <button
        type="button"
        className="compose-dialog__chip-remove"
        aria-label={t('newConversation.removePerson', { name: user.displayName })}
        onClick={onRemove}
      >
        {GLYPH.clear}
      </button>
    </span>
  )
}

// The local name filter (§6.2, §9 items 10–11): the idiom of the People filter. Enter never submits
// the form from here.
function PeopleFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
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

// The selected row's check (§10.2): 14, accent, aria-hidden — the state is the row's aria-pressed.
function CheckMark() {
  return (
    <svg
      className="compose-dialog__check"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  )
}
