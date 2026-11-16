import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, Channel, User, UserId } from '../../src/acl'
import { HOMESERVER, synapseReachable, mintToken } from '../support/synapse'
import { freshUsers, type FreshUser } from '../support/fresh-users'
import { admitToOrg } from '../support/org-membership'

// Gate de integração da camada organizacional do perfil (ADR-054). Fecha o laço WRITER→READER: o
// writer é o sync de diretório out-of-band que roda no `up` do dev-stack (PR-1), e o que se prova aqui
// é que o reader desta fatia lê de volta EXATAMENTE o que aquele writer escreveu, contra os fixtures
// versionados do infra/dev-stack/directory.tsv. Nenhum passo do teste escreve a camada — se escrevesse,
// o laço não estaria fechado, estaria curto-circuitado.
//
// Os três sujeitos cobrem os três estados que o TSV declara:
//   alice → linha completa           → org presente com os três campos
//   bob   → job_title VAZIO no TSV   → org presente, jobTitle AUSENTE (o sync APAGA a chave; é a prova
//                                      de que ausência declarada vira ausência, e não '')
//   fresco→ sem linha nenhuma        → org ausente por INTEIRO
//
// LEITOR: um usuário diferente de todos os alvos. Sob ADR-052 (limit_profile_requests_to_users_who_
// share_rooms) a leitura de perfil estendido exige sala em comum; todo mundo auto-entra no canal da org
// no connect (ADR-045), então conectar cada sujeito É o que estabelece a sala em comum. Medido no §0
// desta fatia: bob com joined_rooms vazio (nunca conectou por cliente ACL) devolve 403 pro leitor.
//
// Isso importa pro assert do fresco: um 403 cairia no catch de fallback de room-state, que TAMBÉM
// produz org undefined — o teste passaria pelo motivo errado. Por isso o fresco é conectado como os
// outros E marcado com um pronome auto-autorado: ver esse pronome de volta é o que prova que a
// leitura ESTENDIDA respondeu. displayName não serviria — o fallback também devolve nome não-vazio.
//
// P1: nenhum mxid nem alias aparece aqui. Os UserId dos alvos vêm do roster do próprio canal (User.id
// brandado), que é também o que prova a sala em comum.
//
// Auto-skip sem a stack (issue #7); fileParallelism:false serializa os gates.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

// Fixtures do infra/dev-stack/directory.tsv. Duplicados de propósito: se alguém editar o TSV sem
// atualizar aqui, o gate cai — é o ponto do teste de laço fechado.
const ALICE_ORG = {
  fullName: 'Alice Alves',
  jobTitle: 'Engenheira de Plataforma',
  workEmail: 'alice@tayet.local',
}
const BOB_ORG = { fullName: 'Bob Barros', workEmail: 'bob@tayet.local' }

async function until<T>(get: () => T | undefined | Promise<T | undefined>, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe.skipIf(!SYNAPSE)('gate da camada organizacional do perfil — writer→reader (ADR-054)', () => {
  // Provisão DENTRO do beforeAll (não em escopo de módulo/describe), espelhando o acl-org-channel: o
  // corpo do describe roda em collection-time mesmo quando skipIf pula os testes, então freshUsers()
  // e mintToken() — que executam `docker exec` — só podem rodar sob a stack, dentro do beforeAll (que
  // não roda quando o describe é pulado). É isso que faz o gate auto-skipar limpo sem a stack.
  let reader: Acl
  let orgChannel: Channel
  let roster: Array<{ user: User; role: unknown; state: unknown }>
  const acls: Acl[] = []

  async function connect(token: string): Promise<Acl> {
    const acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    acls.push(acl)
    await acl.connect(token as Parameters<Acl['connect']>[0])
    return acl
  }

  let noLine: FreshUser

  beforeAll(async () => {
    const [rdr, nl] = await freshUsers(['orgpr', 'orgpn'])
    noLine = nl
    await admitToOrg(rdr.token, nl.token)

    // Conectar CADA sujeito é o que dispara o auto-join do canal da org (ADR-045) e, com ele, a sala
    // em comum que o ADR-052 exige do leitor. alice e bob são os usuários persistentes do dev-stack,
    // os mesmos que o directory.tsv nomeia; o token sai do mesmo mint dos frescos.
    await connect(await mintToken('alice'))
    await connect(await mintToken('bob'))
    const noLineAcl = await connect(nl.token)

    // O usuário sem linha no diretório escreve um PRONOME em si mesmo — campo auto-autorado, sink
    // vizinho ao da camada org no mesmo documento estendido. É o discriminador do terceiro teste:
    // se o leitor enxerga este pronome, a leitura estendida COMPROVADAMENTE respondeu, e o org
    // undefined que se assere ali é ausência real, não um 403 disfarçado pelo fallback. (displayName
    // não serve pra isso: o fallback de room-state também devolve um nome não-vazio.)
    await noLineAcl.updateMyProfile({ pronouns: 'ele/dele' })

    reader = await connect(rdr.token)

    // O canal da org é o único público que um leitor fresco enxerga (ele não criou nada).
    orgChannel = await until<Channel>(async () => {
      const publics = (await reader.getChannels()).filter((c) => c.kind === 'public')
      return publics.length === 1 ? publics[0] : undefined
    })

    // Espera o roster convergir com os três alvos + o leitor. É este await que prova a sala em comum:
    // sem ele a leitura de perfil daria 403 e cairia no fallback, mascarando tudo.
    roster = await until(async () => {
      const ms = await reader.getMembers(orgChannel.id)
      const names = new Set(ms.map((m) => m.user.displayName))
      return names.has('alice') && names.has('bob') && names.has(noLine.name) ? ms : undefined
    })
  }, 300_000)

  afterAll(async () => {
    for (const acl of acls) await acl?.disconnect()
  })

  function idOf(displayName: string): UserId {
    const m = roster.find((r) => r.user.displayName === displayName)
    if (!m) throw new Error(`alvo ${displayName} ausente do roster`)
    return m.user.id
  }

  it(
    'sujeito com linha completa no diretório → org presente, authority directory, os três campos batendo com o TSV',
    async () => {
      const profile = await reader.getUserProfile(idOf('alice'))
      expect(profile.org).toBeDefined()
      expect(profile.org?.authority).toBe('directory')
      expect(profile.org?.fullName).toBe(ALICE_ORG.fullName)
      expect(profile.org?.jobTitle).toBe(ALICE_ORG.jobTitle)
      expect(profile.org?.workEmail).toBe(ALICE_ORG.workEmail)
    },
    240_000,
  )

  it(
    'sujeito com campo VAZIO no TSV → org presente, e o campo apagado vem AUSENTE (não string vazia)',
    async () => {
      const profile = await reader.getUserProfile(idOf('bob'))
      expect(profile.org).toBeDefined()
      expect(profile.org?.fullName).toBe(BOB_ORG.fullName)
      expect(profile.org?.workEmail).toBe(BOB_ORG.workEmail)
      // O CORAÇÃO deste teste: o sync APAGA a chave quando o campo vem vazio, em vez de gravar ''.
      // undefined e '' são coisas diferentes na tela — '' renderiza um rótulo com valor em branco.
      expect(profile.org?.jobTitle).toBeUndefined()
      expect(profile.org?.jobTitle).not.toBe('')
    },
    240_000,
  )

  it(
    'sujeito SEM linha no diretório → org ausente por inteiro',
    async () => {
      const profile = await reader.getUserProfile(idOf(noLine.name))
      // Primeiro o discriminador: o pronome auto-autorado no beforeAll só chega aqui se a leitura
      // ESTENDIDA respondeu. Sem ele, um 403 do ADR-052 cairia no fallback de room-state — que também
      // devolve org undefined — e o assert seguinte passaria por engano.
      expect(profile.pronouns).toBe('ele/dele')
      // Só então a ausência significa alguma coisa: o documento existe e NÃO tem camada org.
      expect(profile.org).toBeUndefined()
    },
    240_000,
  )
})
