import { useEffect, useState } from 'react'
import type { MediaRef, MyProfile, OrgFields } from '@tayet/client'
import { Button, Dialog, Field } from '../primitives'
import { ProfilePhoto } from './ProfilePhoto'
import { t } from '../i18n'

// Editor de perfil (ADR-040), 2º consumidor do drill-in F4 (addendum ADR-038). Corpo + Dialog próprios,
// montado pela view `profile` do AccountSettings. P1: renderiza só campos limpos (fullName, nickname,
// pronouns, note); nenhum id/mxid/termo de protocolo. Pronomes (Slice 1) é self-visível — você vê o seu ao
// reabrir; visível-a-outros é Slice 2. Recado (ADR-053) idem: mesmo sink dos pronomes, self-visível aqui.
// O write (updateMyProfile → o nome efetivo global + account-data) vive
// atrás do barrel; aqui só strings limpas. Lifecycle de save EXPLÍCITO (gatilho = botão Salvar): a escrita bate no
// protocolo, então nada de save-on-blur. Erro inline, campo+botão ficam (idioma do ChannelManagementPanel).
//
// "Da sua organização": Nome, Cargo e Email vêm da camada organizacional do MyProfile — a org é a
// autoridade (não há superfície de claims client-side). São read-only AQUI por invariante, não por
// falta de fonte: a edição desses campos não é do cliente. O Nome é incondicional (sempre resolvido);
// Cargo e Email colapsam individualmente quando a org não os afirma.
//
// Field vivo (ADR-036) é input-via-htmlFor+inputProps com onChange de evento; a dica não é slot do
// primitivo, então mora como <p> irmão (adaptação §0.6 do prompt — sem hint/value-onChange no Field).

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export function ProfileEditor({
  onBack,
  onClose,
  onLoadProfile,
  onSaveProfile,
  onSaveAvatar,
  onClearAvatar,
}: {
  onBack: () => void
  onClose: () => void
  onLoadProfile: () => Promise<MyProfile>
  onSaveProfile: (patch: { nickname?: string; pronouns?: string; note?: string }) => Promise<void>
  // Foto de perfil (ADR-041 PR-3): required — torna irrepresentável montar o editor sem os verbos.
  onSaveAvatar: (file: File) => Promise<void>
  onClearAvatar: () => Promise<void>
}) {
  const [fullName, setFullName] = useState<string | null>(null) // null = carregando
  // ADR-054: camada organizacional do próprio (Cargo/Email), read-only. Lida na mesma volta do
  // MyProfile; ausente = a pessoa não tem linha no diretório. `authority` nunca sai daqui pro DOM.
  const [org, setOrg] = useState<OrgFields | undefined>(undefined)
  const [avatar, setAvatar] = useState<MediaRef | undefined>(undefined) // foto carregada (ADR-041)
  const [loadError, setLoadError] = useState(false)
  const [nickname, setNickname] = useState('')
  const [original, setOriginal] = useState('')
  const [pronouns, setPronouns] = useState('')
  const [originalPronouns, setOriginalPronouns] = useState('')
  const [note, setNote] = useState('')
  const [originalNote, setOriginalNote] = useState('')
  const [save, setSave] = useState<SaveState>('idle')

  useEffect(() => {
    let active = true
    onLoadProfile().then(
      (p) => {
        if (!active) return
        setFullName(p.fullName)
        setOrg(p.org)
        setAvatar(p.avatar)
        setNickname(p.nickname ?? '')
        setOriginal(p.nickname ?? '')
        setPronouns(p.pronouns ?? '')
        setOriginalPronouns(p.pronouns ?? '')
        setNote(p.note ?? '')
        setOriginalNote(p.note ?? '')
      },
      () => {
        if (active) setLoadError(true)
      },
    )
    return () => {
      active = false
    }
  }, [onLoadProfile])

  const dirty =
    nickname.trim() !== original.trim() ||
    pronouns.trim() !== originalPronouns.trim() ||
    note.trim() !== originalNote.trim()

  async function handleSave() {
    if (!dirty || save === 'saving') return
    setSave('saving')
    try {
      const patch: { nickname?: string; pronouns?: string; note?: string } = {}
      if (nickname.trim() !== original.trim()) patch.nickname = nickname
      if (pronouns.trim() !== originalPronouns.trim()) patch.pronouns = pronouns
      if (note.trim() !== originalNote.trim()) patch.note = note
      await onSaveProfile(patch)
      const savedNick = nickname.trim()
      const savedPronouns = pronouns.trim()
      const savedNote = note.trim()
      setNickname(savedNick)
      setOriginal(savedNick) // o valor salvo vira a nova baseline → Salvar desabilita de novo
      setPronouns(savedPronouns)
      setOriginalPronouns(savedPronouns)
      setNote(savedNote)
      setOriginalNote(savedNote)
      setSave('saved')
    } catch {
      setSave('error')
    }
  }

  const status =
    save === 'saving'
      ? t('profile.saving')
      : save === 'saved'
        ? t('profile.saved')
        : save === 'error'
          ? t('profile.saveFailed')
          : ''

  return (
    <Dialog
      className="account-settings-dialog account-settings-dialog--profile"
      title={t('profile.editTitle')}
      onBack={onBack}
      backLabel={t('dialog.back')}
      onClose={onClose}
      closeLabel={t('dialog.close')}
      footer={
        <div className="profile-editor__footer">
          <span
            className={`profile-editor__status profile-editor__status--${save}`}
            role="status"
            aria-live="polite"
          >
            {status}
          </span>
          <Button variant="fill" onClick={handleSave} disabled={!dirty || save === 'saving'}>
            {t('profile.save')}
          </Button>
        </div>
      }
    >
      <div className="profile-editor">
        {loadError ? (
          <p className="profile-editor__load-error">{t('profile.loadOwnFailed')}</p>
        ) : fullName === null ? (
          <p className="profile-editor__loading">{t('profile.loading')}</p>
        ) : (
          <>
            <ProfilePhoto
              avatar={avatar}
              name={fullName}
              onSaveAvatar={onSaveAvatar}
              onClearAvatar={onClearAvatar}
            />
            <div className="profile-editor__field">
              <Field
                label={t('profile.nickname')}
                htmlFor="profile-nickname"
                inputProps={{
                  value: nickname,
                  placeholder: t('profile.nicknamePlaceholder'),
                  onChange: (e) => {
                    setNickname(e.target.value)
                    if (save !== 'idle') setSave('idle') // editar limpa o status anterior
                  },
                }}
              />
              <p className="profile-editor__hint">
                {t('profile.nicknameHint')}
              </p>
            </div>
            <Field
              label={t('profile.pronouns')}
              htmlFor="profile-pronouns"
              inputProps={{
                value: pronouns,
                placeholder: t('profile.pronounsPlaceholder'),
                onChange: (e) => {
                  setPronouns(e.target.value)
                  if (save !== 'idle') setSave('idle') // editar limpa o status anterior
                },
              }}
            />
            <div className="profile-editor__field">
              <Field
                label={t('profile.note')}
                htmlFor="profile-note"
                inputProps={{
                  value: note,
                  placeholder: t('profile.notePlaceholder'),
                  onChange: (e) => {
                    setNote(e.target.value)
                    if (save !== 'idle') setSave('idle') // editar limpa o status anterior
                  },
                }}
              />
              <p className="profile-editor__hint">
                {t('profile.noteHint')}
              </p>
            </div>
            <section className="profile-editor__org" aria-label={t('profile.yourOrg')}>
              <h3 className="profile-editor__org-title">{t('profile.yourOrg')}</h3>
              {/* Nome INCONDICIONAL: lê o `fullName` do MyProfile, que desde o #136 resolve por
                  precedência (diretório ?? snapshot ?? displayName vivo, ADR-054 dec. 7) — sempre há
                  string. NÃO trocar por org.fullName (perde a precedência). Cargo/Email colapsam
                  INDIVIDUALMENTE quando ausentes — assimetria deliberada com o Nome. `authority` nunca
                  vai pro DOM e a UI não ramifica nele (PLANO §0.2 dec. 3). Read-only por invariante. */}
              <div className="profile-editor__org-fields">
                <div className="profile-editor__org-field">
                  <span className="profile-editor__org-label">{t('profile.orgName')}</span>
                  <span className="profile-editor__org-value">{fullName}</span>
                </div>
                {org?.jobTitle && (
                  <div className="profile-editor__org-field">
                    <span className="profile-editor__org-label">{t('profile.orgJobTitle')}</span>
                    <span className="profile-editor__org-value">{org.jobTitle}</span>
                  </div>
                )}
                {org?.workEmail && (
                  <div className="profile-editor__org-field">
                    <span className="profile-editor__org-label">{t('profile.orgWorkEmail')}</span>
                    <span className="profile-editor__org-value">{org.workEmail}</span>
                  </div>
                )}
              </div>
              <p className="profile-editor__org-managed">{t('profile.orgManaged')}</p>
            </section>
          </>
        )}
      </div>
    </Dialog>
  )
}
