import { useEffect, useRef } from 'react'
import type { Person } from '@tayet/client'
import { Avatar, Button } from '../primitives'
import { t } from '../i18n'
import { PILL_TEST, rowsOf, type AccessState, type PeoplePill } from './AdminPeople'

// "Visão geral" da Admin (organization-admin.md §2.2; PLANO-ADMIN §0.3 D4, D6, §8.8 V1–V6). Puramente
// apresentacional, como a AdminPeople: a lista vem do useChat (#all), o papel da leitura da casca, sem segunda
// chamada (V4). O bloco "Saúde da instalação" fica fora: o estado da fatia 1 é `ausente` (O4), e a tela começa
// pelos números. P1: nome e email; user.id só como key, nunca renderizado.

// The four cards (§2.2 item 3), disjoint (V1): each number is the size of the list its pill opens.
const CARDS: ReadonlyArray<[PeoplePill, Parameters<typeof t>[0]]> = [
  ['organization', 'admin.countOrganization'],
  ['guests', 'admin.countGuests'],
  ['pending', 'admin.countPending'],
  ['agents', 'admin.countAgents'],
]

export function AdminOverview({
  people,
  access,
  onOpenPeople,
}: {
  people: Person[]
  access: AccessState
  // Opens "Pessoas" on a pill, with no text (V2).
  onOpenPeople: (pill: PeoplePill) => void
}) {
  // V3: the first title of the column takes the focus on opening, as "Pessoas" does with its own.
  const titleRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => titleRef.current?.focus(), [])

  const rows = rowsOf(people, access)
  // V4: the admins of the role read crossed with the list (C4: an admin outside #all is left out), you first,
  // then by name in the locale (the rows are already in name order).
  const admins = rows.filter((r) => r.admin).sort((a, b) => Number(b.person.self) - Number(a.person.self))

  return (
    <div className="admin-overview">
      <section className="admin-overview__section" aria-labelledby="admin-overview-people">
        <h2 id="admin-overview-people" ref={titleRef} tabIndex={-1} className="admin-overview__title">
          {t('admin.peopleAndAgents')}
        </h2>
        <div className="admin-overview__cards">
          {CARDS.map(([pill, label]) => {
            const n = rows.filter(PILL_TEST[pill]).length
            const name = t(label, { n })
            return (
              <button
                key={pill}
                type="button"
                className="admin-overview__card"
                aria-label={t('admin.countSeeList', { n, label: name })}
                onClick={() => onOpenPeople(pill)}
              >
                <span className="admin-overview__count">{n}</span>
                <span className="admin-overview__count-label">{name}</span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="admin-overview__section" aria-labelledby="admin-overview-admins">
        <div className="admin-overview__head">
          <h2 id="admin-overview-admins" className="admin-overview__title admin-overview__title--grow">
            {t('admin.admins')}
          </h2>
          <button type="button" className="admin-overview__link" onClick={() => onOpenPeople('admins')}>
            {t('admin.manageInPeople')}
          </button>
        </div>
        {/* V4: the server's own count, the same source as the last-admin lock in "Pessoas". */}
        {access.status === 'ready' && access.adminCount === 1 && (
          <div role="alert" className="admin-overview__warning">
            <p className="admin-overview__warning-text">{t('admin.onlyYou')}</p>
            <Button variant="fill" className="admin-overview__warning-action" onClick={() => onOpenPeople('organization')}>
              {t('admin.addAdmin')}
            </Button>
          </div>
        )}
        {/* V5: while loading, neither warning nor list; a failed read (not 403) says so in place of the list. */}
        {access.status === 'failed' && (
          <p role="alert" className="admin-overview__failed">
            {t('admin.adminsFailed')}
          </p>
        )}
        {access.status === 'ready' && (
          <div role="list" className="admin-overview__admins">
            {admins.map(({ person }) => (
              <div key={person.user.id} role="listitem" className="admin-overview__admin">
                <Avatar label={person.user.displayName.slice(0, 1)} />
                <span className="admin-overview__admin-text">
                  <span className="admin-overview__admin-name">
                    {person.self ? t('admin.self', { name: person.user.displayName }) : person.user.displayName}
                  </span>
                  {person.email && <span className="admin-overview__admin-meta">{person.email}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
