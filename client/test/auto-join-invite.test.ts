import { describe, it, expect } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry } from '../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'

// Unit harness for autoJoinInvite (ADR-044), in the fake-client idiom of devices-current.test.ts:
// inject the SDK client via the `client` cast and reach the private method via the same cast. No
// Synapse — runs in CI. The invitee side reads the direct flag + the inviter off the invite member
// event BEFORE joining, joins without explicit acceptance, and on a direct invite converges the DM
// map (the bug: each side had created/seen only its own room). The seam must produce nothing
// renderable — it emits no channel.added (the invite→join transition re-fires the →join branch).

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@bob:server'
const INVITER = '@alice:server'
const ROOM = '!room:server'

interface Captured {
  joinCalls: string[]
  accountData: Array<Record<string, unknown>>
  // Interleaved call order (ADR-044): the DM-classification write must precede the join so the
  // store reflects the DM by the time the invite->join channel.added fires.
  order: string[]
}

type Pending = { promise: Promise<unknown>; resolve: () => void; reject: () => void }

// A controllable joinRoom promise so the in-flight guard can be exercised (pending) and a failure
// path can be driven (reject) without timing races.
function pending(): Pending {
  let resolve!: () => void
  let reject!: () => void
  const promise = new Promise<unknown>((res, rej) => {
    resolve = () => res(undefined)
    reject = () => rej(new Error('join failed'))
  })
  return { promise, resolve, reject }
}

function harness(
  inviteContent: Record<string, unknown> | undefined,
  joinResult: () => Promise<unknown>,
): { gateway: MatrixGateway; cap: Captured; room: unknown } {
  const cap: Captured = { joinCalls: [], accountData: [], order: [] }
  const member = inviteContent
    ? { events: { member: { getContent: () => inviteContent, getSender: () => INVITER } } }
    : undefined
  const room = { roomId: ROOM, getMember: (uid: string) => (uid === ME ? member : undefined) }
  const fakeClient = {
    getUserId: () => ME,
    joinRoom: (roomId: string) => {
      cap.joinCalls.push(roomId)
      cap.order.push('joinRoom')
      return joinResult()
    },
    getAccountData: () => undefined,
    setAccountData: (_type: unknown, content: Record<string, unknown>) => {
      cap.accountData.push(content)
      cap.order.push('setAccountData')
      return Promise.resolve(undefined)
    },
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  return { gateway, cap, room }
}

function autoJoin(gateway: MatrixGateway, room: unknown): Promise<void> {
  return (gateway as unknown as { autoJoinInvite: (r: unknown) => Promise<void> }).autoJoinInvite(room)
}

describe('autoJoinInvite — auto-join + DM convergence (ADR-044)', () => {
  it('convite direto → joinRoom 1x e a DM converge marcando inviter→roomId', async () => {
    const { gateway, cap, room } = harness({ is_direct: true }, () => Promise.resolve(undefined))
    const result = await autoJoin(gateway, room)

    expect(cap.joinCalls).toEqual([ROOM])
    expect(cap.accountData).toHaveLength(1)
    expect(cap.accountData[0]).toEqual({ [INVITER]: [ROOM] })
    // Classificação de DM gravada ANTES do join: o store já reflete a DM quando o channel.added
    // do join dispara.
    expect(cap.order).toEqual(['setAccountData', 'joinRoom'])
    // O seam não produz nada renderável (não emite channel.added; retorno é void).
    expect(findProtocolLeaks(result)).toEqual([])
  })

  it('convite de canal (não direto) → joinRoom chamado, DM NÃO converge', async () => {
    const { gateway, cap, room } = harness({}, () => Promise.resolve(undefined))
    await autoJoin(gateway, room)

    expect(cap.joinCalls).toEqual([ROOM])
    expect(cap.accountData).toEqual([])
    expect(cap.order).toEqual(['joinRoom']) // sem gravação de classificação: convite de canal não converge DM
  })

  it('dupla invocação com join em voo → joinRoom chamado uma vez (guard in-flight)', async () => {
    const p = pending()
    const { gateway, cap, room } = harness({ is_direct: true }, () => p.promise)
    const first = autoJoin(gateway, room)
    const second = autoJoin(gateway, room) // segunda chamada: guard barra (set síncrono), retorna cedo
    p.resolve()
    await Promise.all([first, second])

    expect(cap.joinCalls).toEqual([ROOM]) // join único apesar do double-fire
  })

  it('joinRoom rejeita → resolve sem propagar e o guard fica limpo (2ª chamada retenta)', async () => {
    const failThenOk = (() => {
      let n = 0
      return () => (n++ === 0 ? Promise.reject(new Error('join failed')) : Promise.resolve(undefined))
    })()
    const { gateway, cap, room } = harness({ is_direct: true }, failThenOk)

    await expect(autoJoin(gateway, room)).resolves.toBeUndefined() // swallow: não propaga
    await autoJoin(gateway, room) // guard limpo no finally → retenta

    expect(cap.joinCalls).toEqual([ROOM, ROOM])
  })
})
