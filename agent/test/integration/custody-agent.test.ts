import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  stackUp,
  registerUser,
  mintToken,
  memberState,
  inviteUser,
  joinRoom,
  leaveRoom,
  createEncryptedRoom,
  wireContent,
  retrieveSessionIds,
  agentSignals,
  stopAgent,
  startAgent,
  corruptAgentStore,
  readAgentSentinel,
  runDevStackUp,
  rest,
  until,
  COFRE_USER_ID,
  SERVER_NAME,
} from '../support/stack.ts'
import {
  startEmissor,
  waitLocalMembership,
  waitLocalEncrypted,
  sendEncrypted,
  discardSession,
  type Emissor,
} from '../support/emissor.ts'

// ── Gate de integração do agente de custódia (PLANO-CRIPTO-COBERTURA PR-3; ADR-057
// dec. 5) ─ stack real de pé (Synapse + MAS + escrow + container do agente). Os quatro
// asserts do desenho: nascimento (F2 join + depósito com endereçados do nascimento),
// F7 opção C (late joiner fora do snapshot; sessão nova o inclui), catch-up pós-
// downtime (mesma identidade + snapshot histórico via /context — o teste que separa
// /context de "estado corrente"), e filtro de índice (sessão herdada mid-ratchet
// pulada; primeira sessão pós-entrada depositada). Usuários FRESCOS por run; a prova
// de endereçamento é o RETRIEVE do escrow com o token de cada sujeito (F5: quem foi
// endereçado vê, quem não foi não vê — o serviço não expõe `addressed`).

const RUN = randomBytes(4).toString('hex')
const EMISSOR_USER = `emis${RUN}`
const MEMBER_USER = `memb${RUN}`
const LATE_USER = `tard${RUN}`
const OUTSIDER_USER = `fora${RUN}`
const PASSWORD = 'custodypass123'

let emissor: Emissor
let memberToken: string
let lateToken: string
let outsiderToken: string

let room1: string
let session1: string

async function sessionIdOf(roomId: string, eventId: string): Promise<string> {
  const content = await wireContent(emissor.token, roomId, eventId)
  expect(content.algorithm).toBe('m.megolm.v1.aes-sha2')
  expect(typeof content.session_id).toBe('string')
  return content.session_id as string
}

// Sala nova no shape da PR-4 (cofre convidado no ato) + higiene S2.3 antes de cifrar.
async function bornRoom(invite: string[], withCofre = true): Promise<string> {
  const invitees = withCofre ? [...invite, COFRE_USER_ID] : invite
  const roomId = await createEncryptedRoom(emissor.token, invitees)
  await waitLocalEncrypted(emissor, roomId)
  for (const userId of invitees) {
    await waitLocalMembership(emissor, roomId, userId, ['invite', 'join'])
  }
  return roomId
}

describe.skipIf(!stackUp())('gate do agente de custódia ↔ dev-stack (ADR-057 dec. 5)', () => {
  beforeAll(async () => {
    registerUser(EMISSOR_USER, PASSWORD)
    registerUser(MEMBER_USER, PASSWORD)
    registerUser(LATE_USER, PASSWORD)
    registerUser(OUTSIDER_USER, PASSWORD)
    memberToken = await mintToken(MEMBER_USER)
    lateToken = await mintToken(LATE_USER)
    outsiderToken = await mintToken(OUTSIDER_USER)
    emissor = await startEmissor(EMISSOR_USER)
  }, 180_000)

  afterAll(() => {
    emissor?.client.stopClient()
    // Se um teste morreu entre stop/start, devolve o agente ao estado de pé — o gate
    // não pode deixar a stack pior do que a achou.
    try {
      startAgent()
    } catch {
      /* já de pé */
    }
  })

  it('1. nascimento: auto-join do cofre e depósito com endereçados exatamente do nascimento', async () => {
    room1 = await bornRoom([`@${MEMBER_USER}:${SERVER_NAME}`])

    // F2 revisado: o agente dá JOIN no convite (o snapshot exige sync de estado).
    await until(
      async () => ((await memberState(emissor.token, room1, COFRE_USER_ID)) === 'join' ? true : null),
      'auto-join do cofre',
      60_000,
    )
    await waitLocalMembership(emissor, room1, COFRE_USER_ID, ['join'])

    const msg1 = await sendEncrypted(emissor, room1, 'msg1')
    session1 = await sessionIdOf(room1, msg1)

    // Depósito da sessão de msg1, provado pelo retrieve do membro endereçado.
    await until(
      async () => ((await retrieveSessionIds(memberToken)).includes(session1) ? true : null),
      `depósito da sessão de msg1 (${session1})`,
    )
    // O emissor também é endereçado (membro join do nascimento)…
    expect(await retrieveSessionIds(emissor.token)).toContain(session1)
    // …e quem NÃO era membro no nascimento não vê nada (F5: filtro por endereçamento).
    expect(await retrieveSessionIds(outsiderToken)).not.toContain(session1)
  }, 180_000)

  it('2. F7 (norma 1): late joiner fora do snapshot de msg1; sessão nova o inclui', async () => {
    await inviteUser(emissor.token, room1, `@${LATE_USER}:${SERVER_NAME}`)
    await joinRoom(lateToken, room1)
    await until(
      async () =>
        (await memberState(emissor.token, room1, `@${LATE_USER}:${SERVER_NAME}`)) === 'join'
          ? true
          : null,
      'join do late joiner',
      60_000,
    )

    // O endereçamento é fato de NASCIMENTO: a entrada posterior não reescreve msg1.
    expect(await retrieveSessionIds(lateToken)).not.toContain(session1)

    // Sessão NOVA (rotação forçada — a sub-decisão da rotação pinada aterrissa na
    // PR-4; aqui o protocolo a simula) nasce COM o late joiner no estado.
    await discardSession(emissor, room1)
    const msg2 = await sendEncrypted(emissor, room1, 'msg2')
    const session2 = await sessionIdOf(room1, msg2)
    expect(session2).not.toBe(session1)

    await until(
      async () => ((await retrieveSessionIds(lateToken)).includes(session2) ? true : null),
      `depósito da sessão de msg2 (${session2})`,
    )
    // E msg1 segue fora do alcance dele.
    expect(await retrieveSessionIds(lateToken)).not.toContain(session1)
  }, 180_000)

  it('3. catch-up: sessão nascida no downtime, mesma identidade, snapshot histórico via /context', async () => {
    const identityBefore = agentSignals().filter((s) => s.evt === 'identity')
    expect(identityBefore.length).toBeGreaterThan(0)
    const deviceBefore = identityBefore.at(-1)!.deviceId
    // Relativo ao RUN, não absoluto: os logs do container persistem entre runs do gate,
    // e o teste 7 (F8) produz identity-reset DE PROPÓSITO — um run anterior não pode
    // reprovar este.
    const resetsBefore = agentSignals().filter((s) => s.evt === 'identity-reset').length

    stopAgent()

    // Sala + sessão nascem com o agente MORTO. O cofre fica `invite` (ninguém joina
    // por ele) — e invite endereça (critério C1). A chave dele fica na fila to_device
    // do Synapse (S2.3 b2).
    const room2 = await bornRoom([`@${MEMBER_USER}:${SERVER_NAME}`])
    const msgX = await sendEncrypted(emissor, room2, 'msgX-downtime')
    const sessionX = await sessionIdOf(room2, msgX)

    // Discriminador do snapshot: um join acontece APÓS o nascimento e ANTES do
    // religamento. No religamento o estado CORRENTE já contém o tardio — só o
    // /context no primeiro evento o exclui.
    await inviteUser(emissor.token, room2, `@${LATE_USER}:${SERVER_NAME}`)
    await joinRoom(lateToken, room2)
    await until(
      async () =>
        (await memberState(emissor.token, room2, `@${LATE_USER}:${SERVER_NAME}`)) === 'join'
          ? true
          : null,
      'join do tardio durante o downtime',
      60_000,
    )

    startAgent()

    await until(
      async () => ((await memberState(emissor.token, room2, COFRE_USER_ID)) === 'join' ? true : null),
      'auto-join do cofre pós-religamento',
      90_000,
    )
    await until(
      async () => ((await retrieveSessionIds(memberToken)).includes(sessionX) ? true : null),
      `depósito da sessão do downtime (${sessionX})`,
      120_000,
    )

    // Mesmo device, sem identity-reset: a identidade cripto sobreviveu ao restart (F4).
    const signals = agentSignals()
    const identities = signals.filter((s) => s.evt === 'identity')
    expect(identities.length).toBeGreaterThan(identityBefore.length)
    expect(identities.at(-1)!.deviceId).toBe(deviceBefore)
    expect(signals.filter((s) => s.evt === 'identity-reset')).toHaveLength(resetsBefore)

    // O snapshot é o do NASCIMENTO (via /context), não o estado corrente do religamento.
    expect(await retrieveSessionIds(lateToken)).not.toContain(sessionX)
    expect(await retrieveSessionIds(memberToken)).toContain(sessionX)
  }, 300_000)

  it('4. sala pré-existente (dec. 2): sessão pré-entrada fora da cobertura; primeira pós-entrada deposita', async () => {
    // FATO MEDIDO nesta fatia (sonda isolada, sem cofre no caminho — §8.3): o SDK
    // pinado (41.6.0 + wasm 18.3.1) ROTACIONA a sessão outbound quando um membro novo
    // joina — a sessão viva nunca é compartilhada mid-ratchet com o entrante. O prompt
    // da fatia previa "sessão corrente pulada (contador)"; o pulo mid-ratchet não é
    // manufaturável por este fluxo e fica provado nas units (defesa-em-profundidade).
    // Aqui o invariante da dec. 2 sai na forma MAIS FORTE: a sessão pré-entrada nem
    // chega ao cofre. O assert de rotação é TRIPWIRE deliberado: se um upgrade de SDK
    // voltar a compartilhar no índice corrente, isto quebra e força re-adjudicar a
    // sub-decisão da rotação pinada (F7 → PR-4).

    // Sala SEM o cofre: a sessão nasce e vive antes da entrada dele.
    const room3 = await bornRoom([`@${MEMBER_USER}:${SERVER_NAME}`], false)
    const msgA = await sendEncrypted(emissor, room3, 'msgA-pre-cofre')
    const sessionA = await sessionIdOf(room3, msgA)

    // Cofre entra na sala PRÉ-existente (ADR-057 dec. 2)…
    await inviteUser(emissor.token, room3, COFRE_USER_ID)
    await until(
      async () => ((await memberState(emissor.token, room3, COFRE_USER_ID)) === 'join' ? true : null),
      'join do cofre na sala pré-existente',
      60_000,
    )
    await waitLocalMembership(emissor, room3, COFRE_USER_ID, ['join'])

    // …e o próximo envio nasce em sessão NOVA (rotação no join — o tripwire).
    const msgB = await sendEncrypted(emissor, room3, 'msgB-pos-entrada')
    const sessionB = await sessionIdOf(room3, msgB)
    expect(sessionB).not.toBe(sessionA)

    // Primeira sessão pós-entrada: nasce com o cofre no estado → depositada.
    await until(
      async () => ((await retrieveSessionIds(memberToken)).includes(sessionB) ? true : null),
      `depósito da primeira sessão pós-entrada (${sessionB})`,
    )

    // Cobertura começa na entrada: a sessão pré-entrada nunca foi depositada — nem
    // sequer RECEBIDA pelo agente (zero sinais dela: nem room-key, nem depósito).
    expect(await retrieveSessionIds(memberToken)).not.toContain(sessionA)
    expect(agentSignals().filter((s) => s.sessionId === sessionA)).toEqual([])
  }, 300_000)

  it('5. A3: tripwire de leave — membro humano sai, próxima sessão é NOVA (rotação no leave)', async () => {
    // Espelho do tripwire de join do teste 4 (§8.3 achado A3): o snapshot do
    // nascimento só é correto porque membership não muda DENTRO da vida de uma sessão
    // — o que exige rotação no join E no leave. Se um upgrade de SDK parar de
    // rotacionar no leave, ISTO quebra e força re-adjudicar o F5/A3.
    const memberId = `@${MEMBER_USER}:${SERVER_NAME}`
    const roomA3 = await bornRoom([memberId])
    await joinRoom(memberToken, roomA3)
    await waitLocalMembership(emissor, roomA3, memberId, ['join'])
    await until(
      async () => ((await memberState(emissor.token, roomA3, COFRE_USER_ID)) === 'join' ? true : null),
      'join do cofre na sala do tripwire',
      60_000,
    )

    const msg1 = await sendEncrypted(emissor, roomA3, 'msg1-antes-do-leave')
    const sessionA = await sessionIdOf(roomA3, msg1)

    await leaveRoom(memberToken, roomA3)
    await waitLocalMembership(emissor, roomA3, memberId, ['leave'])

    const msg2 = await sendEncrypted(emissor, roomA3, 'msg2-depois-do-leave')
    const sessionB = await sessionIdOf(roomA3, msg2)
    // O TRIPWIRE: leave rotaciona a sessão outbound.
    expect(sessionB).not.toBe(sessionA)

    // A sessão pós-leave deposita endereçada SEM quem saiu…
    await until(
      async () => ((await retrieveSessionIds(emissor.token)).includes(sessionB) ? true : null),
      `depósito da sessão pós-leave (${sessionB})`,
    )
    expect(await retrieveSessionIds(memberToken)).not.toContain(sessionB)
    // …e o leave NÃO revoga o endereçamento de nascimento da sessão anterior (F5).
    await until(
      async () => ((await retrieveSessionIds(memberToken)).includes(sessionA) ? true : null),
      `depósito da sessão pré-leave (${sessionA})`,
    )
  }, 300_000)

  it('6. A6 vivo: sala que morre antes do join → room-dead, sessões puladas, fila segue drenando', async () => {
    stopAgent()

    // A condenada nasce com o agente MORTO (o convite fica pendente), recebe uma
    // sessão via to_device (C1: invite endereça) e então TODO humano `join` sai —
    // o join do cofre vira "remoto" para o Synapse e nunca completa (§8.4 A6).
    const doomed = await bornRoom([`@${MEMBER_USER}:${SERVER_NAME}`])
    const msgD = await sendEncrypted(emissor, doomed, 'msg-na-condenada')
    const sessionD = await sessionIdOf(doomed, msgD)

    // A viva nasce DEPOIS da condenada: se a morta travasse a fila (head-of-line), a
    // viva nunca joinaria — o assert de não-starvation é a ordem.
    const alive = await bornRoom([`@${MEMBER_USER}:${SERVER_NAME}`])
    const msgL = await sendEncrypted(emissor, alive, 'msg-na-viva')
    const sessionL = await sessionIdOf(alive, msgL)

    await leaveRoom(emissor.token, doomed)

    startAgent()

    // Detecção + desistência com sinal…
    await until(
      () =>
        agentSignals().some((s) => s.evt === 'room-dead' && s.roomId === doomed) ? true : null,
      'sinal room-dead da sala condenada',
      180_000,
    )
    // …convite morto REJEITADO (sem isto o backlog de mortas re-entra na fila a cada
    // restart e re-paga o rc_joins.remote — o acúmulo que mordeu no fecho, §8.5)…
    await until(
      () =>
        agentSignals().some((s) => s.evt === 'invite-rejected' && s.roomId === doomed)
          ? true
          : null,
      'reject do convite da sala morta',
      60_000,
    )
    // …sem starvar a fila: a viva joina e a sessão dela deposita.
    await until(
      async () => ((await memberState(emissor.token, alive, COFRE_USER_ID)) === 'join' ? true : null),
      'join do cofre na sala viva',
      90_000,
    )
    await until(
      async () => ((await retrieveSessionIds(memberToken)).includes(sessionL) ? true : null),
      `depósito da sessão da sala viva (${sessionL})`,
      120_000,
    )
    // As sessões da morta saem da pendência como PULADAS (sinal), nunca depositadas —
    // material irrecuperável POR DESENHO (sem join não há /context nem snapshot).
    await until(
      () =>
        agentSignals().some(
          (s) => s.evt === 'session-skipped' && s.reason === 'room-dead' && s.sessionId === sessionD,
        )
          ? true
          : null,
      'pulo com sinal da sessão da sala morta',
      60_000,
    )
    expect(await retrieveSessionIds(memberToken)).not.toContain(sessionD)
  }, 300_000)

  it('7. F8 vivo: store corrompido → sentinela + exit; remediação atômica → device novo, zero envenenamento', async () => {
    const deviceBefore = agentSignals()
      .filter((s) => s.evt === 'identity')
      .at(-1)!.deviceId as string
    // Relativo ao RUN (mesma razão do teste 3): um run anterior do gate já deixou
    // remediation-needed/identity-reset nos logs persistentes do container.
    const storeResets = () =>
      agentSignals().filter(
        (s) =>
          s.evt === 'identity-reset' &&
          (s.reason === 'store-unusable' || s.reason === 'keys-diverged'),
      ).length
    const remediationsBefore = agentSignals().filter((s) => s.evt === 'remediation-needed').length
    const storeResetsBefore = storeResets()

    stopAgent()
    corruptAgentStore()
    startAgent()

    // O agente NÃO se auto-remedia: sinal nomeado, sentinela persistida, exit 1.
    await until(
      () =>
        agentSignals().filter((s) => s.evt === 'remediation-needed').length > remediationsBefore
          ? true
          : null,
      'sinal remediation-needed pós-corrupção',
      90_000,
    )
    expect(readAgentSentinel()).not.toBe('')
    expect(storeResets()).toBeGreaterThan(storeResetsBefore)

    // A remediação é o caminho REAL do provisionamento: mint novo → wipe → sobe,
    // numa operação só (ensure_agent_token do dev-stack.sh, via up idempotente).
    const upOut = runDevStackUp()
    expect(upOut).toContain('Sessões do cofre encerradas')
    startAgent() // zera o backoff do crash-loop, se o compose não religou ainda

    await until(
      () => {
        const ids = agentSignals().filter((s) => s.evt === 'identity')
        const last = ids.at(-1)
        return last !== undefined && last.deviceId !== deviceBefore ? true : null
      },
      'identidade NOVA (device re-mintado) pós-remediação',
      120_000,
    )
    expect(readAgentSentinel()).toBe('')
    // O kill-sessions é assíncrono do lado do MAS (SyncDevicesJob): o device velho some das
    // chaves publicadas quando o Synapse o apaga. É a única observação que esta remediação
    // muda — o device NOVO vem do mint, com ou sem kill.
    await until(
      async () => {
        const r = await rest<{ device_keys: Record<string, Record<string, unknown>> }>(
          memberToken, 'POST', '/_matrix/client/v3/keys/query', { device_keys: { [COFRE_USER_ID]: [] } },
        )
        return deviceBefore in (r.device_keys[COFRE_USER_ID] ?? {}) ? null : true
      },
      `device velho do cofre (${deviceBefore}) fora das device keys pós-kill-sessions`,
      120_000,
    )

    // Zero envenenamento: sessão NOVA pós-remediação é recebida e depositada (o
    // contraponto exato do zumbi do A1, onde nada mais chegava com check verde).
    const roomF8 = await bornRoom([`@${MEMBER_USER}:${SERVER_NAME}`])
    await until(
      async () => ((await memberState(emissor.token, roomF8, COFRE_USER_ID)) === 'join' ? true : null),
      'join do cofre pós-remediação',
      90_000,
    )
    const msgF = await sendEncrypted(emissor, roomF8, 'msg-pos-remediacao')
    const sessionF = await sessionIdOf(roomF8, msgF)
    await until(
      async () => ((await retrieveSessionIds(memberToken)).includes(sessionF) ? true : null),
      `depósito da sessão pós-remediação (${sessionF})`,
      120_000,
    )
  }, 600_000)
})
