// Entry point do agente de custódia `cofre` (PLANO-CRIPTO-COBERTURA PR-3; ADR-057
// dec. 5). Wiring puro — a lógica de custódia vive em custody-loop.ts (portas + fakes
// nas units); aqui mora o que só a integração prova: SDK, shim de storage, sinais.
//
// ORDEM DE BOOT (crítica, achados S2.1/S2.3 — não reordenar):
//   1. config fail-closed (AGENT_STORAGE_KEY ausente/errada → o processo NÃO sobe);
//   2. chdir(AGENT_STORE_DIR) — o LevelDBManager do node-indexeddb resolve
//      `${cwd}/indexeddb` como singleton NO IMPORT (S2.3-notas);
//   3. whoami com o mct_ (ANTES de tocar o store): o deviceId do token é comparado ao
//      marcador local — divergência = store de um device morto → identity-reset;
//   4. dbManager.loadCache() ANTES do import de node-indexeddb/auto e do SDK;
//   5. initRustCrypto persistente e cifrado (storageKey — S2.1: sem ela o store nasce
//      em claro em disco).
//
// Shutdown (SIGTERM): parar sync → flushWrites() do Level → checkpoint → exit 0.
// SIGKILL com writes pendentes não foi medido (caveat S2.3) — risco aceito, §8.3.
//
// Logs: uma linha JSON por sinal (`evt`). room_id/session_id são operacionais e podem
// aparecer; MATERIAL de chave (session_key, storageKey, token) JAMAIS — a mesma
// disciplina do escrow.

import { readFile, rm, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk'
import { loadConfig, type AgentConfig } from './config.ts'
import { addressedOf } from './addressed.ts'
import { readCheckpoint, writeCheckpoint } from './checkpoint.ts'
import {
  custodyTick,
  newCustodyState,
  RoomGoneError,
  type CustodyPorts,
  type SessionExportEntry,
} from './custody-loop.ts'
import { joinTick, newJoinQueueState, type JoinOutcome, type JoinPorts } from './join-queue.ts'
import { escrowDepositor } from './escrow-client.ts'

const TICK_MS = 3_000
const CHECKPOINT_MS = 10_000
// Margem sobre o checkpoint na paginação do catch-up: o checkpoint é escrito a cada
// CHECKPOINT_MS, então o último instante vivo real pode ser até isso mais recente —
// 5 min de folga custa poucas páginas e nunca perde um nascimento.
const CHECKPOINT_MARGIN_MS = 5 * 60_000
// Teto de páginas por sala quando NÃO há checkpoint (primeiro boot com store virgem):
// busca limitada por construção, nunca varredura sem fim.
const MAX_BACKFILL_PAGES = 50
const SCROLLBACK_PAGE = 50

function log(line: Record<string, unknown>): void {
  console.log(JSON.stringify(line))
}

function fatal(line: Record<string, unknown>): never {
  log({ evt: 'fatal', ...line })
  process.exit(1)
}

// ── Identidade: marcador local do device/chaves (janela de perda observável, padrão F1) ──

interface IdentityMarker {
  deviceId: string
  ed25519: string
  curve25519: string
}

async function readMarker(file: string): Promise<IdentityMarker | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as IdentityMarker
    if (
      typeof parsed.deviceId === 'string' &&
      typeof parsed.ed25519 === 'string' &&
      typeof parsed.curve25519 === 'string'
    ) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value))
  await rename(tmp, file)
}

// ── REST mínimo (whoami/context) — retry de 429 no idioma do harness do repo ─────────

// O status viaja no erro: o `addressedAt` distingue 404/403 (sala inacessível, ADR-079)
// do resto sem ler a mensagem.
class HttpStatusError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function authedJson<T>(url: string, token: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (res.status === 429 && attempt < 10) {
      const retry = (await res.json().catch(() => ({}))) as { retry_after_ms?: number }
      await new Promise((r) => setTimeout(r, (retry.retry_after_ms ?? 500) + 100))
      continue
    }
    if (!res.ok) throw new HttpStatusError(`GET ${new URL(url).pathname} -> ${res.status}`, res.status)
    return (await res.json()) as T
  }
}

async function whoamiBounded(
  hsUrl: string,
  token: string,
): Promise<{ userId: string; deviceId: string }> {
  const deadline = Date.now() + 120_000
  let last = 'no attempt'
  while (Date.now() < deadline) {
    try {
      const r = await authedJson<{ user_id: string; device_id?: string }>(
        `${hsUrl}/_matrix/client/v3/account/whoami`,
        token,
      )
      if (r.device_id === undefined) throw new Error('whoami returned no device_id')
      return { userId: r.user_id, deviceId: r.device_id }
    } catch (err) {
      last = String(err)
      await new Promise((r) => setTimeout(r, 2_000))
    }
  }
  fatal({ stage: 'whoami', message: `homeserver/token não respondeu: ${last}` })
}

// ── Boot ─────────────────────────────────────────────────────────────────────────────

let config: AgentConfig
try {
  config = loadConfig(process.env)
} catch (err) {
  fatal({ stage: 'config', message: String(err) })
}

await mkdir(config.storeDir, { recursive: true })
// ANTES de qualquer import de node-indexeddb (singleton por cwd — S2.3).
process.chdir(config.storeDir)

// ── F8 (PR-3.1): remediação atômica mora no PROVISIONAMENTO, nunca aqui ─────────────
// O A1 (§8.4) mediu por que o agente não pode se auto-remediar: wipe local com token
// vivo renasce o MESMO device com identidade olm nova — device keys re-aceitas
// (mutáveis), upload de OTK 400 (contador zerado colide) e o servidor serve OTK morta
// com check_agent VERDE. A remediação correta é mint (device novo) + wipe JUNTOS, e só
// o ensure_agent_token do dev-stack tem o mint. O agente grava a sentinela e sai alto;
// o crash-loop do restart até a remediação é aceito e é ALTO de propósito (§8.5).
const sentinelFile = join(config.storeDir, 'REMEDIATION_NEEDED')

async function haltForRemediation(reason: string, message?: string): Promise<never> {
  log({ evt: 'identity-reset', reason, ...(message !== undefined ? { message } : {}) })
  await writeJsonAtomic(sentinelFile, { reason, ...(message !== undefined ? { message } : {}) })
  log({ evt: 'remediation-needed', reason })
  process.exit(1)
}

{
  const pending = await readFile(sentinelFile, 'utf8').catch(() => null)
  if (pending !== null) {
    // Sentinela de um boot anterior: NADA de rede nem de store — sai antes de
    // qualquer upload de chave (rodar meio-remediado é o que envenena o servidor).
    log({ evt: 'remediation-needed', sentinel: pending.trim() })
    process.exit(1)
  }
}

const token = (await readFile(config.tokenFile, 'utf8').catch(() => '')).trim()
if (token === '') fatal({ stage: 'token', message: `token vazio/ilegível em AGENT_TOKEN_FILE` })

const identity = await whoamiBounded(config.hsUrl, token)
log({ evt: 'whoami', userId: identity.userId, deviceId: identity.deviceId })

const markerFile = join(config.storeDir, 'identity.json')
const indexeddbDir = join(config.storeDir, 'indexeddb')
let marker = await readMarker(markerFile)
if (marker !== null && marker.deviceId !== identity.deviceId) {
  // Token novo = device novo (cada mint MAS cunha um device). O store pertence ao
  // device morto — segue com store virgem e a janela vira sinal, não silêncio.
  // Único wipe que SOBREVIVE ao F8: aqui o device JÁ é outro (o mint aconteceu), então
  // o renascimento não colide com contador de OTK nem re-usa identidade — é seguro.
  log({
    evt: 'identity-reset',
    reason: 'device-changed',
    previousDeviceId: marker.deviceId,
    deviceId: identity.deviceId,
  })
  await rm(indexeddbDir, { recursive: true, force: true })
  marker = null
}

// Ordem S2.3: loadCache → shim global → SDK.
const { default: dbManager } = await import('node-indexeddb/dbManager')
try {
  await dbManager.loadCache()
} catch (err) {
  // Level rasgado estoura AQUI, antes do initRustCrypto — mesma classe store-unusable,
  // mesmo desfecho F8 (sem esta guarda o processo morreria sem sentinela e o restart
  // re-tentaria para sempre sem sinal de remediação).
  await haltForRemediation('store-unusable', String(err))
}
await import('node-indexeddb/auto')
const sdk = await import('matrix-js-sdk')

const client: MatrixClient = sdk.createClient({
  baseUrl: config.hsUrl,
  userId: identity.userId,
  deviceId: identity.deviceId,
  accessToken: token,
})

try {
  await client.initRustCrypto({
    useIndexedDB: true,
    cryptoDatabasePrefix: 'tayet-cofre',
    storageKey: config.storageKey,
  })
} catch (err) {
  // Store inutilizável (corrupção, chave errada). F8: NUNCA apagar o store aqui —
  // o restart com store virgem e MESMO device é a receita do zumbi (A1). Sentinela
  // + exit; o provisionamento re-minta (device novo) e wipa JUNTOS.
  await haltForRemediation('store-unusable', String(err))
}

const crypto = client.getCrypto()
if (crypto === undefined) fatal({ stage: 'crypto', message: 'getCrypto() undefined pós-init' })

const ownKeys = await crypto.getOwnDeviceKeys()
if (marker !== null && (ownKeys.ed25519 !== marker.ed25519 || ownKeys.curve25519 !== marker.curve25519)) {
  // Mesmo device, chaves novas: o store foi recriado por baixo. Seguir rodando é o
  // MECANISMO do zumbi medido no A1 (upload de OTK 400 aborta o batch; o servidor
  // segue servindo OTKs da identidade morta) — F8: sentinela + exit, sem tocar nada.
  await haltForRemediation('keys-diverged')
}
await writeJsonAtomic(markerFile, {
  deviceId: identity.deviceId,
  ed25519: ownKeys.ed25519,
  curve25519: ownKeys.curve25519,
} satisfies IdentityMarker)
log({ evt: 'identity', deviceId: identity.deviceId, ed25519: ownKeys.ed25519 })

// ── Estado do loop: cache de depositadas (otimização; a verdade é o escrow) ───────────

const depositedFile = join(config.storeDir, 'deposited.json')
const depositedAtBoot = await readFile(depositedFile, 'utf8')
  .then((raw) => JSON.parse(raw) as string[])
  .catch(() => [] as string[])
const state = newCustodyState(depositedAtBoot)
let depositedDirty = false

const checkpointFile = join(config.storeDir, 'checkpoint.json')
const bootCheckpoint = await readCheckpoint(checkpointFile)
const backfillCutoffTs =
  bootCheckpoint === null ? null : bootCheckpoint.lastAliveTs - CHECKPOINT_MARGIN_MS
log({ evt: 'boot', checkpoint: bootCheckpoint?.lastAliveTs ?? null })

// ── Índice de timeline: sessionId → primeiro evento visto (menor origin_server_ts) ────

interface FirstEvent {
  eventId: string
  ts: number
}
const firstEvents = new Map<string, FirstEvent>()
const firstEventKey = (roomId: string, sessionId: string): string => `${roomId}\n${sessionId}`

function indexTimelines(): void {
  for (const room of client.getRooms()) {
    for (const ev of room.getLiveTimeline().getEvents()) {
      indexEvent(room.roomId, ev)
    }
  }
}

function indexEvent(roomId: string, ev: MatrixEvent): void {
  if (ev.getWireType() !== 'm.room.encrypted') return
  const wire = ev.getWireContent() as { algorithm?: unknown; session_id?: unknown }
  if (wire.algorithm !== 'm.megolm.v1.aes-sha2' || typeof wire.session_id !== 'string') return
  const eventId = ev.getId()
  if (eventId === undefined) return
  const key = firstEventKey(roomId, wire.session_id)
  const known = firstEvents.get(key)
  if (known === undefined || ev.getTs() < known.ts) {
    firstEvents.set(key, { eventId, ts: ev.getTs() })
  }
}

// ── Backfill (catch-up pós-downtime): paginar para trás ATÉ o checkpoint ─────────────

const backfillWanted = new Set<string>()
const backfillPages = new Map<string, number>()
const backfillExhausted = new Set<string>()

async function backfillStep(): Promise<void> {
  for (const roomId of backfillWanted) {
    if (backfillExhausted.has(roomId)) continue
    const room = client.getRoom(roomId)
    // Sala fora do alcance: o loop já pulou as sessões dela como `room-gone` (ADR-079).
    if (room === null || room.getMyMembership() !== 'join') continue
    const events = room.getLiveTimeline().getEvents()
    const oldestTs = events.length > 0 ? events[0]!.getTs() : null
    if (backfillCutoffTs !== null && oldestTs !== null && oldestTs <= backfillCutoffTs) {
      // Já cruzamos o último instante vivo: um nascimento de downtime estaria DEPOIS
      // deste ponto. Se a sessão segue sem primeiro evento aqui, o sinal fica no log.
      backfillExhausted.add(roomId)
      log({ evt: 'backfill-cutoff-reached', roomId, oldestTs })
      continue
    }
    const pages = backfillPages.get(roomId) ?? 0
    if (pages >= MAX_BACKFILL_PAGES) {
      backfillExhausted.add(roomId)
      log({ evt: 'backfill-page-cap', roomId, pages })
      continue
    }
    const before = events.length
    try {
      await client.scrollback(room, SCROLLBACK_PAGE)
    } catch (err) {
      log({ evt: 'backfill-error', roomId, message: String(err) })
      continue
    }
    backfillPages.set(roomId, pages + 1)
    const after = room.getLiveTimeline().getEvents().length
    if (after === before) {
      // Sem progresso = início da história da sala alcançado.
      backfillExhausted.add(roomId)
      log({ evt: 'backfill-history-start', roomId, pages: pages + 1 })
    }
  }
  backfillWanted.clear()
}

// ── Portas do loop de custódia ───────────────────────────────────────────────────────

const depositToEscrow = escrowDepositor(config.escrowUrl, token)

// ── Fila de joins (F2 join; A5 serializada/sem livelock, A6 sala morta — PR-3.1) ─────

const joinState = newJoinQueueState()

// Classificação do erro do SDK, no shape da tipagem viva (MatrixError.data carrega o
// corpo do erro Matrix — retry_after_ms no M_LIMIT_EXCEEDED; httpStatus é o status HTTP:
// agent/node_modules/matrix-js-sdk/lib/http-api/errors.d.ts:38-53).
//
// A6 (medido nesta fatia, sonda §0): sala convidada onde NENHUM membro local está
// `join` → o Synapse classifica o join como REMOTO e devolve 404 M_UNKNOWN "Can't join
// remote room because no servers that are in the room have been provided." — num
// servidor único esse join nunca completa. 404 é o discriminador (cobre também sala
// desconhecida/purgada: igualmente injoinável para sempre). O 429 do caminho remoto
// (rc_joins.remote) tem o MESMO errcode do local — indistinguível client-side — mas com
// a fila honrando retry_after um attempt eventualmente atravessa o limiter e recebe o
// 404 que decide.
function classifyJoinError(err: unknown): JoinOutcome {
  const e = err as {
    httpStatus?: unknown
    errcode?: unknown
    data?: { retry_after_ms?: unknown }
  }
  if (e.errcode === 'M_LIMIT_EXCEEDED') {
    const retry = e.data?.retry_after_ms
    return { kind: 'ratelimited', retryAfterMs: typeof retry === 'number' ? retry : null }
  }
  if (e.httpStatus === 404) return { kind: 'dead', message: String(err) }
  return { kind: 'error', message: String(err) }
}

const joinPorts: JoinPorts = {
  invitedRooms: () =>
    client
      .getRooms()
      .filter((room) => room.getMyMembership() === 'invite')
      .map((room) => room.roomId),
  async attemptJoin(roomId) {
    try {
      await client.joinRoom(roomId)
      return { kind: 'joined' }
    } catch (err) {
      return classifyJoinError(err)
    }
  },
  rejectInvite: async (roomId) => {
    await client.leave(roomId)
  },
  myMembership: (roomId) => client.getRoom(roomId)?.getMyMembership() ?? null,
  log,
  now: () => Date.now(),
}

// Custo do export no tick corrente (#248): o export é O(sessões) a cada tick — o candidato
// a tick lento num store acumulado. Medido aqui, no wiring, não no custody-loop.
interface ExportCost {
  ms: number
  sessions: number
}
let lastExport: ExportCost | null = null

const ports: CustodyPorts = {
  async exportSessions(): Promise<SessionExportEntry[]> {
    const start = Date.now()
    const entries = JSON.parse(await crypto.exportRoomKeysAsJson()) as SessionExportEntry[]
    lastExport = { ms: Date.now() - start, sessions: entries.length }
    return entries
  },
  firstEventOf(roomId, sessionId) {
    return firstEvents.get(firstEventKey(roomId, sessionId))?.eventId ?? null
  },
  async addressedAt(roomId, eventId) {
    // Estado NAQUELE evento (limit=0) — o snapshot do nascimento (F5/F7 opção C), que
    // é correto MESMO em catch-up: /context devolve o estado do passado, não o corrente.
    let data: { state?: unknown }
    try {
      data = await authedJson<{ state?: unknown }>(
        `${config.hsUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/context/${encodeURIComponent(eventId)}?limit=0`,
        token,
      )
    } catch (err) {
      // ADR-079 dec. 1: 404 (sala purgada) / 403 (cofre fora da sala) é terminal.
      if (err instanceof HttpStatusError && (err.status === 404 || err.status === 403)) {
        throw new RoomGoneError(err.message, err.status)
      }
      throw err
    }
    return addressedOf(data.state)
  },
  async deposit(entry, addressed) {
    const outcome = await depositToEscrow(entry, addressed)
    depositedDirty = true
    return outcome
  },
  needsBackfill(roomId, sessionId) {
    backfillWanted.add(roomId)
    void sessionId
  },
  roomDead: (roomId) => joinState.dead.has(roomId),
  roomAccess(roomId) {
    // ADR-079 dec. 2: só depois do sync a ausência da sala no SDK é informação.
    if (!syncHealthy) return 'unknown'
    const membership = client.getRoom(roomId)?.getMyMembership()
    return membership === 'join' || membership === 'invite' ? 'member' : 'gone'
  },
  log,
  now: () => Date.now(),
}

// ── Loop principal ───────────────────────────────────────────────────────────────────

let ticking = false
let lastCheckpointWrite = 0
let syncHealthy = false
let syncState: string | null = null
// #248: join com sync parado é o laço — o /join responde 200 e o SDK nunca vê a transição.
// Um sinal por queda (zera quando o sync volta), não um por tick.
let joinSkipLogged = false

async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  const tickStart = Date.now()
  lastExport = null
  try {
    if (syncHealthy) {
      joinSkipLogged = false
      await joinTick(joinPorts, joinState)
    } else if (!joinSkipLogged) {
      joinSkipLogged = true
      log({ evt: 'join-skipped-sync', state: syncState })
    }
    indexTimelines()
    await custodyTick(ports, state)
    await backfillStep()
    if (depositedDirty) {
      await writeJsonAtomic(depositedFile, [...state.deposited])
      depositedDirty = false
    }
    if (syncHealthy && Date.now() - lastCheckpointWrite >= CHECKPOINT_MS) {
      await writeCheckpoint(checkpointFile, { lastAliveTs: Date.now() })
      lastCheckpointWrite = Date.now()
    }
  } catch (err) {
    log({ evt: 'tick-error', message: String(err) })
  } finally {
    // Só o tick que estoura o intervalo é sinal; o gauge a cada tick seria ruído.
    const tickMs = Date.now() - tickStart
    if (tickMs > TICK_MS) {
      // O TS estreita para o `null` do início do tick; o export o reescreve durante o await.
      const cost = lastExport as ExportCost | null
      log({ evt: 'tick-slow', tickMs, exportMs: cost?.ms ?? null, sessions: cost?.sessions ?? null })
    }
    ticking = false
  }
}

client.on(sdk.ClientEvent.ToDeviceEvent, (ev: MatrixEvent) => {
  if (ev.getType() !== 'm.room_key') return
  const content: { room_id?: unknown; session_id?: unknown } = ev.getContent()
  log({
    evt: 'room-key-received',
    roomId: typeof content.room_id === 'string' ? content.room_id : null,
    sessionId: typeof content.session_id === 'string' ? content.session_id : null,
    sender: ev.getSender() ?? null,
  })
  void tick()
})

// Toda transição vira sinal (#248): o SDK passa por RECONNECTING num restart do homeserver
// sem nunca chegar a ERROR, e só o ERROR era logado — a queda ficava invisível.
client.on(sdk.ClientEvent.Sync, (next: string) => {
  syncHealthy = next === 'PREPARED' || next === 'SYNCING'
  if (next !== syncState) {
    log({ evt: 'sync-state', from: syncState, to: next })
    syncState = next
  }
})

// ── Shutdown ordenado (SIGTERM do compose; stop_grace_period cobre o flush) ──────────

// O intervalo nasce ANTES do startClient — tick com estado vazio é no-op barato, e o
// shutdown pode referenciá-lo sem janela de TDZ num SIGTERM precoce.
const interval = setInterval(() => void tick(), TICK_MS)
let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log({ evt: 'shutdown', signal })
  clearInterval(interval)
  client.stopClient()
  try {
    if (depositedDirty) await writeJsonAtomic(depositedFile, [...state.deposited])
    await dbManager.flushWrites()
    // Checkpoint só se o sync esteve saudável: last-alive = "vivo E sincronizando" —
    // avançá-lo com sync quebrado encolheria indevidamente a busca do catch-up.
    if (syncHealthy) await writeCheckpoint(checkpointFile, { lastAliveTs: Date.now() })
  } catch (err) {
    log({ evt: 'shutdown-error', message: String(err) })
    process.exit(1)
  }
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

await client.startClient({ initialSyncLimit: 30 })
log({ evt: 'started' })
