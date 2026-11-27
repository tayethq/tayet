import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Person, UserId } from '@tayet/client'
import { Avatar, Button } from '../primitives'
import { Search } from '../icons'
import { getLocale, t, GLYPH } from '../i18n'
import { AgentAvatar, agentColorOf } from './AgentAvatar'

// "Pessoas" da Admin (organization-admin.md §2.3; ADR-118 dec. 4). Puramente apresentacional: a lista vem do
// useChat (#all), o papel e o "sem acesso válido" da leitura da casca. Os dois conjuntos só marcam quem está
// na lista (C4): um id fora dela é ignorado, e o pendente nunca ganha a marca. P1: nome, email e situação;
// user.id só como key e alvo de verbo, nunca renderizado.

// What the shell read for the role. `ready` carries the server's own admin count: the last-admin lock reads
// it, not the crossing with the list.
export type AccessState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; admins: ReadonlySet<UserId>; withoutAccess: ReadonlySet<UserId>; adminCount: number }

export type PeoplePill = 'all' | 'organization' | 'guests' | 'pending' | 'agents' | 'admins' | 'withoutAccess'

// The row's verbs: the shell opens a confirm or a dialog for each.
export type RowAction = 'makeAdmin' | 'dropAdmin' | 'remove' | 'cancelInvite' | 'editAgent' | 'removeAgent'

export interface Row {
  person: Person
  kind: 'agent' | 'pending' | 'guest' | 'member'
  admin: boolean
  withoutAccess: boolean
}

const PILLS: ReadonlyArray<[PeoplePill, Parameters<typeof t>[0]]> = [
  ['all', 'admin.pillAll'],
  ['organization', 'admin.pillOrganization'],
  ['guests', 'admin.pillGuests'],
  ['pending', 'admin.pillPending'],
  ['agents', 'admin.pillAgents'],
  ['admins', 'admin.pillAdmins'],
  ['withoutAccess', 'admin.withoutAccess'],
]

// Single choice, combined with the text (C8). The pills of the Visão geral's cards are disjoint (V1, PLANO-ADMIN
// §8.8): a row is in exactly one of organization, guests, pending and agents, by its kind; a pending guest is
// pending, not a guest.
export const PILL_TEST: Record<PeoplePill, (row: Row) => boolean> = {
  all: () => true,
  organization: (r) => r.kind === 'member',
  guests: (r) => r.kind === 'guest',
  pending: (r) => r.kind === 'pending',
  agents: (r) => r.kind === 'agent',
  admins: (r) => r.admin,
  withoutAccess: (r) => r.withoutAccess,
}

// The list crossed with the role read (C4), in name order: what the table shows and what the Visão geral counts.
export function rowsOf(people: readonly Person[], access: AccessState): Row[] {
  const ready = access.status === 'ready' ? access : undefined
  return [...people]
    .sort((a, b) => a.user.displayName.localeCompare(b.user.displayName, getLocale()))
    .map((person) => ({
      person,
      kind: person.user.kind === 'agent' ? 'agent' : person.pending ? 'pending' : person.user.kind === 'guest' ? 'guest' : 'member',
      admin: ready?.admins.has(person.user.id) ?? false,
      // C4: a pending person never carries the mark, so the pill never brings one either.
      withoutAccess: !person.pending && (ready?.withoutAccess.has(person.user.id) ?? false),
    }))
}

const SITUATION: Record<Row['kind'], Parameters<typeof t>[0]> = {
  agent: 'admin.situationAgent',
  pending: 'people.pending',
  guest: 'people.kindGuest',
  member: 'people.kindMember',
}

type MenuItem = { action: RowAction; label: string; danger?: boolean; disabled?: boolean } | 'separator'

// The ⋯ menu per kind of row (§2.3 item 5). A guest is never an admin (ADR-118 dec. 5): only removal. Before
// the role read lands (or when it failed) the admin items are left out, never guessed.
function menuOf(row: Row, access: AccessState): MenuItem[] {
  const ready = access.status === 'ready'
  if (row.kind === 'agent') {
    return [
      { action: 'editAgent', label: t('agent.edit') },
      'separator',
      { action: 'removeAgent', label: t('agent.remove'), danger: true },
    ]
  }
  if (row.kind === 'pending') return [{ action: 'cancelInvite', label: t('people.cancelInvite'), danger: true }]
  if (row.person.self) {
    if (!ready || !row.admin) return []
    return [{ action: 'dropAdmin', label: t('admin.dropAdmin'), disabled: access.adminCount <= 1 }]
  }
  const remove: MenuItem = { action: 'remove', label: t('admin.removeFromOrg'), danger: true }
  if (row.kind === 'guest' || !ready) return [remove]
  return [
    row.admin ? { action: 'dropAdmin', label: t('admin.dropAdmin') } : { action: 'makeAdmin', label: t('admin.makeAdmin') },
    'separator',
    remove,
  ]
}

// The local ⋯ menu (C9, below the tier's bar of ADR-036): the arrows, Home and End move; Esc and Tab close, Esc
// handing the focus back to ⋯. A disabled item stays focusable, with its hint as the description.
function RowMenu({
  label,
  items,
  onPick,
  onClose,
}: {
  label: string
  items: MenuItem[]
  onPick: (action: RowAction) => void
  onClose: (refocus: boolean) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const hintId = useId()
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const outside = (e: PointerEvent): void => {
      const target = e.target as Node
      if (ref.current?.contains(target) || ref.current?.parentElement?.querySelector('.admin-people__more')?.contains(target)) return
      onClose(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [onClose])
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    const at = all.indexOf(document.activeElement as HTMLElement)
    const go = (i: number): void => {
      e.preventDefault()
      all[(i + all.length) % all.length]?.focus()
    }
    if (e.key === 'ArrowDown') go(at + 1)
    else if (e.key === 'ArrowUp') go(at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(all.length - 1)
    else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose(true)
    } else if (e.key === 'Tab') onClose(false)
  }
  return (
    <div ref={ref} role="menu" aria-label={label} className="admin-people__menu" onKeyDown={onKeyDown}>
      {items.map((item, i) =>
        item === 'separator' ? (
          <div key={`s${i}`} role="separator" className="admin-people__menu-sep" />
        ) : (
          <button
            key={item.action}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={item.danger ? 'admin-people__menu-item admin-people__menu-item--danger' : 'admin-people__menu-item'}
            aria-disabled={item.disabled || undefined}
            aria-describedby={item.disabled ? hintId : undefined}
            onClick={() => {
              if (!item.disabled) onPick(item.action)
            }}
          >
            <span>{item.label}</span>
            {item.disabled && (
              <span id={hintId} className="admin-people__menu-hint">
                {t('admin.onlyAdmin')}
              </span>
            )}
          </button>
        ),
      )}
    </div>
  )
}

export function AdminPeople({
  people,
  access,
  initialPill = 'all',
  onInvite,
  onAddAgent,
  onAction,
}: {
  people: Person[]
  access: AccessState
  // The pill it opens on (V2): the Visão geral's cards and links open a cut of the list, with no text.
  initialPill?: PeoplePill
  onInvite: () => void
  onAddAgent?: () => void
  onAction: (person: Person, action: RowAction) => void
}) {
  const [filter, setFilter] = useState('')
  const [pill, setPill] = useState<PeoplePill>(initialPill)
  const [openId, setOpenId] = useState<UserId | undefined>(undefined)
  const moreRefs = useRef(new Map<UserId, HTMLButtonElement>())

  // Foco-no-swap, como as sub-telas de "Sua conta": o título anuncia o contexto ao abrir.
  const titleRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => titleRef.current?.focus(), [])

  const rows = useMemo(() => rowsOf(people, access), [people, access])

  const term = filter.trim().toLowerCase()
  const shown = rows.filter(
    (r) =>
      PILL_TEST[pill](r) && (!term || `${r.person.user.displayName} ${r.person.email ?? ''}`.toLowerCase().includes(term)),
  )

  const closeMenu = (refocus: boolean): void => {
    const id = openId
    setOpenId(undefined)
    if (refocus && id !== undefined) moreRefs.current.get(id)?.focus()
  }

  return (
    <section className="admin-people" aria-labelledby="admin-people-title">
      <div className="admin-people__head">
        <div className="admin-people__head-text">
          <h2 id="admin-people-title" ref={titleRef} tabIndex={-1} className="admin-people__title">
            {t('people.title')}
          </h2>
          <p className="admin-people__subtitle">{t('people.subtitle')}</p>
        </div>
        {onAddAgent && (
          <Button variant="secondary" className="admin-people__head-action" onClick={onAddAgent}>
            {t('agent.add')}
          </Button>
        )}
        <Button variant="fill" className="admin-people__head-action" onClick={onInvite}>
          {t('people.invite')}
        </Button>
      </div>

      <label className="people__filter admin-people__filter">
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
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter.length > 0 && (
          <button type="button" className="people__filter-clear" aria-label={t('people.clearFilter')} onClick={() => setFilter('')}>
            {GLYPH.clear}
          </button>
        )}
      </label>

      <div role="group" aria-label={t('admin.show')} className="admin-people__pills">
        {PILLS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className="admin-people__pill"
            aria-pressed={pill === key}
            onClick={() => setPill(key)}
          >
            {t(label)}
          </button>
        ))}
      </div>

      <div role="table" aria-label={t('people.title')} className="admin-people__table">
        <div role="row" className="admin-people__grid admin-people__header">
          <span role="columnheader">{t('admin.colName')}</span>
          <span role="columnheader">{t('admin.colStatus')}</span>
          <span role="columnheader">{t('admin.colRole')}</span>
          <span role="columnheader">
            <span className="admin-people__hidden">{t('admin.colActions')}</span>
          </span>
        </div>
        <div role="rowgroup">
          {shown.map((row) => {
            const { person } = row
            const { user } = person
            const agent = agentColorOf(user)
            const items = menuOf(row, access)
            const open = openId === user.id
            const name = person.self ? t('admin.self', { name: user.displayName }) : user.displayName
            const actionsLabel = t('admin.actionsFor', { name: user.displayName })
            return (
              <div key={user.id} role="row" className="admin-people__grid admin-people__row">
                <div role="cell" className="admin-people__who">
                  {agent !== undefined ? (
                    <AgentAvatar color={agent} />
                  ) : person.pending ? (
                    <span className="people__mono-pending" aria-hidden="true" />
                  ) : (
                    <Avatar label={user.displayName.slice(0, 1)} />
                  )}
                  <span className="admin-people__who-text">
                    <span className="admin-people__name">{name}</span>
                    {agent !== undefined
                      ? user.operatorName !== undefined && (
                          <span className="admin-people__meta">{t('agent.operatedBy', { name: user.operatorName })}</span>
                        )
                      : person.email && <span className="admin-people__meta">{person.email}</span>}
                  </span>
                </div>
                <div role="cell" className="admin-people__status">
                  <span>{t(SITUATION[row.kind])}</span>
                  {row.withoutAccess && <span className="admin-people__flag">{t('admin.withoutAccess')}</span>}
                </div>
                <div role="cell">
                  {row.admin ? (
                    <span className="admin-people__role">{t('admin.roleAdmin')}</span>
                  ) : (
                    <span className="admin-people__meta">
                      <span aria-hidden="true">—</span>
                      <span className="admin-people__hidden">{t('admin.noRole')}</span>
                    </span>
                  )}
                </div>
                <div role="cell" className="admin-people__actions">
                  {items.length > 0 && (
                    <button
                      ref={(el) => {
                        if (el) moreRefs.current.set(user.id, el)
                        else moreRefs.current.delete(user.id)
                      }}
                      type="button"
                      className="admin-people__more"
                      aria-label={actionsLabel}
                      aria-haspopup="menu"
                      aria-expanded={open}
                      onClick={() => setOpenId(open ? undefined : user.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowDown' && !open) {
                          e.preventDefault()
                          setOpenId(user.id)
                        }
                      }}
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <circle cx="3" cy="8" r="1.4" />
                        <circle cx="8" cy="8" r="1.4" />
                        <circle cx="13" cy="8" r="1.4" />
                      </svg>
                    </button>
                  )}
                </div>
                {open && (
                  <RowMenu
                    label={actionsLabel}
                    items={items}
                    onClose={closeMenu}
                    onPick={(action) => {
                      setOpenId(undefined)
                      onAction(person, action)
                    }}
                  />
                )}
              </div>
            )
          })}
        </div>
        {shown.length === 0 && (
          <p className="admin-people__empty">
            {term ? t('people.noResults', { term: filter.trim() }) : t('admin.empty')}
          </p>
        )}
      </div>
    </section>
  )
}
