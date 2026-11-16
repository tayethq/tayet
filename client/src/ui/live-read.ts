import type { ChannelId, DomainEvent, Message, MessageId } from '@tayet/client'

// ADR-100: the open conversation is read as messages arrive. The selection's receipt (ADR-068 D7's
// siblings: select, open a thread, send) only covers what the screen holds at that instant; a message
// that lands later, with the conversation in view, stayed unread until the person replied or left and
// came back. This module receipts it — only from the UI, through the existing markRead verb (the
// gateway and the barrel do not change). Same shape as notifier.ts: pure, env injected.
//
// "In view" is the condition of ADR-073 dec. 4, unchanged: the conversation is selected, the document
// is visible and it has focus. The scroll position is not part of it (ADR-100, limits).

export interface LiveReadDeps {
  markRead(channelId: ChannelId, upTo: MessageId): Promise<void>
  getSelectedId(): ChannelId | undefined
  // The root of the thread open in the panel, if it belongs to the selected conversation.
  getOpenThread(): MessageId | undefined
  // What the screen holds: the main timeline, and the open thread's replies.
  getMain(): readonly Message[]
  getReplies(): readonly Message[]
  // Dec. 2: the thread receipt went out; the thread's unread is re-read.
  threadRead(channelId: ChannelId, root: MessageId): void
}

// Injected like NotifierEnv: the unit tests drive visibility, focus and the return.
export interface LiveReadEnv {
  isVisible(): boolean
  hasFocus(): boolean
  // Calls `fn` when the document may have come back (visibilitychange, window focus). Returns the
  // unsubscribe.
  onReturn(fn: () => void): () => void
}

export interface LiveReader {
  handle(e: DomainEvent): void
  dispose(): void
}

export function browserLiveReadEnv(): LiveReadEnv {
  return {
    isVisible: () => document.visibilityState === 'visible',
    hasFocus: () => document.hasFocus(),
    onReturn: (fn) => {
      document.addEventListener('visibilitychange', fn)
      window.addEventListener('focus', fn)
      return () => {
        document.removeEventListener('visibilitychange', fn)
        window.removeEventListener('focus', fn)
      }
    },
  }
}

// The main timeline and each thread are separate read positions (a thread receipt never moves the
// main one, ADR-067), so the newest-only rule is per scope.
type Scope = 'main' | `thread:${string}`

interface Queue {
  inFlight: boolean
  // The scope and target of the receipt in flight: the return does not queue the same one again.
  flying?: { scope: Scope; target: MessageId }
  // Dec. 5: the newest target waiting per scope while a receipt flies.
  waiting: Map<Scope, { target: MessageId; root?: MessageId }>
}

// The last message the screen holds that the server knows (a pending or failed echo of ours has no
// server id: a receipt on it would only be deferred).
const lastSettled = (list: readonly Message[]): Message | undefined => {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]!
    if (m.status !== 'pending' && m.status !== 'failed') return m
  }
  return undefined
}

export function createLiveReader(deps: LiveReadDeps, env: LiveReadEnv = browserLiveReadEnv()): LiveReader {
  const queues = new Map<ChannelId, Queue>()
  // The last target receipted per channel and scope: the return does not re-send it. Set only when the
  // receipt succeeds, so a failed one is sent again on the next return.
  const sent = new Map<string, MessageId>()
  let disposed = false

  const inView = (): boolean => env.isVisible() && env.hasFocus()

  const fly = (channelId: ChannelId, scope: Scope, target: MessageId, root: MessageId | undefined): void => {
    const q = queues.get(channelId)!
    q.inFlight = true
    q.flying = { scope, target }
    void deps
      .markRead(channelId, target)
      .then(
        () => {
          if (!disposed) sent.set(`${channelId}\n${scope}`, target)
          if (!disposed && root !== undefined && deps.getSelectedId() === channelId) deps.threadRead(channelId, root)
        },
        // Dec. 5: a failed receipt is swallowed, as the selection's is.
        () => {},
      )
      .then(() => {
        q.inFlight = false
        q.flying = undefined
        // Dec. 5 + the switch: what waited for a conversation no longer selected is dropped.
        if (disposed || deps.getSelectedId() !== channelId) {
          queues.delete(channelId)
          return
        }
        const next = q.waiting.entries().next()
        if (next.done) return
        const [nextScope, w] = next.value
        q.waiting.delete(nextScope)
        fly(channelId, nextScope, w.target, w.root)
      })
  }

  const receipt = (channelId: ChannelId, scope: Scope, target: MessageId, root?: MessageId): void => {
    let q = queues.get(channelId)
    if (!q) {
      q = { inFlight: false, waiting: new Map() }
      queues.set(channelId, q)
    }
    if (q.inFlight) {
      q.waiting.set(scope, { target, root })
      return
    }
    fly(channelId, scope, target, root)
  }

  const handle = (e: DomainEvent): void => {
    if (disposed || e.t !== 'message.received') return
    const m = e.message
    // Dec. 1–2: someone else's message, in the selected conversation, in view. An undecryptable
    // arrival counts too: it is in the conversation the person is looking at.
    if (m.mine || deps.getSelectedId() !== e.channelId || !inView()) return
    if (m.threadParent === undefined) receipt(e.channelId, 'main', m.id)
    // Dec. 2: a reply of the thread open in the panel; a closed thread's reply stays unread (ADR-067).
    else if (m.threadParent === deps.getOpenThread()) receipt(e.channelId, `thread:${m.threadParent}`, m.id, m.threadParent)
  }

  // Already receipted, or flying right now: either way the return has nothing to send for it.
  const covered = (channelId: ChannelId, scope: Scope, target: MessageId): boolean => {
    if (sent.get(`${channelId}\n${scope}`) === target) return true
    const f = queues.get(channelId)?.flying
    return f !== undefined && f.scope === scope && f.target === target
  }

  // Dec. 3: back in view, the selected conversation is read up to what the screen holds.
  const onReturn = (): void => {
    if (disposed || !inView()) return
    const channelId = deps.getSelectedId()
    if (!channelId) return
    const main = lastSettled(deps.getMain())
    if (main && !covered(channelId, 'main', main.id)) receipt(channelId, 'main', main.id)
    const root = deps.getOpenThread()
    const reply = root === undefined ? undefined : lastSettled(deps.getReplies())
    if (root !== undefined && reply && !covered(channelId, `thread:${root}`, reply.id))
      receipt(channelId, `thread:${root}`, reply.id, root)
  }
  const unsubscribe = env.onReturn(onReturn)

  const dispose = (): void => {
    disposed = true
    unsubscribe()
    queues.clear()
    sent.clear()
  }

  return { handle, dispose }
}
