// Provisionamento de pessoas (ADR-083): o admin da org convida e remove pessoas. Lógica sem HTTP de
// entrada: MAS, Synapse e auditoria são injetados. Quem chama é só o `sub` cujo usuário MAS tem o flag
// `admin` (dec. 7); o escrow age sobre terceiros, e por isso cada operação audita `actor` e `target`.
// `system` escreve só em #all, por personal session de 60 s, uma por operação (addendum).
// Sem rollback: uma falha depois de criar a conta é 502 com o passo, e reexecutar o convite completa
// o que falta (201 `completed`; 409 só quando nada faltava), porque o email identifica a pessoa. A
// exceção é falhar no próprio email, antes de haver o que identifique a conta: ela é desativada, numa
// tentativa só.
// O `kind` gravado em #all é imutável (ADR-086 dec. 4): vivo ou em lápide, um pedido com outro
// `kind` é recusado (409 `kind_immutable`) e agente nunca passa por aqui (409 `is_agent`). A remoção
// grava a lápide `{ removed: true, kind }`, não `{}` (revisa ADR-083 dec. 8).

import { randomBytes } from 'node:crypto'
import { errorReason, type AuditLog } from './audit.ts'
import { AGENT_LOCALPART, type MasUser, type PeopleAdmin } from './mas-admin.ts'
import type { OrgHomeserver } from './synapse.ts'

export type PersonKind = 'member' | 'guest'
// O que pode estar gravado em io.tayet.member: agentes nascem só por /v1/agents (ADR-086 dec. 1).
export type RecordedKind = PersonKind | 'agent'

// O `kind` gravado, mesmo em lápide (`{ removed: true, kind }`). null quando não há o que valha:
// evento ausente, `{}` legado, `kind` desconhecido.
export function recordedKindOf(content: Record<string, unknown> | null | undefined): RecordedKind | null {
  const kind = content?.kind
  return kind === 'member' || kind === 'guest' || kind === 'agent' ? kind : null
}

export const isTombstone = (content: Record<string, unknown> | null | undefined): boolean =>
  content?.removed === true


// Recusa por `kind` gravado; vira 409 com o motivo.
export type KindRefusal = 'kind_immutable' | 'is_agent'

export interface InviteRequest {
  email: string
  name: string
  kind: PersonKind
}

export interface Actor {
  sub: string
  username: string
}

export interface PeopleResult {
  status: number
  body: Record<string, unknown>
  headers?: Record<string, string> // ex.: Retry-After no 429 do self-reissue
}

// O que um reconvite completou numa conta existente. `email` é o do evento de #all: quem veio da
// allowlist tem conta com email no MAS e evento sem ele.
export type CompletedStep = 'email' | 'link' | 'org'

export interface People {
  me(actor: Actor): Promise<PeopleResult>
  invitePerson(request: InviteRequest, actor: Actor): Promise<PeopleResult>
  // `target` é o mxid: é o que o client tem, no state_key de io.tayet.member.
  removePerson(target: string, actor: Actor): Promise<PeopleResult>
}

const ORG_ALIAS_LOCALPART = 'all'
export const ORG_MEMBER_EVENT = 'io.tayet.member'
const MEMBERSHIP_EVENT = 'm.room.member'
export const SYSTEM_USERNAME = 'system'
const SYSTEM_SESSION_TTL_S = 60
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

// 12 caracteres base32 minúsculos: o localpart nunca carrega dado da pessoa (ADR-083 dec. 1).
export function randomLocalpart(): string {
  return Array.from(randomBytes(12), (b) => BASE32[b & 31]).join('')
}

// Sem o sigilo: o Synapse recusa state_key `@…` de outra conta (ADR-083 dec. 3).
export const memberKey = (mxid: string): string => mxid.slice(1)

// A lápide carrega o `kind` gravado; sem `kind` gravado (evento ausente ou `{}` legado) não há o que
// tornar imutável, e ela fica `{ removed: true }`.
export function tombstoneOf(current: Record<string, unknown> | null): Record<string, unknown> {
  const kind = recordedKindOf(current)
  return kind === null ? { removed: true } : { removed: true, kind }
}

const FORBIDDEN: PeopleResult = { status: 403, body: { error: 'forbidden' } }

class KindRefused extends Error {
  readonly reason: KindRefusal
  readonly recorded: RecordedKind
  constructor(reason: KindRefusal, recorded: RecordedKind) {
    super(reason)
    this.name = 'KindRefused'
    this.reason = reason
    this.recorded = recorded
  }
}

export type AsSystem = <T>(write: (token: string, roomId: string) => Promise<T>) => Promise<T>

// O `system` escrevendo em #all: uma personal session de 60 s por operação, revogada ao fim
// (ADR-083, addendum). Compartilhado por pessoas e agentes; o alias resolve uma vez por boot e a
// falha não fica em cache.
export function systemWriter(deps: { masAdmin: PeopleAdmin; synapse: OrgHomeserver; serverName: string }): AsSystem {
  const { masAdmin, synapse, serverName } = deps
  let orgRoom: Promise<string> | undefined
  function orgRoomId(): Promise<string> {
    orgRoom ??= synapse.roomIdOfAlias(`#${ORG_ALIAS_LOCALPART}:${serverName}`).catch((err: unknown) => {
      orgRoom = undefined
      throw err
    })
    return orgRoom
  }
  return async (write) => {
    const roomId = await orgRoomId()
    const session = await masAdmin.mintSystemSession(SYSTEM_SESSION_TTL_S)
    try {
      return await write(session.token, roomId)
    } finally {
      // Best-effort: o TTL fecha a sessão e o boot recolhe a linha que sobrar.
      await masAdmin.revokeSession(session.id).catch(() => undefined)
    }
  }
}

export function createPeople(deps: {
  masAdmin: PeopleAdmin
  synapse: OrgHomeserver
  audit: AuditLog
  randomId: () => string
  serverName: string
  providerId: string
  custodyUsername: string
  asSystem?: AsSystem
}): People {
  const { masAdmin, synapse, audit, randomId, serverName, providerId, custodyUsername } = deps
  const mxidOf = (username: string): string => `@${username}:${serverName}`
  const asSystem = deps.asSystem ?? systemWriter(deps)

  // true quando o vínculo faltava.
  async function ensureLink(user: MasUser, email: string): Promise<boolean> {
    const links = await masAdmin.linksOf(user.id)
    if (links.some((l) => l.providerId === providerId && l.subject === email)) return false
    await masAdmin.addUpstreamLink(user.id, providerId, email)
    return true
  }

  // Completa o que falta em #all. O `kind` gravado, vivo ou em lápide, nunca muda (ADR-086 dec. 4):
  // outro `kind` lança KindRefused ANTES de qualquer escrita; o mesmo `kind` sobre lápide é reconvite
  // e reescreve o evento sem `removed`. Não convida guest nem quem já está na sala (o Synapse recusaria).
  async function ensureOrg(
    mxid: string,
    { email, name, kind }: InviteRequest,
  ): Promise<{ kind: PersonKind; completed: CompletedStep[] }> {
    const completed = new Set<CompletedStep>()
    await asSystem(async (token, roomId) => {
      const key = memberKey(mxid)
      const current = await synapse.getState(token, roomId, ORG_MEMBER_EVENT, key)
      const recorded = recordedKindOf(current)
      if (recorded === 'agent') throw new KindRefused('is_agent', recorded)
      if (recorded !== null && recorded !== kind) throw new KindRefused('kind_immutable', recorded)
      if (current !== null && recorded !== null && !isTombstone(current)) {
        if (typeof current.email !== 'string') {
          await synapse.putState(token, roomId, ORG_MEMBER_EVENT, key, { name, ...current, email })
          completed.add('email')
        }
      } else {
        await synapse.putState(token, roomId, ORG_MEMBER_EVENT, key, { kind, name, email })
        completed.add('org')
      }
      if (kind !== 'member') return
      const membership = (await synapse.getState(token, roomId, MEMBERSHIP_EVENT, mxid))?.membership
      if (membership !== 'join' && membership !== 'invite') {
        await synapse.invite(token, roomId, mxid)
        completed.add('org')
      }
    })
    return { kind, completed: [...completed] }
  }

  // O operador gravado no evento vivo de agente em #all, como mxid deste servidor.
  async function operatorOf(username: string): Promise<string | undefined> {
    const content = await asSystem((token, roomId) =>
      synapse.getState(token, roomId, ORG_MEMBER_EVENT, memberKey(mxidOf(username))),
    )
    if (content === null || isTombstone(content) || recordedKindOf(content) !== 'agent') return undefined
    const operator = content.operator
    return typeof operator === 'string' && /^[^:@\s]+$/.test(operator) ? mxidOf(operator) : undefined
  }

  async function refused(
    entry: { sub: string; actor: string },
    verb: 'people.invite' | 'people.remove',
    target: string,
    err: KindRefused,
  ): Promise<PeopleResult> {
    await audit.record({ ...entry, verb, outcome: 'conflict', target, kind: err.recorded, reason: err.reason })
    return { status: 409, body: { reason: err.reason, userId: target, kind: err.recorded } }
  }

  return {
    async me(actor) {
      const admin = await masAdmin.isAdmin(actor.username)
      // O sidecar se reconhece pelo prefixo do próprio token (ADR-086 dec. 2) e aprende o operador
      // (PLANO-AGENTES §0.3.10 item 3): o mxid montado do localpart gravado por `system` em #all, que o
      // agente não escreve nem lê. Lápide, registro ausente ou sem `operator` → sem o campo.
      const agent = AGENT_LOCALPART.test(actor.username)
      const operator = agent ? await operatorOf(actor.username) : undefined
      await audit.record({ sub: actor.sub, actor: actor.username, verb: 'people.me', outcome: 'ok' })
      return {
        status: 200,
        body: { admin, ...(agent ? { kind: 'agent', ...(operator !== undefined ? { operator } : {}) } : {}) },
      }
    },

    async invitePerson(request, actor) {
      const entry = { sub: actor.sub, actor: actor.username }
      if (!(await masAdmin.isAdmin(actor.username))) {
        await audit.record({ ...entry, verb: 'people.invite', outcome: 'forbidden' })
        return FORBIDDEN
      }

      const { email, name, kind } = request
      let target: string | undefined
      let step = 'user'
      try {
        const existing = await masAdmin.findUserByEmail(email)
        if (existing !== null) {
          target = mxidOf(existing.username)
          // #all antes do vínculo: a recusa por `kind` gravado sai antes de qualquer escrita.
          step = 'org'
          const org = await ensureOrg(target, request)
          step = 'link'
          const linked = await ensureLink(existing, email)
          const completed: CompletedStep[] = [...(linked ? (['link'] as const) : []), ...org.completed]
          if (completed.length > 0) {
            await audit.record({ ...entry, verb: 'people.invite', outcome: 'completed', target, kind: org.kind, completed })
            return { status: 201, body: { userId: target, kind: org.kind, completed } }
          }
          await audit.record({ ...entry, verb: 'people.invite', outcome: 'exists', target, kind: org.kind })
          return { status: 409, body: { reason: 'exists', userId: target, kind: org.kind } }
        }

        const user = await masAdmin.createUser(`u-${randomId()}`, name)
        target = mxidOf(user.username)
        step = 'email'
        try {
          await masAdmin.addEmail(user.id, email)
        } catch (err) {
          // Sem email o reconvite não acharia esta conta e criaria outra: é o único passo a desfazer.
          await masAdmin.deactivate(user.id, { skipErase: true }).then(
            () => audit.record({ ...entry, verb: 'people.invite.compensated', outcome: 'removed', target }),
            () => undefined,
          )
          throw err
        }
        step = 'link'
        await masAdmin.addUpstreamLink(user.id, providerId, email)
        step = 'org'
        await ensureOrg(target, request)
        await audit.record({ ...entry, verb: 'people.invite', outcome: 'created', target, kind })
        return { status: 201, body: { userId: target, kind } }
      } catch (err) {
        if (err instanceof KindRefused && target !== undefined) return refused(entry, 'people.invite', target, err)
        await audit.record({
          ...entry,
          verb: 'people.invite.partial',
          outcome: 'error',
          kind,
          step,
          reason: errorReason(err),
          ...(target !== undefined ? { target } : {}),
        })
        return { status: 502, body: { error: 'partial', step } }
      }
    },

    async removePerson(target, actor) {
      const entry = { sub: actor.sub, actor: actor.username, verb: 'people.remove' as const, target }
      if (!(await masAdmin.isAdmin(actor.username))) {
        await audit.record({ ...entry, outcome: 'forbidden' })
        return FORBIDDEN
      }

      const username = /^@([^:]+):(.+)$/.exec(target)
      if (
        username === null ||
        username[2] !== serverName ||
        [actor.username, SYSTEM_USERNAME, custodyUsername].includes(username[1]!)
      ) {
        await audit.record({ ...entry, outcome: 'bad_target' })
        return { status: 400, body: { error: 'bad_target' } }
      }

      // Agente sai por DELETE /v1/agents, que revoga a sessão antes (ADR-086 dec. 8).
      if (AGENT_LOCALPART.test(username[1]!)) {
        return refused({ sub: actor.sub, actor: actor.username }, 'people.remove', target, new KindRefused('is_agent', 'agent'))
      }

      const user = await masAdmin.findUserByUsername(username[1]!)
      if (user === null) {
        await audit.record({ ...entry, outcome: 'not_found' })
        return { status: 404, body: { error: 'not_found' } }
      }

      let step = 'deactivate'
      try {
        await masAdmin.deactivate(user.id, { skipErase: true })
        step = 'link'
        for (const link of await masAdmin.linksOf(user.id)) await masAdmin.deleteUpstreamLink(link.id)
        step = 'org'
        await asSystem(async (token, roomId) => {
          const key = memberKey(target)
          const current = await synapse.getState(token, roomId, ORG_MEMBER_EVENT, key)
          await synapse.putState(token, roomId, ORG_MEMBER_EVENT, key, tombstoneOf(current))
        })
      } catch (err) {
        if (err instanceof KindRefused) return refused({ sub: actor.sub, actor: actor.username }, 'people.remove', target, err)
        await audit.record({ ...entry, outcome: 'error', step, reason: errorReason(err) })
        return { status: 502, body: { error: 'partial', step } }
      }
      await audit.record({ ...entry, outcome: 'removed' })
      return { status: 200, body: { removed: true } }
    },
  }
}
