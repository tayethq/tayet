import { describe, it, expect } from 'vitest'
import {
  joinTick,
  newJoinQueueState,
  JOIN_CONFIRM_TIMEOUT_MS,
  JOIN_RETRY_MARGIN_MS,
  JOIN_STALL_ATTEMPTS,
  JOIN_STALLED_CADENCE_MS,
  type JoinOutcome,
  type JoinPorts,
} from '../../src/join-queue.ts'

// A fila de joins (A5/A6) com fakes no idioma do repo. Os invariantes provados são os
// da espec da PR-3.1: reagendamento por retry_after_ms (o limiter conta attempts
// rejeitados — chegar cedo re-trava), rotação sem head-of-line (sala travada nunca
// starva as demais), join-stalled com contagem (desistir ≠ atrasar) e sala morta
// desistida com sinal (A6 — só ela sai da fila sem join).

interface Fake {
  ports: JoinPorts
  invited: string[]
  attempts: string[]
  rejects: string[]
  logs: Array<Record<string, unknown>>
  outcomes: Map<string, () => JoinOutcome>
  rejectOutcome: () => Promise<void>
  clock: { now: number }
  inFlight: { current: number; max: number }
}

function fakePorts(invited: string[] = []): Fake {
  const fake: Fake = {
    invited,
    attempts: [],
    rejects: [],
    logs: [],
    outcomes: new Map(),
    rejectOutcome: () => Promise.resolve(),
    clock: { now: 1_000 },
    inFlight: { current: 0, max: 0 },
    ports: {
      invitedRooms: () => fake.invited,
      attemptJoin: async (roomId) => {
        fake.inFlight.current += 1
        fake.inFlight.max = Math.max(fake.inFlight.max, fake.inFlight.current)
        // Um turno de microtask real: se a fila disparasse dois joins em paralelo,
        // inFlight.max flagraria.
        await Promise.resolve()
        fake.attempts.push(roomId)
        fake.inFlight.current -= 1
        return (fake.outcomes.get(roomId) ?? (() => ({ kind: 'joined' }) as const))()
      },
      rejectInvite: (roomId) => {
        const result = fake.rejectOutcome()
        return result.then(() => {
          fake.rejects.push(roomId)
        })
      },
      // Mesma fonte do invitedRooms no wiring (o sync do SDK): convidada = `invite`.
      myMembership: (roomId) => (fake.invited.includes(roomId) ? 'invite' : 'join'),
      log: (line) => {
        fake.logs.push(line)
      },
      now: () => fake.clock.now,
    },
  }
  return fake
}

describe('join-queue — A5: reagendamento por retry_after_ms', () => {
  it('429 honra retry_after_ms + margem: dentro da janela não tenta, depois tenta e joina', async () => {
    const fake = fakePorts(['!a:hs'])
    let limited = true
    fake.outcomes.set('!a:hs', () =>
      limited ? { kind: 'ratelimited', retryAfterMs: 87_000 } : { kind: 'joined' },
    )
    const state = newJoinQueueState()

    await joinTick(fake.ports, state)
    expect(fake.attempts).toEqual(['!a:hs'])
    expect(fake.logs.find((l) => l.evt === 'join-ratelimited')).toMatchObject({
      roomId: '!a:hs',
      retryAfterMs: 87_000,
    })
    expect(state.queue.get('!a:hs')!.nextAttemptTs).toBe(1_000 + 87_000 + JOIN_RETRY_MARGIN_MS)

    // Um segundo antes da janela: NENHUM attempt novo (attempt rejeitado re-travaria).
    limited = false
    fake.clock.now = 1_000 + 87_000
    await joinTick(fake.ports, state)
    expect(fake.attempts).toEqual(['!a:hs'])

    // Janela + margem vencidas: tenta e joina.
    fake.clock.now = 1_000 + 87_000 + JOIN_RETRY_MARGIN_MS
    await joinTick(fake.ports, state)
    expect(fake.attempts).toEqual(['!a:hs', '!a:hs'])
    expect(state.queue.has('!a:hs')).toBe(false)
    expect(fake.logs.find((l) => l.evt === 'joined')).toMatchObject({ roomId: '!a:hs' })
  })

  it('joins são serializados: nunca dois attempts em voo ao mesmo tempo', async () => {
    const fake = fakePorts(['!a:hs', '!b:hs', '!c:hs'])
    const state = newJoinQueueState()
    await joinTick(fake.ports, state)
    expect(fake.attempts).toEqual(['!a:hs', '!b:hs', '!c:hs'])
    expect(fake.inFlight.max).toBe(1)
  })
})

describe('join-queue — A5: rotação sem head-of-line', () => {
  it('sala travada em 429 não starva as demais: as outras joinam no MESMO tick', async () => {
    const fake = fakePorts(['!travada:hs', '!nova1:hs', '!nova2:hs'])
    fake.outcomes.set('!travada:hs', () => ({ kind: 'ratelimited', retryAfterMs: 87_000 }))
    const state = newJoinQueueState()

    await joinTick(fake.ports, state)
    // A travada tentou primeiro (ordem da fila) e NÃO bloqueou a passagem das novas.
    expect(fake.attempts).toEqual(['!travada:hs', '!nova1:hs', '!nova2:hs'])
    expect(state.queue.has('!nova1:hs')).toBe(false)
    expect(state.queue.has('!nova2:hs')).toBe(false)

    // Ticks seguintes: a travada segue reagendada (zero attempts) e não custa nada.
    fake.invited = ['!travada:hs']
    fake.clock.now += 3_000
    await joinTick(fake.ports, state)
    expect(fake.attempts).toHaveLength(3)
  })
})

describe('join-queue — A5: join-stalled (desistir ≠ atrasar)', () => {
  it('após N attempts o sinal escala com contagem e a cadência cai — mas segue tentando', async () => {
    const fake = fakePorts(['!dificil:hs'])
    fake.outcomes.set('!dificil:hs', () => ({ kind: 'error', message: 'HTTP 500' }))
    const state = newJoinQueueState()

    for (let i = 0; i < JOIN_STALL_ATTEMPTS + 2; i++) {
      fake.clock.now = state.queue.get('!dificil:hs')?.nextAttemptTs ?? fake.clock.now
      await joinTick(fake.ports, state)
    }
    const stalled = fake.logs.filter((l) => l.evt === 'join-stalled')
    expect(stalled.length).toBe(3) // attempts 8, 9 e 10
    expect(stalled[0]).toMatchObject({ roomId: '!dificil:hs', attempts: JOIN_STALL_ATTEMPTS })
    // Cadência baixa: o reagendamento pós-stall nunca é menor que a cadência.
    const entry = state.queue.get('!dificil:hs')!
    expect(entry.nextAttemptTs - fake.clock.now).toBeGreaterThanOrEqual(JOIN_STALLED_CADENCE_MS)
    // Nunca desiste: a sala segue na fila (só o A6 desiste).
    expect(state.queue.has('!dificil:hs')).toBe(true)
    expect(state.dead.size).toBe(0)
  })

  it('cadência baixa não encurta a janela do servidor: max(retry_after, cadência)', async () => {
    const fake = fakePorts(['!lenta:hs'])
    const bigRetry = JOIN_STALLED_CADENCE_MS * 2
    fake.outcomes.set('!lenta:hs', () => ({ kind: 'ratelimited', retryAfterMs: bigRetry }))
    const state = newJoinQueueState()
    for (let i = 0; i < JOIN_STALL_ATTEMPTS; i++) {
      fake.clock.now = state.queue.get('!lenta:hs')?.nextAttemptTs ?? fake.clock.now
      await joinTick(fake.ports, state)
    }
    // 8º attempt é stalled — e o reagendamento segue honrando o retry_after MAIOR.
    expect(fake.logs.filter((l) => l.evt === 'join-stalled')).toHaveLength(1)
    expect(state.queue.get('!lenta:hs')!.nextAttemptTs - fake.clock.now).toBe(
      bigRetry + JOIN_RETRY_MARGIN_MS,
    )
  })
})

describe('join-queue — A6: sala morta é desistida com sinal', () => {
  it('404 → room-dead, convite REJEITADO, sala sai da fila e nunca mais tenta', async () => {
    const fake = fakePorts(['!morta:hs', '!viva:hs'])
    fake.outcomes.set('!morta:hs', () => ({ kind: 'dead', message: 'No known servers (404)' }))
    const state = newJoinQueueState()

    await joinTick(fake.ports, state)
    expect(fake.logs.find((l) => l.evt === 'room-dead')).toMatchObject({
      roomId: '!morta:hs',
      attempts: 1,
    })
    expect(state.dead.has('!morta:hs')).toBe(true)
    expect(state.queue.has('!morta:hs')).toBe(false)
    // O convite morto é rejeitado (some do sync — sem isto todo restart re-enfileira
    // o backlog e re-paga o rc_joins.remote)…
    expect(fake.rejects).toEqual(['!morta:hs'])
    expect(fake.logs.find((l) => l.evt === 'invite-rejected')).toMatchObject({
      roomId: '!morta:hs',
    })
    // …e a viva joinou no mesmo tick — a morta não custou a fila.
    expect(state.queue.has('!viva:hs')).toBe(false)

    // Convite ainda visível no sync (reject em voo): a morta NÃO re-entra na fila.
    fake.clock.now += 60_000
    await joinTick(fake.ports, state)
    expect(fake.attempts.filter((r) => r === '!morta:hs')).toHaveLength(1)
  })

  it('reject que falha é best-effort: sinal próprio, sala segue morta, tick não estoura', async () => {
    const fake = fakePorts(['!morta:hs'])
    fake.outcomes.set('!morta:hs', () => ({ kind: 'dead', message: '404' }))
    fake.rejectOutcome = () => Promise.reject(new Error('M_LIMIT_EXCEEDED'))
    const state = newJoinQueueState()

    await joinTick(fake.ports, state)
    expect(state.dead.has('!morta:hs')).toBe(true)
    expect(fake.rejects).toEqual([])
    expect(fake.logs.find((l) => l.evt === 'invite-reject-failed')).toMatchObject({
      roomId: '!morta:hs',
    })
  })
})

describe('join-queue — #248: joined sem transição no SDK não re-enfileira', () => {
  it('o laço de 26/Out: SDK preso em `invite` por 10 ticks → 1 attemptJoin, 1 joined', async () => {
    // /join idempotente: o servidor responde 200 a cada tentativa e nenhum /sync move o
    // SDK. Sem a confirmação, cada tick de 3 s re-joinava (10 attempts aqui).
    const fake = fakePorts(['!laco:hs'])
    const state = newJoinQueueState()
    for (let i = 0; i < 10; i++) {
      await joinTick(fake.ports, state)
      fake.clock.now += 3_000
    }
    expect(fake.attempts).toEqual(['!laco:hs'])
    expect(fake.logs.filter((l) => l.evt === 'joined')).toHaveLength(1)
  })

  it('SDK vira `join` no tick seguinte: sala sai de awaitingSync sem log extra', async () => {
    const fake = fakePorts(['!ok:hs'])
    const state = newJoinQueueState()
    await joinTick(fake.ports, state)
    expect(state.awaitingSync.has('!ok:hs')).toBe(true)

    fake.invited = []
    fake.clock.now += 3_000
    await joinTick(fake.ports, state)
    expect(state.awaitingSync.has('!ok:hs')).toBe(false)
    expect(state.queue.has('!ok:hs')).toBe(false)
    expect(fake.logs.map((l) => l.evt)).toEqual(['joined'])
  })

  it('SDK fica `invite` além do timeout: join-unconfirmed 1× e próximo attempt só após a cadência de stall', async () => {
    const fake = fakePorts(['!preso:hs'])
    const state = newJoinQueueState()
    await joinTick(fake.ports, state)
    const joinedAt = fake.clock.now

    fake.clock.now = joinedAt + JOIN_CONFIRM_TIMEOUT_MS - 1
    await joinTick(fake.ports, state)
    expect(fake.logs.filter((l) => l.evt === 'join-unconfirmed')).toHaveLength(0)

    fake.clock.now = joinedAt + JOIN_CONFIRM_TIMEOUT_MS
    await joinTick(fake.ports, state)
    const unconfirmed = fake.logs.filter((l) => l.evt === 'join-unconfirmed')
    expect(unconfirmed).toHaveLength(1)
    expect(unconfirmed[0]).toMatchObject({ roomId: '!preso:hs', waitedMs: JOIN_CONFIRM_TIMEOUT_MS })
    expect(state.queue.get('!preso:hs')!.attempts).toBe(JOIN_STALL_ATTEMPTS)
    expect(fake.attempts).toHaveLength(1)

    // Dentro da cadência: nenhum attempt; vencida: tenta de novo (e volta a esperar).
    const timedOutAt = fake.clock.now
    fake.clock.now = timedOutAt + JOIN_STALLED_CADENCE_MS - 1
    await joinTick(fake.ports, state)
    expect(fake.attempts).toHaveLength(1)
    fake.clock.now = timedOutAt + JOIN_STALLED_CADENCE_MS
    await joinTick(fake.ports, state)
    expect(fake.attempts).toHaveLength(2)
    expect(fake.logs.filter((l) => l.evt === 'join-unconfirmed')).toHaveLength(1)
  })

  it('sala em awaitingSync nunca é enfileirada, mesmo listada como convidada', async () => {
    const fake = fakePorts(['!espera:hs'])
    const state = newJoinQueueState()
    state.awaitingSync.set('!espera:hs', { joinedAt: fake.clock.now })
    for (let i = 0; i < 5; i++) {
      await joinTick(fake.ports, state)
      expect(state.queue.has('!espera:hs')).toBe(false)
      fake.clock.now += 3_000
    }
    expect(fake.attempts).toEqual([])
  })
})
