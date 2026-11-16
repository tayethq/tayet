import { describe, it, expect, vi } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry } from '../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'

// P1 boundary assert for getMyProfile()/updateMyProfile() (ADR-040 → ADR-042 → ADR-053). fullName is
// the org-managed name (a displayName snapshot, cleaned so it can never be an mxid), nickname is
// self-authored, pronouns and note live in the extended profile (MSC4133, io.tayet.pronouns /
// io.tayet.note — same sink, distinct keys) — all clean
// strings, no protocol shape. The account-data key, the extended-profile keys, and the mxid stay
// confined to acl/internal. UNIT harness with a fake SDK client (mirrors current-user.test.ts), so it
// runs in CI; the live read-back rides the flaky integration suite (#7), not this gate.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const MXID = '@alice:tayet.local'

function gatewayWith(opts: {
  rawDisplayName?: string
  accountData?: Record<string, unknown>
  userId?: string | null
  pronouns?: string
  note?: string
  // O perfil estendido só rejeita quando o servidor está fora ou o usuário não existe — nunca por
  // "nada setado" (§0 desta trilha, medido: GET /profile/@alice → 200 {"displayname":"alice"}, enquanto
  // GET /profile/@alice/io.tayet.pronouns → 404). Este opt é o ÚNICO jeito de exercitar o fail-soft.
  extUnavailable?: boolean
  // ADR-054: as chaves da camada organizacional, cruas, pro documento estendido. Cru de propósito —
  // é o writer out-of-band que as escreve, então o teste imita o documento do servidor, não um shape
  // de domínio.
  orgDoc?: Record<string, unknown>
}): {
  gateway: MatrixGateway
  setDisplayName: ReturnType<typeof vi.fn>
  setAccountData: ReturnType<typeof vi.fn>
  setExtendedProfileProperty: ReturnType<typeof vi.fn>
  deleteExtendedProfileProperty: ReturnType<typeof vi.fn>
  getExtendedProfile: ReturnType<typeof vi.fn>
} {
  const setDisplayName = vi.fn(async () => ({}))
  const setAccountData = vi.fn(async () => ({}))
  const setExtendedProfileProperty = vi.fn(async () => ({}))
  const deleteExtendedProfileProperty = vi.fn(async () => ({}))
  // O perfil estendido é um DOCUMENTO (getExtendedProfile), não uma propriedade por vez: getMyProfile
  // traz pronomes + recado numa volta (ADR-053). Para usuário que existe o documento SEMPRE resolve —
  // ele carrega o displayname mesmo sem nenhuma chave nossa. Medido no §0 desta trilha:
  // GET /profile/@alice → 200 {"displayname":"alice"}; é a PROPRIEDADE que dá 404, não o documento.
  // Chave ausente vira `undefined` no type check, não exceção — esse é o caminho do dia 1.
  // Rejeição = servidor fora / usuário inexistente: só sob extUnavailable (o fail-soft, P4).
  // (O documento real também traz avatar_url; a impl não o lê daqui — ADR-041 usa getUser.)
  const getExtendedProfile = vi.fn(async () => {
    if (opts.extUnavailable) throw new Error('M_NOT_FOUND')
    const doc: Record<string, unknown> = {}
    if (opts.rawDisplayName != null) doc.displayname = opts.rawDisplayName
    if (opts.pronouns != null) doc['io.tayet.pronouns'] = opts.pronouns
    if (opts.note != null) doc['io.tayet.note'] = opts.note
    if (opts.orgDoc) Object.assign(doc, opts.orgDoc)
    return doc
  })
  const fakeClient = {
    getUserId: () => (opts.userId === undefined ? MXID : opts.userId),
    // ADR-086 dec. 6: the nickname refusal reads the agents this session knows (none here).
    getRooms: () => [],
    getUser: (_id: string) => ({ rawDisplayName: opts.rawDisplayName }),
    getProfileInfo: () => Promise.reject(new Error('down')),
    getAccountData: (_type: string) =>
      opts.accountData ? { getContent: () => opts.accountData } : undefined,
    setAccountData,
    setDisplayName,
    setExtendedProfileProperty,
    deleteExtendedProfileProperty,
    getExtendedProfile,
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  return {
    gateway,
    setDisplayName,
    setAccountData,
    setExtendedProfileProperty,
    deleteExtendedProfileProperty,
    getExtendedProfile,
  }
}

describe('getMyProfile()/updateMyProfile() boundary (ADR-040 → ADR-042 → ADR-053)', () => {
  it('virgin account: fullName tracks the live displayName, nickname absent — no protocol leak', async () => {
    const { gateway } = gatewayWith({ rawDisplayName: 'Alice Stone' })
    const profile = await gateway.getMyProfile()
    expect(profile.fullName).toBe('Alice Stone')
    expect(profile.nickname).toBeUndefined()
    expect(findProtocolLeaks(profile)).toEqual([])
  })

  it('stored snapshot + nickname: returns both, no leak', async () => {
    const { gateway } = gatewayWith({
      rawDisplayName: 'Apelido', // displayName já foi sobrescrito pelo apelido
      accountData: { fullName: 'Alice Stone', nickname: 'Apelido' },
    })
    const profile = await gateway.getMyProfile()
    expect(profile.fullName).toBe('Alice Stone')
    expect(profile.nickname).toBe('Apelido')
    expect(findProtocolLeaks(profile)).toEqual([])
  })

  it('updateMyProfile({ nickname }) captures fullName from displayName on first write, then sets the effective name — extended profile untouched', async () => {
    const { gateway, setDisplayName, setAccountData, setExtendedProfileProperty, deleteExtendedProfileProperty } =
      gatewayWith({ rawDisplayName: 'Alice Stone' })
    await gateway.updateMyProfile({ nickname: 'Ali' })
    // account-data escrito com o snapshot do nome da org + o apelido
    const written = setAccountData.mock.calls[0]?.[1] as Record<string, unknown>
    expect(written.fullName).toBe('Alice Stone')
    expect(written.nickname).toBe('Ali')
    expect(findProtocolLeaks(written)).toEqual([])
    // displayName efetivo = apelido
    expect(setDisplayName).toHaveBeenCalledWith('Ali')
    // patch só de nickname NÃO toca o perfil estendido (ADR-042, fan-out por presença de chave)
    expect(setExtendedProfileProperty).not.toHaveBeenCalled()
    expect(deleteExtendedProfileProperty).not.toHaveBeenCalled()
  })

  it('clearing the nickname reverts displayName to the stored fullName', async () => {
    const { gateway, setDisplayName, setAccountData } = gatewayWith({
      rawDisplayName: 'Ali',
      accountData: { fullName: 'Alice Stone', nickname: 'Ali' },
    })
    await gateway.updateMyProfile({ nickname: '' })
    const written = setAccountData.mock.calls[0]?.[1] as Record<string, unknown>
    expect(written.fullName).toBe('Alice Stone')
    expect(written.nickname).toBeUndefined()
    expect(setDisplayName).toHaveBeenCalledWith('Alice Stone')
  })

  it('fullName is never an mxid — an mxid-shaped displayName collapses to the localpart', async () => {
    const { gateway } = gatewayWith({ rawDisplayName: MXID })
    const profile = await gateway.getMyProfile()
    expect(profile.fullName).toBe('alice')
    expect(profile.fullName).not.toContain('@')
    expect(profile.fullName).not.toContain(':')
    expect(findProtocolLeaks(profile)).toEqual([])
  })

  // ADR-042: pronomes via perfil estendido (MSC4133). Sink distinto do account-data; fan-out por presença
  // de chave no patch; leitura fail-soft. A chave io.tayet.pronouns fica confinada à ACL (asserts pelo valor
  // literal — este é um teste de fronteira já dentro do território interno via MatrixGateway).
  it('getMyProfile returns pronouns when the extended property exists — no protocol leak', async () => {
    const { gateway } = gatewayWith({ rawDisplayName: 'Alice Stone', pronouns: 'they/them' })
    const profile = await gateway.getMyProfile()
    expect(profile.pronouns).toBe('they/them')
    expect(findProtocolLeaks(profile)).toEqual([])
  })

  it('getMyProfile fail-soft: extended profile unavailable (reject) → pronouns undefined, no throw, no leak', async () => {
    // servidor fora / usuário inexistente — o único caso em que o documento rejeita
    const { gateway } = gatewayWith({ rawDisplayName: 'Alice Stone', extUnavailable: true })
    const profile = await gateway.getMyProfile()
    expect(profile.pronouns).toBeUndefined()
    expect(findProtocolLeaks(profile)).toEqual([])
  })

  it('updateMyProfile({ pronouns }) writes the extended property and does not touch displayName/account-data', async () => {
    const { gateway, setDisplayName, setAccountData, setExtendedProfileProperty } = gatewayWith({
      rawDisplayName: 'Alice Stone',
    })
    await gateway.updateMyProfile({ pronouns: 'they/them' })
    expect(setExtendedProfileProperty).toHaveBeenCalledWith('io.tayet.pronouns', 'they/them')
    expect(setDisplayName).not.toHaveBeenCalled()
    expect(setAccountData).not.toHaveBeenCalled()
  })

  it('updateMyProfile({ pronouns: "" }) deletes the extended property', async () => {
    const { gateway, setExtendedProfileProperty, deleteExtendedProfileProperty } = gatewayWith({
      rawDisplayName: 'Alice Stone',
    })
    await gateway.updateMyProfile({ pronouns: '' })
    expect(deleteExtendedProfileProperty).toHaveBeenCalledWith('io.tayet.pronouns')
    expect(setExtendedProfileProperty).not.toHaveBeenCalled()
  })

  it('updateMyProfile({ pronouns }) does NOT touch the note property — the two extended keys are independent', async () => {
    const { gateway, setExtendedProfileProperty, deleteExtendedProfileProperty } = gatewayWith({
      rawDisplayName: 'Alice Stone',
    })
    await gateway.updateMyProfile({ pronouns: 'they/them' })
    // Um patch só de pronomes escreve UMA propriedade — a de pronomes. O recado fica intacto.
    expect(setExtendedProfileProperty).toHaveBeenCalledTimes(1)
    expect(setExtendedProfileProperty).toHaveBeenCalledWith('io.tayet.pronouns', 'they/them')
    expect(deleteExtendedProfileProperty).not.toHaveBeenCalled()
  })

  // ADR-053: recado no MESMO sink dos pronomes (perfil estendido, classe (c) — não classe nova).
  // Mesmo fan-out por presença de chave, mesma leitura fail-soft. Os asserts negativos nos dois
  // sentidos são o gate: uma chave no patch nunca mexe na outra.
  it('getMyProfile returns note when the extended property exists — no protocol leak', async () => {
    const { gateway } = gatewayWith({ rawDisplayName: 'Alice Stone', note: 'em foco até quinta' })
    const profile = await gateway.getMyProfile()
    expect(profile.note).toBe('em foco até quinta')
    expect(findProtocolLeaks(profile)).toEqual([])
  })

  it('getMyProfile fail-soft: extended profile rejects → note undefined, no throw, no leak', async () => {
    // servidor fora / usuário inexistente — o único caso em que o documento rejeita
    const { gateway } = gatewayWith({ rawDisplayName: 'Alice Stone', extUnavailable: true })
    const profile = await gateway.getMyProfile()
    expect(profile.note).toBeUndefined()
    expect(findProtocolLeaks(profile)).toEqual([])
  })

  // Todo usuário antes de escrever qualquer coisa nossa: o documento resolve com SÓ o displayname.
  // Seja honesto sobre o que este teste guarda. O assert do `mock.results` é um PIN DE FIDELIDADE DO
  // FAKE — prova que o fake devolve o documento que o servidor medido devolve (200 {"displayname"}),
  // e não o reject que o método antigo (getExtendedProfileProperty, 404) dava. Os asserts de
  // pronouns/note NÃO discriminam doc-path de catch-path: o catch engole tudo e produz `undefined`
  // igual, então sozinhos passariam com o fake mentindo. Quem prova que a impl não LANÇA lendo
  // documento parcial é o teste de dia N logo abaixo ({pronouns} sem note): lá o `pronouns` CHEGA, e
  // não chegaria se algo tivesse estourado dentro do try.
  it('getMyProfile: documento estendido só com displayname (dia 1) → pronouns e note undefined, sem rejeitar', async () => {
    const { gateway, getExtendedProfile } = gatewayWith({ rawDisplayName: 'Alice Stone' })
    const profile = await gateway.getMyProfile()
    expect(profile.pronouns).toBeUndefined()
    expect(profile.note).toBeUndefined()
    expect(profile.fullName).toBe('Alice Stone') // o documento estendido não contamina o account-data
    // O pin: o documento RESOLVE com só o displayname — não rejeita.
    await expect(getExtendedProfile.mock.results[0]!.value).resolves.toEqual({ displayname: 'Alice Stone' })
    expect(findProtocolLeaks(profile)).toEqual([])
  })

  // DIA N (o dia 1 é o teste acima: documento só com displayname): a pessoa já tem pronomes, mas a
  // chave do recado ainda não foi escrita — documento PARCIAL. Ao ler o documento inteiro em vez de
  // uma propriedade por vez, "chave ausente" deixou de ser o catch e virou o type check.
  // Este é o teste que prova que a impl não estoura lendo documento parcial: o assert de `pronouns`
  // é o gate, porque o valor CHEGA — e não chegaria se algo tivesse rompido dentro do try. O teste
  // de dia 1 acima não consegue provar isso (undefined é o mesmo pelos dois caminhos); ele pina a
  // fidelidade do fake. Os dois são necessários e provam coisas diferentes.
  it('getMyProfile: documento estendido presente com pronomes e SEM note → note undefined, pronouns intacto (dia N)', async () => {
    const { gateway } = gatewayWith({
      rawDisplayName: 'Apelido', // displayName já foi sobrescrito pelo apelido
      accountData: { fullName: 'Alice Stone', nickname: 'Apelido' },
      pronouns: 'ela/dela', // note omitido → documento PARCIAL: resolve, sem a chave do recado
    })
    const profile = await gateway.getMyProfile()
    expect(profile.note).toBeUndefined()
    expect(profile.pronouns).toBe('ela/dela') // a chave ausente não leva a irmã junto
    // O documento estendido não contamina o account-data.
    expect(profile.fullName).toBe('Alice Stone')
    expect(profile.nickname).toBe('Apelido')
    expect(findProtocolLeaks(profile)).toEqual([])
  })

  it('getMyProfile reads pronouns and note in one round-trip — each value validated on its own', async () => {
    const { gateway, getExtendedProfile } = gatewayWith({
      rawDisplayName: 'Alice Stone',
      pronouns: 'ela/dela',
      note: 'em foco até quinta',
    })
    const profile = await gateway.getMyProfile()
    expect(profile.pronouns).toBe('ela/dela')
    expect(profile.note).toBe('em foco até quinta')
    expect(getExtendedProfile).toHaveBeenCalledTimes(1) // o documento é UMA volta, não uma por chave
    expect(findProtocolLeaks(profile)).toEqual([])
  })

  it('updateMyProfile({ note }) writes the extended property and does not touch displayName/account-data/pronouns', async () => {
    const { gateway, setDisplayName, setAccountData, setExtendedProfileProperty, deleteExtendedProfileProperty } =
      gatewayWith({ rawDisplayName: 'Alice Stone' })
    await gateway.updateMyProfile({ note: 'em foco até quinta' })
    // Escreve UMA propriedade — a do recado. Nunca a de pronomes.
    expect(setExtendedProfileProperty).toHaveBeenCalledTimes(1)
    expect(setExtendedProfileProperty).toHaveBeenCalledWith('io.tayet.note', 'em foco até quinta')
    // Fan-out negativo: o recado não toca o nome (account-data) nem o displayName efetivo.
    expect(setDisplayName).not.toHaveBeenCalled()
    expect(setAccountData).not.toHaveBeenCalled()
    expect(deleteExtendedProfileProperty).not.toHaveBeenCalled()
  })

  it('updateMyProfile({ note: "" }) deletes the extended property', async () => {
    const { gateway, setExtendedProfileProperty, deleteExtendedProfileProperty } = gatewayWith({
      rawDisplayName: 'Alice Stone',
    })
    await gateway.updateMyProfile({ note: '' })
    expect(deleteExtendedProfileProperty).toHaveBeenCalledTimes(1)
    expect(deleteExtendedProfileProperty).toHaveBeenCalledWith('io.tayet.note')
    expect(setExtendedProfileProperty).not.toHaveBeenCalled()
  })
})

// ADR-054 dec. 7: o fullName do próprio perfil passa a resolver em TRÊS níveis —
// diretório ?? snapshot em account-data ?? displayName vivo limpo. Um teste por nível, mais os dois
// casos de disputa (diretório e snapshot juntos; só snapshot), porque é a disputa que define a
// migração: ela é por PRECEDÊNCIA, não por remoção. O caminho do ADR-040 continua vivo embaixo.
describe('getMyProfile() — precedência de fullName em três níveis (ADR-054 dec. 7)', () => {
  const ORG_DOC = {
    'io.tayet.full_name': 'Alice Alves',
    'io.tayet.job_title': 'Engenheira de Plataforma',
    'io.tayet.work_email': 'alice@tayet.local',
  }

  it('nível 1 — diretório presente: o fullName vem da camada organizacional', async () => {
    const { gateway } = gatewayWith({ rawDisplayName: 'alice', orgDoc: ORG_DOC })
    const profile = await gateway.getMyProfile()
    expect(profile.fullName).toBe('Alice Alves')
    expect(profile.org?.authority).toBe('directory')
    expect(profile.org?.jobTitle).toBe('Engenheira de Plataforma')
    expect(profile.org?.workEmail).toBe('alice@tayet.local')
    expect(findProtocolLeaks(profile)).toEqual([])
  })

  it('nível 2 — sem diretório, com snapshot: cai no snapshot em account-data (ADR-040 vivo)', async () => {
    const { gateway } = gatewayWith({
      rawDisplayName: 'Apelido',
      accountData: { fullName: 'Alice Stone', nickname: 'Apelido' },
    })
    const profile = await gateway.getMyProfile()
    expect(profile.fullName).toBe('Alice Stone')
    expect(profile.org).toBeUndefined()
  })

  it('nível 3 — sem diretório e sem snapshot: cai no displayName vivo limpo', async () => {
    const { gateway } = gatewayWith({ rawDisplayName: 'Alice Stone' })
    const profile = await gateway.getMyProfile()
    expect(profile.fullName).toBe('Alice Stone')
    expect(profile.org).toBeUndefined()
  })

  // A disputa: os dois presentes. O diretório vence — é a autoridade; o snapshot é só a foto que o
  // cliente tirou antes de o sync existir.
  it('diretório E snapshot presentes → o diretório vence, e o snapshot NÃO é apagado', async () => {
    const { gateway, setAccountData } = gatewayWith({
      rawDisplayName: 'Apelido',
      accountData: { fullName: 'Nome Velho Do Snapshot', nickname: 'Apelido' },
      orgDoc: ORG_DOC,
    })
    const profile = await gateway.getMyProfile()
    expect(profile.fullName).toBe('Alice Alves') // diretório, não o snapshot
    expect(profile.nickname).toBe('Apelido') // o apelido auto-autorado segue intocado
    expect(setAccountData).not.toHaveBeenCalled() // leitura não escreve: o snapshot fica onde está
  })

  // Fail-soft: a leitura estendida cai inteira. org some E o fullName volta à precedência ANTIGA —
  // não vira o displayName vivo por atalho, continua honrando o snapshot. Nunca throw (8.P3).
  it('getExtendedProfile rejeita → org ausente e fullName volta pro snapshot, sem throw', async () => {
    const { gateway } = gatewayWith({
      rawDisplayName: 'Apelido',
      accountData: { fullName: 'Alice Stone', nickname: 'Apelido' },
      extUnavailable: true,
    })
    const profile = await gateway.getMyProfile()
    expect(profile.org).toBeUndefined()
    expect(profile.fullName).toBe('Alice Stone') // snapshot, não 'Apelido'
    expect(findProtocolLeaks(profile)).toEqual([])
  })

  it('documento estendido sem NENHUMA chave de org → org ausente, nunca objeto vazio', async () => {
    const { gateway } = gatewayWith({ rawDisplayName: 'Alice Stone', pronouns: 'ela/dela' })
    const profile = await gateway.getMyProfile()
    expect(profile.org).toBeUndefined()
    expect(profile.pronouns).toBe('ela/dela')
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// O GUARDA EXECUTÁVEL DA ADR-054 dec. 3 (= PLANO §0.2 dec. 6).
//
// A camada organizacional é read-only NO CLIENTE: o writer é o sync de diretório out-of-band, e a
// ACL não tem — nem deve ganhar — verbo de escrita para as três chaves. Isso é um invariante de TIPO,
// mas tipo some no build; este teste é a versão que roda.
//
// Se alguém adicionar um campo de OrgFields ao patch de updateMyProfile (fullName é o candidato
// óbvio, porque MyProfile.fullName existe e parece editável), ESTE TESTE CAI. Foi visto falhando de
// propósito antes de entrar — um gate que nunca se viu falhar não é gate.
describe('updateMyProfile() NÃO escreve a camada organizacional (ADR-054 dec. 3)', () => {
  const ORG_KEYS = ['io.tayet.full_name', 'io.tayet.job_title', 'io.tayet.work_email']

  it('nenhum patch válido toca nenhuma das três chaves de org', async () => {
    const { gateway, setExtendedProfileProperty, deleteExtendedProfileProperty } = gatewayWith({
      rawDisplayName: 'Alice Stone',
      accountData: { fullName: 'Alice Stone' },
      orgDoc: {
        'io.tayet.full_name': 'Alice Alves',
        'io.tayet.job_title': 'Engenheira de Plataforma',
        'io.tayet.work_email': 'alice@tayet.local',
      },
    })

    // Todos os patches que o tipo aceita, incluindo as formas de limpar ('' → delete) — é o delete
    // que poderia apagar uma chave de org por engano, então ele precisa estar aqui.
    await gateway.updateMyProfile({ nickname: 'Ali' })
    await gateway.updateMyProfile({ nickname: '' })
    await gateway.updateMyProfile({ pronouns: 'ela/dela' })
    await gateway.updateMyProfile({ pronouns: '' })
    await gateway.updateMyProfile({ note: 'em foco até quinta' })
    await gateway.updateMyProfile({ note: '' })
    await gateway.updateMyProfile({ nickname: 'Ali', pronouns: 'ela/dela', note: 'oi' })

    // E os patches que o tipo NÃO aceita, forçados por cast. Sem isto o guarda teria alcance menor do
    // que o invariante que protege: um caminho de escrita novo pra `fullName` só é exercitado se
    // alguém PASSAR fullName, e nenhuma das chamadas acima passa. Medido — sem esta linha, adicionar
    // `fullName` ao patch e um setExtendedProfileProperty(ORG_FULL_NAME_KEY) passa despercebido.
    // Hoje estes campos são ignorados em silêncio (o impl só olha 'x' in patch pras três chaves
    // válidas); no dia em que alguém os ligar, esta chamada os pega.
    const wide = gateway.updateMyProfile as (p: Record<string, unknown>) => Promise<void>
    await wide.call(gateway, { fullName: 'Alice Alves' })
    await wide.call(gateway, { fullName: '' })
    await wide.call(gateway, { jobTitle: 'Engenheira', workEmail: 'a@tayet.local' })

    const written = setExtendedProfileProperty.mock.calls.map((c) => c[0])
    const deleted = deleteExtendedProfileProperty.mock.calls.map((c) => c[0])
    for (const key of ORG_KEYS) {
      expect(written).not.toContain(key)
      expect(deleted).not.toContain(key)
    }
    // E o positivo, pra provar que os spies estavam mesmo gravando chamadas (senão o assert acima
    // passaria de graça com um spy morto).
    expect(written).toContain('io.tayet.pronouns')
    expect(deleted).toContain('io.tayet.note')
  })
})
