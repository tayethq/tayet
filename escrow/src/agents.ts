// Provisionamento de agentes (ADR-086): o admin da org cria, remove e reemite a credencial de um
// agente. Lógica sem HTTP de entrada, no molde do people.ts: MAS, Synapse e auditoria são injetados.
// - Identidade (dec. 1): localpart `a-<12 base32>`, reservado a este caminho; sem email, sem vínculo,
//   sem senha. O display name nasce com a conta.
// - #all (dec. 3): o `system` grava `{ kind: 'agent', name, operator, color }` e NÃO convida o agente.
// - Cor (dec. 1): uma das 10 do manifesto (`account-access.md` §11.1), escolhida na criação (default
//   `areia`) e trocada só pelo admin (PATCH). Renomear segue a colisão da criação, excluindo o próprio
//   agente, e acompanha o displayname da conta por uma sessão curta do próprio agente (dec. 7
//   escopada): mint com TTL, PUT do displayname, revoke SÓ dessa sessão — a credencial em uso fica.
// - Credencial (dec. 7): personal session com device e sem expiração, devolvida UMA vez no 201;
//   nem o token nem o id da sessão são persistidos (a revogação lista por ator) nem auditados.
// - Remoção e reissue (dec. 8): revoke → deactivate → lápide; reissue = revoke → mint, nessa ordem
//   (kill→mint do F8, ADR-069 dec. 7).
// - Serialização (ADR-087 dec. 9): reissue, PATCH e remove do MESMO agente rodam um de cada vez (mutex
//   em memória por mxid); depois do mint o reissue revoga toda sessão ativa do agente menos a recém-
//   cunhada, e o self-reissue vale no máximo 1 a cada 60 s (429 `reissue_too_soon`). Mutex e contador
//   são do processo: o escrow roda como UM processo; vários processos exigiriam lock compartilhado
//   (ex.: no store ou no MAS), e o varrido pós-mint é o que ainda segura "uma sessão" nesse cenário.

import { randomInt } from 'node:crypto'
import { errorReason, type AuditLog } from './audit.ts'
import { AGENT_LOCALPART, type AgentAdmin, type PeopleAdmin } from './mas-admin.ts'
import {
  isTombstone,
  memberKey,
  ORG_MEMBER_EVENT,
  recordedKindOf,
  systemWriter,
  type Actor,
  type AsSystem,
  type PeopleResult,
} from './people.ts'
import type { OrgHomeserver } from './synapse.ts'

// As 10 cores do avatar de agente (ADR-086 dec. 1; account-access.md §11.1). O nome é o token
// `color-agent-<cor>-*` do client.
export const AGENT_COLORS = ['areia', 'petroleo', 'turquesa', 'salvia', 'ocre', 'argila', 'barro', 'malva', 'ardosia', 'grafite'] as const
export type AgentColor = (typeof AGENT_COLORS)[number]
export const DEFAULT_AGENT_COLOR: AgentColor = 'areia'
export const isAgentColor = (v: unknown): v is AgentColor => typeof v === 'string' && (AGENT_COLORS as readonly string[]).includes(v)

export interface AgentPatch {
  name?: string
  color?: AgentColor
}

export interface Agents {
  createAgent(name: string, color: AgentColor, actor: Actor): Promise<PeopleResult>
  // Só admin; `kind` e `operator` intocáveis.
  updateAgent(target: string, patch: AgentPatch, actor: Actor): Promise<PeopleResult>
  // `target` é o mxid do agente, como em DELETE /v1/people.
  removeAgent(target: string, actor: Actor): Promise<PeopleResult>
  reissueAgent(target: string, actor: Actor): Promise<PeopleResult>
}

const DEVICE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const DEVICE_LENGTH = 10

// 10 caracteres [A-Z0-9], sem viés (randomInt rejeita a sobra).
export function randomDeviceId(): string {
  return Array.from({ length: DEVICE_LENGTH }, () => DEVICE_ALPHABET[randomInt(DEVICE_ALPHABET.length)]).join('')
}

// Colisão de nome (dec. 6): caixa, acento e espaço não distinguem.
export function normalizeName(name: string): string {
  return name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

const FORBIDDEN: PeopleResult = { status: 403, body: { error: 'forbidden' } }
const NOT_AGENT: PeopleResult = { status: 400, body: { error: 'not_agent' } }
const NOT_FOUND: PeopleResult = { status: 404, body: { error: 'not_found' } }
const PROFILE_SESSION_TTL_S = 60
export const SELF_REISSUE_INTERVAL_MS = 60_000

// Mutex por chave: cada chamada espera a anterior da mesma chave. `waited` diz se houve espera (o
// audit marca `concurrent`). A cauda nunca rejeita (é a cadeia dos `release`), e a chave sai do mapa
// quando a última chamada termina.
export function keyedMutex(): <T>(key: string, fn: (waited: boolean) => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>()
  return async (key, fn) => {
    const prev = tails.get(key)
    let release!: () => void
    const mine = new Promise<void>((r) => (release = r))
    const tail = (prev ?? Promise.resolve()).then(() => mine)
    tails.set(key, tail)
    try {
      if (prev !== undefined) await prev
      return await fn(prev !== undefined)
    } finally {
      release()
      if (tails.get(key) === tail) tails.delete(key)
    }
  }
}

export function createAgents(deps: {
  masAdmin: PeopleAdmin & AgentAdmin
  synapse: OrgHomeserver
  audit: AuditLog
  randomId: () => string
  randomDevice?: () => string
  serverName: string
  asSystem?: AsSystem
  now?: () => number
}): Agents {
  const { masAdmin, synapse, audit, randomId, serverName } = deps
  const now = deps.now ?? Date.now
  const exclusive = keyedMutex()
  // Último self-reissue concluído por agente (mxid → epoch ms). Só o self conta; admin não é limitado.
  const lastSelfReissue = new Map<string, number>()
  const randomDevice = deps.randomDevice ?? randomDeviceId
  const asSystem = deps.asSystem ?? systemWriter(deps)
  const mxidOf = (username: string): string => `@${username}:${serverName}`

  // O localpart do alvo, se for um mxid de agente deste servidor.
  function agentLocalpart(target: string): string | null {
    const m = /^@([^:]+):(.+)$/.exec(target)
    return m !== null && m[2] === serverName && AGENT_LOCALPART.test(m[1]!) ? m[1]! : null
  }

  return {
    async createAgent(name, color, actor) {
      const entry = { sub: actor.sub, actor: actor.username, verb: 'agents.create' as const }
      if (!(await masAdmin.isAdmin(actor.username))) {
        await audit.record({ ...entry, outcome: 'forbidden' })
        return FORBIDDEN
      }

      // Uma leitura de #all decide as duas guardas: o operador precisa ser `member` vivo (nunca guest,
      // dec. 3) e o nome não pode colidir com nenhum `name` gravado, vivo ou em lápide (dec. 6).
      const wanted = normalizeName(name)
      const verdict = await asSystem(async (token, roomId) => {
        const members = await synapse.stateOfType(token, roomId, ORG_MEMBER_EVENT)
        const own = members.find((m) => m.stateKey === memberKey(mxidOf(actor.username)))?.content
        if (own === undefined || isTombstone(own) || recordedKindOf(own) !== 'member') return 'not_member' as const
        const taken = members.some((m) => typeof m.content.name === 'string' && normalizeName(m.content.name) === wanted)
        return taken ? ('name_taken' as const) : ('ok' as const)
      })
      if (verdict === 'not_member') {
        await audit.record({ ...entry, outcome: 'forbidden', reason: 'operator_not_member' })
        return FORBIDDEN
      }
      if (verdict === 'name_taken') {
        await audit.record({ ...entry, outcome: 'conflict', reason: 'name_taken' })
        return { status: 409, body: { reason: 'name_taken' } }
      }

      let target: string | undefined
      let userId: string | undefined
      let step = 'user'
      try {
        const user = await masAdmin.createUser(`a-${randomId()}`, name)
        target = mxidOf(user.username)
        userId = user.id
        step = 'org'
        const key = memberKey(target)
        await asSystem((token, roomId) =>
          synapse.putState(token, roomId, ORG_MEMBER_EVENT, key, { kind: 'agent', name, operator: actor.username, color }),
        )
        step = 'session'
        const deviceId = randomDevice()
        const session = await masAdmin.mintAgentSession(user.id, deviceId)
        await audit.record({ ...entry, outcome: 'created', target, kind: 'agent' })
        return { status: 201, body: { userId: target, name, color, token: session.token, deviceId } }
      } catch (err) {
        // Conta sem credencial não serve a ninguém e um retry criaria outra: desfaz (como o P2 no
        // email). Best-effort, uma tentativa; a lápide guarda o `kind` mesmo que o evento não exista.
        if (userId !== undefined && target !== undefined) {
          const created = { id: userId, mxid: target }
          await masAdmin
            .deactivate(created.id, { skipErase: true })
            .then(() =>
              asSystem((token, roomId) =>
                synapse.putState(token, roomId, ORG_MEMBER_EVENT, memberKey(created.mxid), { removed: true, kind: 'agent' }),
              ),
            )
            .then(
              () => audit.record({ ...entry, verb: 'agents.create.compensated', outcome: 'removed', target: created.mxid }),
              () => undefined,
            )
        }
        await audit.record({
          ...entry,
          outcome: 'error',
          step,
          reason: errorReason(err),
          ...(target !== undefined ? { target } : {}),
        })
        return { status: 502, body: { error: 'partial', step } }
      }
    },

    updateAgent(target, patch, actor) {
      return exclusive(target, () => update(target, patch, actor))
    },

    removeAgent(target, actor) {
      return exclusive(target, () => remove(target, actor))
    },

    reissueAgent(target, actor) {
      return exclusive(target, (waited) => reissue(target, actor, waited))
    },
  }

  async function update(target: string, patch: AgentPatch, actor: Actor): Promise<PeopleResult> {
    const fields = Object.keys(patch).sort()
    const entry = { sub: actor.sub, actor: actor.username, verb: 'agents.update' as const, target }
    if (!(await masAdmin.isAdmin(actor.username))) {
      await audit.record({ ...entry, outcome: 'forbidden' })
      return FORBIDDEN
    }
    const localpart = agentLocalpart(target)
    if (localpart === null) {
      await audit.record({ ...entry, outcome: 'bad_target', reason: 'not_agent' })
      return NOT_AGENT
    }
    const user = await masAdmin.findUserByUsername(localpart)
    if (user === null || user.deactivated) {
      await audit.record({ ...entry, outcome: 'not_found' })
      return NOT_FOUND
    }

    const key = memberKey(target)
    let step = 'org'
    try {
      // Uma leitura de #all: o evento do agente (vivo) e a colisão do nome novo, excluindo o próprio.
      const verdict = await asSystem(async (token, roomId) => {
        const members = await synapse.stateOfType(token, roomId, ORG_MEMBER_EVENT)
        const own = members.find((m) => m.stateKey === key)?.content
        if (own === undefined || isTombstone(own) || recordedKindOf(own) !== 'agent') return 'not_found' as const
        if (patch.name !== undefined) {
          const wanted = normalizeName(patch.name)
          const taken = members.some(
            (m) => m.stateKey !== key && typeof m.content.name === 'string' && normalizeName(m.content.name) === wanted,
          )
          if (taken) return 'name_taken' as const
        }
        // `kind` e `operator` vêm do gravado: o PATCH só alcança nome e cor.
        const next = {
          ...own,
          kind: 'agent',
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          color: patch.color ?? (isAgentColor(own.color) ? own.color : DEFAULT_AGENT_COLOR),
        }
        await synapse.putState(token, roomId, ORG_MEMBER_EVENT, key, next)
        return 'ok' as const
      })
      if (verdict === 'not_found') {
        await audit.record({ ...entry, outcome: 'not_found' })
        return NOT_FOUND
      }
      if (verdict === 'name_taken') {
        await audit.record({ ...entry, outcome: 'conflict', reason: 'name_taken' })
        return { status: 409, body: { reason: 'name_taken' } }
      }
      if (patch.name !== undefined) {
        // O displayname é da conta do agente: só uma sessão dele o escreve. Sessão curta, revogada
        // pelo id; nunca revokeAgentSessions, que derrubaria a credencial em uso. Sempre escreve (mesmo
        // nome igual ao gravado): um PATCH que parou aqui (502 displayname) conclui ao repetir.
        step = 'displayname'
        const session = await masAdmin.mintAgentProfileSession(user.id, PROFILE_SESSION_TTL_S)
        try {
          await synapse.setDisplayName(session.token, target, patch.name)
        } finally {
          await masAdmin.revokeSession(session.id).catch(() => undefined)
        }
      }
    } catch (err) {
      await audit.record({ ...entry, outcome: 'error', step, reason: errorReason(err) })
      return { status: 502, body: { error: 'partial', step } }
    }
    await audit.record({ ...entry, outcome: 'updated', kind: 'agent', fields })
    return { status: 200, body: { userId: target, ...patch } }
  }

  async function remove(target: string, actor: Actor): Promise<PeopleResult> {
    const entry = { sub: actor.sub, actor: actor.username, verb: 'agents.remove' as const, target }
    if (!(await masAdmin.isAdmin(actor.username))) {
      await audit.record({ ...entry, outcome: 'forbidden' })
      return FORBIDDEN
    }
    const localpart = agentLocalpart(target)
    if (localpart === null) {
      await audit.record({ ...entry, outcome: 'bad_target', reason: 'not_agent' })
      return NOT_AGENT
    }
    const user = await masAdmin.findUserByUsername(localpart)
    if (user === null) {
      await audit.record({ ...entry, outcome: 'not_found' })
      return NOT_FOUND
    }

    let step = 'session'
    try {
      await masAdmin.revokeAgentSessions(user.id)
      step = 'deactivate'
      if (!user.deactivated) await masAdmin.deactivate(user.id, { skipErase: true })
      step = 'org'
      await asSystem((token, roomId) =>
        synapse.putState(token, roomId, ORG_MEMBER_EVENT, memberKey(target), { removed: true, kind: 'agent' }),
      )
    } catch (err) {
      await audit.record({ ...entry, outcome: 'error', step, reason: errorReason(err) })
      return { status: 502, body: { error: 'partial', step } }
    }
    await audit.record({ ...entry, outcome: 'removed', kind: 'agent' })
    return { status: 200, body: { removed: true } }
  }

  async function reissue(target: string, actor: Actor, waited: boolean): Promise<PeopleResult> {
    const entry = {
      sub: actor.sub,
      actor: actor.username,
      verb: 'agents.reissue' as const,
      target,
      ...(waited ? { concurrent: true as const } : {}),
    }
    const localpart = agentLocalpart(target)
    // Self = o token do próprio agente (introspecção: username === localpart do alvo).
    const by = localpart !== null && actor.username === localpart ? ('self' as const) : ('admin' as const)
    if (by === 'admin' && !(await masAdmin.isAdmin(actor.username))) {
      await audit.record({ ...entry, outcome: 'forbidden' })
      return FORBIDDEN
    }
    if (localpart === null) {
      await audit.record({ ...entry, outcome: 'bad_target', by, reason: 'not_agent' })
      return NOT_AGENT
    }
    // ≤ 1 self-reissue por agente a cada 60 s. Dentro do mutex: a chamada concorrente com o mesmo
    // token vê o reissue que acabou de concluir e para aqui, sem cunhar uma segunda sessão.
    if (by === 'self') {
      const last = lastSelfReissue.get(target)
      const wait = last === undefined ? 0 : last + SELF_REISSUE_INTERVAL_MS - now()
      if (wait > 0) {
        await audit.record({ ...entry, outcome: 'rate_limited', by, reason: 'reissue_too_soon' })
        return {
          status: 429,
          body: { error: 'reissue_too_soon' },
          headers: { 'Retry-After': String(Math.ceil(wait / 1000)) },
        }
      }
    }
    const user = await masAdmin.findUserByUsername(localpart)
    if (user === null || user.deactivated) {
      await audit.record({ ...entry, outcome: 'not_found', by })
      return NOT_FOUND
    }

    // kill→mint: o device antigo morre antes de o novo existir. Falhar no mint deixa o agente sem
    // credencial (nunca com duas); reexecutar o reissue conclui. Depois do mint, o varrido revoga
    // toda sessão ativa do agente menos a nova: o que outro caminho cunhou entre o kill e o mint não
    // sobrevive. Se o varrido falhar, a nova também cai (best-effort): ninguém a recebeu.
    let step = 'session'
    try {
      await masAdmin.revokeAgentSessions(user.id)
      step = 'mint'
      const deviceId = randomDevice()
      const session = await masAdmin.mintAgentSession(user.id, deviceId)
      step = 'sweep'
      try {
        await masAdmin.revokeAgentSessions(user.id, { except: session.id })
      } catch (err) {
        await masAdmin.revokeSession(session.id).catch(() => undefined)
        throw err
      }
      if (by === 'self') lastSelfReissue.set(target, now())
      await audit.record({ ...entry, outcome: 'reissued', by })
      return { status: 201, body: { token: session.token, deviceId } }
    } catch (err) {
      await audit.record({ ...entry, outcome: 'error', by, step, reason: errorReason(err) })
      return { status: 502, body: { error: 'partial', step } }
    }
  }
}
