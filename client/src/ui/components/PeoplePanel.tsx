import { useEffect, useMemo, useRef } from 'react'
import type { Person } from '@tayet/client'
import { Avatar, Button, Dialog } from '../primitives'
import { Search } from '../icons'
import { getLocale, t, GLYPH } from '../i18n'
import { AgentAvatar, agentColorOf } from './AgentAvatar'

// Sub-tela "Pessoas" (manifesto account-access.md §9.1; ADR-083), drill-in de "Sua conta" para o admin
// da organização. Puramente apresentacional, como a view 'access': a lista vem do useChat, que a relê em
// people.changed. Lista plana por nome, sem virtualização (gatilho 2.000, PLANO-PESSOAS §9). O filtro
// segue o idioma do campo da sidebar em markup local: o SearchField é da busca de mensagens.
// O avatar é o monograma do artboard, sem foto: a lista inteira monta de uma vez, e cada foto é uma
// requisição. P1: a linha mostra nome, email e situação; user.id só como key de React.

// ADR-086: an agent has no situation word ("agente" is never a text badge, §11.1) — its meta is the
// operator, when known.
const situationOf = (person: Person): string => {
  if (person.pending) return t('people.pending')
  switch (person.user.kind) {
    case 'guest':
      return t('people.kindGuest')
    case 'agent':
      return person.user.operatorName !== undefined ? t('agent.operatedBy', { name: person.user.operatorName }) : ''
    case 'member':
      return t('people.kindMember')
  }
}

function PersonRow({
  person,
  onRemove,
  onEditAgent,
}: {
  person: Person
  onRemove: (person: Person) => void
  onEditAgent?: (person: Person) => void
}) {
  const { user, email, pending, self } = person
  const situation = situationOf(person)
  const agent = agentColorOf(user)
  return (
    <li className="people__row">
      {agent !== undefined ? (
        <AgentAvatar color={agent} />
      ) : pending ? (
        <span className="people__mono-pending" aria-hidden="true" />
      ) : (
        <Avatar label={user.displayName.slice(0, 1)} />
      )}
      <span className="people__text">
        <span className="people__name">{user.displayName}</span>
        {(email || situation) && (
          <span className="people__meta">{email ? `${email} ${GLYPH.dot} ${situation}` : situation}</span>
        )}
      </span>
      {agent !== undefined && onEditAgent && (
        // ADR-086 (§11.2): an agent's row offers Editar beside Remover; no email (no login).
        <Button
          variant="ghost"
          size="gestao"
          className="people__remove"
          aria-label={t('agent.editLabel', { name: user.displayName })}
          onClick={() => onEditAgent(person)}
        >
          {t('agent.edit')}
        </Button>
      )}
      {!self && (
        <Button
          variant="ghost"
          size="gestao"
          className="people__remove"
          aria-label={
            pending
              ? t('people.cancelInviteTitle', { name: user.displayName })
              : agent !== undefined
                ? t('agent.removeLabel', { name: user.displayName })
                : t('people.removeLabel', { name: user.displayName })
          }
          onClick={() => onRemove(person)}
        >
          {pending ? t('people.cancelInvite') : t('people.remove')}
        </Button>
      )}
    </li>
  )
}

export function PeoplePanel({
  people,
  filter,
  onFilter,
  onInvite,
  onRemove,
  onAddAgent,
  onEditAgent,
  onBack,
  onClose,
}: {
  people: Person[]
  filter: string
  onFilter: (filter: string) => void
  onInvite: () => void
  onRemove: (person: Person) => void
  // ADR-086: agent management (admin only — this panel already is). Absent → no agent actions.
  onAddAgent?: () => void
  onEditAgent?: (person: Person) => void
  onBack: () => void
  onClose: () => void
}) {
  // Foco-no-swap, como a view 'access': o subtítulo anuncia o contexto do drill-in.
  const subtitleRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => subtitleRef.current?.focus(), [])

  const sorted = useMemo(
    () => [...people].sort((a, b) => a.user.displayName.localeCompare(b.user.displayName, getLocale())),
    [people],
  )
  const term = filter.trim().toLowerCase()
  const shown = term
    ? sorted.filter((p) => `${p.user.displayName} ${p.email ?? ''}`.toLowerCase().includes(term))
    : sorted

  return (
    <Dialog
      className="account-settings-dialog account-settings-dialog--people"
      title={t('people.title')}
      onBack={onBack}
      backLabel={t('dialog.back')}
      onClose={onClose}
      closeLabel={t('dialog.close')}
    >
      <div className="people__top">
        <p ref={subtitleRef} tabIndex={-1} className="account-settings__subtitle">
          {t('people.subtitle')}
        </p>
        <div className="people__actions">
          <label className="people__filter">
            <span className="people__filter-icon">
              <Search />
            </span>
            <input
              className="people__filter-input"
              type="text"
              aria-label={t('people.filter')}
              placeholder={t('people.filter')}
              autoComplete="off"
              value={filter}
              onChange={(e) => onFilter(e.target.value)}
            />
            {filter.length > 0 && (
              <button
                type="button"
                className="people__filter-clear"
                aria-label={t('people.clearFilter')}
                onClick={() => onFilter('')}
              >
                {GLYPH.clear}
              </button>
            )}
          </label>
          <Button variant="fill" className="people__invite" onClick={onInvite}>
            {t('people.invite')}
          </Button>
        </div>
        {onAddAgent && (
          // ADR-086 (§11.2): creating an agent is a discreet admin action under the filter, secondary
          // to "Convidar pessoa".
          <button type="button" className="people__add-agent" onClick={onAddAgent}>
            <span aria-hidden="true">{GLYPH.plus}</span> {t('agent.add')}
          </button>
        )}
      </div>
      <div className="people__scroll">
        {shown.length > 0 && (
          <ul className="people__list" aria-label={t('people.title')}>
            {shown.map((person) => (
              <PersonRow key={person.user.id} person={person} onRemove={onRemove} onEditAgent={onEditAgent} />
            ))}
          </ul>
        )}
        {!term && people.length === 1 && <p className="people__empty">{t('people.onlyYou')}</p>}
        {term && shown.length === 0 && (
          <p className="people__empty">{t('people.noResults', { term: filter.trim() })}</p>
        )}
      </div>
    </Dialog>
  )
}
