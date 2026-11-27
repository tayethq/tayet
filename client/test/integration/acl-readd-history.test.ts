import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, ChannelId, UserId } from '../../src/acl'
import { HOMESERVER, synapseReachable, mintToken, whoami, leave, findOwnEvent } from '../support/synapse'
import { registerUser } from '../support/escrow-harness'
import { until } from '../support/until'

// ADR-057 norm 1, re-add in the same session (addendum of 24/Nov/2026, issue #421): the history of
// a private channel starts at entry, and a person removed and added again does not get what was sent
// while they were out. The path under test is the one the diagnosis of 24/Nov named: the person
// removed keeps a live session (the room stays in their local store), so nothing in their own join
// order would stop them importing a history bundle the inviter's SDK built. The guarantee is on the
// inviter side: addMember invites by a direct call to the server and no bundle is ever built.
//
// Fresh users per run (#32); auto-skip without the stack (issue #7). No escrow: the custody path is
// not what is measured here (the other suites also run without it).

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const M1 = 'antes da remocao'
const M2 = 'enviada com B fora'
const WINDOW_MS = 20_000

async function withRetry<T>(fn: () => Promise<T>, attempts = 20): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const retryAfter = (err as { data?: { retry_after_ms?: number } }).data?.retry_after_ms
      if (retryAfter === undefined || attempt >= attempts) throw err
      await new Promise((r) => setTimeout(r, retryAfter + 200))
    }
  }
}

// session_id of an own encrypted event on the wire (the harness's discriminator, never the ACL's).
async function sessionIdOf(token: string, roomId: string, domainMessageId: string): Promise<string> {
  const ev = await findOwnEvent(token, roomId, domainMessageId)
  const content = ev.content as { algorithm?: string; session_id?: string }
  expect(content.algorithm).toBe('m.megolm.v1.aes-sha2')
  return content.session_id!
}

async function membership(token: string, roomId: string, userId: string): Promise<string | null> {
  const res = await fetch(
    `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(userId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (res.status !== 200) return null
  return ((await res.json()) as { membership?: string }).membership ?? null
}

describe.skipIf(!SYNAPSE)('norma 1 — removida e adicionada de novo na mesma sessão (ADR-057, adendo 24/Nov)', () => {
  const suffix = `${process.pid}${Math.floor(Math.random() * 1e6)}`
  const userA = `rha${suffix}`
  const userB = `rhb${suffix}`

  let tokenA: string
  let tokenB: string
  let mxidB: UserId
  let alice: Acl
  let bob: Acl
  let channelId: ChannelId

  const waitMembership = (state: string) => async (): Promise<true | undefined> =>
    (await membership(tokenA, String(channelId), String(mxidB))) === state ? true : undefined

  beforeAll(async () => {
    registerUser(userA)
    registerUser(userB)
    tokenA = await mintToken(userA)
    tokenB = await mintToken(userB)
    mxidB = (await whoami(tokenB)) as unknown as UserId

    alice = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await alice.connect(tokenA as Parameters<Acl['connect']>[0])
    bob = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await bob.connect(tokenB as Parameters<Acl['connect']>[0])
  }, 240_000)

  afterAll(async () => {
    try {
      if (tokenA && channelId) await leave(tokenA, String(channelId))
    } catch {
      /* best-effort */
    }
    for (const acl of [alice, bob]) {
      try {
        await acl?.disconnect()
      } catch {
        /* best-effort */
      }
    }
  }, 60_000)

  it(
    'B removida e adicionada de novo, sessão viva: M2 (enviada com B fora) não decifra em 20 s e assenta em unavailable',
    async () => {
      channelId = await withRetry(() => alice.createChannel({ name: `readd-${suffix}`, kind: 'private' }))
      await until('canal conhecido de A', async () =>
        (await alice.getChannels()).some((c) => c.id === channelId) ? true : undefined,
      )

      // 1. A adds B; B joins on its own (ADR-044) and reads M1: the session is live and addressed.
      await withRetry(() => alice.addMember(channelId, mxidB))
      await until('B entrou (1ª vez)', waitMembership('join'))
      const m1Id = await alice.sendMessage(channelId, { kind: 'text', text: M1 })
      await until(
        'B decifra M1',
        async () => {
          const page = await bob.getTimeline(channelId)
          return page.items.some((m) => m.body.kind === 'text' && m.body.text === M1) ? true : undefined
        },
        { timeoutMs: 120_000 },
      )

      // 2. A removes B; B's session stays connected (no reload, no logout).
      await withRetry(() => alice.removeMember(channelId, mxidB))
      await until('B fora', waitMembership('leave'))
      // A's own client must have seen the leave too, or M2 could still go out on M1's session (which
      // B holds by right): that would be a harness race, not the path under test.
      await until('A vê B fora', async () =>
        (await alice.getMembers(channelId)).some((m) => m.user.id === mxidB) ? undefined : true,
      )

      // 3. A sends M2 while B is out: the next session is born without B (rotation on leave).
      const m2Id = await alice.sendMessage(channelId, { kind: 'text', text: M2 })
      const s1 = await sessionIdOf(tokenA, String(channelId), String(m1Id))
      const s2 = await sessionIdOf(tokenA, String(channelId), String(m2Id))
      expect(s2, 'M2 saiu na sessão de M1 (corrida do harness, não o caminho medido)').not.toBe(s1)

      // 4. A adds B again; B joins again.
      await withRetry(() => alice.addMember(channelId, mxidB))
      await until('B entrou (2ª vez)', waitMembership('join'))
      const rejoinedAt = Date.now()

      // M2 never decrypts on B during the whole window: a text M2 is an immediate failure.
      const decryptedM2 = async (): Promise<boolean> => {
        const page = await bob.getTimeline(channelId)
        return page.items.some((m) => m.body.kind === 'text' && m.body.text === M2)
      }
      let lastGrade = 'none'
      while (Date.now() - rejoinedAt < WINDOW_MS) {
        expect(await decryptedM2(), 'B decifrou M2 (histórico de fora da membership)').toBe(false)
        const page = await bob.getTimeline(channelId)
        const placeholder = page.items.find((m) => m.body.kind === 'unavailable')
        if (placeholder && placeholder.body.kind === 'unavailable') lastGrade = placeholder.body.arrival
        await new Promise((r) => setTimeout(r, 500))
      }
      expect(await decryptedM2(), 'B decifrou M2 (histórico de fora da membership)').toBe(false)

      // M2 settles as unavailable: M1 is text, so the only placeholder in the channel is M2.
      const page = await bob.getTimeline(channelId)
      const placeholders = page.items.filter((m) => m.body.kind === 'unavailable')
      expect(placeholders, `último grau visto: ${lastGrade}`).toHaveLength(1)
    },
    300_000 + WINDOW_MS,
  )
})

describe('norma 1 — re-add (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
