import type { Message, UserId } from '@tayet/client'
import { richDocToHTML, escapeToParagraph } from './rich-to-html'

// One step of the composer's history (workspace.md §25.6; issue tayethq/tayet #2): the HTML the editor takes
// (the edit path's, PLANO-MOBILE §0.15: setContent with richDocToHTML or escapeToParagraph) and, for a command
// message, the command it carried (H1 c: the chip is rebuilt from the live list). A mention comes back as its
// "@nome" text (H2 a): the RichDoc already carries the mention flattened to text.
export interface HistoryEntry {
  key: string
  html: string
  command?: { agent: UserId; name: string }
}

// The HTML of a text body: the rich when there is one, else the escaped plain text.
export const textBodyHTML = (body: { text: string; rich?: Parameters<typeof richDocToHTML>[0] }): string =>
  body.rich ? richDocToHTML(body.rich) : escapeToParagraph(body.text)

// One's own text messages already loaded, newest first. Out: pending, failed, and every other body kind.
export function historyOf(messages: readonly Message[]): HistoryEntry[] {
  const out: HistoryEntry[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.mine !== true || m.body.kind !== 'text' || m.status === 'pending' || m.status === 'failed') continue
    out.push({ key: m.id, html: textBodyHTML(m.body), ...(m.command && { command: m.command }) })
  }
  return out
}
