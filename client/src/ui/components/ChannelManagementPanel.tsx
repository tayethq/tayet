import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { Channel, ChannelId, ChannelPatch, Presence, Role, RosterEntry, User, UserId } from '@tayet/client'
import { RateLimitedError } from '@tayet/client'
import { Avatar, Button } from '../primitives'
import { ConfirmBody, ConfirmFooter, ConfirmTitle, ManageShell } from './ManageShell'
import type { ConfirmTone } from './ManageShell'
import { AgentAvatar, agentColorOf } from './AgentAvatar'
import { useMedia } from '../MediaContext'
import { ChannelLabel, manageLabel } from './ChannelLabel'
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
// member.displayName / member.role). The opaque ids (channel.id, user.id) live ONLY in verb
// payloads and React keys, never on screen; copy and aria-labels carry no protocol vocabulary.
//
// Member roster (Track U/U2, ADR-029). The managed channel's members, with the three membership
// mutations driven by the operator's own token (P1, client-side). Each mutation is await-and-close:
// success closes its surface and lets the member.changed stream reconcile the roster; failure shows
// an inline error and the roster is left intact (never mutated optimistically). The roster entry
// carries `self` (ADR-081): the own row reads "· você" and offers no mutation on oneself.

// Confirmation target (Track U/U1 + U2). archive/leave carry no payload; remove-member carries the
// User so the dialog body can interpolate the displayName (NEVER user.id — P1) and handleConfirm can
// pass the id to the verb.
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

const confirmCopyOf = (): Record<'archive' | 'leave', { title: string; body: string; action: string }> => ({
  archive: {
    title: t('channel.archiveTitle'),
    body: t('channel.archiveBody'),
    action: t('channel.archive'),
  },
  leave: {
    title: t('channel.leaveTitle'),
    body: t('channel.leaveBody'),
    action: t('channel.leave'),
  },
})

// Dialog copy for the active confirmation. remove-member interpolates the clean displayName (P1 —
// never user.id); archive/leave read confirmCopyOf above.
function confirmCopy(c: Confirm): { title: string; body: string; action: string } {
  if (c.kind === 'remove-member')
    return {
      title: t('channel.removeTitle'),
      body: t('channel.removeBody', { name: c.user.displayName }),
      action: t('channel.remove'),
    }
  return confirmCopyOf()[c.kind]
}

export function ChannelManagementPanel({
  channel,
  members,
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
}: {
  channel: Channel
  // Track U/U2: the managed channel's roster (already keyed on managing.id in useChat). Read-only
  // here — mutations go through the handlers below and reconcile via the member.changed stream.
  members: RosterEntry[]
  onUpdateChannel: (id: ChannelId, patch: ChannelPatch) => Promise<void>
  onArchiveChannel: (id: ChannelId) => Promise<void>
  onLeaveChannel: (id: ChannelId) => Promise<void>
  // Membership mutations (Track U/U2, ADR-029 §2), await-and-close. REQUIRED: a panel mounted without
  // a membership verb is irrepresentable (the Workspace mount-guard narrows the optional Workspace
  // props to these — the U1 pattern). A wiring regression in App fails loud (panel does not mount /
  // gate breaks), never degrades silently into a missing affordance.
  onSetRole: (id: ChannelId, user: UserId, role: 'admin' | 'member') => Promise<void>
  onRemoveMember: (id: ChannelId, user: UserId) => Promise<void>
  onAddMember: (id: ChannelId, user: UserId) => Promise<void>
  loadCandidates: () => Promise<User[]>
  // Perfil-de-outro (ADR-043, Slice 2 PR-2): abre o perfil do membro a partir da sua linha no roster.
  // Optional — App liga via Workspace; o harness bare o omite (o click vira no-op). Recebe o UserId
  // opaco (member.user.id); as ações de gestão (setRole/remove) seguem intactas.
  onOpenProfile?: (user: UserId) => void
  // Presença de linha no roster + picker (ADR-056 rollout, §8.4; cluster 22 herdado por referência —
  // new-conversation.md §2). Leitura síncrona composta pelo Workspace (mapa ?? point read). Opcional:
  // o harness bare a omite → Avatar sem a prop, DOM byte-idêntico. Um invited sem conexão resolve
  // 'offline' → sem dot, correto por construção (sem special-case).
  presenceOf?: (user: UserId) => Presence
  onClose: () => void
}) {
  // Form seeded from props. The mount site keys this component on channel.id, so switching the
  // managed channel remounts it with fresh state — no reset effect needed. The name is seeded WITHOUT
  // the kind mark (Channel.name is '#'+name; the field edits the name, §8.66) and saved as typed: the
  // read side normalizes one leading '#', so a typed '#x' still reads '#x'.
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
  const [pending, setPending] = useState(false)
  const [confirmError, setConfirmError] = useState(false)

  // Add-member picker (seam B1). Lazy: candidates load only when the picker opens. The empty-state
  // copy is shown ONLY on a successful empty load (distinguished from a load failure via pickerError).
  const [picker, setPicker] = useState(false)
  const [candidates, setCandidates] = useState<User[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerError, setPickerError] = useState(false)
  const [adding, setAdding] = useState(false)
  const [rateLimited, setRateLimited] = useState(false)

  const nameRef = useRef<HTMLInputElement>(null)

  // a11y: focus enters the panel on open — land on the name field. The confirm/picker are view-states
  // of the same Dialog (ADR-036/ADR-038), which owns the focus trap + Esc; initial focus inside them
  // rides `autoFocus` on the non-destructive control (Cancel / Close), since Button is not ref-forwarded.
  useEffect(() => {
    nameRef.current?.focus()
  }, [])

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
      e.stopPropagation() // the Dialog's Esc closes the panel; this one only undoes the edit
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
    setConfirmError(false)
    setPending(false)
  }
  function closeConfirm() {
    setConfirm(undefined)
    setConfirmError(false)
    setPending(false)
  }

  async function handleConfirm() {
    if (!confirm || pending) return
    setPending(true)
    setConfirmError(false)
    try {
      if (confirm.kind === 'remove-member') {
        await onRemoveMember(channel.id, confirm.user.id)
        // Success: close the dialog only — the panel stays open and the roster reconciles via the
        // member.changed stream (never an optimistic splice).
        closeConfirm()
        return
      }
      const verb = confirm.kind === 'archive' ? onArchiveChannel : onLeaveChannel
      await verb(channel.id)
      onClose() // success: close. The list reconciles via the channel.removed stream (useChat).
    } catch {
      // Inline error in the dialog; it stays open and the channel/member remains. Reset pending here
      // (not in a finally) so we never setState after the success path unmounts the panel.
      setConfirmError(true)
      setPending(false)
    }
  }

  // Open the picker and load candidates lazily (seam B1). loadCandidates composes the union of the
  // visible channels' members minus this roster (useChat) — no directory verb, resolveUser untouched.
  async function openPicker() {
    setPicker(true)
    setPickerLoading(true)
    setPickerError(false)
    setRateLimited(false)
    setAdding(false)
    setCandidates([])
    try {
      setCandidates(await loadCandidates())
    } catch {
      setPickerError(true)
    } finally {
      setPickerLoading(false)
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
      closePicker() // success: the roster reconciles via member.changed (no optimistic insert).
    } catch (e) {
      // P1: classify on the domain error TYPE (instanceof) — never sniff the SDK's raw error shape
      // here; the gateway already mapped it to a domain type below the barrel. RateLimitedError gets
      // its own copy that does NOT push the user straight back into the same limit; any other
      // failure → the generic inline error.
      if (e instanceof RateLimitedError) setRateLimited(true)
      else setPickerError(true) // inline error; the picker stays open and the roster is untouched.
      setAdding(false)
    }
  }

  const nameStatus = fieldStatus('name')
  const topicStatus = fieldStatus('topic')

  // View-state machine (ADR-038, Fork A): the confirm and the add-member picker are no longer
  // nested Dialogs — they are sub-views of THIS one Dialog (one scrim/trap/Esc). Opening a
  // confirm/picker swaps the body/title/footer; it never overlays. Esc is view-aware via onClose:
  // in `main` it closes the panel; in `confirm`/`picker` it steps back to `main`. The casca and the
  // confirm are shared with the group's details panel (ManageShell).
  const view: 'main' | 'confirm' | 'picker' = confirm ? 'confirm' : picker ? 'picker' : 'main'
  // §9 items 1–3, §6.1: archive is reversible → primary (accent dot, fill); leave and remove → danger.
  const tone: ConfirmTone = confirm?.kind === 'archive' ? 'primary' : 'danger'
  const dialog: { title: ReactNode; ariaLabel: string | undefined; onClose: () => void; closeLabel: string | undefined } =
    view === 'confirm'
      ? {
          title: <ConfirmTitle tone={tone}>{confirmCopy(confirm!).title}</ConfirmTitle>,
          ariaLabel: confirmCopy(confirm!).title,
          onClose: closeConfirm,
          closeLabel: undefined,
        }
      : view === 'picker'
        ? { title: t('channel.addMember'), ariaLabel: undefined, onClose: closePicker, closeLabel: undefined }
        : {
            title: <ChannelLabel channel={channel} />,
            ariaLabel: manageLabel(channel),
            onClose,
            closeLabel: t('channel.closeManage'),
          }

  return (
    <ManageShell
      main={view === 'main'}
      title={dialog.title}
      ariaLabel={dialog.ariaLabel}
      onClose={dialog.onClose}
      closeLabel={dialog.closeLabel}
      footer={
        view === 'confirm' ? (
          <ConfirmFooter
            tone={tone}
            action={confirmCopy(confirm!).action}
            pending={pending}
            onCancel={closeConfirm}
            onConfirm={() => void handleConfirm()}
          />
        ) : view === 'picker' ? (
          // autoFocus: focus enters on Close (the first enabled control while candidates load).
          <Button
            variant="secondary"
            size="gestao"
            autoFocus
            onClick={closePicker}
            disabled={adding}
          >
            {t('channel.close')}
          </Button>
        ) : undefined
      }
      actions={
        // High-consequence verbs: confirmation-gated, pinned to the modal foot. Only on the main view.
        <>
          <Button
            variant="secondary"
            size="gestao"
            className="channel-management-panel__footer-action"
            onClick={() => openConfirm({ kind: 'archive' })}
          >
            {t('channel.archiveTitle')}
          </Button>
          <Button
            variant="danger"
            size="gestao"
            className="channel-management-panel__footer-action"
            onClick={() => openConfirm({ kind: 'leave' })}
          >
            {t('channel.leaveTitle')}
          </Button>
        </>
      }
    >
        {view === 'main' && (
          <>
        <div className="channel-management-panel__field">
          <label className="channel-management-panel__label" htmlFor="manage-name">
            {t('channel.name')}
          </label>
          <div className="channel-management-panel__input-wrap">
            {/* The field's mark is the header's (ChannelLabel): the lock on a private channel, never '#'. */}
            {channel.kind === 'private' ? (
              <span
                className="channel-management-panel__input-mark"
                role="img"
                aria-label={t('channel.privateMark')}
              >
                <Lock />
              </span>
            ) : (
              <span className="channel-management-panel__input-mark" aria-hidden="true">
                {GLYPH.hash}
              </span>
            )}
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

        {/* Member roster (Track U/U2). Read-only here; P1 renders ONLY displayName + the role label —
            user.id lives only in the React key, never on screen. */}
        <section className="channel-management-panel__roster" aria-label={t('channel.members')}>
          <div className="channel-management-panel__roster-head">
            <h4 className="channel-management-panel__roster-title">
              {t('channel.membersCount', { n: members.length })}
            </h4>
            <button
              type="button"
              className="channel-management-panel__add-member"
              aria-label={t('channel.addMember')}
              onClick={() => void openPicker()}
            >
              {t('channel.add')}
            </button>
          </div>
          <ul className="channel-management-panel__roster-list">
            {members.map((member) => (
              <MemberRow
                key={member.user.id}
                member={member}
                channelId={channel.id}
                onSetRole={onSetRole}
                onRequestRemove={(user) => openConfirm({ kind: 'remove-member', user })}
                onOpenProfile={onOpenProfile}
                presence={presenceOf?.(member.user.id)}
              />
            ))}
          </ul>
        </section>
          </>
        )}

        {/* Confirm view (archive / leave / remove-member): same Dialog, body swapped. The footer
            (Cancel + the action) rides the Dialog's footer slot above. */}
        {view === 'confirm' && <ConfirmBody body={confirmCopy(confirm!).body} failed={confirmError} />}

        {/* Add-member picker view (seam B1): same Dialog, body swapped. P1: candidates render by
            displayName only — user.id lives in the React key + the onAddMember payload, never on screen. */}
        {view === 'picker' && (
          <>
            {pickerLoading ? (
              <p className="channel-management-panel__picker-empty">{t('channel.loading')}</p>
            ) : (
              <>
                {candidates.length > 0 && (
                  <ul className="channel-management-panel__picker-list">
                    {candidates.map((user) => (
                      <li key={user.id}>
                        <button
                          type="button"
                          className="channel-management-panel__picker-option"
                          onClick={() => void addCandidate(user)}
                          disabled={adding}
                        >
                          {agentColorOf(user) !== undefined ? (
                            <AgentAvatar color={agentColorOf(user)!} size="gestao" />
                          ) : (
                            <Avatar size="gestao" label={user.displayName.slice(0, 1)} presence={presenceOf?.(user.id)} />
                          )}
                          <span className="channel-management-panel__member-name">
                            {user.displayName}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {/* Neutral empty state — only on a successful empty load (never on a load error).
                    No search/directory affordance (the ADR-029 §3 trigger is not fired). */}
                {!pickerError && !rateLimited && candidates.length === 0 && (
                  <p className="channel-management-panel__picker-empty">
                    {t('channel.noCandidates')}
                  </p>
                )}
              </>
            )}
            {pickerError && (
              <p className="manage-dialog__error" role="alert">
                {t('channel.failed')}
              </p>
            )}
            {rateLimited && (
              <p className="manage-dialog__error" role="alert">
                {t('channel.rateLimited')}
              </p>
            )}
          </>
        )}
    </ManageShell>
  )
}

// One roster row (Track U/U2). Busy/error state is scoped here, per user.id — a failed mutation on
// one member never touches another row, and never mutates the roster (it reconciles only on the
// confirmed member.changed). P1: renders ONLY displayName + role; user.id lives only in verb payloads.
//
// Role control asymmetry (ADR-026): Role is admin | member | guest, but setRole accepts only
// admin | member. So admin/member rows get an admin↔member control; a guest row shows a read-only
// label (no verb makes guest settable) — the read-only gate is on `role`, NOT on handler presence.
// The own row (`self`, ADR-081) offers neither: role as a label, no Remove.
function MemberRow({
  member,
  channelId,
  onSetRole,
  onRequestRemove,
  onOpenProfile,
  presence,
}: {
  member: RosterEntry
  channelId: ChannelId
  onSetRole: (id: ChannelId, user: UserId, role: 'admin' | 'member') => Promise<void>
  // Opens the panel-level remove-member confirmation (the actual await lives there, reusing the
  // shared scrim/dialog). Always wired — the panel passes it unconditionally (mount-guard ensures it).
  onRequestRemove: (user: User) => void
  // Perfil-de-outro (ADR-043): abre o perfil deste membro. Optional-chained — no-op no harness bare.
  // aria-label carrega o displayName limpo, nunca user.id (P1).
  onOpenProfile?: (user: UserId) => void
  // Presença deste membro (ADR-056 rollout, §8.4) — valor já lido pelo panel; ausente no harness
  // bare → Avatar sem a prop.
  presence?: Presence
}) {
  const { user, role, state, self } = member
  const [roleBusy, setRoleBusy] = useState(false)
  const [roleError, setRoleError] = useState(false)
  // Invited members show a read-only role (like guest): setRole on someone who hasn't connected
  // is meaningless, and "awaiting first connection" is not the moment to fiddle with power.
  const settable = role !== 'guest' && state === 'active' && !self
  // Foto do membro (ADR-041 PR-2): resolve o avatar opaco → URL via useMedia (no-op sem avatar). O
  // Avatar cai pro monograma sem foto. P1: o mr_*/mxc fica aqui+ACL, nunca no DOM.
  const avatar = useMedia(user.avatar, 'thumbnail').url

  async function changeRole(next: 'admin' | 'member') {
    if (roleBusy || next === role) return
    setRoleBusy(true)
    setRoleError(false)
    try {
      await onSetRole(channelId, user.id, next)
      // Success: do nothing — the roster (and this row's `role` prop) reconciles via member.changed.
    } catch {
      // Inline error scoped to this row; the roster is left intact (the controlled <select> reverts
      // to the unchanged `role` prop, so no optimistic flip survives the rejection).
      setRoleError(true)
    } finally {
      setRoleBusy(false)
    }
  }

  return (
    <li className="channel-management-panel__member">
      <div className="channel-management-panel__member-line">
        {/* O bloco avatar+nome abre o perfil-de-outro (ADR-043). As ações de gestão (role/remove)
            ficam de fora do botão, intactas. aria-label com o displayName limpo, nunca user.id (P1). */}
        <button
          type="button"
          className="channel-management-panel__member-open"
          onClick={() => onOpenProfile?.(user.id)}
          aria-label={t('channel.viewProfile', { name: user.displayName })}
        >
          {agentColorOf(user) !== undefined ? (
            // ADR-086: an agent member carries the agent avatar — no photo, never presence.
            <AgentAvatar color={agentColorOf(user)!} size="gestao" />
          ) : (
            <Avatar
              size="gestao"
              variant={self ? 'accent' : 'greige'}
              label={user.displayName.slice(0, 1)}
              src={avatar}
              presence={presence}
            />
          )}
          <span className="channel-management-panel__member-name">
            {user.displayName}
            {self && <span className="channel-management-panel__member-you"> {t('channel.you')}</span>}
          </span>
        </button>
        {state === 'invited' && (
          <span className="channel-management-panel__member-pending">{t('channel.awaiting')}</span>
        )}
        {!self && (
          <button
            type="button"
            className="channel-management-panel__member-remove"
            onClick={() => onRequestRemove(user)}
            aria-label={t('channel.removeNamed', { name: user.displayName })}
          >
            {t('channel.remove')}
          </button>
        )}
        {settable ? (
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
