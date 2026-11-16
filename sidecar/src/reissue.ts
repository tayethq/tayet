// Self-reissue (ADR-087 dec. 9, addendum S-h; PLANO-AGENTES §0.3.14): `POST <account>/v1/agents/<self>/reissue`
// with the agent's own token and an empty body. ONE attempt — never fetchSettled: the escrow kills the
// calling token before it mints (kill→mint), so a retry after a lost answer would be refused anyway,
// and a retry after a 429 would only meet the same limit. What comes back is classified; the caller
// maps each kind to an exit (boot.ts). The error never carries the path, the mxid or the body: the
// escrow's answer is read only for `token`, `deviceId`, `error` and `step`, and nothing of it is logged
// here.

export type ReissueOutcome =
  | { kind: 'ok'; token: string; deviceId: string }
  | { kind: 'too-soon' }
  // 502 { error: 'partial', step }: `session` = the kill failed (the token may still live); `mint` /
  // `sweep` = the old token is dead and nothing usable was handed out.
  | { kind: 'partial'; step: 'session' | 'mint' | 'sweep' }
  | { kind: 'refused'; status: number }
  | { kind: 'not-found'; status: number }
  | { kind: 'not-agent'; status: number }
  // Anything else definitive (another status, an unreadable 201): treated as the network case.
  | { kind: 'unexpected'; status: number }
  | { kind: 'network' }

export interface ReissueOptions {
  fetch?: typeof fetch
  timeoutMs?: number
}

const STEPS = new Set(['session', 'mint', 'sweep'])

export async function selfReissue(account: string, userId: string, token: string, opts: ReissueOptions = {}): Promise<ReissueOutcome> {
  const doFetch = opts.fetch ?? fetch
  let res: Response
  try {
    res = await doFetch(`${account}/v1/agents/${encodeURIComponent(userId)}/reissue`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    })
  } catch {
    return { kind: 'network' }
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  const field = (name: string): unknown => (body !== null && typeof body === 'object' ? body[name] : undefined)
  if (res.status === 201) {
    const next = field('token')
    const deviceId = field('deviceId')
    if (typeof next === 'string' && next.length > 0 && typeof deviceId === 'string' && deviceId.length > 0) {
      return { kind: 'ok', token: next, deviceId }
    }
    return { kind: 'unexpected', status: res.status }
  }
  if (res.status === 429 && field('error') === 'reissue_too_soon') return { kind: 'too-soon' }
  if (res.status === 502 && field('error') === 'partial') {
    const step = field('step')
    if (typeof step === 'string' && STEPS.has(step)) return { kind: 'partial', step: step as 'session' | 'mint' | 'sweep' }
  }
  if (res.status === 401 || res.status === 403) return { kind: 'refused', status: res.status }
  if (res.status === 404) return { kind: 'not-found', status: res.status }
  if (res.status === 400 && field('error') === 'not_agent') return { kind: 'not-agent', status: res.status }
  return { kind: 'unexpected', status: res.status }
}
