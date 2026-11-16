import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionError as SdkConnectionError, createClient, MatrixError } from 'matrix-js-sdk'

// Invariante do track STORE ÓRFÃO: o crypto store nunca sobrevive ao device dono. Dois cintos
// no gateway: (1) sessão morta no boot (whoami → M_UNKNOWN_TOKEN) limpa os stores ANTES de
// lançar SessionExpiredError — simetria com o mid-session (onSessionLost → signOut); (2)
// mismatch do OlmMachine no initRustCrypto → wipe + UM retry (auto-cura de store já órfão).
//
// Idioma de oidc.test.ts: mock só o createClient — o resto do SDK (MatrixError, enums que
// matrix-client.ts importa no grafo) fica real. Nenhuma rede.
vi.mock('matrix-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('matrix-js-sdk')>()
  return { ...actual, createClient: vi.fn() }
})

// SUT importado APÓS o mock estar registrado.
import { MatrixGateway, STORE_WIPE_BOUND_MS } from '../src/acl/internal/matrix-client'
import { ConnectionError, SessionExpiredError, type AclTelemetry, type OpaqueSession } from '../src/acl'

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
// Blob legado (token cru, não-JSON): parseSessionBlob → { oidc: false } e o connect usa o
// serverUrl das opts — o caminho mais curto até o whoami, sem renewer no meio.
const SESSION = 'legacy-token' as unknown as OpaqueSession

const makeGateway = () => new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })

// O probe é o primeiro createClient do connect (só whoami + clearStores importam).
function makeProbe(overrides: Partial<Record<'whoami' | 'clearStores', ReturnType<typeof vi.fn>>> = {}) {
  return {
    whoami: vi.fn().mockResolvedValue({ user_id: '@alice:x.local', device_id: 'DEVICE' }),
    clearStores: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// Sentinela plantada no passo SEGUINTE ao initRustCrypto (startClient): nenhum harness unitário
// cobre o connect fim-a-fim, então a testemunha de "seguiu além da cripto" é o erro final ser
// o Sentinel — prova que passamos da cripto sem fake do mundo todo.
class SentinelError extends Error {}

// O segundo createClient do connect (o client real). startClient rejeita com a sentinela.
function makeCryptoClient(initRustCrypto: ReturnType<typeof vi.fn>, sentinel: SentinelError) {
  return {
    initRustCrypto,
    clearStores: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    startClient: vi.fn().mockRejectedValue(sentinel),
    getRooms: vi.fn(() => []),
    // Sem crypto API no fake: a checagem de identidade do ADR-062 D2 não tem o que comparar.
    getCrypto: vi.fn(() => undefined),
    stopClient: vi.fn(),
  }
}

beforeEach(() => {
  vi.mocked(createClient).mockReset()
})

describe('boot-expired: sessão morta no whoami limpa o store antes do SessionExpiredError', () => {
  it('M_UNKNOWN_TOKEN → clearStores 1x E SessionExpiredError (o wipe não engole o throw)', async () => {
    const probe = makeProbe({
      whoami: vi.fn().mockRejectedValue(new MatrixError({ errcode: 'M_UNKNOWN_TOKEN', error: 'dead' })),
    })
    vi.mocked(createClient).mockReturnValue(probe as never)

    await expect(makeGateway().connect(SESSION)).rejects.toBeInstanceOf(SessionExpiredError)
    expect(probe.clearStores).toHaveBeenCalledTimes(1)
  })

  it('outro MatrixError → clearStores NÃO chamado; o erro original propaga', async () => {
    const boom = new MatrixError({ errcode: 'M_FORBIDDEN', error: 'nope' })
    const probe = makeProbe({ whoami: vi.fn().mockRejectedValue(boom) })
    vi.mocked(createClient).mockReturnValue(probe as never)

    await expect(makeGateway().connect(SESSION)).rejects.toBe(boom)
    expect(probe.clearStores).not.toHaveBeenCalled()
  })
})

// PR-B (§8.9): a copy de conexão na tela exige SINAL POSITIVO de rede, e o único sinal que o SDK
// dá é o ConnectionError do FetchHttpApi (fetch rejeitado: servidor fora, DNS/CORS, timeout,
// offline). O gateway o traduz no seam do whoami — o detalhe do SDK morre ali, só o tipo neutro
// cruza a barrel. Sem essa tradução, falha de rede e falha local seriam indistinguíveis no Boot.
describe('boot-network: falha de rede no whoami vira ConnectionError de domínio', () => {
  it('ConnectionError do SDK → ConnectionError da ACL (payload-free) e clearStores NÃO chamado', async () => {
    const probe = makeProbe({
      whoami: vi.fn().mockRejectedValue(new SdkConnectionError('fetch failed', new Error('ECONNREFUSED'))),
    })
    vi.mocked(createClient).mockReturnValue(probe as never)

    const err = await makeGateway().connect(SESSION).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConnectionError)
    // P1: nada do SDK (URL/causa/mensagem de transporte) sobrevive à tradução.
    expect((err as Error).message).toBe('Connection failed')
    expect((err as Error).message).not.toContain('ECONNREFUSED')
    // Rede fora ≠ sessão morta: o store NÃO é limpo (o cinto do #142 não dispara aqui).
    expect(probe.clearStores).not.toHaveBeenCalled()
  })
})

describe('resgate no initRustCrypto: mismatch do OlmMachine → wipe + UM retry', () => {
  it('mismatch na 1ª chamada → clearStores 1x, initRustCrypto 2x, e o connect segue além da cripto', async () => {
    const sentinel = new SentinelError('past-crypto')
    const initRustCrypto = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("the account in the store doesn't match the account in the constructor"),
      )
      .mockResolvedValueOnce(undefined)
    const client = makeCryptoClient(initRustCrypto, sentinel)
    vi.mocked(createClient)
      .mockReturnValueOnce(makeProbe() as never)
      .mockReturnValueOnce(client as never)

    await expect(makeGateway().connect(SESSION)).rejects.toBe(sentinel)
    expect(client.clearStores).toHaveBeenCalledTimes(1)
    expect(initRustCrypto).toHaveBeenCalledTimes(2)
  })

  it('erro qualquer → initRustCrypto 1x (sem retry), clearStores NÃO chamado, erro propaga', async () => {
    const boom = new Error('wasm exploded some other way')
    const initRustCrypto = vi.fn().mockRejectedValue(boom)
    const client = makeCryptoClient(initRustCrypto, new SentinelError('unreached'))
    vi.mocked(createClient)
      .mockReturnValueOnce(makeProbe() as never)
      .mockReturnValueOnce(client as never)

    await expect(makeGateway().connect(SESSION)).rejects.toBe(boom)
    expect(initRustCrypto).toHaveBeenCalledTimes(1)
    expect(client.clearStores).not.toHaveBeenCalled()
  })
})

// ADR-062 D2 (§8.22): identidade de device = conta Olm. Depois do initRustCrypto e antes do
// startClient, a ed25519 local é comparada com a que o servidor publica para o device. Ausente →
// device novo, segue; igual → segue; diferente → wipe + SessionExpiredError, sem startClient (nada
// sai para o servidor sob o device id com identidade trocada).
describe('identidade de device no boot (ADR-062 D2)', () => {
  const OWN = { ed25519: 'LOCAL-ED', curve25519: 'LOCAL-CU' }
  function identityClient(sentinel: SentinelError, publishedEd25519: string | undefined) {
    const device = publishedEd25519 === undefined ? {} : { DEVICE: { keys: { 'ed25519:DEVICE': publishedEd25519 } } }
    return {
      ...makeCryptoClient(vi.fn().mockResolvedValue(undefined), sentinel),
      getCrypto: vi.fn(() => ({ getOwnDeviceKeys: vi.fn().mockResolvedValue(OWN) })),
      downloadKeysForUsers: vi.fn().mockResolvedValue({ device_keys: { '@alice:x.local': device }, failures: {} }),
    }
  }
  function boot(client: unknown) {
    vi.mocked(createClient)
      .mockReturnValueOnce(makeProbe() as never)
      .mockReturnValueOnce(client as never)
    return makeGateway().connect(SESSION)
  }

  it('servidor sem chaves para o device → segue (device novo)', async () => {
    const sentinel = new SentinelError('past-identity')
    const client = identityClient(sentinel, undefined)
    await expect(boot(client)).rejects.toBe(sentinel)
    expect(client.downloadKeysForUsers).toHaveBeenCalledWith(['@alice:x.local'])
    expect(client.clearStores).not.toHaveBeenCalled()
  })

  it('chave publicada igual à local → segue', async () => {
    const sentinel = new SentinelError('past-identity')
    const client = identityClient(sentinel, OWN.ed25519)
    await expect(boot(client)).rejects.toBe(sentinel)
    expect(client.clearStores).not.toHaveBeenCalled()
  })

  it('chave publicada diferente → wipe 1x + SessionExpiredError, startClient NÃO chamado', async () => {
    const client = identityClient(new SentinelError('unreached'), 'SERVER-ED')
    await expect(boot(client)).rejects.toBeInstanceOf(SessionExpiredError)
    expect(client.clearStores).toHaveBeenCalledTimes(1)
    expect(client.startClient).not.toHaveBeenCalled()
  })

  it('falha de rede na query → ConnectionError, sem wipe e sem startClient', async () => {
    const client = identityClient(new SentinelError('unreached'), undefined)
    client.downloadKeysForUsers = vi.fn().mockRejectedValue(new SdkConnectionError('fetch failed', new Error('x')))
    await expect(boot(client)).rejects.toBeInstanceOf(ConnectionError)
    expect(client.clearStores).not.toHaveBeenCalled()
    expect(client.startClient).not.toHaveBeenCalled()
  })
})

// ADR-065 D8: os três wipes do boot têm o mesmo bound do signOut. Um deleteDatabase preso (outra
// conexão segura o IndexedDB; o `onblocked` do SDK só loga) não trava mais o boot em "Conectando…":
// passado STORE_WIPE_BOUND_MS o connect segue o caminho de antes, com o aviso neutro no console.
describe('wipe do boot preso → bound (ADR-065 D8)', () => {
  const hung = () => vi.fn(() => new Promise<void>(() => {}))
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.useFakeTimers()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    warn.mockRestore()
  })

  async function settlesAtBound(p: Promise<unknown>): Promise<unknown> {
    let outcome: { v: unknown } | undefined
    const done = p.then(
      (v) => (outcome = { v }),
      (e: unknown) => (outcome = { v: e }),
    )
    await vi.advanceTimersByTimeAsync(STORE_WIPE_BOUND_MS - 1)
    expect(outcome).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(warn).toHaveBeenCalledWith('[acl] store wipe timed out')
    return outcome!.v
  }

  it('sessão morta no probe: SessionExpiredError no bound', async () => {
    const probe = makeProbe({
      whoami: vi.fn().mockRejectedValue(new MatrixError({ errcode: 'M_UNKNOWN_TOKEN', error: 'x' })),
      clearStores: hung(),
    })
    vi.mocked(createClient).mockReturnValueOnce(probe as never)
    expect(await settlesAtBound(makeGateway().connect(SESSION))).toBeInstanceOf(SessionExpiredError)
  })

  it('store órfão: o retry do initRustCrypto sai no bound', async () => {
    const sentinel = new SentinelError('past-crypto')
    const initRustCrypto = vi
      .fn()
      .mockRejectedValueOnce(new Error("the account in the store doesn't match the account in the constructor"))
      .mockResolvedValueOnce(undefined)
    const client = { ...makeCryptoClient(initRustCrypto, sentinel), clearStores: hung() }
    vi.mocked(createClient)
      .mockReturnValueOnce(makeProbe() as never)
      .mockReturnValueOnce(client as never)
    expect(await settlesAtBound(makeGateway().connect(SESSION))).toBe(sentinel)
    expect(initRustCrypto).toHaveBeenCalledTimes(2)
  })

  it('identidade divergente: SessionExpiredError no bound, sem startClient', async () => {
    const client = {
      ...makeCryptoClient(vi.fn().mockResolvedValue(undefined), new SentinelError('unreached')),
      getCrypto: vi.fn(() => ({ getOwnDeviceKeys: vi.fn().mockResolvedValue({ ed25519: 'LOCAL-ED' }) })),
      downloadKeysForUsers: vi
        .fn()
        .mockResolvedValue({ device_keys: { '@alice:x.local': { DEVICE: { keys: { 'ed25519:DEVICE': 'SERVER-ED' } } } } }),
      clearStores: hung(),
    }
    vi.mocked(createClient)
      .mockReturnValueOnce(makeProbe() as never)
      .mockReturnValueOnce(client as never)
    expect(await settlesAtBound(makeGateway().connect(SESSION))).toBeInstanceOf(SessionExpiredError)
    expect(client.startClient).not.toHaveBeenCalled()
  })
})
