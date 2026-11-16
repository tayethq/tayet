import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, Channel, DomainEvent, RosterEntry } from '../../src/acl'
import { createRoom, HOMESERVER, invite, join, mintToken, synapseReachable, whoami } from '../support/synapse'
import { registerUser } from '../support/escrow-harness'
import { freshUsers, type FreshUser } from '../support/fresh-users'
import { admitToOrg } from '../support/org-membership'

// Gate de integração do `kind: 'agent'` (ADR-086, Proposto, dec. 2): uma conta com o localpart
// reservado `a-` é lida como agente por um membro (que lê #all) e por um guest (que não lê) na mesma
// sala. A conta `a-probe…` nasce aqui por `mas-cli register-user` — SÓ no teste; em produção ela nasce
// pelo escrow (fatia 2) e nenhum outro caminho cria `a-`. O membro é um usuário virgem admitido à org
// (fresh-users.ts: alice/bob compartilhados acumulam devices e arrastam o sync).
// Auto-skip sem a stack (issue #7); fileParallelism:false serializa os gates.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
const AGENT_NAME = 'Agente Probe'

async function until<T>(get: () => T | undefined | Promise<T | undefined>, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 100))
  }
}

// `a-probe` + 7 de base32 = `a-` + 12, o formato exato de ADR-086 dec. 1.
function agentLocalpart(): string {
  let tail = ''
  for (let i = 0; i < 7; i++) tail += BASE32[Math.floor(Math.random() * BASE32.length)]
  return `a-probe${tail}`
}

describe.skipIf(!SYNAPSE)('gate do kind de agente — prefixo reservado, member e guest (ADR-086)', () => {
  let member: FreshUser
  let guest: FreshUser
  let agentMxid: string
  const roomName = `agent-kind-${process.pid}`
  const acls: Acl[] = []

  async function connect(token: string, events: DomainEvent[] = []): Promise<Acl> {
    const acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    acls.push(acl)
    acl.subscribe((e) => events.push(e))
    await acl.connect(token as Parameters<Acl['connect']>[0])
    return acl
  }

  // A linha do agente é achada pelo displayname, que o teste fixa: achá-la pelo kind seria circular.
  // O nome do canal no domínio vem com o `#` da UI, daí o endsWith.
  async function agentLine(acl: Acl): Promise<RosterEntry> {
    let seen = 'no channel yet'
    try {
      return await until(async () => {
        const channels = await acl.getChannels()
        const channel = channels.find((c) => c.name.endsWith(roomName))
        if (!channel) {
          seen = `channels: ${JSON.stringify(channels.map((c) => c.name))}`
          return undefined
        }
        const roster = await acl.getMembers(channel.id)
        seen = `roster: ${JSON.stringify(roster.map((m) => [m.user.displayName, m.user.kind, m.state, m.self]))}`
        return roster.find((m) => !m.self && m.state === 'active' && m.user.displayName === AGENT_NAME)
      }, 60_000)
    } catch (err) {
      throw new Error(`agent line not found (${seen})`, { cause: err })
    }
  }

  beforeAll(async () => {
    ;[member, guest] = await freshUsers(['agkm', 'agkg'])
    await admitToOrg(member.token)
    const localpart = agentLocalpart()
    registerUser(localpart)
    const agentToken = await mintToken(localpart)
    agentMxid = await whoami(agentToken)
    const res = await fetch(`${HOMESERVER}/_matrix/client/v3/profile/${encodeURIComponent(agentMxid)}/displayname`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayname: AGENT_NAME }),
    })
    if (!res.ok) throw new Error(`displayname -> ${res.status} ${await res.text()}`)
    const roomId = await createRoom(member.token, { name: roomName })
    for (const token of [agentToken, guest.token]) {
      await invite(member.token, roomId, await whoami(token))
      await join(token, roomId)
    }
  }, 180_000)

  afterAll(async () => {
    for (const acl of acls) await acl?.disconnect()
  })

  it(
    'membro com #all lê o agente como agente, e o agente nunca é admin',
    async () => {
      const events: DomainEvent[] = []
      const acl = await connect(member.token, events)
      // Garante que o caminho com #all foi exercitado: o canal da org chegou ao stream.
      await until(() =>
        events.find((e): e is { t: 'channel.added'; channel: Channel } => e.t === 'channel.added' && e.channel.kind === 'public'),
      )
      const line = await agentLine(acl)
      expect(line.user.kind).toBe('agent')
      expect(line.role).toBe('member')
    },
    240_000,
  )

  it(
    'guest (sem #all) também lê o agente como agente',
    async () => {
      const acl = await connect(guest.token)
      const line = await agentLine(acl)
      expect(line.user.kind).toBe('agent')
      const me = await until(async () => {
        const channel = (await acl.getChannels()).find((c) => c.name.endsWith(roomName))
        return channel ? (await acl.getMembers(channel.id)).find((m) => m.self) : undefined
      })
      expect(me.user.kind).toBe('guest')
    },
    240_000,
  )
})
