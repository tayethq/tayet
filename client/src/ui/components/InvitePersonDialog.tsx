import { useEffect, useRef, useState } from 'react'
import { PersonExistsError } from '@tayet/client'
import type { Channel, ChannelId, NewPerson, PersonInvite } from '@tayet/client'
import { Button, Dialog, Field, Segmented } from '../primitives'
import { ChannelLabel, PrivateLock, PrivateMarkSpace, bareName } from './ChannelLabel'
import { t, GLYPH } from '../i18n'

// Dialog "Convidar pessoa" (manifesto account-access.md §9.1; ADR-083): a casca do Nova conversa, com o
// corpo substituído no sucesso. O admin copia as instruções: o Tayet não envia email (§9.3). Canais são
// os de que o operador é membro, nunca #all, onde só o convite de `system` entra. Os chips são markup
// local (§9.2 h), com a marca do ChannelLabel. `failedChannels` não desfaz o convite: o sucesso os lista. P1: o endereço é o host do
// app, e a pessoa é escolhida pelo email que o admin digita, sem verbo de diretório.

interface Sent {
  instructions: string
  failed: string[]
}

export function InvitePersonDialog({
  channels,
  onInvite,
  onClose,
}: {
  channels: Channel[]
  onInvite: (person: NewPerson) => Promise<PersonInvite>
  onClose: () => void
}) {
  // ADR-094 dec. 13: a group conversation is not offered (its people are fixed).
  const offered = channels.filter((c) => c.kind !== 'dm' && c.kind !== 'group' && !c.org)

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [kind, setKind] = useState<NewPerson['kind']>('member')
  const [selected, setSelected] = useState<ChannelId[]>([])

  const [sending, setSending] = useState(false)
  const [emailTaken, setEmailTaken] = useState(false)
  const [failed, setFailed] = useState(false)
  const [noChannel, setNoChannel] = useState(false)
  const [sent, setSent] = useState<Sent | undefined>(undefined)

  const nameRef = useRef<HTMLInputElement>(null)
  const instructionsRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => nameRef.current?.focus(), [])

  const trimmedName = name.trim()
  const trimmedEmail = email.trim()
  const canSubmit = !sending && trimmedName.length > 0 && trimmedEmail.length > 0

  const guard = sending ? () => {} : onClose

  function toggle(channel: ChannelId) {
    setSelected((current) => (current.includes(channel) ? current.filter((c) => c !== channel) : [...current, channel]))
    setNoChannel(false)
    setFailed(false)
  }

  function chooseKind(next: NewPerson['kind']) {
    setKind(next)
    setNoChannel(false)
    setFailed(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    if (kind === 'guest' && selected.length === 0) {
      setNoChannel(true)
      return
    }
    setSending(true)
    setEmailTaken(false)
    setFailed(false)
    try {
      const { failedChannels } = await onInvite({
        name: trimmedName,
        email: trimmedEmail,
        kind,
        channels: selected,
      })
      setSent({
        instructions: t('people.instructions', {
          name: trimmedName,
          address: window.location.host,
          email: trimmedEmail,
        }),
        failed: offered.filter((c) => failedChannels.includes(c.id)).map((c) => c.name),
      })
    } catch (error) {
      if (error instanceof PersonExistsError) setEmailTaken(true)
      else setFailed(true)
    } finally {
      setSending(false)
    }
  }

  async function copyInstructions(text: string) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // No clipboard (a denied permission, a plain-http origin): leave the text selected to copy by hand.
      const box = instructionsRef.current
      if (box) window.getSelection()?.selectAllChildren(box)
    }
  }

  if (sent) {
    return (
      <Dialog
        className="compose-dialog invite-person"
        title={t('people.invite')}
        onClose={onClose}
        closeLabel={t('dialog.close')}
        footer={
          <Button variant="secondary" onClick={onClose}>
            {t('dialog.close')}
          </Button>
        }
      >
        <div className="invite-person__done">
          <div className="invite-person__ready">{t('people.inviteReady')}</div>
          <p ref={instructionsRef} className="invite-person__instructions">
            {sent.instructions}
          </p>
          {sent.failed.length > 0 && (
            <p className="compose-dialog__error" role="alert">
              {t('people.channelsFailed', { channels: sent.failed.join(', ') })}
            </p>
          )}
          <Button
            variant="fill"
            className="invite-person__copy"
            autoFocus
            onClick={() => void copyInstructions(sent.instructions)}
          >
            {t('people.copyInstructions')}
          </Button>
        </div>
      </Dialog>
    )
  }

  const selectedChannels = selected.flatMap((id) => offered.filter((c) => c.id === id))
  const suggestions = offered.filter((c) => !selected.includes(c.id))

  return (
    <Dialog className="compose-dialog invite-person" title={t('people.invite')} onClose={guard} closeLabel={t('dialog.close')}>
      <form className="compose-dialog__form" onSubmit={handleSubmit} noValidate>
        <div className="compose-dialog__fields" inert={sending}>
          <Field
            label={t('people.fieldName')}
            htmlFor="invite-name"
            inputRef={nameRef}
            inputProps={{ value: name, autoComplete: 'off', onChange: (e) => setName(e.target.value) }}
          />
          <div className="invite-person__field">
            <Field
              label={t('people.fieldEmail')}
              htmlFor="invite-email"
              inputProps={{
                type: 'email',
                value: email,
                autoComplete: 'off',
                'aria-invalid': emailTaken,
                onChange: (e) => {
                  setEmail(e.target.value)
                  setEmailTaken(false)
                  setFailed(false)
                },
              }}
            />
            {emailTaken && <p className="compose-dialog__error">{t('people.emailTaken')}</p>}
          </div>
          <Field label={t('people.fieldKind')}>
            <div className="invite-person__kind">
              <Segmented
                ariaLabel={t('people.fieldKind')}
                value={kind}
                options={[
                  { value: 'member', label: t('people.kindMember') },
                  { value: 'guest', label: t('people.kindGuest') },
                ]}
                onChange={chooseKind}
              />
              {noChannel ? (
                <p className="compose-dialog__error" role="alert">
                  {t('people.helpGuest')}
                </p>
              ) : (
                <p className="invite-person__help">
                  {kind === 'guest' ? t('people.helpGuest') : t('people.helpMember')}
                </p>
              )}
            </div>
          </Field>
          <div className="invite-person__channels">
            <span className="ui-field__label">{t('people.fieldChannels')}</span>
            <div className="compose-dialog__chips">
              {selectedChannels.map((channel) => (
                <span key={channel.id} className="compose-dialog__chip">
                  {channel.kind === 'private' ? (
                    <>
                      <span className="compose-dialog__chip-mark">
                        <PrivateLock />
                      </span>
                      <PrivateMarkSpace />
                    </>
                  ) : (
                    <span className="compose-dialog__chip-mark invite-person__mark" aria-hidden="true">
                      {GLYPH.hash}
                    </span>
                  )}
                  {bareName(channel)}
                  <button
                    type="button"
                    className="compose-dialog__chip-remove"
                    aria-label={t('people.removeChannel', { channel: bareName(channel) })}
                    onClick={() => toggle(channel.id)}
                  >
                    {GLYPH.clear}
                  </button>
                </span>
              ))}
              {suggestions.map((channel) => (
                <button
                  key={channel.id}
                  type="button"
                  className="compose-dialog__suggest"
                  onClick={() => toggle(channel.id)}
                >
                  <span aria-hidden="true">{GLYPH.plus}</span>
                  <ChannelLabel channel={channel} />
                </button>
              ))}
            </div>
          </div>
          {failed && (
            <p className="compose-dialog__error" role="alert">
              {t('people.inviteError')}
            </p>
          )}
        </div>
        <div className="ui-dialog__footer">
          <Button variant="secondary" onClick={onClose} disabled={sending}>
            {t('account.cancel')}
          </Button>
          <Button variant="fill" type="submit" disabled={!canSubmit} aria-busy={sending || undefined}>
            {sending ? t('people.submitting') : t('people.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
