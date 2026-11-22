import { useCallback, useEffect, useRef, useState } from 'react'
import type { Acl, AgentColor, ChannelId, SearchHit, User } from '@tayet/client'
import { searchStateOf, type SearchState } from './search-state'
import { t } from './i18n'
import { resolveAuthor } from './author'

// Local message search for the sidebar (ADR-074; manifest workspace.md §8). The query and its scope —
// all conversations by default, or only the open one (the "nesta conversa" chip, §8 item 2) — the hits
// of the last query run, the author names they show, and the index's search.state.

// Search as you type (§8 item 2): one searchMessages per pause, from two characters on.
export const SEARCH_DEBOUNCE_MS = 150
export const SEARCH_MIN_CHARS = 2

// A hit ready to render: the barrel hit plus its author's display name (the barrel carries none —
// ADR-074 dec. 5; resolved here per conversation, best-effort like ADR-073 D5).
export interface ResolvedHit {
  hit: SearchHit
  author: string
  // ADR-086: the agent mark of a result — from the member map, else from the snapshot's portrait of an
  // author who left (PLANO-AGENTES §0.3.11). Absent for a person.
  authorAgent?: AgentColor
}

export interface SearchView {
  query: string
  setQuery: (query: string) => void
  scoped: boolean
  // undefined when no conversation is open — nothing to narrow to.
  toggleScope?: () => void
  clear: () => void
  // The query has enough characters: the results replace the conversation list (§8 item 4).
  active: boolean
  // The hits of `searched`, the last query that came back (they stay while the next one runs).
  hits: ResolvedHit[]
  searched: string
  state: SearchState
}

const IDLE: SearchState = { preparing: false, partial: false, persisting: false, degraded: false }

// Below the width breakpoint (`narrow`) there is no "nesta conversa" scope (workspace.md §23.12): the chip is
// not offered and a scope that was on goes off when the window narrows (PLANO-MOBILE M6).
export function useSearch(acl: Acl, current: ChannelId | undefined, narrow = false): SearchView {
  const [query, setQuery] = useState('')
  const [scoped, setScoped] = useState(false)
  const [results, setResults] = useState<{ searched: string; hits: ResolvedHit[] }>({ searched: '', hits: [] })
  const [state, setState] = useState<SearchState>(() => searchStateOf(acl)?.get() ?? IDLE)
  // Display names per conversation, from getMembers (in-memory in the ACL). Dropped when the query is
  // cleared, so a renamed or new member shows up on the next search.
  const names = useRef(new Map<ChannelId, Promise<Record<string, User>>>())

  useEffect(() => {
    const feed = searchStateOf(acl)
    if (!feed) return
    setState(feed.get())
    return feed.subscribe(setState)
  }, [acl])

  useEffect(() => {
    if (narrow) setScoped(false)
  }, [narrow])

  const term = query.trim()
  const active = term.length >= SEARCH_MIN_CHARS
  const channel = scoped ? current : undefined

  useEffect(() => {
    if (!active) return
    let alive = true
    const namesOf = (id: ChannelId): Promise<Record<string, User>> => {
      let p = names.current.get(id)
      if (!p) {
        p = acl
          .getMembers(id)
          .then((ms) => Object.fromEntries(ms.map(({ user }) => [user.id, user])))
          .catch((): Record<string, User> => ({}))
        names.current.set(id, p)
      }
      return p
    }
    const timer = setTimeout(() => {
      void acl
        .searchMessages(term, channel ? { channel } : undefined)
        .then(async (hits) => {
          const byChannel = new Map<ChannelId, Record<string, User>>()
          for (const id of new Set(hits.map((h) => h.channel))) byChannel.set(id, await namesOf(id))
          if (!alive) return
          setResults({
            searched: term,
            hits: hits.map((hit) => {
              // An author no longer among the conversation's members resolves by the snapshot's portrait;
              // an older entry without one falls to the unknown author.
              const r = resolveAuthor(hit.message, byChannel.get(hit.channel) ?? {}, t('search.unknownAuthor'))
              return { hit, author: r.name, ...(r.agentColor !== undefined && { authorAgent: r.agentColor }) }
            }),
          })
        })
        .catch(() => {})
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
    // The backfill's progress re-runs the query when the index grows (preparing → done, or partial);
    // a write committing (`persisting`) adds nothing to what memory already answers.
  }, [acl, active, term, channel, state.preparing, state.partial])

  const toggle = useCallback(() => setScoped((s) => !s), [])
  const clear = useCallback(() => {
    setQuery('')
    setScoped(false)
    setResults({ searched: '', hits: [] })
    names.current.clear()
  }, [])

  return {
    query,
    setQuery,
    scoped: scoped && current !== undefined,
    toggleScope: current && !narrow ? toggle : undefined,
    clear,
    active,
    hits: results.hits,
    searched: results.searched,
    state,
  }
}
