// Rich text — a NEUTRAL structured document model (ADR-012, Opção C). This is the domain
// representation of formatted message content: ZERO protocol vocabulary, ZERO HTML string.
// The ACL owns the bidirectional translation formatted_body (HTML) ↔ RichDoc, confined to
// acl/internal/rich-text.ts; this file only declares the shape that crosses the barrel.
//
// The node set is BOUNDED on purpose: a new node (table, spoiler, mention) is a coordinated
// extension (type + parser + serializer + gate), never an ad-hoc addition. Mention specifically
// is deferred and pairs with ❓2 (identity in the UX) — see PLANO §8 / ADR-012 trigger.
//
// Why structured (not an HTML string in the domain): the renderer consumes RichDoc
// STRUCTURALLY — there is no dangerouslySetInnerHTML anywhere, so XSS is impossible by
// construction (an unknown node cannot be rendered). Inbound parsing is fail-closed: only
// known nodes survive the allowlist parse; everything else is dropped.

// Inline-level content (lives inside a block). `code` is verbatim text (no children).
export type RichInline =
  | { t: 'text'; text: string }
  | { t: 'strong'; children: RichInline[] }
  | { t: 'em'; children: RichInline[] }
  | { t: 'strike'; children: RichInline[] }
  | { t: 'code'; text: string } // inline code
  | { t: 'link'; href: string; children: RichInline[] }

// Block-level content. `ul`/`ol` items are themselves lists of blocks (a list item may hold
// paragraphs). `codeblock` is verbatim text with an optional language hint.
export type RichBlock =
  | { t: 'p'; children: RichInline[] }
  | { t: 'ul'; items: RichBlock[][] }
  | { t: 'ol'; items: RichBlock[][] }
  | { t: 'quote'; children: RichBlock[] }
  | { t: 'codeblock'; text: string; lang?: string }

// A rich document is a sequence of blocks.
export type RichDoc = RichBlock[]
