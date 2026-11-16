import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { AgentPanel, User, UserId } from '@tayet/client'
import { AgentAvatar, agentColorOf } from './AgentAvatar'
import { RichText } from './RichText'
import { updatedOf } from './Timeline'
import { Chevron } from '../icons'
import { t } from '../i18n'

// The pinned panels of a conversation (ADR-091 Proposto dec. 12; manifest workspace.md §17.2, §17.3, §18
// item 4, §19). Purely presentational: the panels come filtered and ordered from the ACL (the agents the
// person operates first, then by name), the names and colours from the members the shell holds, and the
// remembered state from the caller — the render-scan drives it exactly like the app.
//
// One `section` per agent in an accordion (one open at a time); at most 3 sections and, past that, the
// "mais {n}" row, which opens the list of the others over the timeline; a pick takes the third section,
// open. Escape (the popover's own, no global key handler), a click outside and another click on the row
// close the list without changing anything, and the focus returns to the row. No unread, dot,
// notification or new colour (§17.2 item 7).

const MAX_SECTIONS = 3

export function PinnedPanel({
  panels,
  usersById,
  initialOpen,
  initialPicked,
  collapsedByDefault = false,
  onPrefChange,
  now,
}: {
  panels: AgentPanel[]
  usersById: Record<string, User>
  // undefined = nothing remembered: the first panel opens (none on the narrow shell); null = none open.
  initialOpen?: UserId | null
  initialPicked?: UserId
  collapsedByDefault?: boolean
  onPrefChange?: (open: UserId | null, picked: UserId | undefined) => void
  now?: number
}) {
  const [picked, setPicked] = useState<UserId | undefined>(initialPicked)
  const [open, setOpen] = useState<UserId | null>(() =>
    initialOpen !== undefined ? initialOpen : collapsedByDefault ? null : (visibleOf(panels, initialPicked)[0]?.agent ?? null),
  )
  const [listOpen, setListOpen] = useState(false)
  const slotRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const visible = visibleOf(panels, picked)
  const more = panels.filter((p) => !visible.includes(p))

  const closeList = (): void => {
    setListOpen(false)
    moreRef.current?.focus()
  }

  // A click outside the slot closes the list (only while it is open).
  useEffect(() => {
    if (!listOpen) return
    const onDown = (e: MouseEvent): void => {
      if (slotRef.current && e.target instanceof Node && slotRef.current.contains(e.target)) return
      closeList()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [listOpen])

  // The list takes the focus when it opens (its first row).
  useEffect(() => {
    if (listOpen) listRef.current?.querySelector('button')?.focus()
  }, [listOpen])

  const toggle = (agent: UserId): void => {
    const next = open === agent ? null : agent
    setOpen(next)
    onPrefChange?.(next, picked)
  }

  const pick = (agent: UserId): void => {
    setPicked(agent)
    setOpen(agent)
    setListOpen(false)
    onPrefChange?.(agent, agent)
    moreRef.current?.focus()
  }

  const onSlotKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && listOpen) {
      e.stopPropagation()
      closeList()
    }
  }

  const nameOf = (agent: UserId): string => usersById[agent]?.displayName ?? t('agent.label')

  return (
    <div className="pinned-panel" ref={slotRef} onKeyDown={onSlotKeyDown}>
      <div className="pinned-panel__card">
        {visible.map((p) => {
          const expanded = open === p.agent
          const name = nameOf(p.agent)
          return (
            <section key={p.agent} className="pinned-panel__section" aria-label={t('panel.section', { agent: name })}>
              <button type="button" className="pinned-panel__row" aria-expanded={expanded} onClick={() => toggle(p.agent)}>
                <PanelRowContent panel={p} name={name} user={usersById[p.agent]} now={now} />
                <span className="pinned-panel__chevron" data-open={expanded ? 'true' : 'false'}>
                  <Chevron />
                </span>
              </button>
              {expanded && (
                <div className="pinned-panel__body">
                  {p.rich ? <RichText doc={p.rich} /> : <p className="pinned-panel__text">{p.text}</p>}
                </div>
              )}
            </section>
          )
        })}
        {more.length > 0 && (
          <div className="pinned-panel__section">
            <button
              ref={moreRef}
              type="button"
              className="pinned-panel__row"
              aria-expanded={listOpen}
              aria-haspopup="true"
              onClick={() => (listOpen ? closeList() : setListOpen(true))}
            >
              <span className="pinned-panel__more">{t('panel.more', { n: more.length })}</span>
              <span className="pinned-panel__chevron pinned-panel__chevron--more" data-open={listOpen ? 'true' : 'false'}>
                <Chevron />
              </span>
            </button>
          </div>
        )}
      </div>
      {listOpen && (
        <div className="pinned-panel__list" role="group" aria-label={t('panel.others')} ref={listRef}>
          {more.map((p) => (
            <button key={p.agent} type="button" className="pinned-panel__row pinned-panel__row--list" onClick={() => pick(p.agent)}>
              <PanelRowContent panel={p} name={nameOf(p.agent)} user={usersById[p.agent]} now={now} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// The row's content (§17.2 item 3, §19.1 item 5): avatar 22 · title · agent name · "atualizado às".
// Without a title the agent's name takes the title's place.
function PanelRowContent({ panel, name, user, now }: { panel: AgentPanel; name: string; user: User | undefined; now?: number }) {
  return (
    <>
      <AgentAvatar color={agentColorOf(user) ?? 'areia'} size="gestao" />
      {panel.title !== undefined ? (
        <>
          <span className="pinned-panel__title">{panel.title}</span>
          <span className="pinned-panel__agent">{name}</span>
        </>
      ) : (
        <span className="pinned-panel__title pinned-panel__title--alone">{name}</span>
      )}
      <span className="pinned-panel__updated">{updatedOf(panel.updatedAt, now)}</span>
    </>
  )
}

// The sections on show: the first two in order and, in the third, the panel picked from the list (when
// it is still there and not already above) or the third in order (§19.1 items 2 and 6).
function visibleOf(panels: AgentPanel[], picked: UserId | undefined): AgentPanel[] {
  if (panels.length <= MAX_SECTIONS) return panels
  const head = panels.slice(0, MAX_SECTIONS - 1)
  const chosen = picked !== undefined ? panels.find((p) => p.agent === picked && !head.includes(p)) : undefined
  return [...head, chosen ?? panels[MAX_SECTIONS - 1]!]
}
