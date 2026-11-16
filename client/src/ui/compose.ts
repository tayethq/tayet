import type { RichDoc } from '@tayet/client'

// What a composer hands to send/edit: the raw text (the plain fallback) plus a RichDoc when there is
// formatting. The markdown → RichDoc parser that produces this shape lives in @tayet/shared
// (`parseCompose`, shared/src/markdown.ts — PLANO-AGENTES §0.3.15); src/ui keeps only the type,
// because it never imports @tayet/shared (ADR-088 dec. 3). The TipTap composer builds it directly.
export interface ComposeResult {
  text: string
  rich?: RichDoc
}
