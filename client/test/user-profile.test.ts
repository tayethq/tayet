import { describe, it, expect, vi } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { brandUserId } from '@tayet/shared/internal'
import type { AclTelemetry } from '../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'

// P1 boundary assert for getUserProfile() (ADR-043). The other-user read resolves displayname +
// avatar_url + io.tayet.pronouns in ONE getExtendedProfile round-trip (MSC4133), failing soft to the
// in-room room-state cache (client.getUser) when the extended read is unavailable. Only the opaque
// UserProfile crosses (branded UserId + clean displayName + opaque MediaRef + pronouns string) — the
// mxid, the avatar_url and the io.tayet.pronouns key stay confined to acl/internal. UNIT harness with a
// fake SDK client (mirrors my-profile.test.ts / current-user.test.ts), so it runs in CI; the live
// read-back rides the flaky integration suite (#7), not this gate.
//
// findProtocolLeaks SKIPS the opaque-id key `id` (ADR-008 residual: a branded UserId's runtime value IS
// the mxid, defended by opacity) and asserts everything renderable (displayName, avatar, pronouns) is
// free of protocol shapes — exactly the P1 line for the other-user read.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const MXID = '@bob:tayet.local'

function gatewayWith(opts: {
  ext?: Record<string, unknown>
  cachedDisplayName?: string
  cachedAvatarUrl?: string
  rooms?: unknown[]
}): {
  gateway: MatrixGateway
  getExtendedProfile: ReturnType<typeof vi.fn>
  getUser: ReturnType<typeof vi.fn>
} {
  // ext ausente → getExtendedProfile rejeita (servidor sem MSC4133 / leitura indisponível): o caminho
  // fail-soft que cai pro cache de room-state.
  const getExtendedProfile = vi.fn(async () => {
    if (!opts.ext) throw new Error('M_NOT_FOUND')
    return opts.ext
  })
  const getUser = vi.fn((_id: string) => ({
    rawDisplayName: opts.cachedDisplayName,
    avatarUrl: opts.cachedAvatarUrl,
  }))
  const fakeClient = { getUserId: () => '@me:tayet.local', getRooms: () => opts.rooms ?? [], getExtendedProfile, getUser }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  return { gateway, getExtendedProfile, getUser }
}

describe('getUserProfile() boundary (ADR-043)', () => {
  it('resolves name + opaque avatar + pronouns from the extended profile in one round-trip — no protocol leak', async () => {
    const { gateway, getUser } = gatewayWith({
      ext: {
        displayname: 'Bob Stone',
        avatar_url: 'mxc://tayet.local/bob123',
        'io.tayet.pronouns': 'ela/dela',
      },
    })
    const profile = await gateway.getUserProfile(brandUserId(MXID))
    expect(profile.displayName).toBe('Bob Stone')
    expect(profile.pronouns).toBe('ela/dela')
    expect(profile.avatar).toBeDefined()
    expect(String(profile.avatar)).not.toContain('mxc://')
    // The single extended read is enough — no fallback to the room-state cache.
    expect(getUser).not.toHaveBeenCalled()
    expect(findProtocolLeaks(profile)).toEqual([])
  })

  it('extended profile without the pronouns key → pronouns undefined, no leak', async () => {
    const { gateway } = gatewayWith({
      ext: { displayname: 'Bob Stone', avatar_url: 'mxc://tayet.local/bob123' },
    })
    const profile = await gateway.getUserProfile(brandUserId(MXID))
    expect(profile.displayName).toBe('Bob Stone')
    expect(profile.pronouns).toBeUndefined()
    expect(findProtocolLeaks(profile)).toEqual([])
  })

  it('fail-soft: the extended read rejects → name/avatar from the in-room cache, pronouns undefined, no throw, no leak', async () => {
    const { gateway, getUser } = gatewayWith({
      // ext ausente → getExtendedProfile rejeita
      cachedDisplayName: 'Bob Stone',
      cachedAvatarUrl: 'mxc://tayet.local/bobcache',
    })
    const profile = await gateway.getUserProfile(brandUserId(MXID))
    expect(getUser).toHaveBeenCalled() // caiu pro cache de room-state
    expect(profile.displayName).toBe('Bob Stone')
    expect(profile.avatar).toBeDefined()
    expect(String(profile.avatar)).not.toContain('mxc://')
    expect(profile.pronouns).toBeUndefined()
    expect(findProtocolLeaks(profile)).toEqual([])
  })

  // ADR-090 path (Operador 2): an agent the operator just added stays `invite` until its process runs;
  // a viewer who shares no JOINED room with it gets the ADR-052 403 and the SDK User has no name (the
  // SDK fills it with the mxid). The invite member event of the shared room carries the name — never
  // the localpart on screen.
  it('fail-soft for someone only invited: the shared room member name, never the localpart', async () => {
    const room = {
      roomId: '!c:tayet.local',
      getMyMembership: () => 'join',
      getCanonicalAlias: () => null,
      getMember: (id: string) => (id === MXID ? { userId: MXID, rawDisplayName: 'Bob Stone', membership: 'invite' } : null),
    }
    const { gateway } = gatewayWith({ cachedDisplayName: MXID, rooms: [room] })
    const profile = await gateway.getUserProfile(brandUserId(MXID))
    expect(profile.displayName).toBe('Bob Stone')
    expect(findProtocolLeaks(profile)).toEqual([])
  })

  it('never surfaces the mxid as the displayName — an mxid-shaped name collapses to the localpart', async () => {
    const { gateway } = gatewayWith({ ext: { displayname: MXID } })
    const profile = await gateway.getUserProfile(brandUserId(MXID))
    expect(profile.displayName).toBe('bob')
    expect(profile.displayName).not.toContain('@')
    expect(profile.displayName).not.toContain(':')
    expect(findProtocolLeaks(profile)).toEqual([])
  })

  // ADR-053: o recado de OUTRO, no MESMO documento estendido dos pronomes (classe (c) do ADR-042 —
  // não classe de storage nova). Vem na mesma volta que já buscava nome+avatar+pronomes: custo zero.
  // O literal 'io.tayet.note' fica AQUI, na fixture — é o pin da chave. A impl usa a const; se alguém
  // trocar uma sem a outra, estes testes caem. Não "DRY" isso.
  it('getUserProfile devolve note quando o documento tem a chave — sem leak', async () => {
    const { gateway, getUser } = gatewayWith({
      ext: {
        displayname: 'Bob Stone',
        'io.tayet.pronouns': 'ela/dela',
        'io.tayet.note': 'em foco até quinta',
      },
    })
    const profile = await gateway.getUserProfile(brandUserId(MXID))
    expect(profile.note).toBe('em foco até quinta')
    expect(profile.pronouns).toBe('ela/dela')
    expect(getUser).not.toHaveBeenCalled() // a volta única basta — sem fallback
    expect(findProtocolLeaks(profile)).toEqual([])
  })

  // DIA N: a pessoa já tem pronomes, mas a chave do recado ainda não foi escrita — documento PARCIAL.
  // O assert de `pronouns` é o gate: o valor CHEGA, e não chegaria se ler a chave ausente tivesse
  // estourado dentro do try. "Chave ausente" é o type check, não o catch.
  it('getUserProfile: documento com pronomes e SEM note (dia N) → note undefined, pronouns intacto', async () => {
    const { gateway, getUser } = gatewayWith({
      ext: { displayname: 'Bob Stone', 'io.tayet.pronouns': 'ela/dela' }, // note omitido → parcial
    })
    const profile = await gateway.getUserProfile(brandUserId(MXID))
    expect(profile.note).toBeUndefined()
    expect(profile.pronouns).toBe('ela/dela') // a chave ausente não leva a irmã junto
    expect(getUser).not.toHaveBeenCalled() // o documento parcial RESOLVE — não caiu no catch
    expect(findProtocolLeaks(profile)).toEqual([])
  })

  // O fail-soft aqui é estruturalmente diferente do getMyProfile: o catch RECUPERA nome+avatar do
  // cache de room-state. Mas não há fonte de recado no room state — note só pode ser undefined. O
  // assert de displayName é o que prova que o catch fez o trabalho em vez de só engolir.
  it('getUserProfile fail-soft: documento indisponível → cai no room-state, note undefined, sem throw', async () => {
    const { gateway, getUser } = gatewayWith({
      // ext ausente → getExtendedProfile rejeita
      cachedDisplayName: 'Bob Stone',
      cachedAvatarUrl: 'mxc://tayet.local/bobcache',
    })
    const profile = await gateway.getUserProfile(brandUserId(MXID))
    expect(getUser).toHaveBeenCalled() // caiu pro cache de room-state
    expect(profile.displayName).toBe('Bob Stone') // o fallback recuperou o nome — o catch trabalhou
    expect(profile.note).toBeUndefined() // o room-state não carrega recado
    expect(findProtocolLeaks(profile)).toEqual([])
  })
})

// ADR-054: a camada ORGANIZACIONAL lida na mesma volta. O invariante que estes testes protegem não é
// "os campos aparecem" — é a DISTINÇÃO entre ausência do objeto (a pessoa não está no diretório) e
// campo ausente dentro dele (ausência declarada pelo diretório). As duas são undefined pro consumidor,
// mas dizem coisas diferentes, e a UI do PR-3 vai depender disso.
describe('getUserProfile() — camada organizacional (ADR-054)', () => {
  it('as três chaves presentes → org com authority directory e os três campos, sem leak', async () => {
    const { gateway } = gatewayWith({
      ext: {
        displayname: 'Bob Stone',
        'io.tayet.full_name': 'Bob Barros',
        'io.tayet.job_title': 'Engenheiro de Plataforma',
        'io.tayet.work_email': 'bob@tayet.local',
      },
    })
    const profile = await gateway.getUserProfile(brandUserId(MXID))
    expect(profile.org).toBeDefined()
    expect(profile.org?.authority).toBe('directory')
    expect(profile.org?.fullName).toBe('Bob Barros')
    expect(profile.org?.jobTitle).toBe('Engenheiro de Plataforma')
    expect(profile.org?.workEmail).toBe('bob@tayet.local')
    expect(findProtocolLeaks(profile)).toEqual([])
  })

  // O caso que separa "sem linha no diretório" de "no diretório, sem atributos". org tem que SUMIR,
  // não virar um { authority: 'directory' } vazio — esse objeto afirmaria presença no diretório que
  // não existe. Por isso o assert é toBeUndefined() e não toEqual({}).
  it('NENHUMA das três presentes → org ausente por inteiro, nunca um objeto vazio', async () => {
    const { gateway } = gatewayWith({
      ext: { displayname: 'Bob Stone', 'io.tayet.pronouns': 'ele/dele' },
    })
    const profile = await gateway.getUserProfile(brandUserId(MXID))
    expect(profile.org).toBeUndefined()
    expect(profile.pronouns).toBe('ele/dele') // a volta continua servindo o resto
  })

  // O sync apaga a chave quando o campo vem vazio no diretório (em vez de gravar ''), então na prática
  // o valor não-string/'' não deveria chegar. A guarda existe pra que um documento sujo — escrito à
  // mão, ou por um writer futuro — degrade pra ausência em vez de vazar '' ou um número pra tela.
  it('chave com valor não-string ou vazio → o campo fica ausente, o resto do objeto sobrevive', async () => {
    const { gateway } = gatewayWith({
      ext: {
        displayname: 'Bob Stone',
        'io.tayet.full_name': 'Bob Barros',
        'io.tayet.job_title': '', // vazio
        'io.tayet.work_email': 42, // não-string
      },
    })
    const profile = await gateway.getUserProfile(brandUserId(MXID))
    expect(profile.org).toBeDefined()
    expect(profile.org?.fullName).toBe('Bob Barros')
    expect(profile.org?.jobTitle).toBeUndefined()
    expect(profile.org?.workEmail).toBeUndefined()
    expect(findProtocolLeaks(profile)).toEqual([])
  })

  // Mesmo fail-soft do note, e pela mesma razão: o room-state carrega nome e avatar, não camada
  // organizacional. O assert de displayName prova que o catch RECUPEROU em vez de só engolir.
  it('getExtendedProfile rejeita → fallback de room-state com org ausente, sem throw', async () => {
    const { gateway, getUser } = gatewayWith({
      // ext ausente → getExtendedProfile rejeita
      cachedDisplayName: 'Bob Stone',
    })
    const profile = await gateway.getUserProfile(brandUserId(MXID))
    expect(getUser).toHaveBeenCalled()
    expect(profile.displayName).toBe('Bob Stone') // o catch trabalhou
    expect(profile.org).toBeUndefined()
    expect(findProtocolLeaks(profile)).toEqual([])
  })
})
