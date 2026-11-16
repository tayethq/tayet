import type { AgentCommand } from '@tayet/shared'
import { COMMANDS_REL_TYPE, brandUserId, readCommandsBlock } from '@tayet/shared/internal'
import type { RelationsClient } from './approval-state'
import { AnchoredAggregator, fetchAnchoredPage, type AnchoredPage, type LatestWrite } from './anchored-state'

// ADR-093 (Proposto) — the client's reader of the agents' `/` commands (PLANO-AGENTES §0.3.21 items 1–6): an
// adapter of the anchored aggregator (anchored-state.ts). A manifest is a message of the agent, related to
// the conversation's creation event by the manifest's relation type and updated by edits; the aggregator
// keeps the author's latest write per member agent, and this adapter reads its block tolerantly
// (readCommandsBlock: a cleared manifest or a block that is not an object leaves the agent without
// commands) and hands the list flat: one item per command, ordered by the command's name and then the
// agent's name (the same name under two agents is two items).

export interface CommandPorts {
  // The conversation's creation event (the anchor), or undefined when the room does not hold it.
  anchorOf(roomId: string): string | undefined
  // One page of the anchor's manifest relations in the server's order, from `from` (undefined = the start).
  fetchPage(roomId: string, anchorId: string, from: string | undefined): Promise<AnchoredPage>
  // Whether the account is a current member (joined) of the conversation.
  isMember(roomId: string, sender: string): boolean
  // The agent's name in the conversation, for the order.
  nameOf(roomId: string, sender: string): string
  // The list moved: emit it.
  changed(roomId: string, commands: AgentCommand[]): void
  // Detached work is tracked by the gateway (disconnect waits / drops it).
  detach(work: Promise<unknown>): void
}

const collator = new Intl.Collator('pt-BR')

export class CommandAggregator extends AnchoredAggregator<AgentCommand> {
  constructor(ports: CommandPorts) {
    super(
      {
        anchorOf: (roomId) => ports.anchorOf(roomId),
        fetchPage: (roomId, anchorId, from) => ports.fetchPage(roomId, anchorId, from),
        isMember: (roomId, sender) => ports.isMember(roomId, sender),
        output: (roomId, latest) => flatCommands(latest, ports, roomId),
        changed: (roomId, commands) => ports.changed(roomId, commands),
        detach: (work) => ports.detach(work),
      },
      'commands unavailable',
    )
  }
}

function flatCommands(latest: LatestWrite[], ports: CommandPorts, roomId: string): AgentCommand[] {
  const out: Array<{ command: AgentCommand; agentName: string }> = []
  for (const w of latest) {
    const block = readCommandsBlock(w.content)
    if (!block || block.cleared) continue
    const agentName = ports.nameOf(roomId, w.sender)
    for (const c of block.commands) {
      out.push({ command: { agent: brandUserId(w.sender), ...c }, agentName })
    }
  }
  // By the command's name (code order: names are lower ASCII), then by the agent's name (pt-BR), then by the
  // agent itself so two agents with the same name keep a stable order.
  out.sort(
    (a, b) =>
      (a.command.name < b.command.name ? -1 : a.command.name > b.command.name ? 1 : 0) ||
      collator.compare(a.agentName, b.agentName) ||
      ((a.command.agent as unknown as string) < (b.command.agent as unknown as string) ? -1 : 1),
  )
  return out.map((o) => o.command)
}

// One page of the anchor's manifest relations, forward, each manifest resolved to the content it shows.
export function fetchCommandsPage(client: RelationsClient, roomId: string, anchorId: string, from: string | undefined): Promise<AnchoredPage> {
  return fetchAnchoredPage(client, roomId, anchorId, COMMANDS_REL_TYPE, from)
}
