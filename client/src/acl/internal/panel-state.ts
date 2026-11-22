import type { AgentPanel, Timestamp } from '@tayet/shared'
import { PANEL_REL_TYPE, brandUserId, readPanelBlock, richFromContent } from '@tayet/shared/internal'
import type { RelationsClient } from './approval-state'
import { AnchoredAggregator, fetchAnchoredPage, type AnchoredEdit, type AnchoredFact, type LatestWrite } from './anchored-state'

// ADR-091 dec. 12 — the client's reader of the pinned panels (PLANO-AGENTES §0.3.18 items 1–4; §0.3.16
// items 15–16): an adapter of the anchored aggregator (anchored-state.ts, ADR-093 (Proposto) — §0.3.21
// item 5). A panel is a message of the agent, related to the conversation's creation event by the panel's
// relation type and updated by edits; the aggregator keeps the author's latest write per member agent, and
// this adapter reads its block (a cleared or malformed panel is out — manifest §18 item 4: no empty state)
// and orders the list: the agents the person operates first, then by name.

export type PanelFact = AnchoredFact
export type PanelEdit = AnchoredEdit

export interface PanelPage {
  panels: PanelFact[]
  next?: string
}

export interface PanelPorts {
  // The conversation's creation event (the anchor), or undefined when the room does not hold it.
  anchorOf(roomId: string): string | undefined
  // One page of the anchor's panel relations in the server's order, from `from` (undefined = the start).
  fetchPage(roomId: string, anchorId: string, from: string | undefined): Promise<PanelPage>
  // Whether the account is a current member (joined) of the conversation.
  isMember(roomId: string, sender: string): boolean
  // Whether this session operates the agent (agentOf's operator — nothing of it crosses the barrel).
  isOwn(sender: string): boolean
  // The agent's name in the conversation, for the order.
  nameOf(roomId: string, sender: string): string
  // The list moved: emit it.
  changed(roomId: string, panels: AgentPanel[]): void
  // Detached work is tracked by the gateway (disconnect waits / drops it).
  detach(work: Promise<unknown>): void
}

// Conversations kept in the cache; past this the oldest goes (its next listPanels reads it again).
export { ANCHORED_CACHE_CAP as PANEL_CACHE_CAP } from './anchored-state'

const collator = new Intl.Collator(undefined)

export class PanelAggregator extends AnchoredAggregator<AgentPanel> {
  constructor(ports: PanelPorts) {
    super(
      {
        anchorOf: (roomId) => ports.anchorOf(roomId),
        fetchPage: async (roomId, anchorId, from) => {
          const page = await ports.fetchPage(roomId, anchorId, from)
          return { facts: page.panels, ...(page.next !== undefined && { next: page.next }) }
        },
        isMember: (roomId, sender) => ports.isMember(roomId, sender),
        output: (roomId, latest) => orderPanels(latest, ports, roomId),
        changed: (roomId, panels) => ports.changed(roomId, panels),
        detach: (work) => ports.detach(work),
      },
      'panels unavailable',
    )
  }
}

function orderPanels(latest: LatestWrite[], ports: PanelPorts, roomId: string): AgentPanel[] {
  const out: Array<{ panel: AgentPanel; own: boolean; name: string }> = []
  for (const w of latest) {
    const panel = panelOf(w.sender, w.content, w.at)
    if (!panel) continue
    out.push({ panel, own: ports.isOwn(w.sender), name: ports.nameOf(roomId, w.sender) })
  }
  out.sort((a, b) => (a.own === b.own ? collator.compare(a.name, b.name) : a.own ? -1 : 1))
  return out.map((o) => o.panel)
}

// The domain panel from the content a panel shows: undefined when the block is malformed or the panel is
// cleared (out of the list).
export function panelOf(sender: string, content: Record<string, unknown>, at: number): AgentPanel | undefined {
  const block = readPanelBlock(content)
  if (!block || block.cleared) return undefined
  const rich = richFromContent(content)
  return {
    agent: brandUserId(sender),
    ...(block.title !== undefined && { title: block.title }),
    text: typeof content.body === 'string' ? content.body : '',
    ...(rich !== undefined && { rich }),
    updatedAt: at as Timestamp,
  }
}

export { isReaderCopy } from './anchored-state'

export type PanelClient = RelationsClient

// One page of the anchor's panel relations, forward, each panel resolved to the content it shows
// (fetchAnchoredPage): the author's latest edit, else the original; never the stale original under an
// author's edit that does not decrypt.
export async function fetchPanelPage(client: PanelClient, roomId: string, anchorId: string, from: string | undefined): Promise<PanelPage> {
  const { facts, next } = await fetchAnchoredPage(client, roomId, anchorId, PANEL_REL_TYPE, from)
  return { panels: facts, ...(next !== undefined && { next }) }
}
