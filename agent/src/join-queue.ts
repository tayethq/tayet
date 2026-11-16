// A5/A6 (PLANO-CRIPTO-COBERTURA PR-3.1): fila de joins do auto-join (F2), serializada e
// sem livelock. Fatos medidos na PR-4 (§8.4) que fixam o desenho:
//   · o Ratelimiter do Synapse conta attempts REJEITADOS — retry cego (~2/s) escala o
//     próprio retry_after (87 s medidos) e trava a sala por horas; restart não cura;
//   · a fila starvava atrás das travadas — 6 salas novas sem attempt NENHUM enquanto
//     4 zumbis ciclavam.
// Daí os quatro invariantes deste módulo:
//   · UM join em voo por vez (serialização), mas NUNCA head-of-line: sala reagendada
//     sai da frente e a próxima elegível tenta no MESMO tick;
//   · 429 honra o retry_after_ms do servidor + margem — attempt rejeitado nunca é
//     re-martelado dentro da janela que o próprio servidor pediu;
//   · desistir ≠ atrasar: após N attempts a sala ganha sinal escalado `join-stalled`
//     e SEGUE em cadência baixa (abandonar join = abandonar cobertura — o depósito
//     exige o join, F2/F10). Só sala MORTA é desistida (A6): sem membro local `join`
//     o Synapse classifica o join como remoto e ele NUNCA completa num servidor único
//     — a desistência vira sinal `room-dead`, e as sessões dela são puladas no loop
//     de custódia (roomDead — material irrecuperável POR DESENHO);
//   · `joined` sem transição no SDK não re-enfileira: `/join` é idempotente no servidor
//     (200 sem evento novo, logo nenhum /sync corrige o `invite` local) e o laço de 26/Out
//     (#248, §8.60) rodava a cada tick. A sala espera a confirmação em `awaitingSync`;
//     sem ela até JOIN_CONFIRM_TIMEOUT_MS, sinal `join-unconfirmed` e cadência de stall.
//
// Puro de I/O por portas injetadas, como o custody-loop: a classificação do erro do
// SDK (429/404) fica no wiring (main.ts); as units provam a fila com fakes.

export type JoinOutcome =
  | { kind: 'joined' }
  | { kind: 'ratelimited'; retryAfterMs: number | null }
  | { kind: 'dead'; message: string }
  | { kind: 'error'; message: string }

export interface JoinPorts {
  // Salas onde a minha membership corrente é `invite` (fonte: sync do SDK).
  invitedRooms(): string[]
  // UM attempt de join, já classificado pelo wiring. Nunca rejeita.
  attemptJoin(roomId: string): Promise<JoinOutcome>
  // A6: rejeita o convite da sala morta (POST /leave — provado 200 mesmo sem membro
  // local `join`, sonda §0). Sem o reject o convite morto persiste no servidor: o set
  // `dead` é em memória, TODO restart re-enfileira o backlog inteiro e re-paga o
  // orçamento rc_joins.remote (0.01/s!) — acúmulo medido no fecho desta fatia, com a
  // sala morta NOVA starvada atrás de retry_after de ~90 s dos zumbis antigos.
  rejectInvite(roomId: string): Promise<void>
  // Membership corrente da sala no SDK (null = sala desconhecida) — a confirmação do join.
  myMembership(roomId: string): string | null
  log(line: Record<string, unknown>): void
  now(): number
}

export interface JoinQueueState {
  queue: Map<string, { attempts: number; nextAttemptTs: number }>
  // Salas desistidas (A6) — o loop de custódia consulta isto para pular as sessões.
  dead: Set<string>
  // Salas com `joined` cujo SDK ainda não saiu de `invite` — fora da fila até confirmar.
  awaitingSync: Map<string, { joinedAt: number }>
}

export function newJoinQueueState(): JoinQueueState {
  return { queue: new Map(), dead: new Set(), awaitingSync: new Map() }
}

// Margem sobre o retry_after_ms do servidor: o limiter conta attempts rejeitados, então
// chegar 1 ms cedo re-trava a sala — a margem compra a folga do relógio/rede.
export const JOIN_RETRY_MARGIN_MS = 1_000
// 429 sem retry_after_ms no corpo (não deveria acontecer no Synapse; defesa): espera fixa.
export const JOIN_DEFAULT_RETRY_MS = 5_000
// Sinal escalado após N attempts sem sucesso — a partir daí a cadência cai.
export const JOIN_STALL_ATTEMPTS = 8
export const JOIN_STALLED_CADENCE_MS = 5 * 60_000
// Espera máxima pela transição `invite` → outra no SDK depois de um `joined`.
export const JOIN_CONFIRM_TIMEOUT_MS = 5 * 60_000
const JOIN_BACKOFF_BASE_MS = 2_000
const JOIN_BACKOFF_MAX_MS = 60_000

export async function joinTick(ports: JoinPorts, state: JoinQueueState): Promise<void> {
  for (const [roomId, { joinedAt }] of state.awaitingSync) {
    if (ports.myMembership(roomId) !== 'invite') {
      state.awaitingSync.delete(roomId)
      continue
    }
    const waitedMs = ports.now() - joinedAt
    if (waitedMs < JOIN_CONFIRM_TIMEOUT_MS) continue
    // O servidor aceitou e o SDK nunca viu: re-tentar em 3 s é o laço. Volta à fila já na
    // contagem de stall — o próximo attempt só depois da cadência baixa.
    state.awaitingSync.delete(roomId)
    ports.log({ evt: 'join-unconfirmed', roomId, waitedMs })
    state.queue.set(roomId, {
      attempts: JOIN_STALL_ATTEMPTS,
      nextAttemptTs: ports.now() + JOIN_STALLED_CADENCE_MS,
    })
  }
  for (const roomId of ports.invitedRooms()) {
    if (!state.queue.has(roomId) && !state.dead.has(roomId) && !state.awaitingSync.has(roomId)) {
      state.queue.set(roomId, { attempts: 0, nextAttemptTs: 0 })
    }
  }
  for (const [roomId, entry] of state.queue) {
    if (ports.now() < entry.nextAttemptTs) continue
    // Serializado por construção: um await por vez, na ordem da fila. Sala reagendada
    // (nextAttemptTs futuro) é pulada pelo guard acima — zero head-of-line.
    const outcome = await ports.attemptJoin(roomId)
    entry.attempts += 1
    if (outcome.kind === 'joined') {
      state.queue.delete(roomId)
      state.awaitingSync.set(roomId, { joinedAt: ports.now() })
      ports.log({ evt: 'joined', roomId })
      continue
    }
    if (outcome.kind === 'dead') {
      state.queue.delete(roomId)
      state.dead.add(roomId)
      ports.log({ evt: 'room-dead', roomId, attempts: entry.attempts, message: outcome.message })
      try {
        await ports.rejectInvite(roomId)
        ports.log({ evt: 'invite-rejected', roomId })
      } catch (err) {
        // Best-effort: a sala já está em `dead` (este processo não re-tenta); num
        // restart o ciclo 404→reject re-tenta o descarte do convite.
        ports.log({ evt: 'invite-reject-failed', roomId, message: String(err) })
      }
      continue
    }
    let delayMs: number
    if (outcome.kind === 'ratelimited') {
      delayMs = (outcome.retryAfterMs ?? JOIN_DEFAULT_RETRY_MS) + JOIN_RETRY_MARGIN_MS
      ports.log({
        evt: 'join-ratelimited',
        roomId,
        attempt: entry.attempts,
        retryAfterMs: outcome.retryAfterMs,
      })
    } else {
      delayMs = Math.min(JOIN_BACKOFF_BASE_MS * 2 ** (entry.attempts - 1), JOIN_BACKOFF_MAX_MS)
      ports.log({ evt: 'join-error', roomId, attempt: entry.attempts, message: outcome.message })
    }
    if (entry.attempts >= JOIN_STALL_ATTEMPTS) {
      // Cadência baixa NUNCA encurta a janela pedida pelo servidor — max, não override.
      delayMs = Math.max(delayMs, JOIN_STALLED_CADENCE_MS)
      ports.log({ evt: 'join-stalled', roomId, attempts: entry.attempts, nextAttemptInMs: delayMs })
    }
    entry.nextAttemptTs = ports.now() + delayMs
  }
}
