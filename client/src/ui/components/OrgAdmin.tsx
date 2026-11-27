import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  AgentColor,
  AgentPatch,
  Channel,
  NewAgent,
  NewPerson,
  OrgAccess,
  Person,
  PersonInvite,
  UserId,
} from '@tayet/client'
import { LastAdminError, NotMemberError, OrgAccessDeniedError } from '@tayet/client'
import { Button, Dialog } from '../primitives'
import { InvitePersonDialog } from './InvitePersonDialog'
import { AgentDialog, type AgentDialogMode } from './AgentDialog'
import { AdminPeople, type AccessState, type PeoplePill, type RowAction } from './AdminPeople'
import { AdminOverview } from './AdminOverview'
import { t, GLYPH } from '../i18n'

// A Admin da organização (organization-admin.md §2.1; PLANO-ADMIN §0.2 A1, §0.3 D2–D3; fatia 1c): casca em
// tela cheia no lugar do workspace, só na tela larga, só para admin. A navegação traz só o que existe: "Visão
// geral" e "Pessoas" (D2; §2.1 item 3, fatia 1). A casca sempre abre na Visão geral, que consome a mesma
// leitura do papel (V3, V4; PLANO-ADMIN §8.8). Ao abrir, a casca relê o papel (R6, C2): um 403 nessa
// leitura ou em qualquer verbo de organização fecha a superfície — quem fecha é o Workspace, ao ver o
// orgAdmin do useChat cair. Os diálogos de convite, de agente e de remover pessoa são os do Account Access,
// movidos de AccountSettings sem redesenho.

// The page in the column, and the pill "Pessoas" opens on (V2).
type Page = { page: 'overview' } | { page: 'people'; pill: PeoplePill }

type Confirm = { kind: 'promote' | 'demote' | 'demoteSelf'; person: Person }

const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name

const accessOf = (a: OrgAccess): AccessState => ({
  status: 'ready',
  admins: new Set(a.admins),
  withoutAccess: new Set(a.withoutAccess),
  adminCount: a.admins.length,
})

export function OrgAdmin({
  people,
  inviteChannels,
  displayName,
  onBack,
  onGetOrgAccess,
  onSetOrgAdmin,
  onInvitePerson,
  onRemovePerson,
  onCreateAgent,
  onUpdateAgent,
  onReissueAgent,
  onRemoveAgent,
}: {
  people: Person[]
  inviteChannels: Channel[]
  // The admin's own name: the operator of an agent they create.
  displayName?: string
  onBack: () => void
  onGetOrgAccess: () => Promise<OrgAccess>
  onSetOrgAdmin: (user: UserId, admin: boolean) => Promise<void>
  onInvitePerson: (person: NewPerson) => Promise<PersonInvite>
  onRemovePerson: (user: UserId) => Promise<void>
  // ADR-086 (Proposto): agent management. Absent → no agent actions.
  onCreateAgent?: (name: string, color: AgentColor) => Promise<NewAgent>
  onUpdateAgent?: (user: UserId, patch: AgentPatch) => Promise<void>
  onReissueAgent?: (user: UserId) => Promise<{ token: string }>
  onRemoveAgent?: (user: UserId) => Promise<void>
}) {
  const [access, setAccess] = useState<AccessState>({ status: 'loading' })
  // V3: it always opens on the Visão geral (the shell mounts again on every opening).
  const [page, setPage] = useState<Page>({ page: 'overview' })
  const [view, setView] = useState<'people' | 'invite' | 'agent' | 'removePerson'>('people')
  // ADR-086: what the AgentDialog opens on (create, or edit/remove of an agent of the list).
  const [agentMode, setAgentMode] = useState<AgentDialogMode>({ kind: 'create' })
  const [removing, setRemoving] = useState<Person | undefined>(undefined)
  const [removeBusy, setRemoveBusy] = useState(false)
  const [removeFailed, setRemoveFailed] = useState(false)
  const [confirm, setConfirm] = useState<Confirm | undefined>(undefined)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [confirmFailed, setConfirmFailed] = useState(false)
  // A 409 (last admin, not a member) is not worth repeating: the action stops counting.
  const [confirmSettled, setConfirmSettled] = useState(false)

  // R6 (C2): the role read on opening. The refusal (OrgAccessDeniedError) closes the surface upstream; any other
  // failure leaves the list without the role, and the admin items out of the menus.
  const readAccess = useCallback(async (): Promise<boolean> => {
    try {
      setAccess(accessOf(await onGetOrgAccess()))
      return true
    } catch (e) {
      if (!(e instanceof OrgAccessDeniedError)) setAccess((was) => (was.status === 'ready' ? was : { status: 'failed' }))
      return false
    }
  }, [onGetOrgAccess])
  useEffect(() => {
    void readAccess()
  }, [readAccess])

  const onAction = (person: Person, action: RowAction): void => {
    switch (action) {
      case 'makeAdmin':
      case 'dropAdmin':
        setConfirm({ kind: action === 'makeAdmin' ? 'promote' : person.self ? 'demoteSelf' : 'demote', person })
        setConfirmFailed(false)
        setConfirmSettled(false)
        return
      case 'editAgent':
        setAgentMode({ kind: 'edit', agent: person })
        setView('agent')
        return
      case 'removeAgent':
        // ADR-086: an agent leaves by the AgentDialog's remove (revokes the credential first).
        setAgentMode({ kind: 'remove', agent: person })
        setView('agent')
        return
      case 'remove':
      case 'cancelInvite':
        setRemoving(person)
        setRemoveFailed(false)
        setView('removePerson')
        return
    }
  }

  // C5/C6, with the amendment to C5: after the 200 on someone else the role is read again, and the confirm closes
  // when that read is back; a failure of the verb or of the read keeps it open with the error and the action
  // still counts (the verb is idempotent). A 409 shows the error, reads the role again and stops the action.
  // A 403 is the R6 path, and so is the 200 on oneself, with no read: the surface closes.
  const runConfirm = async (): Promise<void> => {
    if (!confirm) return
    const { kind, person } = confirm
    setConfirmBusy(true)
    setConfirmFailed(false)
    try {
      await onSetOrgAdmin(person.user.id, kind === 'promote')
    } catch (e) {
      if (e instanceof OrgAccessDeniedError) return
      setConfirmFailed(true)
      if (e instanceof LastAdminError || e instanceof NotMemberError) {
        setConfirmSettled(true)
        await readAccess()
      }
      setConfirmBusy(false)
      return
    }
    if (kind === 'demoteSelf') return
    const read = await readAccess()
    setConfirmBusy(false)
    if (read) setConfirm(undefined)
    else setConfirmFailed(true)
  }

  const closeConfirm = (): void => {
    if (!confirmBusy) setConfirm(undefined)
  }

  let dialog: ReactNode = null
  if (confirm) {
    const name = confirm.person.user.displayName
    const copy =
      confirm.kind === 'promote'
        ? { title: t('admin.promoteTitle', { name }), body: t('admin.promoteBody', { first: firstName(name) }), action: t('admin.makeAdmin') }
        : confirm.kind === 'demote'
          ? { title: t('admin.demoteTitle', { name }), body: t('admin.demoteBody', { first: firstName(name) }), action: t('admin.dropAdmin') }
          : { title: t('admin.demoteSelfTitle'), body: t('admin.demoteSelfBody'), action: t('admin.dropAdmin') }
    const danger = confirm.kind === 'demoteSelf'
    dialog = (
      <Dialog
        role="alertdialog"
        size="gestao"
        ariaLabel={copy.title}
        title={
          <span className="account-settings__confirm-title">
            <span
              className={danger ? 'account-settings__confirm-dot' : 'account-settings__confirm-dot agent-dialog__dot--primary'}
              aria-hidden="true"
            />
            {copy.title}
          </span>
        }
        onClose={closeConfirm}
        footer={
          <>
            <Button variant="secondary" autoFocus disabled={confirmBusy} onClick={closeConfirm}>
              {t('account.cancel')}
            </Button>
            <Button
              variant={danger ? 'danger-fill' : 'fill'}
              disabled={confirmBusy || confirmSettled}
              onClick={() => void runConfirm()}
            >
              {copy.action}
            </Button>
          </>
        }
      >
        <div className="account-settings__confirm-body people__confirm-body">
          <p>{copy.body}</p>
          {confirmFailed && (
            <p className="compose-dialog__error" role="alert">
              {t('newConversation.failed')}
            </p>
          )}
        </div>
      </Dialog>
    )
  } else if (view === 'agent' && onCreateAgent && onUpdateAgent && onReissueAgent && onRemoveAgent) {
    dialog = (
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
  } else if (view === 'invite') {
    dialog = <InvitePersonDialog channels={inviteChannels} onInvite={onInvitePerson} onClose={() => setView('people')} />
  } else if (view === 'removePerson' && removing) {
    // ── 'removePerson' ── confirm `alertdialog` (manifesto account-access.md §9.1, §9.2 g), na forma do
    // confirm de reset. Await-and-close: a lista se corrige no people.changed; falha fica aqui.
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
        await onRemovePerson(removing.user.id)
        setView('people')
      } catch {
        setRemoveFailed(true)
      } finally {
        setRemoveBusy(false)
      }
    }
    dialog = (
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

  return (
    <div className="org-admin">
      <header className="org-admin__top">
        <button type="button" className="org-admin__back" onClick={onBack}>
          <span className="org-admin__back-arrow" aria-hidden="true">
            {GLYPH.arrowBack}
          </span>
          {t('admin.back')}
        </button>
      </header>
      <div className="org-admin__body">
        <nav className="org-admin__nav" aria-label={t('admin.nav')}>
          <h1 className="org-admin__nav-title">{t('admin.title')}</h1>
          <button
            type="button"
            className="org-admin__nav-item"
            aria-current={page.page === 'overview' ? 'page' : undefined}
            onClick={() => {
              if (page.page !== 'overview') setPage({ page: 'overview' })
            }}
          >
            {t('admin.overview')}
          </button>
          <button
            type="button"
            className="org-admin__nav-item"
            aria-current={page.page === 'people' ? 'page' : undefined}
            onClick={() => {
              if (page.page !== 'people') setPage({ page: 'people', pill: 'all' })
            }}
          >
            {t('people.title')}
          </button>
        </nav>
        <main className="org-admin__main">
          <div className="org-admin__column">
            {page.page === 'overview' ? (
              <AdminOverview people={people} access={access} onOpenPeople={(pill) => setPage({ page: 'people', pill })} />
            ) : (
              <AdminPeople
                people={people}
                access={access}
                initialPill={page.pill}
                onInvite={() => setView('invite')}
                onAddAgent={
                  onCreateAgent
                    ? () => {
                        setAgentMode({ kind: 'create' })
                        setView('agent')
                      }
                    : undefined
                }
                onAction={onAction}
              />
            )}
          </div>
        </main>
      </div>
      {dialog}
    </div>
  )
}
