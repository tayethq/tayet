import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'

// The editor's schema IS the P1 allowlist at the editing edge (PLANO-COMPOSER §2): only the
// nodes/marks the RichDoc (shared/src/domain/rich.ts, ADR-012) models are allowed to exist. We
// turn OFF everything the RichDoc does not model so an unmodeled node can never be authored.
//
// StarterKit 3.27.2 bundles more than the RichDoc allows: besides the structural extras we drop
// (heading, horizontalRule, hardBreak), it now ships a `link` mark AND an `underline` mark. The
// RichDoc has no underline → `underline: false`. It DOES model links, but we disable StarterKit's
// bundled `link` and add the standalone @tiptap/extension-link instead (single source, no
// duplicate-extension warning), configured to not navigate on click. The resulting schema is
// EXACTLY the RichDoc set: nodes {paragraph, blockquote, bulletList, orderedList, listItem,
// codeBlock, doc, text} and marks {bold, italic, strike, code, link} — mirroring
// p/quote/ul/ol/codeblock + strong/em/strike/code/link.
//
// Mention (atomic node, W3) is deferred to its own PR — out of scope here.
//
// Link (PR-4, ADR-051 §4): `protocols` is barrier 1b — the schema's OWN scheme allowlist. Only
// http/https/mailto marks may exist in the doc, so a dangerous scheme can never be authored even
// if barrier 1 (isSafeHref, the dialog gate) is bypassed; the ACL's outbound sanitizeHref is
// barrier 2. `autolink: false` keeps link creation explicit (via the dialog), never inferred from
// typed text. No `validate` (deprecated in 3.x — the scheme check rides `protocols`/isAllowedUri).
export const richExtensions = [
  StarterKit.configure({
    heading: false,
    horizontalRule: false,
    hardBreak: false,
    underline: false,
    link: false,
    // kept: bold, italic, strike, code, paragraph, text, document, bulletList, orderedList,
    // listItem, blockquote, codeBlock (mirror strong/em/strike/code/p/ul/ol/quote/codeblock).
  }),
  Link.configure({ openOnClick: false, protocols: ['http', 'https', 'mailto'], autolink: false }),
]
