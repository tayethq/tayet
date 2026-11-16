import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, Channel } from '../../src/acl'
import { HOMESERVER, mintToken, synapseReachable } from '../support/synapse'
import { freshUsers, type FreshUser } from '../support/fresh-users'
import { admitToOrg } from '../support/org-membership'

// Gate de integração da entrada de sessão no canal da organização (ADR-045, por convite desde o ADR-083).
// A VARIÁVEL NOVEL: um usuário FRESCO (zero salas, zero devices — fresh-users), convidado, conecta e, sem nenhum verbo de UI, passa a ver
// o canal da org como Channel comum de kind 'public' entregue pelo stream existente (channel.added da
// transição →join; ADR-026). E o join é IDEMPOTENTE: uma segunda sessão do MESMO usuário não duplica a
// membership. O teste asserta pelo SHAPE DE DOMÍNIO (kind, nome exibido não-vazio) — nunca pelo alias/
// domínio (P1: o literal de protocolo fica confinado ao acl/internal). Um usuário fresco só junta o que
// ele mesmo cria; sem criar nada, a ÚNICA sala que aparece é o canal da org.
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

describe.skipIf(!SYNAPSE)('gate join de sessão do canal da org — entrega + idempotência (ADR-045)', () => {
  // Provisão DENTRO do beforeAll (não em escopo de módulo/describe), espelhando o acl-create: o corpo
  // do describe roda em collection-time mesmo quando skipIf pula os testes, então freshUsers() —
  // que executa `docker exec … register-user` via registerUser — só pode rodar sob a stack, dentro do
  // beforeAll (que não roda quando o describe é pulado). Assim o gate auto-skipa limpo sem a stack.
  let alice: FreshUser
  const acls: Acl[] = []

  beforeAll(async () => {
    ;[alice] = await freshUsers(['orgc'])
    await admitToOrg(alice.token)
  }, 120_000)

  // Cada sessão é um device novo: o 1º connect usa o token do freshUsers, os seguintes cunham outro.
  // Reusar o MESMO token num client novo (store de cripto de memória, vazio) é o wipe parcial que o
  // ADR-062 D2 encerra com SessionExpiredError — não é "segunda sessão", é o mesmo device sem a conta.
  async function connectFresh(): Promise<Acl> {
    const acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    acls.push(acl)
    const token = acls.length === 1 ? alice.token : await mintToken(alice.name)
    await acl.connect(token as Parameters<Acl['connect']>[0])
    return acl
  }

  afterAll(async () => {
    for (const acl of acls) await acl?.disconnect()
  })

  it(
    'usuário fresco conecta → o canal da org chega ao stream como Channel público (nome exibido não-vazio)',
    async () => {
      const acl = await connectFresh()
      // O join é fire-and-forget pós-PREPARED; o canal aterra pela transição →join. Espera o snapshot
      // conter EXATAMENTE um canal público (o fresco não tem outra sala) com nome exibido.
      const org = await until<Channel>(async () => {
        const publics = (await acl.getChannels()).filter((c) => c.kind === 'public')
        return publics.length === 1 ? publics[0] : undefined
      })
      expect(org.kind).toBe('public')
      expect(org.name.length).toBeGreaterThan(0)
    },
    240_000,
  )

  it(
    'segunda sessão do MESMO usuário não duplica — segue com UM canal da org (idempotência)',
    async () => {
      const acl = await connectFresh()
      // Idempotência por construção (join de sala já-joinada = no-op server-side): a segunda sessão
      // continua com um único canal público, nunca dois.
      const publics = await until(async () => {
        const ps = (await acl.getChannels()).filter((c) => c.kind === 'public')
        return ps.length >= 1 ? ps : undefined
      })
      expect(publics.length).toBe(1)
    },
    240_000,
  )
})
