// ADR-091 dec. 12: reading a pinned panel's block. Pure — no SDK, no network — so the client
// (A3-5) and the sidecar (A3-6) read the same shape (PLANO-AGENTES §0.3.18 items 1–2).
import { PANEL_BLOCK, PANEL_MSGTYPE } from './product-events'

// The title: plain text, one line, at most 75 characters (the sidecar validates the same on write).
export const PANEL_TITLE_MAX = 75

// A line break of any kind (CR, LF, and the Unicode line/paragraph separators). Also the one-line rule of the
// command manifest's description and hint (commands.ts, ADR-093).
export const LINE_BREAK = new RegExp('[\\r\\n\\u2028\\u2029]')

export interface PanelBlock {
  title?: string
  cleared: boolean
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// A title that keeps the rule, else undefined: a string, not blank, no line break, at most 75
// characters (code points). Leading/trailing space is trimmed before the count.
export function panelTitleOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const title = raw.trim()
  if (title === '' || LINE_BREAK.test(title) || [...title].length > PANEL_TITLE_MAX) return undefined
  return title
}

// The block of the content a panel SHOWS (the author's latest edit's new content, or the original):
// `{ title?, cleared }`, or undefined when the content is not a panel or its block is malformed (present
// and not an object). A title outside the rule leaves the panel without a title — never an error. An
// absent block is a panel with no title, not cleared.
export function readPanelBlock(content: Record<string, unknown>): PanelBlock | undefined {
  if (content.msgtype !== PANEL_MSGTYPE) return undefined
  const block = content[PANEL_BLOCK]
  if (block === undefined) return { cleared: false }
  if (!isRecord(block)) return undefined
  const title = panelTitleOf(block.title)
  return { ...(title !== undefined && { title }), cleared: block.cleared === true }
}
