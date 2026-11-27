import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Channel, ChannelId, Presence, RosterEntry, UserId } from '@tayet/client'
import { Button, Field, ScreenHeader } from '../primitives'
import { useCoveringScreen } from '../covering-screen'
import { useStackBack, useStackDialog } from '../stack'
import { useMounted } from '../use-mounted'
import { ConfirmBody, ConfirmFooter, ConfirmSheet, ConfirmTitle, ManageShell, MemberAvatar, MemberName } from './ManageShell'
import { GLYPH, t } from '../i18n'

// The group conversation's details panel (ADR-094 dec. 9 and 13; channel-management.md §10). Its own
// component on the management panel's casca and confirm (ManageShell), never a branch of the
// ChannelManagementPanel: a group has no name or topic to edit, no archive, no roles, no add or remove
// (§10.1 item 6). What it has: the participants, read-only; convert into a private channel; leave.
//
// Consistency = await-and-close (ADR-029 §2), as on the channel's panel: convert and leave await the
// verb; success closes the panel (after converting the conversation stays selected — the same conversation,
// now a channel, reconciled by channel.changed; after leaving, channel.removed drops it and clears the
// selection, the path leaving a channel already takes); failure keeps the confirm open with the
// inline error.
//
// Narrow window (`narrow`; §11, PLANO-MOBILE M8): the same instance as a full screen of the stack, with
// leaving in a bottom sheet that is an entry of its own over it. Converting does not exist there (G2): a
// convert confirm open when the window narrows is not shown. Closing the sheet while it waits closes the
// sheet alone and leaving goes on; reopened, it shows where that stands (G3).
//
// P1 (ADR-007/ADR-008): only clean domain on screen — displayName, operatorName. The opaque ids live in
// React keys and verb payloads, never in text, title or aria-label.

type Confirm = 'convert' | 'leave'

// §10.1 item 2: the reader first, then the order of `participants`. Anyone the roster has and the
// channel's participants don't (a race between the two reads) goes last, in roster order.
function ordered(members: RosterEntry[], participants: UserId[]): RosterEntry[] {
  const rank = (m: RosterEntry): number => {
    if (m.self) return -1
    const i = participants.indexOf(m.user.id)
    return i < 0 ? participants.length : i
  }
  return members
    .map((m, i) => ({ m, i }))
    .sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i)
    .map(({ m }) => m)
}

// One instance per group, wherever it is mounted: what is open, pending or late belongs to that group.
export function GroupDetailsPanel(props: Parameters<typeof GroupDetails>[0]) {
  return <GroupDetails key={props.channel.id} {...props} />
}

function GroupDetails({
  channel,
  members,
  onConvertToChannel,
  onLeaveChannel,
  onOpenProfile,
  presenceOf,
  onClose,
  narrow = false,
  covered = false,
}: {
  channel: Channel
  // The group's roster (useChat keys it on managing.id). The reader's entry (`self`, ADR-081) carries
  // the reader's role: convert is offered only once it is known and admin (§10.1 item 3).
  members: RosterEntry[]
  onConvertToChannel: (id: ChannelId, name: string) => Promise<void>
  onLeaveChannel: (id: ChannelId) => Promise<void>
  // Perfil-de-outro (ADR-043): the row opens the person's profile, as on the channel's roster.
  onOpenProfile?: (user: UserId) => void
  // Presence of a row (ADR-056): the picker's dot on whoever is online. Optional — the bare harness
  // omits it and no row gets a dot.
  presenceOf?: (user: UserId) => Presence
  onClose: () => void
  // Below the width breakpoint: a full screen; `covered` while another one is over it.
  narrow?: boolean
  covered?: boolean
}) {
  const [confirm, setConfirm] = useState<Confirm | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [name, setName] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const mounted = useMounted()

  const rows = ordered(members, channel.participants ?? [])
  const canConvert = members.some((m) => m.self && m.role === 'admin')
  const trimmedName = name.trim()

  useEffect(() => {
    if (confirm === 'convert') nameRef.current?.focus()
  }, [confirm])

  function openConfirm(next: Confirm) {
    setConfirm(next)
    setName('')
    // G3: the sheet reopens on where leaving stands; only a hidden convert confirm leaves nothing behind.
    if (narrow && confirm !== 'convert') return
    setPending(false)
    setFailed(false)
  }
  function closeConfirm() {
    setConfirm(undefined)
    setFailed(false)
    if (!narrow) setPending(false)
  }
  // Both entries here, bottom first, so they push in that order when both open in one commit.
  useStackDialog('group', narrow, onClose)
  useStackDialog('group-leave', narrow && confirm === 'leave', closeConfirm)

  async function handleConfirm() {
    if (!confirm || pending) return
    // The channel name follows creation's rule (NewConversationDialog): required, trimmed.
    if (confirm === 'convert' && trimmedName.length === 0) return
    setPending(true)
    setFailed(false)
    try {
      if (confirm === 'convert') await onConvertToChannel(channel.id, trimmedName)
      else await onLeaveChannel(channel.id)
      // R4: a verb closes only the details it started from, never another group's opened meanwhile.
      if (mounted.current) onClose()
    } catch {
      // The panel may be gone by now: channel.removed can land before the verb rejects, or the person left it.
      if (!mounted.current) return
      // Not in a finally: never setState after the success path unmounts the panel.
      setFailed(true)
      setPending(false)
    }
  }

  const copy =
    confirm === 'convert'
      ? { title: t('group.convert'), body: t('group.convertBody'), action: t('group.convert') }
      : { title: t('group.leave'), body: t('group.leaveBody'), action: t('channel.leave') }
  const tone = confirm === 'convert' ? 'primary' : 'danger'
  const participants = (
    <section className="channel-management-panel__roster" aria-label={t('group.participants')}>
      <div className="channel-management-panel__roster-head">
        <h4 className="channel-management-panel__roster-title">
          {t('group.participants')} {GLYPH.dot} {rows.length}
        </h4>
      </div>
      <ul className="channel-management-panel__roster-list">
        {rows.map((member) => (
          <ParticipantRow
            key={member.user.id}
            member={member}
            onOpenProfile={onOpenProfile}
            presence={presenceOf?.(member.user.id)}
          />
        ))}
      </ul>
    </section>
  )

  if (narrow)
    return (
      <>
        <GroupScreen covered={covered} onClose={onClose} onLeave={() => openConfirm('leave')}>
          {participants}
        </GroupScreen>
        {confirm === 'leave' && (
          <ConfirmSheet
            title={t('group.leave')}
            body={t('group.leaveBody')}
            action={t('channel.leave')}
            tone="danger"
            pending={pending}
            failed={failed}
            onConfirm={() => void handleConfirm()}
            onClose={closeConfirm}
          />
        )}
      </>
    )

  return (
    <ManageShell
      main={confirm === undefined}
      title={confirm ? <ConfirmTitle tone={tone}>{copy.title}</ConfirmTitle> : t('group.details')}
      ariaLabel={confirm ? copy.title : t('group.details')}
      onClose={confirm ? closeConfirm : onClose}
      closeLabel={confirm ? undefined : t('channel.close')}
      footer={
        confirm && (
          <ConfirmFooter
            tone={tone}
            action={copy.action}
            pending={pending}
            disabled={confirm === 'convert' && trimmedName.length === 0}
            focusCancel={confirm !== 'convert'}
            onCancel={closeConfirm}
            onConfirm={() => void handleConfirm()}
          />
        )
      }
      actions={
        <>
          {canConvert && (
            <Button
              variant="secondary"
              size="gestao"
              className="channel-management-panel__footer-action"
              onClick={() => openConfirm('convert')}
            >
              {t('group.convert')}
            </Button>
          )}
          <Button
            variant="danger"
            size="gestao"
            className="channel-management-panel__footer-action"
            onClick={() => openConfirm('leave')}
          >
            {t('group.leave')}
          </Button>
        </>
      }
    >
      {confirm === undefined && participants}
      {confirm !== undefined && (
        <ConfirmBody body={copy.body} failed={failed}>
          {confirm === 'convert' && (
            // §10.1 item 4: the new conversation dialog's name field, by its recipe (§10.2).
            <Field label={t('group.convertName')} htmlFor="group-convert-name">
              <div className="compose-dialog__name">
                <span className="compose-dialog__name-mark" aria-hidden="true">
                  {GLYPH.hash}
                </span>
                <input
                  id="group-convert-name"
                  ref={nameRef}
                  className="compose-dialog__name-input"
                  value={name}
                  aria-invalid={trimmedName.length === 0}
                  disabled={pending}
                  onChange={(e) => {
                    setName(e.target.value)
                    setFailed(false)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void handleConfirm()
                    }
                  }}
                />
              </div>
            </Field>
          )}
        </ConfirmBody>
      )}
    </ManageShell>
  )
}

// §11.1 items 1 to 3: back and the title, the participants that scroll, leaving in the fixed footer.
function GroupScreen({
  covered,
  onClose,
  onLeave,
  children,
}: {
  covered: boolean
  onClose: () => void
  onLeave: () => void
  children: ReactNode
}) {
  const back = useStackBack(onClose)
  const { backRef, screenProps } = useCoveringScreen(back, covered)
  return (
    <section className="group-screen" aria-label={t('group.details')} {...screenProps}>
      <ScreenHeader className="group-screen__header" onBack={back} backRef={backRef} title={t('group.details')} />
      <div className="group-screen__body">{children}</div>
      <div className="group-screen__footer">
        <Button variant="danger" onClick={onLeave}>
          {t('group.leave')}
        </Button>
      </div>
    </section>
  )
}

// One participant (§10.1 item 2): the roster row's avatar and name, "· você" on the reader's own; the
// picker's presence dot on whoever is online; an agent with its avatar and, when known, its operator on a
// second line (§13.1 item 4). No role, no Remove.
function ParticipantRow({
  member,
  onOpenProfile,
  presence,
}: {
  member: RosterEntry
  onOpenProfile?: (user: UserId) => void
  presence?: Presence
}) {
  const { user, self } = member
  return (
    <li className="channel-management-panel__member">
      <div className="channel-management-panel__member-line">
        <button
          type="button"
          className="channel-management-panel__member-open"
          onClick={() => onOpenProfile?.(user.id)}
          aria-label={t('channel.viewProfile', { name: user.displayName })}
        >
          <MemberAvatar user={user} self={self} presence={presence} />
          <MemberName user={user} self={self} />
        </button>
      </div>
    </li>
  )
}
