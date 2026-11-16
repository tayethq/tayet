// In-memory fake of the escrow service (PLANO-FASE-2-ESCROW-C2 §0.2 item 4 — fork 2 option C):
// implements the ADR-017 contract (identity from the token, write-once, 401 indistinguishable)
// as a fetch-compatible function, so the unit regime never opens a port. The integration gate
// uses the REAL service spawned by the C1 harness — two regimes, the slices' usual pattern.
//
// The audit trail mirrors the real service's (§3.6) closely enough for the asserts that C2's
// units need: verb/outcome/sub per authenticated access, append-only.

export interface EscrowFakeAuditEntry {
  sub?: string
  verb: 'put' | 'get' | 'rotate' | 'retrieve-sessions'
  outcome: 'created' | 'ok' | 'conflict' | 'not_found' | 'unauthorized' | 'rotated' | 'stale' | 'missing_precondition'
}

export interface EscrowFake {
  // Drop-in for EscrowClientOpts.fetchFn.
  fetch: typeof fetch
  audit: EscrowFakeAuditEntry[]
  // Simulated outages: 'down' throws (network failure); 'error' answers 500.
  mode: 'ok' | 'down' | 'error'
  // Direct store access for assertions (sub → base64 as deposited).
  secrets: Map<string, string>
  // Custódia de sessão (PR-5): entries servidas a QUALQUER GET /v1/sessions autenticado. O fake
  // não modela endereçamento (isso é contrato do serviço, unit-testado no escrow/) — os units
  // do client controlam o conteúdo e provam o que o CLIENT faz com ele.
  sessionEntries: unknown[]
}

// tokens: bearer token → stable subject. Tokens outside the map → 401 (invalid/expired/revoked
// are indistinguishable, like the real introspection).
export function createEscrowFake(tokens: Record<string, string>): EscrowFake {
  const fake: EscrowFake = {
    mode: 'ok',
    audit: [],
    secrets: new Map(),
    sessionEntries: [],
    fetch: undefined as unknown as typeof fetch,
  }

  // Per-sub version tag (D1 §2.2 / PF-3): the service emits an ETag on PUT/GET and a NEW one on
  // every rotate; the fake mirrors that with a monotonic opaque tag so the rotate CAS is testable
  // without a port. We never reproduce the service's hex — only the contract (distinct on write).
  const etags = new Map<string, string>()
  let etagSeq = 0
  const bumpEtag = (sub: string): string => {
    const tag = `etag-${++etagSeq}`
    etags.set(sub, tag)
    return tag
  }
  const withEtag = (status: number, body: BodyInit | null, etag: string): Response =>
    new Response(body, { status, headers: { ETag: etag } })

  fake.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (fake.mode === 'down') throw new TypeError('fetch failed')
    if (fake.mode === 'error') return new Response(JSON.stringify({ error: 'internal' }), { status: 500 })

    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    const isSecret = url.endsWith('/v1/secret') && (method === 'PUT' || method === 'GET')
    const isRotate = url.endsWith('/v1/secret/rotate') && method === 'POST'
    const isSessions = url.endsWith('/v1/sessions') && method === 'GET'
    if (!isSecret && !isRotate && !isSessions) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
    }

    const headers = new Headers(init?.headers)
    const bearer = /^Bearer (.+)$/.exec(headers.get('authorization') ?? '')?.[1]
    const sub = bearer !== undefined ? tokens[bearer] : undefined
    const verb = isSessions ? 'retrieve-sessions' : isRotate ? 'rotate' : method === 'PUT' ? 'put' : 'get'
    if (sub === undefined) {
      fake.audit.push({ verb, outcome: 'unauthorized' })
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
    }

    if (verb === 'retrieve-sessions') {
      // Zero matches = 200 com array vazio (desfecho NORMAL, não 404) — contrato do serviço.
      fake.audit.push({ sub, verb, outcome: 'ok' })
      return new Response(JSON.stringify({ sessions: fake.sessionEntries }), { status: 200 })
    }

    if (verb === 'put') {
      const secret = parseSecret(init?.body)
      if (secret === undefined) {
        return new Response(JSON.stringify({ error: 'bad_request' }), { status: 400 })
      }
      if (fake.secrets.has(sub)) {
        fake.audit.push({ sub, verb, outcome: 'conflict' })
        return new Response(JSON.stringify({ error: 'conflict' }), { status: 409 })
      }
      fake.secrets.set(sub, secret)
      fake.audit.push({ sub, verb, outcome: 'created' })
      return withEtag(201, null, bumpEtag(sub))
    }

    if (verb === 'rotate') {
      // Guard order mirrors the service (D1 §3.3): If-Match present → body valid → exists → CAS.
      const ifMatch = headers.get('if-match')
      if (ifMatch === null || ifMatch === '') {
        fake.audit.push({ sub, verb, outcome: 'missing_precondition' })
        return new Response(JSON.stringify({ error: 'precondition_required' }), { status: 428 })
      }
      const secret = parseSecret(init?.body)
      if (secret === undefined) {
        return new Response(JSON.stringify({ error: 'bad_request' }), { status: 400 })
      }
      if (!fake.secrets.has(sub)) {
        // Rotate NEVER creates (D1 §0.2.4): creation is PUT.
        fake.audit.push({ sub, verb, outcome: 'not_found' })
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
      }
      if (etags.get(sub) !== ifMatch) {
        fake.audit.push({ sub, verb, outcome: 'stale' })
        return new Response(JSON.stringify({ error: 'precondition_failed' }), { status: 412 })
      }
      fake.secrets.set(sub, secret)
      fake.audit.push({ sub, verb, outcome: 'rotated' })
      return withEtag(200, JSON.stringify({ rotated: true }), bumpEtag(sub))
    }

    const existing = fake.secrets.get(sub)
    if (existing === undefined) {
      fake.audit.push({ sub, verb, outcome: 'not_found' })
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
    }
    fake.audit.push({ sub, verb, outcome: 'ok' })
    return withEtag(200, JSON.stringify({ secret: existing }), etags.get(sub) ?? bumpEtag(sub))
  }) as typeof fetch

  return fake
}

// Base64 secret from a request body, or undefined if malformed/empty (the 400 of PUT and rotate).
function parseSecret(body: BodyInit | null | undefined): string | undefined {
  let secret: unknown
  try {
    secret = (JSON.parse(String(body)) as { secret?: unknown }).secret
  } catch {
    /* malformed */
  }
  return typeof secret === 'string' && secret !== '' ? secret : undefined
}
