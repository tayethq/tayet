// The organization admin role: promote, demote and the access read. The role is the MAS admin flag,
// and MAS has neither a last-admin guard nor a conditional write, so the guard lives here: one
// in-process lock serializes every verb that can leave the organization without an admin (demote and
// person removal), from the caller's admin check to the write, and those verbs recount the active
// admins inside it. The guard only holds with a single org process.

import type { AuditEntry, AuditLog } from './audit.ts'
import { keyedMutex } from './agents.ts'
import type { MasUser, PeopleAdmin, RoleAdmin } from './mas-admin.ts'
import { isTombstone, memberKey, ORG_MEMBER_EVENT, recordedKindOf, SYSTEM_USERNAME, systemWriter, type Actor, type AsSystem, type PeopleResult } from './people.ts'
import type { OrgHomeserver } from './synapse.ts'

export type Serialize = <T>(fn: () => Promise<T>) => Promise<T>

// One lock per process, shared by demote, promote and person removal.
export function adminLock(): Serialize {
  const exclusive = keyedMutex()
  return (fn) => exclusive('org-admins', () => fn())
}

// The reserved agent prefix: an `a-` account is never an admin.
const AGENT_PREFIX = /^a-/

// Why a promotion was refused. `deactivated` and `not_member` are both `409 not_member` over HTTP;
// the command line names them apart.
export type PromoteRefusal = 'reserved' | 'agent' | 'not_found' | 'deactivated' | 'not_member'
export type PromoteOutcome =
  | { ok: true; username: string; changed: boolean }
  | { ok: false; refusal: PromoteRefusal }

export interface Admins {
  promote(target: string, actor: Actor): Promise<PeopleResult>
  demote(target: string, actor: Actor): Promise<PeopleResult>
  access(actor: Actor): Promise<PeopleResult>
  // The promotion rules without a caller: the recovery command of the operator.
  promoteByEmail(email: string, actor: string): Promise<PromoteOutcome>
}

const FORBIDDEN: PeopleResult = { status: 403, body: { error: 'forbidden' } }
const BAD_TARGET: PeopleResult = { status: 400, body: { error: 'bad_target' } }
const NOT_FOUND: PeopleResult = { status: 404, body: { error: 'not_found' } }

export function createAdmins(deps: {
  masAdmin: PeopleAdmin & RoleAdmin
  synapse: OrgHomeserver
  audit: AuditLog
  asSystem?: AsSystem
  serialize?: Serialize
  serverName: string
  custodyUsername: string
}): Admins {
  const { masAdmin, synapse, audit, serverName, custodyUsername } = deps
  const asSystem = deps.asSystem ?? systemWriter(deps)
  const serialize = deps.serialize ?? adminLock()
  const mxidOf = (username: string): string => `@${username}:${serverName}`
  const reserved = (username: string): boolean => username === SYSTEM_USERNAME || username === custodyUsername

  // The localpart of a mxid of this server that is not a reserved account; null otherwise.
  function localpartOf(target: string): string | null {
    const m = /^@([^:]+):(.+)$/.exec(target)
    if (m === null || m[2] !== serverName || reserved(m[1]!)) return null
    return m[1]!
  }

  // A live member of the organization: a `kind: member` record in #all that is not a tombstone. A
  // guest (with or without a record), a tombstone and a legacy `{}` record are not.
  async function isLiveMember(username: string): Promise<boolean> {
    const content = await asSystem((token, roomId) =>
      synapse.getState(token, roomId, ORG_MEMBER_EVENT, memberKey(mxidOf(username))),
    )
    return recordedKindOf(content) === 'member' && !isTombstone(content)
  }

  // The promotion rules, shared by the HTTP verb and the command line. `user` is the account when the
  // caller already looked it up.
  async function promoteAccount(username: string, user?: MasUser | null): Promise<PromoteOutcome> {
    if (reserved(username)) return { ok: false, refusal: 'reserved' }
    if (AGENT_PREFIX.test(username)) return { ok: false, refusal: 'agent' }
    const account = user === undefined ? await masAdmin.findUserByUsername(username) : user
    if (account === null) return { ok: false, refusal: 'not_found' }
    // MAS accepts set-admin on a deactivated account: the refusal has to be ours.
    if (account.deactivated || account.locked) return { ok: false, refusal: 'deactivated' }
    if (!(await isLiveMember(username))) return { ok: false, refusal: 'not_member' }
    if (account.admin) return { ok: true, username, changed: false }
    await masAdmin.setAdmin(account.id, true)
    return { ok: true, username, changed: true }
  }

  return {
    promote: (target, actor) =>
      serialize(async () => {
        const entry: Omit<AuditEntry, 'outcome'> = { sub: actor.sub, actor: actor.username, verb: 'people.promote', target }
        if (!(await masAdmin.isAdmin(actor.username))) {
          await audit.record({ ...entry, outcome: 'forbidden' })
          return FORBIDDEN
        }
        const username = localpartOf(target)
        if (username === null) {
          await audit.record({ ...entry, outcome: 'bad_target' })
          return BAD_TARGET
        }
        const outcome = await promoteAccount(username)
        if (outcome.ok) {
          await audit.record({ ...entry, outcome: outcome.changed ? 'promoted' : 'unchanged' })
          return { status: 200, body: { userId: target, admin: true } }
        }
        switch (outcome.refusal) {
          case 'reserved':
            await audit.record({ ...entry, outcome: 'bad_target' })
            return BAD_TARGET
          case 'not_found':
            await audit.record({ ...entry, outcome: 'not_found' })
            return NOT_FOUND
          case 'agent':
            await audit.record({ ...entry, outcome: 'conflict', kind: 'agent', reason: 'is_agent' })
            return { status: 409, body: { reason: 'is_agent', userId: target, kind: 'agent' } }
          default:
            await audit.record({ ...entry, outcome: 'conflict', reason: 'not_member' })
            return { status: 409, body: { reason: 'not_member', userId: target } }
        }
      }),

    demote: (target, actor) =>
      serialize(async () => {
        const entry: Omit<AuditEntry, 'outcome'> = { sub: actor.sub, actor: actor.username, verb: 'people.demote', target }
        if (!(await masAdmin.isAdmin(actor.username))) {
          await audit.record({ ...entry, outcome: 'forbidden' })
          return FORBIDDEN
        }
        const username = localpartOf(target)
        if (username === null) {
          await audit.record({ ...entry, outcome: 'bad_target' })
          return BAD_TARGET
        }
        const user = await masAdmin.findUserByUsername(username)
        if (user === null) {
          await audit.record({ ...entry, outcome: 'not_found' })
          return NOT_FOUND
        }
        const demoted = { status: 200, body: { userId: target, admin: false } }
        if (!user.admin) {
          await audit.record({ ...entry, outcome: 'unchanged' })
          return demoted
        }
        // A deactivated or locked admin is not counted, so demoting one never leaves zero.
        if (!user.deactivated && !user.locked && (await masAdmin.countActiveAdmins()) <= 1) {
          await audit.record({ ...entry, outcome: 'conflict', reason: 'last_admin' })
          return { status: 409, body: { reason: 'last_admin', userId: target } }
        }
        await masAdmin.setAdmin(user.id, false)
        await audit.record({ ...entry, outcome: 'demoted' })
        return demoted
      }),

    async access(actor) {
      const entry: Omit<AuditEntry, 'outcome'> = { sub: actor.sub, actor: actor.username, verb: 'org.access' }
      if (!(await masAdmin.isAdmin(actor.username))) {
        await audit.record({ ...entry, outcome: 'forbidden' })
        return FORBIDDEN
      }
      const [admins, users, oauth2, compat, personal] = await Promise.all([
        masAdmin.listActiveAdmins(),
        masAdmin.listActiveUsers(),
        masAdmin.listActiveOAuth2SessionUsers(),
        masAdmin.listActiveCompatSessionUsers(),
        masAdmin.listActivePersonalSessionActors(),
      ])
      // A person has access through an app session (OAuth2 or compat); a MAS browser session is only
      // the login page. An agent has access through its own personal session, whoever operates it.
      const appSession = new Set([...oauth2, ...compat])
      const agentSession = new Set(personal)
      const withoutAccess = users
        .filter((u) => !reserved(u.username))
        .filter((u) => (AGENT_PREFIX.test(u.username) ? !agentSession.has(u.id) : !appSession.has(u.id)))
        .map((u) => mxidOf(u.username))
        .sort()
      // The lists themselves stay out of the audit.
      await audit.record({ ...entry, outcome: 'ok' })
      return {
        status: 200,
        body: { admins: admins.map((u) => mxidOf(u.username)).sort(), withoutAccess },
      }
    },

    async promoteByEmail(email, actor) {
      const user = await masAdmin.findUserByEmail(email)
      const outcome = user === null ? { ok: false as const, refusal: 'not_found' as const } : await promoteAccount(user.username, user)
      const target = user === null ? undefined : mxidOf(user.username)
      const entry: Omit<AuditEntry, 'outcome'> = { actor, verb: 'people.promote', ...(target !== undefined ? { target } : {}) }
      if (outcome.ok) await audit.record({ ...entry, outcome: outcome.changed ? 'promoted' : 'unchanged' })
      else if (outcome.refusal === 'not_found') await audit.record({ ...entry, outcome: 'not_found' })
      else if (outcome.refusal === 'reserved') await audit.record({ ...entry, outcome: 'bad_target' })
      else await audit.record({ ...entry, outcome: 'conflict', reason: outcome.refusal === 'agent' ? 'is_agent' : outcome.refusal })
      return outcome
    },
  }
}
