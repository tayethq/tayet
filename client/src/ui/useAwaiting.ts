import { useEffect, useRef, useState } from 'react'
import type { Acl, AwaitingApproval, User } from '@tayet/client'
import { resolveAuthor } from './author'
import { t, getLocale } from './i18n'

// "Aguardando você" (ADR-099; workspace.md §23.2 item 5, §23.4; PLANO-MOBILE §0.20).

// V1: the one observer of the ACL's read, only while the window is narrow. Subscribed before the watch (the
// contract's order): the first list arrives once the read's first pass ends. Undefined until then (V7: no
// row, no loading state) and whenever the window is wide (no observer, no read).
export function useAwaitingApprovals(acl: Acl, narrow: boolean): AwaitingApproval[] | undefined {
  const [items, setItems] = useState<AwaitingApproval[] | undefined>(undefined)
  useEffect(() => {
    if (!narrow) return
    const unsubscribe = acl.subscribe((e) => {
      if (e.t === 'approvals.awaiting') setItems(e.items)
    })
    const unwatch = acl.watchAwaitingApprovals()
    return () => {
      unwatch()
      unsubscribe()
      setItems(undefined)
    }
  }, [acl, narrow])
  return items
}

const newestFirst = (a: AwaitingApproval, b: AwaitingApproval): number =>
  (b.message.sentAt as unknown as number) - (a.message.sentAt as unknown as number)

// V3: while the screen is on the stack, the cards it showed stay. A new card of the ACL's list comes in, in
// order; a card that leaves the list stays where it was, moved by message.edited (sending, not sent,
// answered, closed); a deleted card goes at once. Closed, what it held is dropped. `empty` (V4, F1): the screen
// was reached with nothing to show, or its last card was deleted.
export function useAwaitingScreen(
  acl: Acl,
  items: AwaitingApproval[] | undefined,
  open: boolean,
  empty: () => void,
): AwaitingApproval[] {
  const [shown, setShown] = useState<AwaitingApproval[]>([])
  const onEmpty = useRef(empty)
  onEmpty.current = empty
  // Opened: start from the ACL's list; nothing there is an arrival with nothing pending.
  useEffect(() => {
    if (!open) {
      setShown([])
      return
    }
    const start = items ?? []
    setShown(start)
    if (start.length === 0) onEmpty.current()
    // Only on opening: the list's later changes are merged below.
  }, [open])
  // The list moved: what it has is fresher; what it dropped stays.
  useEffect(() => {
    if (!open || !items) return
    setShown((held) => {
      const fresh = new Map(items.map((i) => [i.message.id, i]))
      const kept = held.map((i) => fresh.get(i.message.id) ?? i)
      const known = new Set(held.map((i) => i.message.id))
      return [...kept, ...items.filter((i) => !known.has(i.message.id))].sort(newestFirst)
    })
  }, [open, items])
  // F1: a screen whose every card was deleted goes back as the arrival with nothing pending does. A card that
  // stays in any state (answered, sending, not sent, closed) keeps it open (V4).
  const held = useRef(false)
  useEffect(() => {
    if (!open) {
      held.current = false
      return
    }
    if (shown.length > 0) held.current = true
    else if (held.current) {
      held.current = false
      onEmpty.current()
    }
  }, [open, shown])
  useEffect(() => {
    if (!open) return
    return acl.subscribe((e) => {
      if (e.t === 'message.edited' && e.message.body.kind === 'approval') {
        const message = e.message
        setShown((held) => (held.some((i) => i.message.id === message.id) ? held.map((i) => (i.message.id === message.id ? { ...i, message } : i)) : held))
      } else if (e.t === 'message.removed') {
        setShown((held) => (held.some((i) => i.message.id === e.messageId) ? held.filter((i) => i.message.id !== e.messageId) : held))
      }
    })
  }, [acl, open])
  return shown
}

// V5: the distinct agents in the list's order, joined by the interface language's list format, with the
// catalog's plural on the count.
export function awaitingSummary(items: AwaitingApproval[], usersById: Record<string, User>): string {
  const agents = new Map<string, string>()
  for (const { message } of items) {
    if (!agents.has(message.author)) agents.set(message.author, resolveAuthor(message, usersById, t('timeline.someone')).name)
  }
  const list = new Intl.ListFormat(getLocale(), { style: 'long', type: 'conjunction' }).format([...agents.values()])
  return t('awaiting.summary', { n: items.length, agents: list })
}
