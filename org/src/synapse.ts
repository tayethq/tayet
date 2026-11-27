// Cliente mínimo do Synapse para o provisionamento de pessoas (ADR-083): lê o alias e escreve o state
// de #all com o token de `system`. Client-API, rede interna; nada de admin API (ADR-054).

export interface OrgHomeserver {
  roomIdOfAlias(alias: string): Promise<string>
  // null quando o evento não existe.
  getState(token: string, roomId: string, type: string, stateKey: string): Promise<Record<string, unknown> | null>
  putState(token: string, roomId: string, type: string, stateKey: string, content: object): Promise<void>
  // Todo state event do tipo na sala (a colisão de nome de agente varre io.tayet.member, ADR-086 dec. 6).
  stateOfType(token: string, roomId: string, type: string): Promise<Array<{ stateKey: string; content: Record<string, unknown> }>>
  invite(token: string, roomId: string, mxid: string): Promise<void>
  // O displayname da conta do token (o rename de agente, ADR-086 dec. 7 escopada). O Synapse propaga
  // o nome para o evento de membro das salas em que a conta está.
  setDisplayName(token: string, mxid: string, name: string): Promise<void>
}

// `rc_message` de `system` é um balde só, compartilhado por todos os admins, e o ADR-054 veta o
// override_ratelimit no `up` (ADR-083, addendum): espera o retry_after, como o org_room_call dos
// provisionadores, porque tentativa rejeitada também conta. O teto vale por escrita e, com as duas
// escritas de um convite, cabe no TTL de 60 s da sessão.
const MAX_RATELIMIT_WAIT_MS = 20_000
const DEFAULT_RETRY_AFTER_MS = 5_000

export function homeserver(opts: {
  url: string
  timeoutMs?: number
  fetchFn?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}): OrgHomeserver {
  const fetchFn = opts.fetchFn ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? 5000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const base = `${opts.url.replace(/\/+$/, '')}/_matrix/client/v3`

  const stateUrl = (roomId: string, type: string, stateKey: string): string =>
    `${base}/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`

  async function write(method: 'PUT' | 'POST', url: string, token: string, body: object): Promise<void> {
    let waited = 0
    for (;;) {
      const res = await fetchFn(url, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.ok) return
      if (res.status !== 429) throw new Error(`synapse ${method}: ${res.status}`)
      const { retry_after_ms: retryAfter } = (await res.json()) as { retry_after_ms?: unknown }
      const ms = typeof retryAfter === 'number' ? retryAfter : DEFAULT_RETRY_AFTER_MS
      waited += ms
      if (waited > MAX_RATELIMIT_WAIT_MS) throw new Error('synapse: rate limited')
      await sleep(ms)
    }
  }

  return {
    async roomIdOfAlias(alias) {
      const res = await fetchFn(`${base}/directory/room/${encodeURIComponent(alias)}`, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`alias: ${res.status}`)
      return ((await res.json()) as { room_id: string }).room_id
    },

    async getState(token, roomId, type, stateKey) {
      const res = await fetchFn(stateUrl(roomId, type, stateKey), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`state: ${res.status}`)
      return (await res.json()) as Record<string, unknown>
    },

    async stateOfType(token, roomId, type) {
      const res = await fetchFn(`${base}/rooms/${encodeURIComponent(roomId)}/state`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`state: ${res.status}`)
      const events = (await res.json()) as Array<{ type?: unknown; state_key?: unknown; content?: unknown }>
      return events.flatMap((e) =>
        e.type === type && typeof e.state_key === 'string' && typeof e.content === 'object' && e.content !== null
          ? [{ stateKey: e.state_key, content: e.content as Record<string, unknown> }]
          : [],
      )
    },

    putState: (token, roomId, type, stateKey, content) =>
      write('PUT', stateUrl(roomId, type, stateKey), token, content),

    invite: (token, roomId, mxid) =>
      write('POST', `${base}/rooms/${encodeURIComponent(roomId)}/invite`, token, { user_id: mxid }),

    setDisplayName: (token, mxid, name) =>
      write('PUT', `${base}/profile/${encodeURIComponent(mxid)}/displayname`, token, { displayname: name }),
  }
}
