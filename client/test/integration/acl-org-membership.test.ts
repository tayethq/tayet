import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, Channel, DomainEvent } from '../../src/acl'
import { HOMESERVER, join, synapseReachable, whoami } from '../support/synapse'
import { freshUsers, type FreshUser } from '../support/fresh-users'
import { admitToOrg, orgSystemSession, putOrgMember } from '../support/org-membership'

// Gate de integração do pertencimento à org (ADR-083 Conformidade). A fronteira é do SERVIDOR: #all
// recusa quem não foi convidado e io.tayet.member só aceita o `system`, e isso se prova com a API crua.
// Do lado do client, o convite pendente vira channel.added uma vez; sem convite, nada: é um guest, e
// guest só sabe de si.
// Auto-skip sem a stack (issue #7); fileParallelism:false serializa os gates.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

async function until<T>(get: () => T | undefined | Promise<T | undefined>, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe.skipIf(!SYNAPSE)('gate do pertencimento à org — #all por convite e kind (ADR-083)', () => {
  let member: FreshUser
  let guest: FreshUser
  let roomId: string
  let systemToken: string
  const acls: Acl[] = []

  async function connect(token: string, events: DomainEvent[]): Promise<Acl> {
    const acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    acls.push(acl)
    acl.subscribe((e) => events.push(e))
    await acl.connect(token as Parameters<Acl['connect']>[0])
    return acl
  }

  const publicAdds = (events: DomainEvent[]): Channel[] =>
    events.flatMap((e) => (e.t === 'channel.added' && e.channel.kind === 'public' ? [e.channel] : []))

  beforeAll(async () => {
    ;[member, guest] = await freshUsers(['orgmm', 'orgmg'])
    ;({ token: systemToken, roomId } = await orgSystemSession())
  }, 120_000)

  afterAll(async () => {
    for (const acl of acls) await acl?.disconnect()
  })

  it('conta sem convite não entra pelo servidor: 403', async () => {
    await expect(join(guest.token, roomId)).rejects.toThrow('403')
  })

  it('io.tayet.member recusa quem não é o system, inclusive sobre si mesmo', async () => {
    const mxid = await whoami(member.token)
    expect(await putOrgMember(member.token, roomId, mxid)).toBe(403)
    expect(await putOrgMember(systemToken, roomId, mxid)).toBe(200)
  })

  it(
    'boot com convite pendente: o canal da org chega ao stream uma vez e a própria pessoa é membro',
    async () => {
      await admitToOrg(member.token)
      const events: DomainEvent[] = []
      const acl = await connect(member.token, events)
      const org = await until(() => publicAdds(events)[0])
      expect(org.kind).toBe('public')
      const roster = await until(async () => {
        const ms = await acl.getMembers(org.id)
        return ms.some((m) => m.self && m.state === 'active') ? ms : undefined
      })
      const me = roster.find((m) => m.self)
      expect(me?.user.kind).toBe('member')
      expect(me?.role).toBe('member')
      // A conta de sistema é dona do canal e não aparece nele (ADR-083 dec. 5).
      expect(roster.some((m) => m.user.displayName === 'system')).toBe(false)
      await new Promise((r) => setTimeout(r, 1_000))
      expect(publicAdds(events)).toHaveLength(1)
    },
    240_000,
  )

  it(
    'boot sem convite: nenhum canal da org, e guest é guest até com PL de dono',
    async () => {
      const events: DomainEvent[] = []
      const acl = await connect(guest.token, events)
      await new Promise((r) => setTimeout(r, 3_000))
      expect(publicAdds(events)).toHaveLength(0)
      expect((await acl.getChannels()).filter((c) => c.kind === 'public')).toHaveLength(0)

      // O próprio criador do canal, com PL de dono, é guest no roster dele: guest vem de kind.
      const channel = await acl.createChannel({ name: 'guest-room', kind: 'public' })
      const roster = await until(async () => {
        const known = (await acl.getChannels()).some((c) => c.id === channel)
        const ms = known ? await acl.getMembers(channel) : []
        return ms.length > 0 ? ms : undefined
      })
      const me = roster.find((m) => m.self)
      expect(me?.role).toBe('guest')
      expect(me?.user.kind).toBe('guest')
    },
    240_000,
  )
})
