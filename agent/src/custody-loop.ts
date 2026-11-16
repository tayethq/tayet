// O coração do agente (F5 + F7 opção C): loop export-diff. A FONTE de sessões pendentes
// é o próprio crypto store (`exportRoomKeysAsJson`) — que persiste (F4), logo o diff
// sobrevive a restart sem estado auxiliar. Cada tick:
//
//   export → para cada sessão ainda não tratada:
//     · índice inicial > 0 ou indecodificável → PULA com sinal (sessão recebida
//       mid-ratchet — sala anterior à entrada do cofre, ADR-057 dec. 2: a cobertura
//       começa na primeira sessão pós-entrada);
//     · primeiro evento da sessão ainda desconhecido → DEFERE o depósito e pede
//       backfill (o snapshot de endereçados é o estado NO PRIMEIRO evento — sem ele
//       não há o que snapshotar; depositar com estado corrente quebraria a opção C);
//     · GET /context no primeiro evento → endereçados do NASCIMENTO → PUT no escrow.
//       `exists` (200) é sucesso idempotente — a VERDADE é a idempotência do escrow;
//       o set `deposited` local é otimização (perdê-lo só gera redepósitos exists).
//     · falha de rede/5xx/escrow → retry com backoff exponencial, NUNCA descarta: a
//       sessão fica pendente até o escrow aceitar;
//     · sala inacessível (404/403 no /context, ou sala fora do alcance do SDK após o
//       sync) → PULA com sinal `room-gone` (ADR-079): sem /context não há nascimento.
//
// Puro de I/O por portas injetadas — as units provam o loop com fakes no idioma do repo.

import { firstKnownIndexOf } from './megolm-index.ts'

// Entry do exportRoomKeysAsJson (shape provado no spike C2). Campos extras da entry
// (sender_key, m.shared_history, …) viajam intactos DENTRO de `session` no depósito.
export interface SessionExportEntry {
  room_id: string
  session_id: string
  session_key: string
  [key: string]: unknown
}

// ADR-079 dec. 1: o wiring do `addressedAt` lança este erro quando o /context responde
// 404/403 (sala purgada, cofre fora dela). Terminal para a sessão — nunca retry.
export class RoomGoneError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'RoomGoneError'
    this.status = status
  }
}

export interface CustodyPorts {
  exportSessions(): Promise<SessionExportEntry[]>
  // Primeiro evento CONHECIDO da sessão (menor origin_server_ts observado na timeline);
  // null enquanto nenhum evento dela foi visto — o gatilho do deferral.
  firstEventOf(roomId: string, sessionId: string): string | null
  // Estado da sala NAQUELE evento (GET /context?limit=0) já reduzido a localparts.
  addressedAt(roomId: string, eventId: string): Promise<string[]>
  deposit(entry: SessionExportEntry, addressed: string[]): Promise<'created' | 'exists'>
  // Sinaliza ao dono da timeline que a sessão precisa de paginação para trás (catch-up).
  needsBackfill(roomId: string, sessionId: string): void
  // Sala desistida pela fila de joins (A6, PR-3.1): sem join não há /context nem
  // snapshot — as sessões dela são irrecuperáveis POR DESENHO e saem da pendência
  // como puladas, nunca como silêncio.
  roomDead(roomId: string): boolean
  // ADR-079 dec. 2: a sala está ao alcance do SDK? `unknown` enquanto o sync não está
  // saudável (ausência antes do sync não prova nada); `gone` = sem `join` nem `invite`.
  roomAccess(roomId: string): 'member' | 'gone' | 'unknown'
  log(line: Record<string, unknown>): void
  now(): number
}

export interface CustodyState {
  deposited: Set<string>
  skipped: Set<string>
  failures: Map<string, { count: number; nextAttemptTs: number }>
  // A2 (PR-3.1): first-seen por sessão pendente — alimenta o gauge `pending-sessions`.
  // Em memória de propósito: restart re-observa e zera a idade (registrado no §8.5).
  firstSeen: Map<string, number>
  lastGaugeTs: number
}

export function newCustodyState(deposited: Iterable<string> = []): CustodyState {
  return {
    deposited: new Set(deposited),
    skipped: new Set(),
    failures: new Map(),
    firstSeen: new Map(),
    lastGaugeTs: 0,
  }
}

const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 60_000
// A2: cadência do gauge de pendências. Zero pendências = silêncio (o gauge some).
export const PENDING_GAUGE_INTERVAL_MS = 60_000

export async function custodyTick(ports: CustodyPorts, state: CustodyState): Promise<void> {
  const skipRoomGone = (entry: SessionExportEntry, extra: Record<string, unknown> = {}): void => {
    // ADR-079: sala inacessível — pulo terminal com sinal, no molde do `room-dead`. Em
    // memória: um restart re-avalia e re-emite uma vez, por desenho (dec. 4).
    state.skipped.add(entry.session_id)
    state.failures.delete(entry.session_id)
    ports.log({
      evt: 'session-skipped',
      reason: 'room-gone',
      roomId: entry.room_id,
      sessionId: entry.session_id,
      skippedTotal: state.skipped.size,
      ...extra,
    })
  }

  const entries = await ports.exportSessions()
  for (const entry of entries) {
    const sessionId = entry.session_id
    if (state.deposited.has(sessionId) || state.skipped.has(sessionId)) continue

    if (ports.roomDead(entry.room_id)) {
      // A6: a sala nunca será joinada — sem /context não há snapshot de nascimento, e
      // sala que todos abandonaram não terá mensagens novas. Pulo terminal com sinal.
      state.skipped.add(sessionId)
      ports.log({
        evt: 'session-skipped',
        reason: 'room-dead',
        roomId: entry.room_id,
        sessionId,
        skippedTotal: state.skipped.size,
      })
      continue
    }

    const index = firstKnownIndexOf(entry.session_key)
    if (index === null || index > 0) {
      state.skipped.add(sessionId)
      ports.log({
        evt: 'session-skipped',
        roomId: entry.room_id,
        sessionId,
        firstKnownIndex: index,
        skippedTotal: state.skipped.size,
      })
      continue
    }

    const failure = state.failures.get(sessionId)
    if (failure !== undefined && ports.now() < failure.nextAttemptTs) continue

    const firstEvent = ports.firstEventOf(entry.room_id, sessionId)
    if (firstEvent === null) {
      // Sem primeiro evento E sem a sala no SDK pós-sync: o backfill não teria onde
      // paginar — pendência muda para sempre (#254). Pula com sinal.
      if (ports.roomAccess(entry.room_id) === 'gone') {
        skipRoomGone(entry)
        continue
      }
      ports.needsBackfill(entry.room_id, sessionId)
      continue
    }

    try {
      const addressed = await ports.addressedAt(entry.room_id, firstEvent)
      if (addressed.length === 0) {
        // Estado sem nenhum membro join/invite não é um nascimento válido — trata como
        // falha transitória (retry), nunca como depósito vazio (o escrow o rejeitaria).
        throw new Error('empty addressed set')
      }
      const outcome = await ports.deposit(entry, addressed)
      state.deposited.add(sessionId)
      state.failures.delete(sessionId)
      ports.log({
        evt: 'session-deposited',
        roomId: entry.room_id,
        sessionId,
        firstEvent,
        outcome,
        addressedCount: addressed.length,
      })
    } catch (err) {
      if (err instanceof RoomGoneError) {
        skipRoomGone(entry, { firstEvent, status: err.status })
        continue
      }
      const count = (failure?.count ?? 0) + 1
      const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** (count - 1), BACKOFF_MAX_MS)
      state.failures.set(sessionId, { count, nextAttemptTs: ports.now() + backoffMs })
      ports.log({
        evt: 'deposit-retry',
        roomId: entry.room_id,
        sessionId,
        attempt: count,
        backoffMs,
        message: String(err),
      })
    }
  }

  // ── A2 (PR-3.1): gauge de pendências ─────────────────────────────────────────────
  // Pendente = exportada, não-depositada, não-pulada. O sinal one-shot
  // (`backfill-cutoff-reached`) sai uma vez e vira silêncio; o gauge re-emite a cada
  // ~60 s ENQUANTO houver pendência — pendência permanente nunca fica muda (A2).
  const now = ports.now()
  const pending = entries.filter(
    (e) => !state.deposited.has(e.session_id) && !state.skipped.has(e.session_id),
  )
  const pendingIds = new Set(pending.map((e) => e.session_id))
  for (const e of pending) {
    if (!state.firstSeen.has(e.session_id)) state.firstSeen.set(e.session_id, now)
  }
  for (const id of state.firstSeen.keys()) {
    if (!pendingIds.has(id)) state.firstSeen.delete(id)
  }
  if (pending.length > 0 && now - state.lastGaugeTs >= PENDING_GAUGE_INTERVAL_MS) {
    const oldestTs = Math.min(...pending.map((e) => state.firstSeen.get(e.session_id)!))
    ports.log({ evt: 'pending-sessions', count: pending.length, oldestAgeMs: now - oldestTs })
    state.lastGaugeTs = now
  }
}
