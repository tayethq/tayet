import type { AgentColor, Message, User } from '@tayet/client'
import { agentColorOf } from './components/AgentAvatar'

// PLANO-AGENTES §0.3.11 (P6 / ADR-086 dec. 2): the one place a message's author is resolved for display.
// The current member map wins; an author no longer in it (a person who left, a removed agent) falls back
// to the portrait the translator took at the event (`authorAt`); with neither, the surface's own
// "Alguém". The agent mark shows whenever the portrait says agent — colour absent → 'areia'.
export interface ResolvedAuthor {
  name: string
  agentColor?: AgentColor
  // The author as a User, only when they are in the member map (the avatar photo comes from it).
  user?: User
}

export function resolveAuthor(
  m: Pick<Message, 'author' | 'authorAt'>,
  usersById: Record<string, User>,
  fallback: string,
): ResolvedAuthor {
  const user = usersById[m.author]
  if (user) {
    const agentColor = agentColorOf(user)
    return { name: user.displayName, ...(agentColor !== undefined && { agentColor }), user }
  }
  const at = m.authorAt
  if (at) return { name: at.name ?? fallback, ...(at.agent && { agentColor: at.color ?? 'areia' }) }
  return { name: fallback }
}

// Up to two initials for a monogram avatar ("Rafael Souza" → "RS"); a single word gives its first two
// letters ("Você" → "VO"). The Avatar primitive upper-cases for display; we normalise here too so the
// value handed across is stable. Shared by the timeline and the composer's suggestion popup.
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const raw = parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : name.trim().slice(0, 2)
  return raw.toUpperCase()
}
