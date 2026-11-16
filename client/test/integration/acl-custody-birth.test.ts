import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, ChannelId, UserId } from '../../src/acl'
import { HOMESERVER, synapseReachable, whoami, findOwnEvent } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { until } from '../support/until'

// Gate de integração da PR-4 do track CRIPTO-COBERTURA (ADR-057 dec. 2/3) — a PROVA FIM-A-FIM do
// track: uma sala nascida PELA ACL, contra a stack real (Synapse + MAS + escrow + agente de
// custódia de pé), tem as propriedades que a cobertura depende E a primeira mensagem dela chega
// custodiada no escrow.
//
// O que só este gate consegue provar (as units param na fronteira do SDK):
//  - o servidor ACEITOU o initial_state pinado — history_visibility `shared` e os dois campos de
//    rotação sobrevivem ao createRoom (um servidor pode reescrever state no preset);
//  - o cofre está de fato na sala (invite→join pelo próprio agente, F2);
//  - a sessão Megolm da PRIMEIRA mensagem foi depositada — isto é, o fan-out realmente alcançou a
//    identidade estrutural. É o elo que o A1 mostrou que pode quebrar em silêncio.
//
// Auto-skip sem a stack (issue #7). Usuários FRESCOS por run (o drag de device/room da alice/bob
// compartilhadas é a causa-raiz #32).

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ESCROW = process.env.TAYET_ESCROW_URL ?? 'http://localhost:8090'
const COFRE = '@cofre:tayet.local'

// Migração S3a (PLANO-GATES §8.8): a cópia local do `until` (label sem attempts/snapshot —
// a forma que o run 31015773523 estourou mudo de estado) virou o helper compartilhado do
// PR-B2. Budgets verbatim: timeout 120s e poll 500ms da cópia vão EXPLÍCITOS em cada call
// site (defaults do helper: 150s/120ms). Snapshot nas esperas de depósito = o retorno atual
// de retrievedSessionIds — discrimina "depósito nunca aconteceu" de "aconteceu com id
// diferente".
const BUDGET = { timeoutMs: 120_000, pollMs: 500 }

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

// Estado de sala lido do SERVIDOR (não do store local) — é o servidor que tem que concordar.
async function roomState(token: string, roomId: string, type: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(
    `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${type}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  return res.status === 200 ? ((await res.json()) as Record<string, unknown>) : null
}

async function membership(token: string, roomId: string, userId: string): Promise<string | null> {
  const res = await fetch(
    `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(userId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (res.status !== 200) return null
  return ((await res.json()) as { membership?: string }).membership ?? null
}

// F5: o retrieve do escrow filtra por `requester ∈ endereçados`. Quem pergunta é o MEMBRO HUMANO —
// é a forma da prova: o humano que estava na sala ao nascimento da sessão a encontra custodiada.
async function retrievedSessionIds(token: string): Promise<string[]> {
  const res = await fetch(`${ESCROW}/v1/sessions`, { headers: { Authorization: `Bearer ${token}` } })
  if (res.status !== 200) throw new Error(`retrieve -> ${res.status}`)
  const { sessions } = (await res.json()) as { sessions: Array<{ session_id?: string }> }
  return sessions.map((s) => s.session_id ?? '')
}

// O session_id da mensagem, lido do envelope cifrado NA WIRE (o que a ACL nunca deixa cruzar).
// ADR-010: sendMessage devolve o id ESTÁVEL, que para os próprios envios é o txn — não o event id
// de wire. Por isso a resolução passa por findOwnEvent (busca pelo transaction_id), não por
// getEvent direto: um GET /event/{txn} devolve 404.
async function sessionIdOf(token: string, roomId: string, domainMessageId: string): Promise<string> {
  const ev = await findOwnEvent(token, roomId, domainMessageId)
  const content = ev.content as { algorithm?: string; session_id?: string }
  expect(content.algorithm).toBe('m.megolm.v1.aes-sha2')
  expect(typeof content.session_id).toBe('string')
  return content.session_id!
}

describe.skipIf(!SYNAPSE)('gate nascimento com cobertura — ACL ↔ stack real (ADR-057 dec. 2/3)', () => {
  let acl: Acl
  let creatorToken: string
  let peerId: UserId

  beforeAll(async () => {
    const [creator, peer] = await freshUsers(['cba', 'cbb'])
    creatorToken = creator.token
    peerId = (await whoami(peer.token)) as UserId
    acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await acl.connect(creatorToken as Parameters<Acl['connect']>[0])
  }, 240_000)

  afterAll(async () => {
    await acl?.disconnect()
  })

  it(
    'canal privado: initial_state pinado no servidor, cofre dentro, 1ª sessão custodiada',
    async () => {
      const id = await withRetry(() => acl.createChannel({ name: `cob-${Date.now()}`, kind: 'private' }))
      const roomId = String(id)

      // ── dec. 3: as duas propriedades pinadas sobreviveram ao createRoom, no SERVIDOR.
      expect(await roomState(creatorToken, roomId, 'm.room.history_visibility')).toEqual({
        history_visibility: 'shared',
      })
      // Sub-decisão do F7: rotação DECIDIDA, não herdada.
      expect(await roomState(creatorToken, roomId, 'm.room.encryption')).toMatchObject({
        algorithm: 'm.megolm.v1.aes-sha2',
        rotation_period_msgs: 100,
        rotation_period_ms: 604_800_000,
      })

      // ── dec. 2: o destinatário estrutural está na sala. `invite` já basta para o fan-out (C1);
      // o agente joina sozinho logo depois (F2), então aceitamos os dois.
      const state = await membership(creatorToken, roomId, COFRE)
      expect(['invite', 'join']).toContain(state)

      // ── O elo que importa: a PRIMEIRA sessão da sala chega custodiada.
      // ADR-058: sendMessage rejects for a channel the session does not know yet; wait for it.
      await until(
        'canal privado conhecido antes do 1º envio',
        async () => ((await acl.getChannels()).some((c) => c.id === id) ? true : undefined),
        {
          snapshot: async () => {
            const chs = await acl.getChannels()
            return `known=${chs.length} hasChannelId=${chs.some((c) => c.id === id)}`
          },
        },
      )
      const messageId = await acl.sendMessage(id as ChannelId, { kind: 'text', text: 'primeira' })
      const sessionId = await sessionIdOf(creatorToken, roomId, String(messageId))
      await until(
        `depósito da 1ª sessão do canal privado (${sessionId})`,
        async () => ((await retrievedSessionIds(creatorToken)).includes(sessionId) ? true : undefined),
        {
          ...BUDGET,
          snapshot: async () => `retrievedSessionIds atuais: [${(await retrievedSessionIds(creatorToken)).join(', ')}]`,
        },
      )
    },
    300_000,
  )

  it(
    'DM: mesmo contrato — pinado, cofre dentro, 1ª sessão custodiada',
    async () => {
      const id = await withRetry(() => acl.openDirectMessage(peerId))
      const roomId = String(id)

      expect(await roomState(creatorToken, roomId, 'm.room.history_visibility')).toEqual({
        history_visibility: 'shared',
      })
      expect(await roomState(creatorToken, roomId, 'm.room.encryption')).toMatchObject({
        algorithm: 'm.megolm.v1.aes-sha2',
        rotation_period_msgs: 100,
        rotation_period_ms: 604_800_000,
      })
      expect(['invite', 'join']).toContain(await membership(creatorToken, roomId, COFRE))

      // ADR-058: sendMessage rejects for a channel the session does not know yet; wait for it.
      await until(
        'DM conhecido antes do 1º envio',
        async () => ((await acl.getChannels()).some((c) => c.id === id) ? true : undefined),
        {
          snapshot: async () => {
            const chs = await acl.getChannels()
            return `known=${chs.length} hasChannelId=${chs.some((c) => c.id === id)}`
          },
        },
      )
      const messageId = await acl.sendMessage(id as ChannelId, { kind: 'text', text: 'oi' })
      const sessionId = await sessionIdOf(creatorToken, roomId, String(messageId))
      await until(
        `depósito da 1ª sessão do DM (${sessionId})`,
        async () => ((await retrievedSessionIds(creatorToken)).includes(sessionId) ? true : undefined),
        {
          ...BUDGET,
          snapshot: async () => `retrievedSessionIds atuais: [${(await retrievedSessionIds(creatorToken)).join(', ')}]`,
        },
      )

      // Ripple visto do produto: o DM tem TRÊS membros no protocolo e continua sendo 1:1.
      const members = await acl.getMembers(id as ChannelId)
      expect(members.map((m) => String(m.user.id))).not.toContain(COFRE)
      expect((await acl.getChannel(id as ChannelId)).memberCount).toBeLessThanOrEqual(2)
    },
    300_000,
  )

  it(
    'canal público: nada disso — sem cifra, sem pinagem, sem cofre',
    async () => {
      const id = await withRetry(() => acl.createChannel({ name: `pub-${Date.now()}`, kind: 'public' }))
      const roomId = String(id)

      expect(await roomState(creatorToken, roomId, 'm.room.encryption')).toBeNull()
      expect(await membership(creatorToken, roomId, COFRE)).toBeNull()
      // NOTA: history_visibility NÃO é discriminador aqui. O preset `public_chat` do Synapse já
      // entrega `shared` por conta própria, então ler `shared` numa sala pública não prova que a
      // ACL injetou nada. O que prova a ausência da pinagem em canal público é a unit do
      // initial_state (custody-birth.test.ts), que inspeciona o que a ACL MANDA — não o que o
      // servidor acabou tendo. Asserção deliberadamente omitida em vez de escrita errada.
    },
    300_000,
  )
})
