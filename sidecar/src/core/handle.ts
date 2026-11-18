// The handle the boot returns (core of the sidecar, ADR-087 decs. 1, 7, 8). Neutral vocabulary:
// channel/message/state, never the protocol's. `read` and `write` take and hand out only opaque
// tokens (S-c1, S-c2 — §0.3.7 item 10): no raw protocol id crosses this handle. The core never exits
// the process: cli.ts owns it.
import type { ApprovalFacade } from './approvals'
import type { CommandsFacade } from './commands'
import type { FormFacade } from './forms'
import type { PanelFacade } from './panels'
import type { ReadFacade } from './read'
import type { WriteFacade } from './write'

// online = the sync is healthy (prepared or syncing); offline = anything else after it was healthy.
export type CoreState = 'online' | 'offline'

export interface Core {
  // The read path, tokenized (core/read.ts, S-c1): what the local API serves.
  read: ReadFacade
  // The write path, tokenized (core/write.ts, S-c2): every effect through the single send queue.
  write: WriteFacade
  // The approval cards (ADR-091, A3-3; core/approvals.ts): send, close, state. Absent in fakes.
  approvals?: ApprovalFacade
  // An agent's forms (core/forms.ts): open, result, the in-memory listener of submissions. Only the Slack layer
  // reaches it (views.open, view_submission); no native route or tool. Absent in fakes.
  forms?: FormFacade
  // The agent's pinned panel (ADR-091 dec. 13, A3-6; core/panels.ts): write, clear, read. Absent in fakes.
  panels?: PanelFacade
  // The agent's `/` commands (ADR-093, A4-2a; core/commands.ts): declare, clear, read. Absent in fakes.
  commands?: CommandsFacade
  // The store directory this run holds the lock of (local.token and api.json live there).
  storeDir: string
  // The product URL the agent was started with (`--server`): the Slack layer's `auth.test` `url`.
  productUrl: string
  // The local API's bearer token (<store>/local.token), registered as a secret.
  localToken: string
  state(): CoreState
  // Fails pending writes `stopped`, stops the sync, flushes the store, writes the checkpoint and
  // releases the lock. Never settles while a revocation is in progress ('revoked' ends the process).
  shutdown(): Promise<void>
  on(event: 'state', listener: (state: CoreState) => void): void
  // Terminal and sticky: a listener added after the revocation is called at once.
  on(event: 'revoked', listener: () => void): void
  // The revocation STARTED (before the wipe; 'revoked' follows when it is done). Sticky as well: the
  // local API refuses everything from here (§0.3.6 adj. 8), not only after the store is gone.
  on(event: 'revoking', listener: () => void): void
}

export interface CoreEvents {
  on: Core['on']
  state(state: CoreState): void
  revoking(): void
  revoked(): void
}

export function createCoreEvents(): CoreEvents {
  const stateListeners = new Set<(state: CoreState) => void>()
  const revokedListeners = new Set<() => void>()
  const revokingListeners = new Set<() => void>()
  let wasRevoked = false
  let wasRevoking = false
  const on = ((event: 'state' | 'revoked' | 'revoking', listener: (() => void) | ((state: CoreState) => void)): void => {
    if (event === 'state') {
      stateListeners.add(listener)
      return
    }
    if (event === 'revoking') {
      if (wasRevoking) (listener as () => void)()
      else revokingListeners.add(listener as () => void)
      return
    }
    if (wasRevoked) (listener as () => void)()
    else revokedListeners.add(listener as () => void)
  }) as Core['on']
  return {
    on,
    state: (state) => {
      for (const l of stateListeners) l(state)
    },
    revoking: () => {
      if (wasRevoking) return
      wasRevoking = true
      for (const l of revokingListeners) l()
      revokingListeners.clear()
    },
    revoked: () => {
      if (wasRevoked) return
      wasRevoked = true
      for (const l of revokedListeners) l()
      revokedListeners.clear()
    },
  }
}
