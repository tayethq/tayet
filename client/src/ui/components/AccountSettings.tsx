import { useState, useEffect, useMemo, useRef } from 'react'
import type {
  AgentColor,
  AgentPatch,
  NewAgent,
  Channel,
  DeviceId,
  MyProfile,
  NewPerson,
  Person,
  PersonInvite,
  Presence,
  Timestamp,
  UserId,
} from '@tayet/client'
import { Avatar, Button, Dialog, Segmented, Sweep } from '../primitives'
import { InvitePersonDialog } from './InvitePersonDialog'
import { DataExportDialog } from './DataExportDialog'
import type { DataExportVerb } from '../useDataExport'
import { AgentDialog, type AgentDialogMode } from './AgentDialog'
import { PeoplePanel } from './PeoplePanel'
import { ProfileEditor } from './ProfileEditor'
import type { ResetStatus } from './ResetAccessBanner'
import { relativeTimeOf } from './Timeline'
import { type Theme } from '../theme'
import { t, GLYPH } from '../i18n'

// Superfície de conta (ADR-019 §3.4) + lista PROATIVA de acessos conhecidos (ADR-018) + ação de
// logout deste navegador (ADR-031 D7 / ADR-034), agora montada como Dialog aberto pela engrenagem do
// footer da sidebar (ADR-038: tudo é Dialog exceto a thread). Vocabulário de produto apenas —
// "acesso", nunca dispositivo/sessão/crypto/"seguro"-como-estado (P1 / ADR-015; o render-scan em
// test/ui/account-render-scan é fail-closed). Puramente apresentacional: props de domínio limpas
// entram, app vivo e render-scan a dirigem identicamente. O id opaco é SÓ key de React, nunca
// renderizado (provado pelo render-scan).
//
// A lista de acessos e o reset vivem numa sub-tela drill-in alcançada pela entry-row; view-swap no
// mesmo Dialog — addendum F4 ao ADR-038. O reset voluntário é uma caixa descritiva que abre uma
// view `confirm` (espelha o idioma do ChannelManagementPanel: Dialog sem ×, Esc cancela, footer
// Cancel + danger-fill) carregando o caveat de histórico F3 — só o danger chama onReset (A4).
export interface KnownAccess {
  id: DeviceId
  // Do display name MAS do acesso (Device.friendlyName); ausente/em branco → copy genérica.
  friendlyName?: string
  // É ESTE navegador? Booleano derivado na ACL (Device.current, espelha `mine`) — o device_id cru
  // nunca cruza. Marca o acesso atual com o badge "Este navegador" + accent-wash. §8.A3 / P1.
  current: boolean
  // Device.lastSeen: alimenta o meta "Ativo {quando}"; ausente → a linha fica só com o nome.
  lastSeen?: Timestamp
}

// Monograma da linha de acesso: iniciais das duas primeiras palavras; uma palavra → 2 letras.
function accessMonogram(name: string): string {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? []
  const letters =
    words.length > 1
      ? words.slice(0, 2).map((w) => Array.from(w)[0])
      : Array.from(words[0] ?? '').slice(0, 2)
  return letters.join('').toUpperCase()
}

// Meta sob o nome: atual = "Este navegador · agora"; demais = "Ativo {quando}"; sem lastSeen, nada.
function accessMeta(access: KnownAccess): string | undefined {
  if (access.current) return `${t('account.thisBrowser')} ${GLYPH.dot} ${t('account.now')}`
  if (access.lastSeen === undefined) return undefined
  return t('account.activeSince', { when: relativeTimeOf(access.lastSeen) })
}

const RESET_STATUS_COPY = {
  pending: 'account.resetPending',
  done: 'account.resetDone',
  notDone: 'account.resetNotDone',
} as const

const themeOptions = (): ReadonlyArray<{ value: Theme; label: string }> => [
  { value: 'light', label: t('account.themeLight') },
  { value: 'dark', label: t('account.themeDark') },
]

export function AccountSettings({
  open,
  accesses,
  orgAdmin = false,
  people = [],
  inviteChannels = [],
  onInvitePerson,
  onRemovePerson,
  onCreateAgent,
  onUpdateAgent,
  onReissueAgent,
  onRemoveAgent,
  displayName,
  avatarUrl,
  presence,
  onLoadProfile,
  onSaveProfile,
  onSaveAvatar,
  onClearAvatar,
  onExportData,
  onReset,
  resetStatus = 'idle',
  onSignOut,
  theme,
  onThemeChange,
  onClose,
}: {
  open: boolean
  accesses: KnownAccess[]
  // ADR-083 dec. 7: só o admin da organização vê a seção "Organização" e a sub-tela "Pessoas".
  orgAdmin?: boolean
  people?: Person[]
  // Os verbos vêm junto com orgAdmin; os canais são a fonte dos chips do convite.
  inviteChannels?: Channel[]
  onInvitePerson?: (person: NewPerson) => Promise<PersonInvite>
  onRemovePerson?: (user: UserId) => Promise<void>
  // ADR-086 (Proposto): agent management, with orgAdmin like the people verbs. Absent → no agent actions.
  onCreateAgent?: (name: string, color: AgentColor) => Promise<NewAgent>
  onUpdateAgent?: (user: UserId, patch: AgentPatch) => Promise<void>
  onReissueAgent?: (user: UserId) => Promise<{ token: string }>
  onRemoveAgent?: (user: UserId) => Promise<void>
  // ADR-040: summary da entry-row "Editar perfil". Opcional — degrada pra sem-summary se ausente
  // (ex.: identidade ainda não resolvida). É o displayName efetivo já limpo (nickname || fullName), P1.
  displayName?: string
  // URL da foto do operador JÁ resolvida pelo Workspace (useMedia); o componente nunca toca MediaRef (P1).
  avatarUrl?: string
  // Presença do PRÓPRIO operador no avatar do header (ADR-056 rollout, §8.4 — self mostra o dot,
  // adjudicação 6). Opcional: o harness bare a omite → Avatar sem a prop, DOM byte-idêntico.
  presence?: Presence
  onLoadProfile: () => Promise<MyProfile>
  onSaveProfile: (patch: { nickname?: string; pronouns?: string; note?: string }) => Promise<void>
  // Foto de perfil (ADR-041 PR-3): required, threaded ao ProfileEditor na view `profile`.
  onSaveAvatar: (file: File) => Promise<void>
  onClearAvatar: () => Promise<void>
  // ADR-096: "Seus dados" → the export dialog, for every person (dec. 9). Required, like the profile verbs.
  onExportData: DataExportVerb
  onReset: () => void
  // ADR-082: where the reset stands, shown in the `confirm` view that started it.
  resetStatus?: ResetStatus
  onSignOut: () => void
  theme: Theme
  onThemeChange: (theme: Theme) => void
  onClose: () => void
}) {
  const [view, setView] = useState<
    'main' | 'access' | 'confirm' | 'profile' | 'people' | 'invite' | 'removePerson' | 'agent' | 'export'
  >('main')
  // ADR-086: what the AgentDialog opens on (create, or edit/remove of an agent of the list).
  const [agentMode, setAgentMode] = useState<AgentDialogMode>({ kind: 'create' })
  const [peopleFilter, setPeopleFilter] = useState('')
  const [removing, setRemoving] = useState<Person | undefined>(undefined)
  const [removeBusy, setRemoveBusy] = useState(false)
  const [removeFailed, setRemoveFailed] = useState(false)

  // Foco-no-swap main→access: o subtítulo da sub-tela recebe o foco ao entrar nela (anúncio de
  // contexto em drill-in; alvo não-destrutivo). A view `confirm` ancora seu foco no Cancelar
  // (autoFocus), espelhando o ChannelManagementPanel.
  const subtitleRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (view === 'access') subtitleRef.current?.focus()
  }, [view])

  // Cargo sob o nome (ADR-054, read-only): só o perfil o traz, lido ao abrir a view main. Ausente ou
  // falha de leitura = sem linha, em silêncio — a identidade não depende dele.
  const [jobTitle, setJobTitle] = useState<string | undefined>(undefined)
  const showsMain = open && view === 'main'
  useEffect(() => {
    if (!showsMain) return
    let alive = true
    onLoadProfile().then(
      (profile) => {
        if (alive) setJobTitle(profile.org?.jobTitle?.trim() || undefined)
      },
      () => {
        if (alive) setJobTitle(undefined)
      },
    )
    return () => {
      alive = false
    }
  }, [showsMain, onLoadProfile])

  // A linha atual vem primeiro (manifesto §7.2); as demais mantêm a ordem da ACL (sort estável).
  const orderedAccesses = useMemo(
    () => [...accesses].sort((a, b) => Number(b.current) - Number(a.current)),
    [accesses],
  )

  if (!open) return null

  // Fecha SEMPRE resetando pra main, pro próximo open começar na raiz (o componente não desmonta no
  // close — só retorna null — então o estado de view persiste sem isto).
  const handleClose = () => {
    setView('main')
    setPeopleFilter('')
    onClose()
  }

  // ── view 'profile' ── 2º drill-in (ADR-040): o editor possui o próprio Dialog (corpo + footer), tal
  // como cada view aqui dá early-return do seu. onBack volta pra main; onClose reseta via handleClose.
  if (view === 'profile') {
    return (
      <ProfileEditor
        onBack={() => setView('main')}
        onClose={handleClose}
        onLoadProfile={onLoadProfile}
        onSaveProfile={onSaveProfile}
        onSaveAvatar={onSaveAvatar}
        onClearAvatar={onClearAvatar}
      />
    )
  }

  if (view === 'agent' && onCreateAgent && onUpdateAgent && onReissueAgent && onRemoveAgent) {
    return (
      <AgentDialog
        mode={agentMode}
        operatorName={displayName}
        onCreate={onCreateAgent}
        onUpdate={onUpdateAgent}
        onReissue={onReissueAgent}
        onRemove={onRemoveAgent}
        onClose={() => setView('people')}
      />
    )
  }

  // ── view 'export' ── "Exportar seus dados" (account-access.md §12): its own dialog, back to "Sua conta" on
  // close, as the invite goes back to "Pessoas" (PLANO-EXPORT-DADOS §0.3.6 item 1).
  if (view === 'export') {
    return <DataExportDialog onExport={onExportData} onClose={() => setView('main')} />
  }

  if (view === 'invite') {
    return (
      <InvitePersonDialog channels={inviteChannels} onInvite={onInvitePerson!} onClose={() => setView('people')} />
    )
  }

  // ── view 'removePerson' ── confirm `alertdialog` (manifesto account-access.md §9.1, §9.2 g), na forma do
  // confirm de reset. Await-and-close: a lista se corrige no people.changed; falha fica aqui.
  if (view === 'removePerson' && removing) {
    const name = removing.user.displayName
    const title = removing.pending
      ? t('people.cancelInviteTitle', { name })
      : t('people.removeTitle', { name })
    const backToPeople = () => {
      if (!removeBusy) setView('people')
    }
    const confirmRemoval = async () => {
      setRemoveBusy(true)
      setRemoveFailed(false)
      try {
        await onRemovePerson!(removing.user.id)
        setView('people')
      } catch {
        setRemoveFailed(true)
      } finally {
        setRemoveBusy(false)
      }
    }
    return (
      <Dialog
        role="alertdialog"
        size="gestao"
        ariaLabel={title}
        title={
          <span className="account-settings__confirm-title">
            <span className="account-settings__confirm-dot" aria-hidden="true" />
            {title}
          </span>
        }
        onClose={backToPeople}
        footer={
          <>
            <Button variant="secondary" autoFocus disabled={removeBusy} onClick={backToPeople}>
              {t('account.cancel')}
            </Button>
            <Button variant="danger-fill" disabled={removeBusy} onClick={() => void confirmRemoval()}>
              {removing.pending ? t('people.cancelInvite') : t('people.remove')}
            </Button>
          </>
        }
      >
        <div className="account-settings__confirm-body people__confirm-body">
          <p>
            {removing.pending ? t('people.cancelInviteBody', { name }) : t('people.removeBody', { name })}
          </p>
          {removeFailed && (
            <p className="compose-dialog__error" role="alert">
              {t('newConversation.failed')}
            </p>
          )}
        </div>
      </Dialog>
    )
  }

  if (view === 'people') {
    return (
      <PeoplePanel
        people={people}
        filter={peopleFilter}
        onFilter={setPeopleFilter}
        onInvite={() => setView('invite')}
        onRemove={(person) => {
          // ADR-086: an agent leaves by the AgentDialog's remove (revokes the credential first).
          if (person.user.kind === 'agent') {
            setAgentMode({ kind: 'remove', agent: person })
            setView('agent')
            return
          }
          setRemoving(person)
          setRemoveFailed(false)
          setView('removePerson')
        }}
        onAddAgent={
          onCreateAgent
            ? () => {
                setAgentMode({ kind: 'create' })
                setView('agent')
              }
            : undefined
        }
        onEditAgent={
          onUpdateAgent
            ? (person) => {
                setAgentMode({ kind: 'edit', agent: person })
                setView('agent')
              }
            : undefined
        }
        onBack={() => setView('main')}
        onClose={handleClose}
      />
    )
  }

  if (view === 'access') {
    return (
      <Dialog
        className="account-settings-dialog account-settings-dialog--access"
        title={t('account.accessTitle')}
        onBack={() => setView('main')}
        backLabel={t('dialog.back')}
        onClose={handleClose}
        closeLabel={t('dialog.close')}
      >
        <div className="account-settings account-settings--access">
          <p ref={subtitleRef} tabIndex={-1} className="account-settings__subtitle">
            {t('account.accessSubtitle')}
          </p>
          {accesses.length > 0 && (
            <>
              <ul className="account-settings__list" aria-label={t('account.accessTitle')}>
                {orderedAccesses.map((a) => {
                  const name = a.friendlyName?.trim()
                  const meta = accessMeta(a)
                  return (
                    <li
                      key={a.id}
                      className={
                        a.current
                          ? 'account-settings__access account-settings__access--current'
                          : 'account-settings__access'
                      }
                    >
                      <span
                        className={
                          name
                            ? 'account-settings__access-mono'
                            : 'account-settings__access-mono account-settings__access-mono--unknown'
                        }
                        aria-hidden="true"
                      >
                        {name ? accessMonogram(name) : null}
                      </span>
                      <span className="account-settings__access-text">
                        <span className="account-settings__access-name">
                          {name ? name : t('account.accessUnknown')}
                        </span>
                        {meta && <span className="account-settings__access-meta">{meta}</span>}
                      </span>
                      {a.current && (
                        <span className="account-settings__access-badge">{t('account.thisBrowser')}</span>
                      )}
                    </li>
                  )
                })}
              </ul>
              <hr className="account-settings__divider" />
            </>
          )}
          {/* Reset voluntário: caixa descritiva (teaser, sem caveat) que abre o gate de confirmação.
              Só o danger-fill do `confirm` chama onReset — a caixa nunca reseta direto (A4). */}
          <button
            type="button"
            className="account-settings__reset"
            onClick={() => setView('confirm')}
          >
            <span className="account-settings__reset-title">
              <span className="account-settings__reset-dot" aria-hidden="true" />
              {t('account.resetTitle')}
            </span>
            <span className="account-settings__reset-desc">
              {t('account.resetDesc')}
            </span>
          </button>
        </div>
      </Dialog>
    )
  }

  // ── view 'confirm' ── gate do reset voluntário, carregando o caveat de histórico F3. Espelha o
  // idioma do ChannelManagementPanel: Dialog sem × (closeLabel ausente), Esc/onClose volta pra
  // `access` sem resetar, footer = Cancelar (autoFocus, não-destrutivo) + danger-fill. Estados
  // (account-access.md §10): `pending` = status + varredura, sem rodapé; `notDone` = Cancelar +
  // "Tentar de novo" danger-fill; `done` = só "Entrar de novo", primário. Botões `gestao`. onReset é
  // chamado SÓ pelo danger-fill. Assimetria intencional: o ResetAccessBanner (recuperação) segue
  // direto, sem confirmação — lá o reset restaura histórico; aqui ele queima histórico ainda legível.
  if (view === 'confirm') {
    return (
      <Dialog
        size="gestao"
        ariaLabel={t('account.resetTitle')}
        title={
          <span className="account-settings__confirm-title">
            <span className="account-settings__confirm-dot" aria-hidden="true" />
            {t('account.resetTitle')}
          </span>
        }
        onClose={() => setView('access')}
        footer={
          resetStatus === 'pending' ? undefined : resetStatus === 'done' ? (
            <Button variant="fill" size="gestao" autoFocus onClick={onSignOut}>
              {t('account.resetSignInAgain')}
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                size="gestao"
                autoFocus
                onClick={() => setView('access')}
              >
                {t('account.cancel')}
              </Button>
              <Button variant="danger-fill" size="gestao" onClick={onReset}>
                {resetStatus === 'notDone' ? t('account.resetTryAgain') : t('account.reset')}
              </Button>
            </>
          )
        }
      >
        {resetStatus === 'idle' ? (
          <div className="account-settings__confirm-body">
            <p>
              {t('account.resetWarning')}
            </p>
            <p className="account-settings__confirm-caveat">{t('account.resetCaveat')}</p>
          </div>
        ) : (
          <div className="account-settings__confirm-body">
            <p role="status">{t(RESET_STATUS_COPY[resetStatus])}</p>
            {resetStatus === 'pending' && (
              <span className="account-settings__confirm-sweep">
                <Sweep />
              </span>
            )}
          </div>
        )}
      </Dialog>
    )
  }

  // ── view 'main' ──
  const knownCount = accesses.length
  const unknownCount = accesses.filter((a) => !a.friendlyName?.trim()).length
  const accessSummary =
    t('account.accessCount', { n: knownCount }) +
    (unknownCount > 0 ? ` ${GLYPH.dot} ${t('account.unknownCount', { n: unknownCount })}` : '')

  return (
    <Dialog
      className="account-settings-dialog account-settings-dialog--main"
      title={t('account.title')}
      onClose={handleClose}
      closeLabel={t('dialog.close')}
    >
      <div className="account-settings">
        <header className="account-settings__identity">
          <Avatar label={(displayName?.trim()?.[0] ?? t('account.title')[0]!).toUpperCase()} src={avatarUrl} presence={presence} />
          <div className="account-settings__identity-text">
            <span className="account-settings__identity-name">{displayName?.trim() || t('account.title')}</span>
            {jobTitle && <span className="account-settings__identity-role">{jobTitle}</span>}
          </div>
          <Button variant="secondary" onClick={() => setView('profile')}>
            {t('account.edit')}
          </Button>
        </header>
        <hr className="account-settings__divider" />
        <section className="account-settings__appearance">
          <div className="account-settings__appearance-text">
            <h3 className="account-settings__appearance-title">{t('account.appearance')}</h3>
            <p className="account-settings__appearance-flavor">{t('account.appearanceFlavor')}</p>
          </div>
          <Segmented
            ariaLabel={t('account.appearance')}
            value={theme}
            options={themeOptions()}
            onChange={onThemeChange}
          />
        </section>
        <hr className="account-settings__divider" />
        <section className="account-settings__access-section">
          <h3 className="account-settings__section-title">{t('account.accessSection')}</h3>
          {/* Entry-row pra sub-tela — SEMPRE presente (mesmo com 0 acessos), porque o reset
              sempre-disponível (ADR-019 §3.4) vive lá dentro. */}
          <button
            type="button"
            className="account-settings__access-entry"
            onClick={() => setView('access')}
          >
            <span className="account-settings__access-entry-text">
              <span className="account-settings__access-entry-label">{t('account.accessTitle')}</span>
              <span className="account-settings__access-entry-summary">{accessSummary}</span>
            </span>
            <span className="account-settings__access-entry-chevron" aria-hidden="true">{GLYPH.chevron}</span>
          </button>
        </section>
        <hr className="account-settings__divider" />
        {/* "Seus dados" (account-access.md §12.1 item 1): every person, member or guest; for the admin it sits
            before "Organização". */}
        <section className="account-settings__access-section">
          <h3 className="account-settings__section-title">{t('dataExport.section')}</h3>
          <button
            type="button"
            className="account-settings__access-entry"
            onClick={() => setView('export')}
          >
            <span className="account-settings__access-entry-text">
              <span className="account-settings__access-entry-label">{t('dataExport.entry')}</span>
              <span className="account-settings__access-entry-summary">{t('dataExport.entrySummary')}</span>
            </span>
            <span className="account-settings__access-entry-chevron" aria-hidden="true">{GLYPH.chevron}</span>
          </button>
        </section>
        <hr className="account-settings__divider" />
        {orgAdmin && (
          <>
            <section className="account-settings__access-section">
              <h3 className="account-settings__section-title">{t('people.orgSection')}</h3>
              <button
                type="button"
                className="account-settings__access-entry"
                onClick={() => setView('people')}
              >
                <span className="account-settings__access-entry-text">
                  <span className="account-settings__access-entry-label">{t('people.title')}</span>
                  <span className="account-settings__access-entry-summary">
                    {t('people.summaryPeople', { n: people.length })} {GLYPH.dot}{' '}
                    {t('people.summaryGuests', { n: people.filter((p) => p.user.kind === 'guest').length })}
                  </span>
                </span>
                <span className="account-settings__access-entry-chevron" aria-hidden="true">{GLYPH.chevron}</span>
              </button>
            </section>
            <hr className="account-settings__divider" />
          </>
        )}
        <Button variant="secondary" className="account-settings__signout" onClick={onSignOut}>
          {t('account.signOut')}
        </Button>
      </div>
    </Dialog>
  )
}
