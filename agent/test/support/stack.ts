import { execSync } from 'node:child_process'

// Harness de integração do agente contra a dev-stack REAL (Synapse + MAS + escrow +
// container do agente). Mesmo regime do gate do escrow: auto-skip sem a stack, usuários
// FRESCOS por run (register-user idempotente + mintToken mct_), nada de alice/bob (o
// gate irmão do escrow mata sessões e cruzaria asserts — §8.2). Helpers REST no idioma
// do client/test/support/synapse.ts (retry de 429; probe de ativação do token —
// issue #7 M2). Sem import cruzado de client/ ou escrow/: o invariante do repo é cada
// pacote autossuficiente (grep de CI), então o subconjunto necessário vive aqui.

export const HOMESERVER = process.env.TAYET_HS_URL ?? 'http://localhost:8008'
export const ESCROW_BASE = process.env.TAYET_ESCROW_URL ?? 'http://localhost:8090'
const MAS_CONTAINER = process.env.TAYET_MAS_CONTAINER ?? 'spike-mas-1'
const MAS_CONFIG = process.env.TAYET_MAS_CONFIG ?? '/config/config.yaml'
export const AGENT_CONTAINER = process.env.TAYET_AGENT_CONTAINER ?? 'spike-agent-1'
export const SERVER_NAME = 'tayet.local'
export const COFRE_USER_ID = `@cofre:${SERVER_NAME}`

// A stack do agente exige o container dele de pé além do trio Synapse/MAS/escrow — o
// gate stop/start (catch-up) manipula exatamente esse container.
export function stackUp(): boolean {
  try {
    execSync(`curl -sf -m 3 ${HOMESERVER}/_matrix/client/versions`, { stdio: 'ignore' })
    execSync(`docker exec ${MAS_CONTAINER} mas-cli --version`, { stdio: 'ignore' })
    execSync(`curl -sf -m 3 ${ESCROW_BASE}/healthz`, { stdio: 'ignore' })
    execSync(`docker inspect ${AGENT_CONTAINER}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// register-user tolera "User already exists" (idempotência entre runs).
export function registerUser(username: string, password: string): void {
  try {
    execSync(
      `docker exec ${MAS_CONTAINER} mas-cli manage register-user -c ${MAS_CONFIG} --yes --ignore-password-complexity --password ${password} ${username} 2>&1`,
      { encoding: 'utf8' },
    )
  } catch (err) {
    const out = String((err as { stdout?: unknown }).stdout ?? err)
    if (!out.includes('User already exists')) throw err
  }
}

// Probe de ativação (issue #7 M2): mct_ recém-cunhado pode dar M_UNKNOWN_TOKEN no
// primeiro uso — janela mint→visibilidade da introspecção delegada.
export async function probeTokenActive(token: string): Promise<void> {
  const start = Date.now()
  for (;;) {
    const res = await fetch(`${HOMESERVER}/_matrix/client/v3/account/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null)
    if (res?.status === 200) return
    if (Date.now() - start > 30_000) {
      throw new Error(`token-activation probe: não ativou (último ${res?.status ?? 'sem resposta'})`)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

export async function mintToken(username: string): Promise<string> {
  const out = execSync(
    `docker exec ${MAS_CONTAINER} mas-cli manage issue-compatibility-token -c ${MAS_CONFIG} ${username} 2>&1`,
    { encoding: 'utf8' },
  )
  const m = /mct_[A-Za-z0-9_]+/.exec(out)
  if (!m) throw new Error(`mint falhou para ${username}: ${out}`)
  await probeTokenActive(m[0])
  return m[0]
}

// REST 429-tolerante (idioma do synapse.ts do client).
export async function rest<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${HOMESERVER}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (res.status === 429 && attempt < 25) {
      const retry = (await res.clone().json().catch(() => ({}))) as { retry_after_ms?: number }
      await new Promise((r) => setTimeout(r, (retry.retry_after_ms ?? 500) + 100))
      continue
    }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`)
    return (await res.json()) as T
  }
}

export async function whoami(token: string): Promise<{ userId: string; deviceId: string }> {
  const r = await rest<{ user_id: string; device_id?: string }>(
    token,
    'GET',
    '/_matrix/client/v3/account/whoami',
  )
  if (r.device_id === undefined) throw new Error('whoami sem device_id')
  return { userId: r.user_id, deviceId: r.device_id }
}

// Sala cifrada em nível de protocolo, SIMULANDO a PR-4: preset private_chat (nasce com
// history_visibility shared — medido no spike C1), m.room.encryption no initial_state e
// o cofre convidado no ATO da criação (ADR-057 dec. 2/3).
export async function createEncryptedRoom(token: string, invite: string[]): Promise<string> {
  const r = await rest<{ room_id: string }>(token, 'POST', '/_matrix/client/v3/createRoom', {
    preset: 'private_chat',
    invite,
    initial_state: [
      { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    ],
  })
  return r.room_id
}

export async function inviteUser(token: string, roomId: string, userId: string): Promise<void> {
  await rest(token, 'POST', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
    user_id: userId,
  })
}

export async function joinRoom(token: string, roomId: string): Promise<void> {
  await rest(token, 'POST', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {})
}

export async function leaveRoom(token: string, roomId: string): Promise<void> {
  await rest(token, 'POST', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {})
}

export async function memberState(
  token: string,
  roomId: string,
  userId: string,
): Promise<string | null> {
  try {
    const r = await rest<{ membership?: string }>(
      token,
      'GET',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(userId)}`,
    )
    return r.membership ?? null
  } catch {
    return null
  }
}

// Wire content de um evento como o SERVIDOR o guarda — a fonte do session_id da msg.
export async function wireContent(
  token: string,
  roomId: string,
  eventId: string,
): Promise<Record<string, unknown>> {
  const r = await rest<{ content: Record<string, unknown> }>(
    token,
    'GET',
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
  )
  return r.content
}

// Retrieve da custódia (GET /v1/sessions do escrow) — devolve só os session_id, o que
// os asserts de endereçamento comparam.
export async function retrieveSessionIds(token: string): Promise<string[]> {
  const res = await fetch(`${ESCROW_BASE}/v1/sessions`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status !== 200) throw new Error(`retrieve -> ${res.status}`)
  const { sessions } = (await res.json()) as { sessions: Array<{ session_id?: string }> }
  return sessions.map((s) => s.session_id ?? '')
}

export async function until<T>(
  probe: () => Promise<T | null> | T | null,
  what: string,
  timeoutMs = 90_000,
  intervalMs = 1_000,
): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await probe()
    if (value !== null) return value
    if (Date.now() - start > timeoutMs) throw new Error(`timeout esperando: ${what}`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

export function agentLogs(): string {
  return execSync(`docker logs ${AGENT_CONTAINER} 2>&1`, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}

export function agentSignals(): Array<Record<string, unknown>> {
  return agentLogs()
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>]
      } catch {
        return []
      }
    })
}

export function stopAgent(): void {
  execSync(`docker stop ${AGENT_CONTAINER}`, { stdio: 'ignore' })
}

export function startAgent(): void {
  execSync(`docker start ${AGENT_CONTAINER}`, { stdio: 'ignore' })
}

// ── F8 (PR-3.1): manipulação do volume de dados do agente ────────────────────────────
// agentdata é volume nomeado (sem bind no host): shell efêmero com a MESMA imagem
// pinada do serviço (via inspect do container — zero digest duplicado no harness).

const AGENT_VOLUME = process.env.TAYET_AGENT_VOLUME ?? 'spike_agentdata'

function agentDataSh(cmd: string): string {
  const image = execSync(`docker inspect ${AGENT_CONTAINER} --format '{{.Image}}'`, {
    encoding: 'utf8',
  }).trim()
  return execSync(`docker run --rm -v ${AGENT_VOLUME}:/data ${image} sh -c '${cmd}'`, {
    encoding: 'utf8',
  })
}

// Corrompe o crypto store (garble de todos os arquivos do Level) — a simulação de
// store-unusable do F8. Rodar SEMPRE com o agente parado.
export function corruptAgentStore(): void {
  agentDataSh(
    'for f in $(find /data/indexeddb -type f); do head -c 64 /dev/urandom > "$f"; done',
  )
}

export function readAgentSentinel(): string {
  return agentDataSh('cat /data/REMEDIATION_NEEDED 2>/dev/null || true').trim()
}

// A remediação atômica VIVE no provisionamento (ensure_agent_token) — o gate a exercita
// pelo caminho real: o próprio `dev-stack.sh up`, idempotente com a stack de pé.
export function runDevStackUp(): string {
  const script = new URL('../../../infra/dev-stack/dev-stack.sh', import.meta.url).pathname
  return execSync(`${script} up`, { encoding: 'utf8', timeout: 300_000 })
}
