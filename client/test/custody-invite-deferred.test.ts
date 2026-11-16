import { describe, it, expect } from 'vitest'
import { MatrixError } from 'matrix-js-sdk'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import {
  CUSTODY_INVITE_MAX_ATTEMPTS,
  CUSTODY_WAIT_MS,
} from '../src/acl/internal/custody'
import type { AclTelemetry } from '../src/acl'

// F11 (ratificado — PR-3.1 do track CRIPTO-COBERTURA): convite estrutural sob 429 do
// rc_message do CRIADOR. Medido na PR-4 (§8.4): 6/12 salas da rajada nasceram sem cofre —
// fail-open sistemático, não excepcional. O que este arquivo prova, em ordem: (1) 429 no
// convite imediato → o VERBO resolve sem bloquear, com o sinal DISTINTO `deferred` (não
// `failed`), e o convite TARDIO acontece pelo drain; (2) o sucesso tardio dispensa a espera
// de membership (nenhum wait-timeout); (3) teto de tentativas → aí sim o fail-open do F1
// (invite-failed) e a sala sai da fila; (4) erro não-429 segue no fail-open imediato.
// Idioma de fake-client do custody-birth.test.ts; o 429 é um MatrixError REAL do SDK com
// retry_after_ms no corpo (o shape que o Synapse manda).

const ME = '@me:tayet.local'
const COFRE = '@cofre:tayet.local'
const ROOM = '!room:tayet.local'

const DEFERRED = 'io.tayet.custody.invite-deferred'
const FAILED = 'io.tayet.custody.invite-failed'
const WAIT_TIMEOUT = 'io.tayet.custody.wait-timeout'

function limit429(retryAfterMs: number): MatrixError {
  return new MatrixError(
    { errcode: 'M_LIMIT_EXCEEDED', error: 'Too Many Requests', retry_after_ms: retryAfterMs },
    429,
  )
}

interface Captured {
  invites: Array<{ roomId: string; userId: string }>
  signals: string[]
}

// `inviteResults` é o roteiro do fake: um resultado por chamada de invite, na ordem;
// esgotado o roteiro, sucesso. 'ok' resolve; um MatrixError rejeita com ele.
function harness(inviteResults: Array<'ok' | MatrixError | Error>): {
  gateway: MatrixGateway
  cap: Captured
} {
  const cap: Captured = { invites: [], signals: [] }
  const telemetry: AclTelemetry = {
    untranslated: (e) => cap.signals.push(e.shape.eventType),
  }
  const fakeClient = {
    getUserId: () => ME,
    getRoom: () => ({
      roomId: ROOM,
      getMember: (uid: string) => (uid === COFRE ? { userId: COFRE, membership: 'invite' } : null),
    }),
    createRoom: () => Promise.resolve({ room_id: ROOM }),
    invite: (roomId: string, userId: string) => {
      cap.invites.push({ roomId, userId })
      const result = inviteResults.shift() ?? 'ok'
      return result === 'ok' ? Promise.resolve(undefined) : Promise.reject(result)
    },
    getAccountData: () => undefined,
    setAccountData: () => Promise.resolve(undefined),
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  return { gateway, cap }
}

async function until<T>(probe: () => T | null, what: string, timeoutMs = 10_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = probe()
    if (value !== null) return value
    if (Date.now() - start > timeoutMs) throw new Error(`timeout esperando: ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('F11 — convite estrutural deferido sob 429 (PR-3.1)', () => {
  it('429 imediato: verbo resolve SEM bloquear, sinal deferred, e o convite tardio acontece', async () => {
    const { gateway, cap } = harness([limit429(50)])
    const started = Date.now()
    await gateway.createChannel({ name: 'privado', kind: 'private' })
    // O verbo não esperou nem o retry nem a membership — resolveu no ato do defer.
    expect(Date.now() - started).toBeLessThan(CUSTODY_WAIT_MS)
    expect(cap.signals).toEqual([DEFERRED])
    expect(cap.invites).toHaveLength(1)

    // Drain fora do caminho do verbo: o convite tardio chega sozinho.
    await until(() => (cap.invites.length >= 2 ? true : null), 'convite tardio do drain')
    expect(cap.invites[1]).toEqual({ roomId: ROOM, userId: COFRE })
    // Sucesso tardio NÃO espera membership: nenhum wait-timeout, nenhum failed.
    expect(cap.signals).toEqual([DEFERRED])
  }, 15_000)

  it('teto de tentativas: 429 persistente → invite-failed (F1) e a sala sai da fila', async () => {
    // Roteiro infinito de 429: o array esgota mas o fake devolve 'ok' — então geramos o
    // teto ANTES: máximo de attempts = imediata + tardias, todas 429.
    const script: MatrixError[] = Array.from({ length: CUSTODY_INVITE_MAX_ATTEMPTS }, () =>
      limit429(10),
    )
    const { gateway, cap } = harness(script)
    await gateway.createChannel({ name: 'privado', kind: 'private' })

    await until(() => (cap.signals.includes(FAILED) ? true : null), 'fail-open do teto', 12_000)
    // Exatamente o teto de attempts foi feito (imediata + tardias), nem um a mais…
    expect(cap.invites).toHaveLength(CUSTODY_INVITE_MAX_ATTEMPTS)
    // …com um deferred por reagendamento e o failed ÚNICO no fecho.
    expect(cap.signals.filter((s) => s === DEFERRED)).toHaveLength(CUSTODY_INVITE_MAX_ATTEMPTS - 1)
    expect(cap.signals.filter((s) => s === FAILED)).toHaveLength(1)
    expect(cap.signals).not.toContain(WAIT_TIMEOUT)

    // Fila vazia: nenhum attempt novo depois do teto.
    const settled = cap.invites.length
    await new Promise((r) => setTimeout(r, 1_500))
    expect(cap.invites).toHaveLength(settled)
  }, 20_000)

  it('erro não-429 segue no fail-open IMEDIATO do F1 (sem fila, sem deferred)', async () => {
    const { gateway, cap } = harness([new Error('M_FORBIDDEN')])
    await gateway.createChannel({ name: 'privado', kind: 'private' })
    expect(cap.signals).toEqual([FAILED])
    await new Promise((r) => setTimeout(r, 1_200))
    expect(cap.invites).toHaveLength(1) // nada re-tentado — recusa não é rate limit
  }, 10_000)
})
