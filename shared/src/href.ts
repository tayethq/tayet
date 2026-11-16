// The one href predicate (PLANO-AGENTES §0.3.15 item 4; ADR-088 addendum 2026-11-09). Clean side: the
// parser (markdown.ts) and the translator (internal/rich-text.ts, reader and serializer) both use it.
//
// Only http(s)/mailto links survive; javascript:/data:/vbscript:/file: (and anything else) are refused.
// matrix.to is refused too (P1): a pill or a permalink from a Matrix client carries a protocol id in
// its URL, percent-encoded or not. The caller unwraps the link — the link text stays, the href goes.

const SCHEME = /^(https?:|mailto:)/i

function hostOf(href: string): string | undefined {
  try {
    return new URL(href).hostname
  } catch {
    // Unparseable but http(s)-shaped: take the authority by hand (userinfo and port dropped).
    const m = /^https?:[/\\]*([^/\\?#]*)/i.exec(href)
    return m ? m[1]!.replace(/^.*@/, '').replace(/:\d*$/, '') : undefined
  }
}

export function safeHref(href: string): boolean {
  const h = href.trim()
  if (!SCHEME.test(h)) return false
  if (/^mailto:/i.test(h)) return true
  const host = hostOf(h)?.toLowerCase().replace(/\.$/, '')
  return host !== 'matrix.to'
}
