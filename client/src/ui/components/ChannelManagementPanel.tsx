import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { Channel, ChannelAbilities, ChannelId, ChannelPatch, Presence, Role, RosterEntry, User, UserId } from '@tayet/client'
import { RateLimitedError } from '@tayet/client'
import { BottomSheet, Button, ScreenHeader, Segmented } from '../primitives'
import { ConfirmBody, ConfirmFooter, ConfirmSheet, ConfirmTitle, ManageShell, MemberAvatar, MemberName } from './ManageShell'
import type { ConfirmTone } from './ManageShell'
import { PeopleFilter, matchesName } from './PeopleFilter'
import { ChannelLabel, manageLabel } from './ChannelLabel'
import { useCoveringScreen } from '../covering-screen'
import { useStackBack, useStackDialog } from '../stack'
import { useMounted } from '../use-mounted'
import { Lock } from '../icons'
import { GLYPH, t } from '../i18n'

// Channel management panel (Track U/U1, ADR-029). A presentational sibling of the ThreadPanel,
// state-mounted by useChat (`managing`) and dressed in the `gestao` density regime (ADR-028 §5).
// It edits a channel's name/topic and offers the two high-consequence verbs (archive / leave) behind
// short confirmation dialogs.
//
// Consistency model = await-and-close (ADR-029 §2), DISTINCT from the spine's optimism (ADR-010):
//   • Edit: no Save button (manifest §2). A field commits on blur and Enter; Esc on a changed field
//     restores it and keeps focus there (Esc on a clean field closes the panel, the Dialog's Esc).
//     Await onUpdateChannel → on success a discreet "Saved" note under the field, panel STAYS open
//     (the operator can keep editing); on failure an inline error, panel stays open.
//   • Archive / Leave: await the verb → on success onClose() (the list reconciles via the
//     channel.removed stream in useChat); on failure an inline error in the dialog, it stays open.
// The verbs' Promises are owned here — useChat hands them through without a .catch (ADR-029 §2).
//
// P1 (ADR-007/ADR-008): this renders ONLY clean domain (channel.name / channel.topic /
// member.displayName / member.role / operatorName). The opaque ids (channel.id, user.id) live ONLY in
// verb payloads and React keys, never on screen; copy and aria-labels carry no protocol vocabulary.
//
// Member roster (Track U/U2, ADR-029). The managed channel's members, with the three membership
// mutations driven by the operator's own token (P1, client-side). Each mutation is await-and-close:
// success closes its surface and lets the member.changed stream reconcile the roster; failure shows
// an inline error and the roster is left intact (never mutated optimistically). The roster entry
// carries `self` (ADR-081): the own row reads "· você" and offers no mutation on oneself.
//
// What the session may do (ADR-115; channel-management.md §15 item 1): each control follows its own answer
// from `abilities`, not the role of the reader's own row — the name field (rename), the topic field
// (editTopic), "+ Adicionar" and the picker (addPeople), the role control (setRoles), Remove (removePeople,
// never on the own row) and archive (archive). Until the answers are read, everything is closed: name and
// topic as text, no add, no role control, no Remove, no archive; the roster, the profile and leaving stay.
// The answer is per channel: the server may still refuse a verb against one person, shown where it ran.
//
// Narrow window (`narrow`; §13.2): the same instance as a full screen of the stack. The picker is a screen
// over it; the person's sheet and each confirm are sheets; each is an entry of its own, so the system's
// back closes the top one. Closing a sheet while its verb runs closes the sheet and the verb goes on
// (§14 item 3); a verb that settles closes only the surface it started from (R4).

type Field = 'name' | 'topic'

type Confirm =
  | { kind: 'archive' }
  | { kind: 'leave' }
  | { kind: 'remove-member'; user: User }

// Role labels for the roster. Role is admin | member | guest (ADR-026); guest is display-only — there
// is no verb that makes it settable, so its role control is read-only (the asymmetry: setRole accepts
// only admin | member).
const roleLabel = (): Record<Role, string> => ({
  admin: t('channel.roleAdmin'),
  member: t('channel.roleMember'),
  guest: t('channel.roleGuest'),
})

// The role is settable on someone active who is not a guest nor oneself (§4.3); someone who has not
// connected yet shows it read-only.
const settableRole = (m: RosterEntry): boolean => m.role !== 'guest' && m.state === 'active' && !m.self

// ADR-115: nothing is offered until the answers are read.
const NO_ABILITIES: ChannelAbilities = {
  rename: false,
  editTopic: false,
  addPeople: false,
  removePeople: false,
  setRoles: false,
  archive: false,
}

const keyOf = (c: Confirm): string => (c.kind === 'remove-member' ? `remove:${c.user.id}` : c.kind)

// Dialog copy for the active confirmation. remove-member interpolates the clean displayName (P1 —
// never user.id).
function confirmCopy(c: Confirm): { title: string; body: string; action: string } {
  if (c.kind === 'remove-member')
    return {
      title: t('channel.removeTitle'),
      body: t('channel.removeBody', { name: c.user.displayName }),
      action: t('channel.remove'),
    }
  if (c.kind === 'archive')
    return { title: t('channel.archiveTitle'), body: t('channel.archiveBody'), action: t('channel.archive') }
  return { title: t('channel.leaveTitle'), body: t('channel.leaveBody'), action: t('channel.leave') }
}

export function ChannelManagementPanel({
  channel,
  members,
  abilities,
  onUpdateChannel,
  onArchiveChannel,
  onLeaveChannel,
  onSetRole,
  onRemoveMember,
  onAddMember,
  loadCandidates,
  onOpenProfile,
  presenceOf,
  onClose,
  narrow = false,
  covered = false,
}: {
  channel: Channel
  // Track U/U2: the managed channel's roster (already keyed on managing.id in useChat). Read-only
  // here — mutations go through the handlers below and reconcile via the member.changed stream.
  members: RosterEntry[]
  // ADR-115: what the session may do in this channel. Absent = not read yet: read-only.
  abilities?: ChannelAbilities
  onUpdateChannel: (id: ChannelId, patch: ChannelPatch) => Promise<void>
  onArchiveChannel: (id: ChannelId) => Promise<void>
  onLeaveChannel: (id: ChannelId) => Promise<void>
  // Membership mutations (Track U/U2, ADR-029 §2), await-and-close. REQUIRED: a panel mounted without
  // a membership verb is irrepresentable (the Workspace mount-guard narrows the optional Workspace
  // props to these — the U1 pattern).
  onSetRole: (id: ChannelId, user: UserId, role: 'admin' | 'member') => Promise<void>
  onRemoveMember: (id: ChannelId, user: UserId) => Promise<void>
  onAddMember: (id: ChannelId, user: UserId) => Promise<void>
  loadCandidates: () => Promise<User[]>
  // Perfil-de-outro (ADR-043): abre o perfil do membro a partir da sua linha. Optional — o harness bare o
  // omite (o click vira no-op). Recebe o UserId opaco.
  onOpenProfile?: (user: UserId) => void
  // Presença de linha no roster + picker (ADR-056). Opcional: o harness bare a omite → Avatar sem a prop.
  presenceOf?: (user: UserId) => Presence
  onClose: () => void
  // Below the width breakpoint: a full screen; `covered` while another one is over it.
  narrow?: boolean
  covered?: boolean
}) {
  // Form seeded from props. The mount site keys this component on channel.id, so switching the
  // managed channel remounts it with fresh state. The name is seeded WITHOUT the kind mark and saved
  // as typed: the read side normalizes one leading '#'.
  const bareName = channel.name.replace(/^#/, '')
  const [name, setName] = useState(bareName)
  const [topic, setTopic] = useState(channel.topic ?? '')
  const [status, setStatus] = useState<{ field: Field; phase: 'saving' | 'saved' | 'failed' } | undefined>(
    undefined,
  )
  // The last values the server accepted: the `channel` prop only catches up via the channel.changed
  // stream, so it can't tell a change from what was just committed. Commits run one at a time.
  const accepted = useRef<Record<Field, string>>({ name: bareName, topic: channel.topic ?? '' })
  const commits = useRef(Promise.resolve())

  const [confirm, setConfirm] = useState<Confirm | undefined>(undefined)
  // The confirm whose verb is in flight, and the one whose verb failed (by key): a narrow sheet reopened
  // shows where its verb stands.
  const [running, setRunning] = useState<Confirm | undefined>(undefined)
  const [failed, setFailed] = useState<string | undefined>(undefined)

  // Add-member picker (seam B1). Lazy: candidates load only when the picker opens. The empty-state
  // copy is shown ONLY on a successful empty load (distinguished from a load failure via pickerError).
  const [picker, setPicker] = useState(false)
  const [candidates, setCandidates] = useState<User[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerError, setPickerError] = useState(false)
  const [adding, setAdding] = useState(false)
  const [rateLimited, setRateLimited] = useState(false)
  const [filter, setFilter] = useState('')

  // The person's sheet (narrow, §13.2 item 4), read fresh from the roster: someone removed meanwhile closes it.
  const [personId, setPersonId] = useState<UserId | undefined>(undefined)
  const mounted = useMounted()

  // ADR-115; §15 items 1 and 2: each control by its answer, all closed until the answers are read. On the
  // narrow window the person's sheet opens only if it has something to offer (the role pair or Remove).
  const can = abilities ?? NO_ABILITIES
  const sheet = can.setRoles || can.removePeople
  const person = sheet && personId !== undefined ? members.find((m) => m.user.id === personId && !m.self) : undefined
  const confirmShown =
    confirm &&
    (confirm.kind === 'leave' || (confirm.kind === 'archive' ? can.archive : can.removePeople))
      ? confirm
      : undefined
  const pickerShown = picker && can.addPeople

  const nameRef = useRef<HTMLInputElement>(null)
  const rosterRef = useRef<HTMLElement>(null)
  const nameFocused = useRef(false)

  // a11y: focus enters the panel on open — the name field once the gate opens, else the ✕ (the Dialog's
  // trap and Esc listen inside it). The confirm/picker are view-states of the same Dialog (ADR-038);
  // their initial focus rides `autoFocus` on the non-destructive control. Narrow: the screen's back.
  useEffect(() => {
    if (narrow || nameFocused.current) return
    if (can.rename) {
      const active = document.activeElement
      if (active === document.body || active?.classList.contains('ui-dialog__close')) {
        nameFocused.current = true
        nameRef.current?.focus()
      }
    } else if (!rosterRef.current?.closest('.ui-dialog')?.contains(document.activeElement))
      rosterRef.current?.closest('.ui-dialog')?.querySelector<HTMLElement>('.ui-dialog__close')?.focus()
  }, [can.rename, narrow])

  const trimmedName = name.trim()

  function onFieldChange(field: Field, value: string) {
    if (field === 'name') setName(value)
    else setTopic(value)
    setStatus(undefined)
  }

  function commit(field: Field, value: string) {
    commits.current = commits.current.then(() => saveField(field, value))
  }

  async function saveField(field: Field, value: string) {
    const next = field === 'name' ? value.trim() : value
    if (next === accepted.current[field] || (field === 'name' && next.length === 0)) return
    setStatus({ field, phase: 'saving' })
    try {
      await onUpdateChannel(channel.id, { [field]: next } satisfies ChannelPatch)
      accepted.current[field] = next
      setStatus({ field, phase: 'saved' }) // discreet success; panel stays open (await-and-close)
    } catch {
      setStatus({ field, phase: 'failed' }) // inline error; panel stays open
    }
  }

  function onFieldKeyDown(e: KeyboardEvent<HTMLInputElement>, field: Field, value: string) {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit(field, value)
    } else if (e.key === 'Escape' && value !== accepted.current[field]) {
      e.stopPropagation() // the Dialog's (or the screen's) Esc closes; this one only undoes the edit
      onFieldChange(field, accepted.current[field])
    }
  }

  function fieldStatus(field: Field): ReactNode {
    if (status?.field !== field) return null
    if (status.phase === 'failed')
      return (
        <span className="channel-management-panel__error" role="alert">
          {t('channel.saveFailed')}
        </span>
      )
    return (
      <span className="channel-management-panel__feedback" role="status">
        {status.phase === 'saving' ? t('channel.saving') : t('channel.saved')}
      </span>
    )
  }

  function openConfirm(next: Confirm) {
    setConfirm(next)
    if (narrow) return
    setFailed(undefined)
    setRunning(undefined)
  }
  function closeConfirm() {
    setConfirm(undefined)
    if (narrow) return
    setFailed(undefined)
    setRunning(undefined)
  }

  async function handleConfirm() {
    const ran = confirmShown
    if (!ran || running) return
    setRunning(ran)
    setFailed(undefined)
    try {
      if (ran.kind === 'remove-member') {
        await onRemoveMember(channel.id, ran.user.id)
        if (!mounted.current) return
        // Success: close the confirm and that person's sheet only — the panel stays open and the roster
        // reconciles via the member.changed stream (never an optimistic splice).
        setRunning(undefined)
        setConfirm((c) => (c && keyOf(c) === keyOf(ran) ? undefined : c))
        setPersonId((p) => (p === ran.user.id ? undefined : p))
        return
      }
      await (ran.kind === 'archive' ? onArchiveChannel : onLeaveChannel)(channel.id)
      // R4: close only the details this verb started from. The list reconciles via channel.removed.
      if (mounted.current) onClose()
    } catch {
      if (!mounted.current) return
      // Not in a finally: never setState after the success path unmounts the panel.
      setFailed(keyOf(ran))
      setRunning(undefined)
    }
  }

  // Open the picker and load candidates lazily (seam B1). loadCandidates composes the union of the
  // visible channels' members minus this roster (useChat) — no directory verb, resolveUser untouched.
  async function openPicker() {
    setPicker(true)
    setFilter('')
    setPickerLoading(true)
    setPickerError(false)
    setRateLimited(false)
    setAdding(false)
    setCandidates([])
    try {
      const loaded = await loadCandidates()
      if (mounted.current) setCandidates(loaded)
    } catch {
      if (mounted.current) setPickerError(true)
    } finally {
      if (mounted.current) setPickerLoading(false)
    }
  }
  function closePicker() {
    setPicker(false)
    setCandidates([])
    setPickerLoading(false)
    setPickerError(false)
    setRateLimited(false)
    setAdding(false)
  }
  async function addCandidate(user: User) {
    if (adding) return
    setAdding(true)
    setPickerError(false)
    setRateLimited(false)
    try {
      await onAddMember(channel.id, user.id)
      if (!mounted.current) return
      // §9 item 5, I4: the picker stays open and the person leaves the list; the roster reconciles via
      // member.changed (no optimistic insert).
      setCandidates((list) => list.filter((u) => u.id !== user.id))
      setAdding(false)
    } catch (e) {
      if (!mounted.current) return
      // P1: classify on the domain error TYPE (instanceof) — never sniff the SDK's raw error shape.
      // RateLimitedError gets its own copy; any other failure → the generic inline error.
      if (e instanceof RateLimitedError) setRateLimited(true)
      else setPickerError(true) // inline error; the picker stays open and the roster is untouched.
      setAdding(false)
    }
  }

  function openRow(member: RosterEntry) {
    if (member.self) return
    // §15 item 2: the person's sheet if it has the role pair or Remove to offer; otherwise the profile.
    if (sheet) setPersonId(member.user.id)
    else onOpenProfile?.(member.user.id)
  }

  // The stack's entries, bottom first, so they push in that order when several open in one commit.
  useStackDialog('channel', narrow, onClose)
  useStackDialog('channel-picker', narrow && pickerShown, closePicker)
  useStackDialog('channel-person', narrow && person !== undefined, () => setPersonId(undefined))
  useStackDialog('channel-confirm', narrow && confirmShown !== undefined, closeConfirm)

  const pending = running !== undefined
  const confirmError = confirmShown !== undefined && failed === keyOf(confirmShown)
  const tone: ConfirmTone = confirmShown?.kind === 'archive' ? 'primary' : 'danger'

  // The name's mark is the header's (ChannelLabel): the lock on a private channel, never '#'.
  const mark =
    channel.kind === 'private' ? (
      <span className="channel-management-panel__input-mark" role="img" aria-label={t('channel.privateMark')}>
        <Lock />
      </span>
    ) : (
      <span className="channel-management-panel__input-mark" aria-hidden="true">
        {GLYPH.hash}
      </span>
    )

  const nameStatus = fieldStatus('name')
  const topicStatus = fieldStatus('topic')
  // §15 item 1: name and topic each by its own answer — one may be a field and the other text. As text
  // (§13.1 item 5): a label and the value, no box; an empty topic has no line.
  const fields = (
    <>
      {can.rename ? (
        <div className="channel-management-panel__field">
          <label className="channel-management-panel__label" htmlFor="manage-name">
            {t('channel.name')}
          </label>
          <div className="channel-management-panel__input-wrap">
            {mark}
            <input
              id="manage-name"
              ref={nameRef}
              className="channel-management-panel__input"
              value={name}
              onChange={(e) => onFieldChange('name', e.target.value)}
              onBlur={() => commit('name', name)}
              onKeyDown={(e) => onFieldKeyDown(e, 'name', name)}
              aria-invalid={trimmedName.length === 0}
            />
          </div>
          {nameStatus}
        </div>
      ) : (
        <div className="channel-management-panel__field">
          <span className="channel-management-panel__label">{t('channel.name')}</span>
          <p className="channel-management-panel__value">
            {mark}
            {bareName}
          </p>
        </div>
      )}
      {can.editTopic ? (
        <div className="channel-management-panel__field">
          <label className="channel-management-panel__label" htmlFor="manage-topic">
            {t('channel.topic')}
          </label>
          <div className="channel-management-panel__input-wrap">
            <input
              id="manage-topic"
              className="channel-management-panel__input"
              value={topic}
              onChange={(e) => onFieldChange('topic', e.target.value)}
              onBlur={() => commit('topic', topic)}
              onKeyDown={(e) => onFieldKeyDown(e, 'topic', topic)}
            />
          </div>
          {topicStatus}
        </div>
      ) : (
        channel.topic && (
          <div className="channel-management-panel__field">
            <span className="channel-management-panel__label">{t('channel.topic')}</span>
            <p className="channel-management-panel__value">{channel.topic}</p>
          </div>
        )
      )}
    </>
  )

  // Member roster (Track U/U2). P1 renders ONLY displayName + the role label — user.id lives only in the
  // React key, never on screen.
  const roster = (
    <section ref={rosterRef} className="channel-management-panel__roster" aria-label={t('channel.members')}>
      <div className="channel-management-panel__roster-head">
        <h4 className="channel-management-panel__roster-title">{t('channel.membersCount', { n: members.length })}</h4>
        {can.addPeople && (
          <button
            type="button"
            className="channel-management-panel__add-member"
            aria-label={t('channel.addMember')}
            onClick={() => void openPicker()}
          >
            {t('channel.add')}
          </button>
        )}
      </div>
      <ul className="channel-management-panel__roster-list">
        {members.map((member) =>
          narrow ? (
            <NarrowMemberRow
              key={member.user.id}
              member={member}
              onOpen={() => openRow(member)}
              presence={presenceOf?.(member.user.id)}
            />
          ) : (
            <MemberRow
              key={member.user.id}
              member={member}
              setRoles={can.setRoles}
              removePeople={can.removePeople}
              channelId={channel.id}
              onSetRole={onSetRole}
              onRequestRemove={(user) => openConfirm({ kind: 'remove-member', user })}
              onOpenProfile={onOpenProfile}
              presence={presenceOf?.(member.user.id)}
            />
          ),
        )}
      </ul>
    </section>
  )

  const footerActions = (
    <>
      {can.archive && (
        <Button
          variant="secondary"
          size={narrow ? undefined : 'gestao'}
          className="channel-management-panel__footer-action"
          onClick={() => openConfirm({ kind: 'archive' })}
        >
          {t('channel.archiveTitle')}
        </Button>
      )}
      <Button
        variant="danger"
        size={narrow ? undefined : 'gestao'}
        className="channel-management-panel__footer-action"
        onClick={() => openConfirm({ kind: 'leave' })}
      >
        {t('channel.leaveTitle')}
      </Button>
    </>
  )

  // The picker's body (§9 items 4–6, §13.2 item 6): the filter fixed under the header, the list that scrolls.
  // P1: candidates render by displayName only — user.id lives in the React key + the onAddMember payload.
  const offered = candidates.filter(matchesName(filter))
  const pickerBody = (
    <>
      <div className="channel-management-panel__picker-filter">
        <PeopleFilter value={filter} onChange={setFilter} />
      </div>
      <div className="channel-management-panel__picker-scroll">
        {pickerLoading ? (
          <p className="channel-management-panel__picker-empty">{t('channel.loading')}</p>
        ) : offered.length > 0 ? (
          <ul className="channel-management-panel__picker-list">
            {offered.map((user) => (
              <li key={user.id}>
                <button
                  type="button"
                  className="channel-management-panel__picker-option"
                  onClick={() => void addCandidate(user)}
                  disabled={adding}
                >
                  <MemberAvatar user={user} presence={presenceOf?.(user.id)} photo={false} />
                  <MemberName user={user} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          // Neutral empty states — only on a successful load (never on a load error). No directory
          // affordance (the ADR-029 §3 trigger is not fired).
          !pickerError &&
          !rateLimited && (
            <p className="channel-management-panel__picker-empty">
              {candidates.length === 0 ? t('channel.noCandidates') : t('people.noResults', { term: filter.trim() })}
            </p>
          )
        )}
        {pickerError && (
          <p className="manage-dialog__error channel-management-panel__picker-empty" role="alert">
            {t('channel.failed')}
          </p>
        )}
        {rateLimited && (
          <p className="manage-dialog__error channel-management-panel__picker-empty" role="alert">
            {t('channel.rateLimited')}
          </p>
        )}
      </div>
    </>
  )

  if (narrow)
    return (
      <>
        <ChannelScreen covered={covered || pickerShown} onClose={onClose} actions={footerActions}>
          <div className="channel-screen__fields">{fields}</div>
          {roster}
        </ChannelScreen>
        {pickerShown && <PickerScreen onClose={closePicker}>{pickerBody}</PickerScreen>}
        {person && (
          <PersonSheet
            key={person.user.id}
            member={person}
            setRoles={can.setRoles}
            removePeople={can.removePeople}
            // §13.2 item 8: the remove confirm alone over the details, as the artboard draws it.
            under={confirmShown?.kind === 'remove-member'}
            presence={presenceOf?.(person.user.id)}
            onSetRole={(role) => onSetRole(channel.id, person.user.id, role)}
            onOpenProfile={() => {
              setPersonId(undefined)
              onOpenProfile?.(person.user.id)
            }}
            onRemove={() => openConfirm({ kind: 'remove-member', user: person.user })}
            onClose={() => setPersonId(undefined)}
          />
        )}
        {confirmShown && (
          <ConfirmSheet
            key={keyOf(confirmShown)}
            {...confirmCopy(confirmShown)}
            tone={tone}
            pending={pending}
            failed={confirmError}
            onConfirm={() => void handleConfirm()}
            onClose={closeConfirm}
          />
        )}
      </>
    )

  // View-state machine (ADR-038, Fork A): the confirm and the add-member picker are sub-views of THIS one
  // Dialog (one scrim/trap/Esc). Esc is view-aware via onClose: in `main` it closes the panel; in
  // `confirm`/`picker` it steps back to `main`.
  const view: 'main' | 'confirm' | 'picker' = confirmShown ? 'confirm' : pickerShown ? 'picker' : 'main'
  return (
    <ManageShell
      main={view === 'main'}
      picker={view === 'picker'}
      title={
        view === 'confirm' ? (
          <ConfirmTitle tone={tone}>{confirmCopy(confirmShown!).title}</ConfirmTitle>
        ) : view === 'picker' ? (
          t('channel.addMember')
        ) : (
          <ChannelLabel channel={channel} />
        )
      }
      ariaLabel={view === 'confirm' ? confirmCopy(confirmShown!).title : view === 'main' ? manageLabel(channel) : undefined}
      onClose={view === 'confirm' ? closeConfirm : view === 'picker' ? closePicker : onClose}
      closeLabel={view === 'confirm' ? undefined : view === 'picker' ? t('channel.close') : t('channel.closeManage')}
      footer={
        view === 'confirm' ? (
          <ConfirmFooter
            tone={tone}
            action={confirmCopy(confirmShown!).action}
            pending={pending}
            onCancel={closeConfirm}
            onConfirm={() => void handleConfirm()}
          />
        ) : view === 'picker' ? (
          // autoFocus: focus enters on Close (the first enabled control while candidates load).
          <Button variant="secondary" size="gestao" autoFocus onClick={closePicker} disabled={adding}>
            {t('channel.close')}
          </Button>
        ) : undefined
      }
      // High-consequence verbs: confirmation-gated, pinned to the modal foot. Only on the main view.
      actions={footerActions}
    >
      {view === 'main' && (
        <>
          {fields}
          {roster}
        </>
      )}
      {view === 'confirm' && <ConfirmBody body={confirmCopy(confirmShown!).body} failed={confirmError} />}
      {view === 'picker' && pickerBody}
    </ManageShell>
  )
}

// §13.2 items 1, 2, 3 and 7: back and "Detalhes do canal", the fields and the people that scroll, the verbs
// stacked in the fixed footer.
function ChannelScreen({
  covered,
  onClose,
  actions,
  children,
}: {
  covered: boolean
  onClose: () => void
  actions: ReactNode
  children: ReactNode
}) {
  const back = useStackBack(onClose)
  const { backRef, screenProps } = useCoveringScreen(back, covered)
  return (
    <section className="channel-screen" aria-label={t('channel.details')} {...screenProps}>
      <ScreenHeader className="channel-screen__header" onBack={back} backRef={backRef} title={t('channel.details')} />
      <div className="channel-screen__body">{children}</div>
      <div className="channel-screen__footer">{actions}</div>
    </section>
  )
}

// §13.2 item 6: the picker as a screen over the details — back in place of the ✕, no footer.
function PickerScreen({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const back = useStackBack(onClose)
  const { backRef, screenProps } = useCoveringScreen(back)
  return (
    <section className="channel-screen channel-picker-screen" aria-label={t('channel.addMember')} {...screenProps}>
      <ScreenHeader className="channel-screen__header" onBack={back} backRef={backRef} title={t('channel.addMember')} />
      {children}
    </section>
  )
}

// One row on the narrow window (§13.2 item 3): the whole row is the target, the own row is not one.
function NarrowMemberRow({
  member,
  onOpen,
  presence,
}: {
  member: RosterEntry
  onOpen: () => void
  presence?: Presence
}) {
  const { user, role, state, self } = member
  const inner = (
    <>
      <MemberAvatar user={user} self={self} presence={presence} />
      <MemberName user={user} self={self} />
      {state === 'invited' && <span className="channel-management-panel__member-pending">{t('channel.awaiting')}</span>}
      <span className="channel-management-panel__member-role" data-role={role}>
        {roleLabel()[role]}
      </span>
    </>
  )
  return (
    <li className="channel-management-panel__member">
      {self ? (
        <div className="channel-screen__row">{inner}</div>
      ) : (
        <button type="button" className="channel-screen__row" onClick={onOpen}>
          {inner}
        </button>
      )}
    </li>
  )
}

// §13.2 item 4: the person on top; "Ver perfil"; "Papel" with the pair, applied on the tap (or the role as
// text for a guest or someone not connected yet); "Remover". Busy and failure are this sheet's: closing it
// while the role verb runs lets the verb go on (§14 item 3). §15 item 2: the pair only if the session may
// change roles (otherwise the role as text), and "Remover" only if it may remove.
function PersonSheet({
  member,
  setRoles,
  removePeople,
  under,
  presence,
  onSetRole,
  onOpenProfile,
  onRemove,
  onClose,
}: {
  member: RosterEntry
  setRoles: boolean
  removePeople: boolean
  under: boolean
  presence?: Presence
  onSetRole: (role: 'admin' | 'member') => Promise<void>
  onOpenProfile: () => void
  onRemove: () => void
  onClose: () => void
}) {
  const { user, role } = member
  const [opener] = useState(() => document.activeElement as HTMLElement | null)
  const [busy, setBusy] = useState(false)
  const [roleFailed, setRoleFailed] = useState(false)
  const mounted = useMounted()

  async function changeRole(next: 'admin' | 'member') {
    if (busy || next === role) return
    setBusy(true)
    setRoleFailed(false)
    try {
      await onSetRole(next) // success: the roster (and `role`) reconciles via member.changed
    } catch {
      if (mounted.current) setRoleFailed(true)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <BottomSheet ariaLabel={user.displayName} onClose={onClose} returnFocus={opener} under={under}>
      <div className="person-sheet__top">
        <MemberAvatar user={user} presence={presence} />
        <span className="person-sheet__name">{user.displayName}</span>
      </div>
      <button type="button" className="message-sheet__row" onClick={onOpenProfile}>
        {t('channel.openProfile')}
      </button>
      <div className="person-sheet__role">
        <span className="person-sheet__role-label">{t('channel.role')}</span>
        {setRoles && settableRole(member) ? (
          <Segmented
            ariaLabel={t('channel.roleFor', { name: user.displayName })}
            value={role as 'admin' | 'member'}
            options={[
              { value: 'admin', label: roleLabel().admin },
              { value: 'member', label: roleLabel().member },
            ]}
            onChange={(next) => void changeRole(next)}
            disabled={busy}
          />
        ) : (
          <span className="channel-management-panel__member-role" data-role={role}>
            {roleLabel()[role]}
          </span>
        )}
      </div>
      {roleFailed && (
        <p className="manage-dialog__error person-sheet__error" role="alert">
          {t('channel.roleFailed')}
        </p>
      )}
      {removePeople && (
        <button type="button" className="message-sheet__row message-sheet__row--danger" onClick={onRemove}>
          {t('channel.remove')}
        </button>
      )}
    </BottomSheet>
  )
}

// One roster row on the wide window (Track U/U2). Busy/error state is scoped here, per user.id — a failed
// mutation on one member never touches another row, and never mutates the roster.
//
// Role control asymmetry (ADR-026): Role is admin | member | guest, but setRole accepts only
// admin | member. So admin/member rows get an admin↔member control; a guest row shows a read-only
// label. The own row (`self`, ADR-081) offers neither; the role control follows setRoles and Remove follows
// removePeople (ADR-115).
function MemberRow({
  member,
  setRoles,
  removePeople,
  channelId,
  onSetRole,
  onRequestRemove,
  onOpenProfile,
  presence,
}: {
  member: RosterEntry
  setRoles: boolean
  removePeople: boolean
  channelId: ChannelId
  onSetRole: (id: ChannelId, user: UserId, role: 'admin' | 'member') => Promise<void>
  // Opens the panel-level remove-member confirmation (the actual await lives there).
  onRequestRemove: (user: User) => void
  // Perfil-de-outro (ADR-043). aria-label carrega o displayName limpo, nunca user.id (P1).
  onOpenProfile?: (user: UserId) => void
  presence?: Presence
}) {
  const { user, role, state, self } = member
  const [roleBusy, setRoleBusy] = useState(false)
  const [roleError, setRoleError] = useState(false)

  async function changeRole(next: 'admin' | 'member') {
    if (roleBusy || next === role) return
    setRoleBusy(true)
    setRoleError(false)
    try {
      await onSetRole(channelId, user.id, next)
      // Success: do nothing — the roster (and this row's `role` prop) reconciles via member.changed.
    } catch {
      // Inline error scoped to this row; the controlled <select> reverts to the unchanged `role` prop.
      setRoleError(true)
    } finally {
      setRoleBusy(false)
    }
  }

  return (
    <li className="channel-management-panel__member">
      <div className="channel-management-panel__member-line">
        {/* O bloco avatar+nome abre o perfil-de-outro (ADR-043). As ações de gestão (role/remove)
            ficam de fora do botão, intactas. */}
        <button
          type="button"
          className="channel-management-panel__member-open"
          onClick={() => onOpenProfile?.(user.id)}
          aria-label={t('channel.viewProfile', { name: user.displayName })}
        >
          <MemberAvatar user={user} self={self} presence={presence} />
          <MemberName user={user} self={self} />
        </button>
        {state === 'invited' && (
          <span className="channel-management-panel__member-pending">{t('channel.awaiting')}</span>
        )}
        {removePeople && !self && (
          <button
            type="button"
            className="channel-management-panel__member-remove"
            onClick={() => onRequestRemove(user)}
            aria-label={t('channel.removeNamed', { name: user.displayName })}
          >
            {t('channel.remove')}
          </button>
        )}
        {setRoles && settableRole(member) ? (
          <span className="channel-management-panel__role-field">
            <select
              className="channel-management-panel__role-control"
              data-role={role}
              value={role}
              disabled={roleBusy}
              aria-label={t('channel.roleFor', { name: user.displayName })}
              onChange={(e) => void changeRole(e.target.value as 'admin' | 'member')}
            >
              <option value="admin">{roleLabel().admin}</option>
              <option value="member">{roleLabel().member}</option>
            </select>
          </span>
        ) : (
          <span className="channel-management-panel__member-role" data-role={role}>
            {roleLabel()[role]}
          </span>
        )}
      </div>
      {roleError && (
        <span className="channel-management-panel__member-error" role="alert">
          {t('channel.roleFailed')}
        </span>
      )}
    </li>
  )
}
