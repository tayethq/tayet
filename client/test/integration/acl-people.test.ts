import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl, PersonExistsError } from '../../src/acl'
import type { Acl, AclTelemetry, DomainEvent, Person } from '../../src/acl'
import { mintOidcSession } from '../support/mint-oidc'
import { orgMemberKey, orgSystemSession, ORG_MEMBER_EVENT } from '../support/org-membership'
import { ESCROW_URL } from '../support/stack-env'
import { HOMESERVER, mintToken, synapseReachable } from '../support/synapse'
import { until } from '../support/until'

// Gate de integração dos verbos de Pessoas (ADR-083, P3-1): o client de `alice` (admin da org, fixture
// do dev-stack) contra o escrow, o MAS e o Synapse de verdade. Toda conta criada sai no afterAll.
// Auto-skip sem a stack (issue #7); fileParallelism:false serializa os gates.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const rand = (): string => Math.random().toString(36).slice(2, 10)
const emailOf = (): string => `pessoa-${rand()}@tayet.local`

describe.skipIf(!SYNAPSE)('gate dos verbos de Pessoas (ADR-083)', () => {
  let alice: Acl
  let bob: Acl
  let prevEscrow: string | undefined
  const events: DomainEvent[] = []
  const acls: Acl[] = []
  const created: Person['user']['id'][] = []

  async function connect(token: string): Promise<Acl> {
    const acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    acls.push(acl)
    await acl.connect(token as Parameters<Acl['connect']>[0])
    return acl
  }

  const person = (email: string): Promise<Person> =>
    until('pessoa na lista', async () => (await alice.listPeople()).find((p) => p.email === email))

  const peopleEvents = (): number => events.filter((e) => e.t === 'people.changed').length

  async function emptyEvent(mxid: string): Promise<void> {
    const { token, roomId } = await orgSystemSession()
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${ORG_MEMBER_EVENT}/${encodeURIComponent(orgMemberKey(mxid))}`
    const res = await fetch(`${HOMESERVER}${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(200)
  }

  beforeAll(async () => {
    prevEscrow = process.env.TAYET_ESCROW_URL
    process.env.TAYET_ESCROW_URL = ESCROW_URL
    alice = await connect((await mintOidcSession('alice', 'alicepass123')).accessToken)
    bob = await connect((await mintOidcSession('bob', 'bobpass123')).accessToken)
    alice.subscribe((e) => events.push(e))
    await until('lista de alice', async () => ((await alice.listPeople()).length > 0 ? true : undefined))
  }, 180_000)

  afterAll(async () => {
    for (const id of created) await alice.removePerson(id).catch(() => undefined)
    for (const acl of acls) await acl.disconnect()
    if (prevEscrow === undefined) delete process.env.TAYET_ESCROW_URL
    else process.env.TAYET_ESCROW_URL = prevEscrow
  }, 120_000)

  it('isOrgAdmin: alice sim, bob não', async () => {
    expect(await alice.isOrgAdmin()).toBe(true)
    expect(await bob.isOrgAdmin()).toBe(false)
  })

  it('member: state e convite de #all; a lista mostra pendente com nome e email', async () => {
    const email = emailOf()
    const before = peopleEvents()
    const { user, failedChannels } = await alice.invitePerson({
      name: 'Pessoa Membro',
      email,
      kind: 'member',
      channels: [],
    })
    created.push(user.id)
    expect(failedChannels).toEqual([])
    // O evento vem antes do convite: duas escritas, dois syncs.
    await until('membro pendente', async () => ((await person(email)).pending ? true : undefined))
    const listed = await person(email)
    expect(listed.self).toBe(false)
    expect(listed.user).toMatchObject({ id: user.id, displayName: 'Pessoa Membro', kind: 'member' })
    await until('people.changed', () => (peopleEvents() > before ? true : undefined))
  }, 120_000)

  it('guest com canal: addMember do admin e pendente pela membership do canal', async () => {
    const channel = await alice.createChannel({ name: `pessoas-${rand()}`, kind: 'private' })
    const email = emailOf()
    const { user, failedChannels } = await alice.invitePerson({
      name: 'Pessoa Convidada',
      email,
      kind: 'guest',
      channels: [channel],
    })
    created.push(user.id)
    expect(failedChannels).toEqual([])
    await until('guest pendente', async () => ((await person(email)).pending ? true : undefined))
    expect((await person(email)).user.kind).toBe('guest')
    await alice.leaveChannel(channel)
  }, 120_000)

  it('reexecutar: completo é PersonExistsError; com passo faltando, completa', async () => {
    const email = emailOf()
    const input = { name: 'Pessoa Parcial', email, kind: 'member' as const, channels: [] }
    const { user } = await alice.invitePerson(input)
    created.push(user.id)
    await expect(alice.invitePerson(input)).rejects.toBeInstanceOf(PersonExistsError)

    await emptyEvent(user.id as unknown as string)
    await until('pessoa fora da lista', async () =>
      (await alice.listPeople()).some((p) => p.email === email) ? undefined : true,
    )
    const again = await alice.invitePerson(input)
    expect(again.user.id).toBe(user.id)
    await person(email)
  }, 120_000)

  it('removePerson: evento vazio, some da lista, com people.changed', async () => {
    const email = emailOf()
    const { user } = await alice.invitePerson({ name: 'Pessoa Removida', email, kind: 'member', channels: [] })
    await person(email)
    const before = peopleEvents()
    await alice.removePerson(user.id)
    await until('pessoa fora da lista', async () =>
      (await alice.listPeople()).some((p) => p.email === email) ? undefined : true,
    )
    expect(peopleEvents()).toBeGreaterThan(before)
  }, 120_000)

  it.each(['member', 'guest'] as const)('1º boot de %s: currentUser traz o nome, nunca o localpart', async (kind) => {
    const name = `Pessoa Nova ${rand()}`
    const { user } = await alice.invitePerson({ name, email: emailOf(), kind, channels: [] })
    created.push(user.id)
    const localpart = (user.id as unknown as string).slice(1).split(':')[0]!
    const acl = await connect(await mintToken(localpart))
    const self = await acl.currentUser()
    expect(self.displayName).toBe(name)
    expect(self.displayName).not.toMatch(/^u-/)
  }, 120_000)
})
