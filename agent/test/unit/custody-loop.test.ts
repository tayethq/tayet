import { describe, it, expect } from 'vitest'
import {
  custodyTick,
  newCustodyState,
  RoomGoneError,
  type CustodyPorts,
  type SessionExportEntry,
} from '../../src/custody-loop.ts'

// O loop export-diff com fakes no idioma do repo: cada porta é um fake observável.
// Os invariantes provados aqui são os do desenho da PR-3: snapshot no primeiro evento
// (deferral até conhecê-lo), filtro de índice (dec. 2), `exists` como sucesso
// idempotente, retry-sem-descarte na falha do escrow e pulo com sinal da sala inacessível
// (ADR-079).

function entryOf(roomId: string, sessionId: string, firstKnownIndex = 0): SessionExportEntry {
  const blob = Buffer.alloc(165, 0xab)
  blob.writeUInt8(1, 0)
  blob.writeUInt32BE(firstKnownIndex, 1)
  return {
    algorithm: 'm.megolm.v1.aes-sha2',
    room_id: roomId,
    session_id: sessionId,
    session_key: blob.toString('base64'),
  }
}

interface Fake {
  ports: CustodyPorts
  deposits: Array<{ sessionId: string; addressed: string[] }>
  backfills: Array<{ roomId: string; sessionId: string }>
  logs: Array<Record<string, unknown>>
  entries: SessionExportEntry[]
  firstEvents: Map<string, string>
  deadRooms: Set<string>
  roomAccess: Map<string, 'member' | 'gone' | 'unknown'>
  depositOutcome: () => Promise<'created' | 'exists'>
  clock: { now: number }
}

function fakePorts(
  overrides: Partial<Pick<Fake, 'entries' | 'depositOutcome'>> = {},
): Fake {
  const fake: Fake = {
    deposits: [],
    backfills: [],
    logs: [],
    entries: overrides.entries ?? [],
    firstEvents: new Map(),
    deadRooms: new Set(),
    roomAccess: new Map(),
    depositOutcome: overrides.depositOutcome ?? (() => Promise.resolve('created')),
    clock: { now: 1_000 },
    ports: {
      exportSessions: () => Promise.resolve(fake.entries),
      firstEventOf: (roomId, sessionId) => fake.firstEvents.get(`${roomId}|${sessionId}`) ?? null,
      addressedAt: (roomId, eventId) => Promise.resolve([`membro-de-${roomId}-${eventId}`, 'cofre']),
      deposit: (entry, addressed) => {
        const outcome = fake.depositOutcome()
        return outcome.then((o) => {
          fake.deposits.push({ sessionId: entry.session_id, addressed })
          return o
        })
      },
      needsBackfill: (roomId, sessionId) => {
        fake.backfills.push({ roomId, sessionId })
      },
      roomDead: (roomId) => fake.deadRooms.has(roomId),
      roomAccess: (roomId) => fake.roomAccess.get(roomId) ?? 'member',
      log: (line) => {
        fake.logs.push(line)
      },
      now: () => fake.clock.now,
    },
  }
  return fake
}

describe('custody-loop — depósito do nascimento', () => {
  it('sessão índice-0 com primeiro evento conhecido → deposita com os endereçados do /context', async () => {
    const fake = fakePorts({ entries: [entryOf('!sala:hs', 'sessao-a')] })
    fake.firstEvents.set('!sala:hs|sessao-a', '$primeiro')
    const state = newCustodyState()
    await custodyTick(fake.ports, state)
    expect(fake.deposits).toEqual([
      { sessionId: 'sessao-a', addressed: ['membro-de-!sala:hs-$primeiro', 'cofre'] },
    ])
    expect(state.deposited.has('sessao-a')).toBe(true)
    expect(fake.logs.map((l) => l.evt)).toContain('session-deposited')
  })

  it('`exists` do escrow é sucesso idempotente — marca depositada, sem retry', async () => {
    const fake = fakePorts({
      entries: [entryOf('!sala:hs', 'sessao-a')],
      depositOutcome: () => Promise.resolve('exists'),
    })
    fake.firstEvents.set('!sala:hs|sessao-a', '$primeiro')
    const state = newCustodyState()
    await custodyTick(fake.ports, state)
    await custodyTick(fake.ports, state)
    expect(fake.deposits).toHaveLength(1)
    expect(state.deposited.has('sessao-a')).toBe(true)
    expect(state.failures.size).toBe(0)
  })

  it('sessão já no cache de depositadas (boot) → não re-deposita', async () => {
    const fake = fakePorts({ entries: [entryOf('!sala:hs', 'sessao-a')] })
    fake.firstEvents.set('!sala:hs|sessao-a', '$primeiro')
    const state = newCustodyState(['sessao-a'])
    await custodyTick(fake.ports, state)
    expect(fake.deposits).toEqual([])
  })
})

describe('custody-loop — deferral até o primeiro evento (o snapshot exige o nascimento)', () => {
  it('sem primeiro evento conhecido: NÃO deposita, pede backfill; depositando quando ele aparece', async () => {
    const fake = fakePorts({ entries: [entryOf('!sala:hs', 'sessao-a')] })
    const state = newCustodyState()
    await custodyTick(fake.ports, state)
    expect(fake.deposits).toEqual([])
    expect(fake.backfills).toEqual([{ roomId: '!sala:hs', sessionId: 'sessao-a' }])
    expect(state.deposited.size).toBe(0)

    fake.firstEvents.set('!sala:hs|sessao-a', '$achado-no-catchup')
    await custodyTick(fake.ports, state)
    expect(fake.deposits).toEqual([
      { sessionId: 'sessao-a', addressed: ['membro-de-!sala:hs-$achado-no-catchup', 'cofre'] },
    ])
  })
})

describe('custody-loop — filtro de índice (ADR-057 dec. 2)', () => {
  it('índice N>0 (mid-ratchet, sala pré-entrada) → pulada com sinal/contador, nunca depositada', async () => {
    const fake = fakePorts({
      entries: [entryOf('!velha:hs', 'sessao-herdada', 5), entryOf('!nova:hs', 'sessao-nova', 0)],
    })
    fake.firstEvents.set('!velha:hs|sessao-herdada', '$qualquer')
    fake.firstEvents.set('!nova:hs|sessao-nova', '$primeiro')
    const state = newCustodyState()
    await custodyTick(fake.ports, state)
    expect(fake.deposits.map((d) => d.sessionId)).toEqual(['sessao-nova'])
    expect(state.skipped.has('sessao-herdada')).toBe(true)
    const skip = fake.logs.find((l) => l.evt === 'session-skipped')
    expect(skip).toMatchObject({ sessionId: 'sessao-herdada', firstKnownIndex: 5, skippedTotal: 1 })
  })

  it('pulo é terminal e loga uma vez só (Megolm não anda para trás)', async () => {
    const fake = fakePorts({ entries: [entryOf('!velha:hs', 'sessao-herdada', 2)] })
    const state = newCustodyState()
    await custodyTick(fake.ports, state)
    await custodyTick(fake.ports, state)
    expect(fake.logs.filter((l) => l.evt === 'session-skipped')).toHaveLength(1)
  })

  it('session_key indecodificável → pulada (nunca depositar o que não se sabe ler)', async () => {
    const entry = entryOf('!sala:hs', 'sessao-rasgada')
    entry.session_key = 'AAA='
    const fake = fakePorts({ entries: [entry] })
    fake.firstEvents.set('!sala:hs|sessao-rasgada', '$primeiro')
    const state = newCustodyState()
    await custodyTick(fake.ports, state)
    expect(fake.deposits).toEqual([])
    expect(fake.logs.find((l) => l.evt === 'session-skipped')).toMatchObject({
      firstKnownIndex: null,
    })
  })
})

describe('custody-loop — falha do escrow: retry com backoff, nunca descarte', () => {
  it('depósito falha → pendente com backoff; antes do prazo não tenta; depois tenta e deposita', async () => {
    let failures = 1
    const fake = fakePorts({
      entries: [entryOf('!sala:hs', 'sessao-a')],
      depositOutcome: () => {
        if (failures > 0) {
          failures -= 1
          return Promise.reject(new Error('ECONNREFUSED'))
        }
        return Promise.resolve('created')
      },
    })
    fake.firstEvents.set('!sala:hs|sessao-a', '$primeiro')
    const state = newCustodyState()

    await custodyTick(fake.ports, state)
    expect(fake.deposits).toEqual([])
    expect(state.deposited.size).toBe(0)
    expect(state.failures.get('sessao-a')).toMatchObject({ count: 1 })
    expect(fake.logs.find((l) => l.evt === 'deposit-retry')).toMatchObject({ attempt: 1 })

    // dentro da janela de backoff: nada acontece
    fake.clock.now += 100
    await custodyTick(fake.ports, state)
    expect(fake.deposits).toEqual([])

    // janela vencida: re-tenta e agora o escrow aceita
    fake.clock.now += 60_000
    await custodyTick(fake.ports, state)
    expect(fake.deposits.map((d) => d.sessionId)).toEqual(['sessao-a'])
    expect(state.deposited.has('sessao-a')).toBe(true)
    expect(state.failures.size).toBe(0)
  })

  it('backoff cresce exponencial e satura em 60s', async () => {
    const fake = fakePorts({
      entries: [entryOf('!sala:hs', 'sessao-a')],
      depositOutcome: () => Promise.reject(new Error('HTTP 503')),
    })
    fake.firstEvents.set('!sala:hs|sessao-a', '$primeiro')
    const state = newCustodyState()
    const backoffs: number[] = []
    for (let i = 0; i < 8; i++) {
      await custodyTick(fake.ports, state)
      const failure = state.failures.get('sessao-a')!
      backoffs.push(failure.nextAttemptTs - fake.clock.now)
      fake.clock.now = failure.nextAttemptTs
    }
    expect(backoffs).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000])
    // nunca descartada: segue pendente, nunca marcada nem pulada
    expect(state.deposited.size).toBe(0)
    expect(state.skipped.size).toBe(0)
  })

  it('endereçados vazios do /context são falha transitória (retry), nunca depósito vazio', async () => {
    const fake = fakePorts({ entries: [entryOf('!sala:hs', 'sessao-a')] })
    fake.firstEvents.set('!sala:hs|sessao-a', '$primeiro')
    fake.ports.addressedAt = () => Promise.resolve([])
    const state = newCustodyState()
    await custodyTick(fake.ports, state)
    expect(fake.deposits).toEqual([])
    expect(state.failures.get('sessao-a')).toMatchObject({ count: 1 })
  })
})

describe('custody-loop — A6: sala morta pula as sessões com sinal (PR-3.1)', () => {
  it('sessão de sala morta → pulada com reason room-dead, nunca depositada nem backfillada', async () => {
    const fake = fakePorts({
      entries: [entryOf('!morta:hs', 'sessao-orfa'), entryOf('!viva:hs', 'sessao-viva')],
    })
    fake.deadRooms.add('!morta:hs')
    fake.firstEvents.set('!viva:hs|sessao-viva', '$primeiro')
    const state = newCustodyState()
    await custodyTick(fake.ports, state)
    expect(fake.deposits.map((d) => d.sessionId)).toEqual(['sessao-viva'])
    expect(fake.backfills).toEqual([])
    expect(state.skipped.has('sessao-orfa')).toBe(true)
    expect(fake.logs.find((l) => l.evt === 'session-skipped')).toMatchObject({
      reason: 'room-dead',
      roomId: '!morta:hs',
      sessionId: 'sessao-orfa',
    })
  })

  it('pulo por sala morta é terminal: loga uma vez, sai da pendência do gauge', async () => {
    const fake = fakePorts({ entries: [entryOf('!morta:hs', 'sessao-orfa')] })
    fake.deadRooms.add('!morta:hs')
    const state = newCustodyState()
    await custodyTick(fake.ports, state)
    fake.clock.now += 120_000
    await custodyTick(fake.ports, state)
    expect(fake.logs.filter((l) => l.evt === 'session-skipped')).toHaveLength(1)
    expect(fake.logs.filter((l) => l.evt === 'pending-sessions')).toEqual([])
  })
})

describe('custody-loop — ADR-079: sala inacessível pula as sessões com sinal (#254)', () => {
  it('/context 404/403 → pulada com reason room-gone, zero deposit-retry, nunca re-tentada', async () => {
    const fake = fakePorts({ entries: [entryOf('!purgada:hs', 'sessao-a')] })
    fake.firstEvents.set('!purgada:hs|sessao-a', '$primeiro')
    let contexts = 0
    fake.ports.addressedAt = () => {
      contexts += 1
      return Promise.reject(new RoomGoneError('GET /context -> 404', 404))
    }
    const state = newCustodyState()
    for (let i = 0; i < 10; i++) {
      await custodyTick(fake.ports, state)
      fake.clock.now += 61_000
    }
    expect(contexts).toBe(1)
    expect(fake.logs.filter((l) => l.evt === 'deposit-retry')).toEqual([])
    const skips = fake.logs.filter((l) => l.evt === 'session-skipped')
    expect(skips).toHaveLength(1)
    expect(skips[0]).toMatchObject({
      reason: 'room-gone',
      roomId: '!purgada:hs',
      sessionId: 'sessao-a',
      status: 404,
      skippedTotal: 1,
    })
    expect(state.skipped.has('sessao-a')).toBe(true)
    expect(state.failures.size).toBe(0)
    expect(fake.logs.filter((l) => l.evt === 'pending-sessions')).toEqual([])
  })

  it('erro comum do /context segue transitório: retry com backoff, nunca pulo', async () => {
    const fake = fakePorts({ entries: [entryOf('!sala:hs', 'sessao-a')] })
    fake.firstEvents.set('!sala:hs|sessao-a', '$primeiro')
    fake.ports.addressedAt = () => Promise.reject(new Error('GET /context -> 502'))
    const state = newCustodyState()
    await custodyTick(fake.ports, state)
    expect(state.failures.get('sessao-a')).toMatchObject({ count: 1 })
    expect(state.skipped.size).toBe(0)
    expect(fake.logs.find((l) => l.evt === 'deposit-retry')).toMatchObject({ attempt: 1 })
  })

  it('sem primeiro evento + sala fora do alcance pós-sync (gone) → pulo room-gone, sem backfill', async () => {
    const fake = fakePorts({ entries: [entryOf('!purgada:hs', 'sessao-a')] })
    fake.roomAccess.set('!purgada:hs', 'gone')
    const state = newCustodyState()
    await custodyTick(fake.ports, state)
    await custodyTick(fake.ports, state)
    expect(fake.backfills).toEqual([])
    expect(fake.logs.filter((l) => l.evt === 'session-skipped')).toEqual([
      { evt: 'session-skipped', reason: 'room-gone', roomId: '!purgada:hs', sessionId: 'sessao-a', skippedTotal: 1 },
    ])
  })

  it.each(['unknown', 'member'] as const)(
    'sem primeiro evento + roomAccess %s → needsBackfill (comportamento de antes), sem pulo',
    async (access) => {
      const fake = fakePorts({ entries: [entryOf('!sala:hs', 'sessao-a')] })
      fake.roomAccess.set('!sala:hs', access)
      const state = newCustodyState()
      await custodyTick(fake.ports, state)
      expect(fake.backfills).toEqual([{ roomId: '!sala:hs', sessionId: 'sessao-a' }])
      expect(state.skipped.size).toBe(0)
    },
  )

  it('room-dead (A6) tem precedência sobre room-gone', async () => {
    const fake = fakePorts({ entries: [entryOf('!morta:hs', 'sessao-orfa')] })
    fake.deadRooms.add('!morta:hs')
    fake.roomAccess.set('!morta:hs', 'gone')
    const state = newCustodyState()
    await custodyTick(fake.ports, state)
    expect(fake.logs.filter((l) => l.evt === 'session-skipped')).toEqual([
      expect.objectContaining({ reason: 'room-dead' }),
    ])
  })
})

describe('custody-loop — A2: gauge de pendências (PR-3.1)', () => {
  it('pendência viva re-emite pending-sessions a cada intervalo, com idade da mais velha', async () => {
    // Sessão sem primeiro evento conhecido = pendente (deferral) — o caso A2 real.
    const fake = fakePorts({ entries: [entryOf('!sala:hs', 'sessao-presa')] })
    const state = newCustodyState()

    fake.clock.now = 100_000
    await custodyTick(fake.ports, state)
    const first = fake.logs.filter((l) => l.evt === 'pending-sessions')
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ count: 1, oldestAgeMs: 0 })

    // Dentro do intervalo: silêncio (sem re-emissão a cada tick).
    fake.clock.now += 10_000
    await custodyTick(fake.ports, state)
    expect(fake.logs.filter((l) => l.evt === 'pending-sessions')).toHaveLength(1)

    // Intervalo vencido: re-emite, e a idade acumula desde o first-seen.
    fake.clock.now += 60_000
    await custodyTick(fake.ports, state)
    const gauges = fake.logs.filter((l) => l.evt === 'pending-sessions')
    expect(gauges).toHaveLength(2)
    expect(gauges[1]).toMatchObject({ count: 1, oldestAgeMs: 70_000 })
  })

  it('zero pendências = silêncio: depósito no mesmo tick nunca conta como pendente', async () => {
    const fake = fakePorts({ entries: [entryOf('!sala:hs', 'sessao-a')] })
    fake.firstEvents.set('!sala:hs|sessao-a', '$primeiro')
    const state = newCustodyState()
    fake.clock.now = 100_000
    await custodyTick(fake.ports, state)
    fake.clock.now += 70_000
    await custodyTick(fake.ports, state)
    expect(fake.logs.filter((l) => l.evt === 'pending-sessions')).toEqual([])
  })

  it('gauge some quando a pendência drena (e o first-seen é limpo)', async () => {
    const fake = fakePorts({ entries: [entryOf('!sala:hs', 'sessao-a')] })
    const state = newCustodyState()
    fake.clock.now = 100_000
    await custodyTick(fake.ports, state)
    expect(fake.logs.filter((l) => l.evt === 'pending-sessions')).toHaveLength(1)

    // Primeiro evento aparece → deposita → pendência zera → silêncio dali em diante.
    fake.firstEvents.set('!sala:hs|sessao-a', '$achado')
    fake.clock.now += 70_000
    await custodyTick(fake.ports, state)
    fake.clock.now += 70_000
    await custodyTick(fake.ports, state)
    expect(fake.logs.filter((l) => l.evt === 'pending-sessions')).toHaveLength(1)
    expect(state.firstSeen.size).toBe(0)
  })
})
