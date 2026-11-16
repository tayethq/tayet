// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { completeAuthorizationCodeGrant, generateOidcAuthorizationUrl } from 'matrix-js-sdk'

// Mock só as funções OIDC do SDK — o resto (enums/classes que matrix-client.ts importa no grafo do
// barrel) fica real. Nenhuma rede: getAuthMetadata/authorize/exchange são stubs.
vi.mock('matrix-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('matrix-js-sdk')>()
  return {
    ...actual,
    createClient: vi.fn(() => ({
      getAuthMetadata: vi.fn().mockResolvedValue({ issuer: 'https://mas.local' }),
    })),
    generateOidcAuthorizationUrl: vi.fn().mockResolvedValue('https://mas.local/authorize?client_id=TAYET'),
    completeAuthorizationCodeGrant: vi.fn(),
  }
})

// SUT importado APÓS o mock estar registrado.
import { completeLogin, buildLoginUrl, parseSessionBlob } from '../src/acl/internal/oidc'
import { isCallback, scrubCallback, isErrorCallback } from '../src/ui/oidc'
import { ConnectionError, type OpaqueSession } from '../src/acl'

const setUrl = (search: string) => window.history.replaceState({}, '', `/${search}`)

beforeEach(() => setUrl(''))
afterEach(() => vi.clearAllMocks())

describe('isCallback: detecta o retorno do OP pela URL', () => {
  it('true quando há ?code&state', () => {
    setUrl('?code=abc&state=xyz')
    expect(isCallback()).toBe(true)
  })
  it('false sem os params', () => {
    setUrl('?foo=1')
    expect(isCallback()).toBe(false)
    setUrl('')
    expect(isCallback()).toBe(false)
  })
})

describe('isErrorCallback: detecta a negação do OP pela URL (?error&state)', () => {
  it('true quando há ?error&state', () => {
    setUrl('?error=access_denied&state=xyz')
    expect(isErrorCallback()).toBe(true)
  })
  it('false sem error, sem state, ou num callback de sucesso', () => {
    setUrl('?code=abc&state=xyz')
    expect(isErrorCallback()).toBe(false)
    setUrl('?error=access_denied')
    expect(isErrorCallback()).toBe(false)
    setUrl('')
    expect(isErrorCallback()).toBe(false)
  })
})

describe('scrubCallback: limpa os params de callback da address-bar (P1 + higiene)', () => {
  it('remove ?code&state sem reload', () => {
    setUrl('?code=abc&state=xyz')
    scrubCallback()
    expect(window.location.search).toBe('')
    expect(window.location.pathname).toBe('/')
  })
})

describe('completeLogin: troca o código por um blob renovável (sem side-effect na URL)', () => {
  it('monta o blob de refresh (SEM identidade) e devolve OpaqueSession serializada', async () => {
    setUrl('?code=the-code&state=the-state')
    vi.mocked(completeAuthorizationCodeGrant).mockResolvedValue({
      oidcClientSettings: { clientId: 'TAYET', issuer: 'https://mas.local' },
      tokenResponse: {
        token_type: 'Bearer',
        access_token: 'at_live',
        refresh_token: 'rt_live',
        id_token: 'idt',
        scope:
          'openid urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:DEVICEXYZ',
      },
      homeserverUrl: 'http://hs.local',
      // O sub chega não-canônico (sem @); deliberadamente NÃO entra no blob — identidade vem do whoami.
      idTokenClaims: { sub: 'alice' },
    } as never)

    const session = await completeLogin()
    // Passou o code/state corretos ao exchange.
    expect(completeAuthorizationCodeGrant).toHaveBeenCalledWith('the-code', 'the-state')
    // completeLogin é puro agora (§8.L31): NÃO mexe na address-bar — o scrub é do app (scrubCallback).
    expect(window.location.search).toBe('?code=the-code&state=the-state')

    // O blob é opaco pro app, mas o connect (ACL) o desserializa — checamos via parseSessionBlob.
    const parsed = parseSessionBlob(session)
    expect(parsed.oidc).toBe(true)
    if (!parsed.oidc) throw new Error('expected oidc blob')
    expect(parsed.accessToken).toBe('at_live')
    expect(parsed.refreshToken).toBe('rt_live')
    expect(parsed.issuer).toBe('https://mas.local')
    expect(parsed.clientId).toBe('TAYET')
    expect(parsed.homeserverUrl).toBe('http://hs.local')
    // §8.L25: o blob NÃO carrega campo de identidade — nem userId (do sub), nem deviceId (do scope).
    // (idTokenClaims permanece — o refresher valida tokens com ele —, então o sub vive ALI, nunca como
    // userId; checamos a ausência dos CAMPOS de identidade, não a substring do sub.)
    expect(session as string).not.toContain('"userId"')
    expect(session as string).not.toContain('"deviceId"')
    expect((parsed as unknown as Record<string, unknown>).userId).toBeUndefined()
    expect((parsed as unknown as Record<string, unknown>).deviceId).toBeUndefined()
  })

  it('rejeita quando não é um callback (sem code/state)', async () => {
    setUrl('')
    await expect(completeLogin()).rejects.toThrow()
  })
})

describe('completeLogin: classificação de falha do exchange (PLANO-BOOT-STORE-ORFAO §8 item 11)', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('rede caída no exchange → ConnectionError de domínio (o shape do SDK/fetch morre na ACL)', async () => {
    setUrl('?code=c&state=s')
    // Fiel ao caminho real: o transporte rejeita (TypeError de rede) e o SDK ENGOLE o tipo,
    // relançando o Error(CodeExchangeFailed) genérico (matrix-js-sdk src/oidc/authorize.ts). A
    // classificação só pode vir do wrapper de fetch do completeLogin — é isso que este teste prova.
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    vi.mocked(completeAuthorizationCodeGrant).mockImplementation(async () => {
      try {
        await fetch('https://mas.local/token')
      } catch {
        throw new Error('Failed to exchange code for token')
      }
      throw new Error('unreachable')
    })

    const err: unknown = await completeLogin().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConnectionError)
    // Payload-free: só o nome neutro de produto, nada do TypeError/URL/SDK.
    expect((err as Error).message).toBe('Connection failed')
  })

  it('resposta OIDC inválida (sem falha de transporte) → falha comum neutra, não ConnectionError', async () => {
    setUrl('?code=c&state=s')
    vi.mocked(completeAuthorizationCodeGrant).mockRejectedValue(new Error('Invalid bearer token response'))

    const err: unknown = await completeLogin().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(ConnectionError)
    // O shape do SDK não atravessa a barrel — a mensagem é a neutra do completeLogin.
    expect((err as Error).message).toBe('OIDC login failed')
  })

  it('restaura o fetch global após o exchange (sucesso e falha)', async () => {
    setUrl('?code=c&state=s')
    const stub = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    globalThis.fetch = stub

    // Falha: o finally devolve o fetch que encontrou (aqui, o stub do teste).
    vi.mocked(completeAuthorizationCodeGrant).mockRejectedValue(new Error('x'))
    await completeLogin().catch(() => {})
    expect(globalThis.fetch).toBe(stub)

    // Sucesso: idem.
    vi.mocked(completeAuthorizationCodeGrant).mockResolvedValue({
      oidcClientSettings: { clientId: 'TAYET', issuer: 'https://mas.local' },
      tokenResponse: { token_type: 'Bearer', access_token: 'at', refresh_token: 'rt' },
      homeserverUrl: 'http://hs.local',
      idTokenClaims: { sub: 'alice' },
    } as never)
    await completeLogin()
    expect(globalThis.fetch).toBe(stub)
  })
})

describe('buildLoginUrl: descobre o OP e devolve a URL de authorize', () => {
  it('retorna a URL gerada pelo SDK (PKCE/state stashado internamente)', async () => {
    const url = await buildLoginUrl({ serverUrl: 'http://hs.local', clientId: 'TAYET' })
    expect(url).toBe('https://mas.local/authorize?client_id=TAYET')
    expect(generateOidcAuthorizationUrl).toHaveBeenCalledOnce()
  })
})

describe('parseSessionBlob: distingue blob OIDC de token legado', () => {
  it('string crua mct_ → legado', () => {
    const parsed = parseSessionBlob('mct_legacy' as OpaqueSession)
    expect(parsed).toEqual({ oidc: false, accessToken: 'mct_legacy' })
  })
  it('JSON sem o discriminante kind → legado (não confunde)', () => {
    const parsed = parseSessionBlob(JSON.stringify({ accessToken: 'x' }) as OpaqueSession)
    expect(parsed.oidc).toBe(false)
  })
})
