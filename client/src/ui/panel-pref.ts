import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChannelId, UserId } from '@tayet/client'

// PLANO-AGENTES §0.3.16 item 18, §0.3.18 item 6; manifest workspace.md §17.2 item 6, §19.1 item 8: which
// pinned panel is open in a conversation (or none) and the panel picked from the list, remembered per
// conversation on this device. App-side preference, NEVER domain — the posture of archived-pref.ts
// (localStorage, per origin, best-effort) — with one difference: the key and the values are derived by a
// hash that does not reverse (SHA-256, truncated), so no raw id of account, conversation or agent is
// ever written. The account and the conversation salt the agent's token, so the same agent gets a
// different token in each conversation.

const PREFIX = 'tayet.panel'
// 16 hex = 64 bits: enough to tell a conversation's few panels apart, too short to be an id.
const TOKEN_HEX = 16

export interface StoredPanelPref {
  // The open panel's token, or '' for none.
  open: string
  picked?: string
}

async function hashOf(...parts: string[]): Promise<string> {
  const bytes = new TextEncoder().encode(parts.join('\u0000'))
  // WebCrypto matches algorithm names case-insensitively.
  const digest = await crypto.subtle.digest('sha-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, TOKEN_HEX)
}

export async function panelPrefKey(account: string, channel: string): Promise<string> {
  const hash = await hashOf('key', account, channel)
  return [PREFIX, hash].join('.')
}

export async function panelAgentToken(account: string, channel: string, agent: string): Promise<string> {
  return hashOf('agent', account, channel, agent)
}

export function loadPanelPref(key: string): StoredPanelPref | undefined {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return undefined
    const v = JSON.parse(raw) as { o?: unknown; p?: unknown }
    if (typeof v.o !== 'string') return undefined
    return { open: v.o, ...(typeof v.p === 'string' && { picked: v.p }) }
  } catch {
    return undefined
  }
}

export function savePanelPref(key: string, pref: StoredPanelPref): void {
  try {
    localStorage.setItem(key, JSON.stringify(pref.picked !== undefined ? { o: pref.open, p: pref.picked } : { o: pref.open }))
  } catch {
    // best-effort
  }
}

// What the panel starts with: `open` undefined = nothing remembered (the default applies); null = the
// person closed them all.
export interface PanelPrefState {
  open?: UserId | null
  picked?: UserId
}

// The preference of one conversation, resolved before the panel's first render (`ready`). Once ready for
// a conversation it stays ready: a panel of a new agent resolves its token in the background, and until
// then a choice involving that agent holds on screen and is not saved. Without a working hash (an insecure
// context) it is ready with nothing remembered and nothing saved.
export function usePanelPref(account: UserId | undefined, channel: ChannelId | undefined, agents: readonly UserId[]) {
  const scope = account !== undefined && channel !== undefined ? `${account}\u0000${channel}` : undefined
  const agentsKey = agents.join('\n')
  const [resolved, setResolved] = useState<{ scope: string; key?: string; tokens: Map<string, string> } | undefined>(undefined)
  useEffect(() => {
    if (account === undefined || channel === undefined || scope === undefined) return
    let alive = true
    const list = agentsKey === '' ? [] : agentsKey.split('\n')
    void Promise.all([panelPrefKey(account, channel), ...list.map((a) => panelAgentToken(account, channel, a))]).then(
      ([key, ...tokens]) => {
        if (alive) setResolved({ scope, key, tokens: new Map(list.map((a, i) => [a, tokens[i]!])) })
      },
      () => {
        if (alive) setResolved({ scope, tokens: new Map() })
      },
    )
    return () => {
      alive = false
    }
  }, [account, channel, scope, agentsKey])

  const current = resolved?.scope === scope ? resolved : undefined
  const allTokens = current !== undefined && (current.key === undefined || agents.every((a) => current.tokens.has(a)))
  // The conversation whose first resolution happened: from then on the panel stays mounted.
  const readyScope = useRef<string | undefined>(undefined)
  if (allTokens && scope !== undefined) readyScope.current = scope
  const ready = current !== undefined && (allTokens || readyScope.current === scope)
  const initial = useMemo<PanelPrefState>(() => {
    if (!current?.key) return {}
    const stored = loadPanelPref(current.key)
    if (!stored) return {}
    const agentOf = (token: string): UserId | undefined => {
      for (const [agent, t] of current.tokens) if (t === token) return agent as UserId
      return undefined
    }
    const picked = stored.picked !== undefined ? agentOf(stored.picked) : undefined
    const open = stored.open === '' ? null : agentOf(stored.open)
    return { ...(open !== undefined && { open }), ...(picked !== undefined && { picked }) }
    // Read once per conversation (when it resolves); later saves do not re-seed the mounted panel.
  }, [current?.key, ready])

  const save = (open: UserId | null, picked: UserId | undefined): void => {
    if (!current?.key) return
    const openToken = open === null ? '' : current.tokens.get(open)
    if (openToken === undefined) return
    const pickedToken = picked !== undefined ? current.tokens.get(picked) : undefined
    // A choice whose agent has no token yet holds on screen and is not saved.
    if (picked !== undefined && pickedToken === undefined) return
    savePanelPref(current.key, { open: openToken, ...(pickedToken !== undefined && { picked: pickedToken }) })
  }

  return { ready, initial, save }
}
