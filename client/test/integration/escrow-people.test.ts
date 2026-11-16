import { execFileSync } from 'node:child_process'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mintOidcSession } from '../support/mint-oidc'
import { orgMemberKey, orgSystemSession, ORG_MEMBER_EVENT } from '../support/org-membership'
import { ESCROW_URL, MAS_CONTAINER } from '../support/stack-env'
import { HOMESERVER, synapseReachable } from '../support/synapse'

// Gate de integração do provisionamento (ADR-083 P2): o escrow de verdade, contra o MAS e o Synapse do
// stack, autenticado pela introspecção. Sem login da pessoa nova: o vínculo foi provado no §0 D2-B e a
// prova E2E é da P3. `alice` é a fixture admin da org (dev-stack.sh, promote_org_admin).
// Auto-skip sem a stack (issue #7); fileParallelism:false serializa os gates.

const SYNAPSE = synapseReachable()
const rand = (): string => Math.random().toString(36).slice(2, 10)

// A admin API do MAS só existe na rede do compose: lê pelo container do escrow, com o client dele.
function masUser(username: string): { deactivated_at: string | null } {
  const script = `
    const { ESCROW_MAS_ADMIN_CLIENT_ID: id, ESCROW_MAS_ADMIN_CLIENT_SECRET: secret } = process.env
    const auth = Buffer.from(id + ':' + secret).toString('base64')
    const { access_token } = await (await fetch('http://mas:8080/oauth2/token', {
      method: 'POST',
      headers: { authorization: 'Basic ' + auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'urn:mas:admin' }),
    })).json()
    const res = await fetch('http://mas:8081/api/admin/v1/users/by-username/${username}', {
      headers: { authorization: 'Bearer ' + access_token },
    })
    console.log(JSON.stringify((await res.json()).data.attributes))`
  const container = MAS_CONTAINER.replace('-mas-', '-escrow-')
  const out = execFileSync('docker', ['exec', container, 'node', '--input-type=module', '-e', script], {
    encoding: 'utf8',
  })
  return JSON.parse(out) as { deactivated_at: string | null }
}

describe.skipIf(!SYNAPSE)('gate do provisionamento de pessoas — escrow (ADR-083 P2)', () => {
  let alice: string
  let bob: string
  let system: { token: string; roomId: string }
  const created: string[] = []

  // Toda conta criada sai no afterAll: o convite pendente entraria no roster de #all das outras suítes.
  async function invite(token: string, email: string, name: string, kind: string): Promise<Response> {
    const res = await fetch(`${ESCROW_URL}/v1/people`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name, kind }),
    })
    if (res.status === 201) created.push(((await res.clone().json()) as { userId: string }).userId)
    return res
  }

  const remove = (token: string, mxid: string): Promise<Response> =>
    fetch(`${ESCROW_URL}/v1/people/${encodeURIComponent(mxid)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })

  async function roomState(type: string, stateKey: string): Promise<Record<string, unknown> | null> {
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(system.roomId)}/state/${type}/${encodeURIComponent(stateKey)}`
    const res = await fetch(`${HOMESERVER}${path}`, { headers: { Authorization: `Bearer ${system.token}` } })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`state ${type} -> ${res.status}`)
    return (await res.json()) as Record<string, unknown>
  }

  beforeAll(async () => {
    alice = (await mintOidcSession('alice', 'alicepass123')).accessToken
    bob = (await mintOidcSession('bob', 'bobpass123')).accessToken
    system = await orgSystemSession()
  }, 120_000)

  afterAll(async () => {
    for (const userId of created) await remove(alice, userId)
  }, 60_000)

  it('member: 201, evento com nome e email e convite de #all; reconvite é idempotente', async () => {
    const email = `probe-${rand()}@tayet.local`
    const res = await invite(alice, email, 'Probe Pessoa', 'member')
    expect(res.status).toBe(201)
    const { userId } = (await res.json()) as { userId: string }
    expect(await roomState(ORG_MEMBER_EVENT, orgMemberKey(userId))).toEqual({
      kind: 'member',
      name: 'Probe Pessoa',
      email,
    })
    expect(await roomState('m.room.member', userId)).toMatchObject({ membership: 'invite' })

    const again = await invite(alice, email, 'Probe Pessoa', 'member')
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({ reason: 'exists', userId, kind: 'member' })
  }, 60_000)

  it('guest: evento presente, sem convite de #all', async () => {
    const email = `probe-${rand()}@tayet.local`
    const res = await invite(alice, email, 'Probe Convidada', 'guest')
    expect(res.status).toBe(201)
    const { userId } = (await res.json()) as { userId: string }
    expect(await roomState(ORG_MEMBER_EVENT, orgMemberKey(userId))).toEqual({
      kind: 'guest',
      name: 'Probe Convidada',
      email,
    })
    expect(await roomState('m.room.member', userId)).toBeNull()
  }, 60_000)

  it('quem não é admin da org recebe 403 nos dois verbos', async () => {
    expect((await invite(bob, `probe-${rand()}@tayet.local`, 'Nope', 'member')).status).toBe(403)
    expect((await remove(bob, '@alice:tayet.local')).status).toBe(403)
  }, 60_000)

  it('remoção: lápide com o kind (ADR-086 dec. 4), usuário desativado no MAS, e o mesmo email pode ser reconvidado', async () => {
    const email = `probe-${rand()}@tayet.local`
    const created = await invite(alice, email, 'Probe Remoção', 'member')
    const { userId } = (await created.json()) as { userId: string }
    expect(masUser(userId.slice(1, userId.indexOf(':'))).deactivated_at).toBeNull()

    expect((await remove(alice, userId)).status).toBe(200)
    expect(await roomState(ORG_MEMBER_EVENT, orgMemberKey(userId))).toEqual({ removed: true, kind: 'member' })
    expect(masUser(userId.slice(1, userId.indexOf(':'))).deactivated_at).not.toBeNull()

    const again = await invite(alice, email, 'Probe Remoção', 'member')
    expect(again.status).toBe(201)
    expect(((await again.json()) as { userId: string }).userId).not.toBe(userId)
  }, 60_000)
})
