import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createEscrowClient, createPeopleClient } from '../src/acl/internal/escrow-client'
import { createEscrowFake } from './support/escrow-fake'

// ── Cliente do escrow (PLANO-FASE-2-ESCROW-C2 §3.1 / commit 4) ─────────────────────────────
// Unit contra o fake in-memory (§0.2 item 4). O mapeamento de desfecho é TOTAL: nenhuma
// exceção atravessa (401/5xx/rede → 'unavailable'); 409 é protocolo, não erro; nenhum
// material (segredo, base64, token) toca console em nenhum caminho.

const SECRET = new Uint8Array(32).map((_, i) => (i * 7 + 3) % 256)
const SECRET_B64 = Buffer.from(SECRET).toString('base64')

const consoleMethods = ['log', 'warn', 'error', 'info', 'debug', 'trace'] as const
let consoleSpies: Array<ReturnType<typeof vi.spyOn>>

beforeEach(() => {
  consoleSpies = consoleMethods.map((m) => vi.spyOn(console, m))
})

afterEach(() => {
  // Nenhum material em log, em NENHUM caminho (PLANO §6): o cliente simplesmente não loga.
  for (const spy of consoleSpies) {
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  }
})

function clientFor(fake: ReturnType<typeof createEscrowFake>, token = 'tok-alice') {
  return createEscrowClient({ baseUrl: 'http://escrow.test', token, fetchFn: fake.fetch })
}

describe('escrow-client — deposit', () => {
  it('201 → deposited; o wire carrega base64 do segredo cru (round-trip exato)', async () => {
    const fake = createEscrowFake({ 'tok-alice': 'sub-alice' })
    const out = await clientFor(fake).deposit(SECRET)
    expect(out).toEqual({ kind: 'deposited' })
    expect(fake.secrets.get('sub-alice')).toBe(SECRET_B64)
    expect(fake.audit).toEqual([{ sub: 'sub-alice', verb: 'put', outcome: 'created' }])
  })

  it('409 → exists (perdeu a corrida; protocolo, não erro) e o segredo vencedor fica intacto', async () => {
    const fake = createEscrowFake({ 'tok-alice': 'sub-alice' })
    const client = clientFor(fake)
    await client.deposit(SECRET)
    const second = await client.deposit(new Uint8Array(32).fill(9))
    expect(second).toEqual({ kind: 'exists' })
    expect(fake.secrets.get('sub-alice')).toBe(SECRET_B64)
  })

  it('401 (token desconhecido) → unavailable; storage intocado', async () => {
    const fake = createEscrowFake({ 'tok-alice': 'sub-alice' })
    const out = await clientFor(fake, 'tok-lixo').deposit(SECRET)
    expect(out).toEqual({ kind: 'unavailable' })
    expect(fake.secrets.size).toBe(0)
  })

  it('5xx → unavailable; rede caída → unavailable (nenhuma exceção vaza)', async () => {
    const fake = createEscrowFake({ 'tok-alice': 'sub-alice' })
    fake.mode = 'error'
    expect(await clientFor(fake).deposit(SECRET)).toEqual({ kind: 'unavailable' })
    fake.mode = 'down'
    expect(await clientFor(fake).deposit(SECRET)).toEqual({ kind: 'unavailable' })
  })
})

describe('escrow-client — retrieve', () => {
  it('404 → none (primeiro login)', async () => {
    const fake = createEscrowFake({ 'tok-alice': 'sub-alice' })
    expect(await clientFor(fake).retrieve()).toEqual({ kind: 'none' })
  })

  it('200 → bytes idênticos aos depositados (base64 só no wire)', async () => {
    const fake = createEscrowFake({ 'tok-alice': 'sub-alice' })
    const client = clientFor(fake)
    await client.deposit(SECRET)
    const out = await client.retrieve()
    expect(out.kind).toBe('secret')
    if (out.kind === 'secret') expect(Array.from(out.secret)).toEqual(Array.from(SECRET))
  })

  it('401 → unavailable; 5xx → unavailable; rede caída → unavailable (nenhuma exceção vaza)', async () => {
    const fake = createEscrowFake({ 'tok-alice': 'sub-alice' })
    expect(await clientFor(fake, 'tok-lixo').retrieve()).toEqual({ kind: 'unavailable' })
    fake.mode = 'error'
    expect(await clientFor(fake).retrieve()).toEqual({ kind: 'unavailable' })
    fake.mode = 'down'
    expect(await clientFor(fake).retrieve()).toEqual({ kind: 'unavailable' })
  })

  it('200 com corpo malformado → unavailable (totalidade defensiva)', async () => {
    const broken = (async () => new Response('{"secret": 12345}', { status: 200 })) as unknown as typeof fetch
    const client = createEscrowClient({ baseUrl: 'http://escrow.test', token: 't', fetchFn: broken })
    expect(await client.retrieve()).toEqual({ kind: 'unavailable' })
    const notB64 = (async () => new Response('{"secret": "!!não-base64!!"}', { status: 200 })) as unknown as typeof fetch
    const client2 = createEscrowClient({ baseUrl: 'http://escrow.test', token: 't', fetchFn: notB64 })
    expect(await client2.retrieve()).toEqual({ kind: 'unavailable' })
  })

  it('isolamento de sujeito espelhado no fake: bob não enxerga o segredo de alice (404)', async () => {
    const fake = createEscrowFake({ 'tok-alice': 'sub-alice', 'tok-bob': 'sub-bob' })
    await clientFor(fake, 'tok-alice').deposit(SECRET)
    expect(await clientFor(fake, 'tok-bob').retrieve()).toEqual({ kind: 'none' })
  })

  it('200 expõe o etag corrente (insumo do If-Match do rotate — aditivo, PF-3)', async () => {
    const fake = createEscrowFake({ 'tok-alice': 'sub-alice' })
    const client = clientFor(fake)
    await client.deposit(SECRET)
    const out = await client.retrieve()
    expect(out.kind).toBe('secret')
    if (out.kind === 'secret') {
      expect(Array.from(out.secret)).toEqual(Array.from(SECRET))
      expect(typeof out.etag).toBe('string')
      expect(out.etag).not.toBe('')
    }
  })
})

describe('escrow-client — rotate (ADR-019 §2 — rotate-primeiro)', () => {
  const NEW_SECRET = new Uint8Array(32).fill(42)
  const NEW_SECRET_B64 = Buffer.from(NEW_SECRET).toString('base64')

  async function depositedEtag(fake: ReturnType<typeof createEscrowFake>): Promise<string> {
    const out = await clientFor(fake).retrieve()
    if (out.kind !== 'secret' || out.etag === undefined) throw new Error('expected a secret + etag')
    return out.etag
  }

  it('If-Match correto → rotated + ETag NOVO; o segredo no storage é o rotacionado', async () => {
    const fake = createEscrowFake({ 'tok-alice': 'sub-alice' })
    const client = clientFor(fake)
    await client.deposit(SECRET)
    const etag = await depositedEtag(fake)
    const out = await client.rotate(NEW_SECRET, etag)
    expect(out.kind).toBe('rotated')
    if (out.kind === 'rotated') {
      expect(out.etag).not.toBe(etag) // tag novo
      expect(out.etag).not.toBe('')
    }
    expect(fake.secrets.get('sub-alice')).toBe(NEW_SECRET_B64)
  })

  it('If-Match velho (outro reset linearizou na frente) → stale; storage intocado (CAS, C2 §8 obs. 5)', async () => {
    const fake = createEscrowFake({ 'tok-alice': 'sub-alice' })
    const client = clientFor(fake)
    await client.deposit(SECRET)
    const stale = await depositedEtag(fake)
    // Um reset vence o CAS e avança o etag…
    const first = await client.rotate(NEW_SECRET, stale)
    expect(first.kind).toBe('rotated')
    // …o concorrente, ainda com o etag velho, perde a linearização e re-lê.
    const second = await client.rotate(new Uint8Array(32).fill(7), stale)
    expect(second).toEqual({ kind: 'stale' })
    expect(fake.secrets.get('sub-alice')).toBe(NEW_SECRET_B64) // o vencedor permanece
  })

  it('sujeito sem depósito (rotate nunca cria) → absent (404)', async () => {
    const fake = createEscrowFake({ 'tok-alice': 'sub-alice' })
    expect(await clientFor(fake).rotate(NEW_SECRET, 'qualquer')).toEqual({ kind: 'absent' })
  })

  it('If-Match vazio → unavailable (428 do serviço dobra em unavailable)', async () => {
    const fake = createEscrowFake({ 'tok-alice': 'sub-alice' })
    const client = clientFor(fake)
    await client.deposit(SECRET)
    expect(await client.rotate(NEW_SECRET, '')).toEqual({ kind: 'unavailable' })
  })

  it('401 / 5xx / rede caída → unavailable (nenhuma exceção vaza)', async () => {
    const fake = createEscrowFake({ 'tok-alice': 'sub-alice' })
    await clientFor(fake).deposit(SECRET)
    const etag = await depositedEtag(fake)
    expect(await clientFor(fake, 'tok-lixo').rotate(NEW_SECRET, etag)).toEqual({ kind: 'unavailable' })
    fake.mode = 'error'
    expect(await clientFor(fake).rotate(NEW_SECRET, etag)).toEqual({ kind: 'unavailable' })
    fake.mode = 'down'
    expect(await clientFor(fake).rotate(NEW_SECRET, etag)).toEqual({ kind: 'unavailable' })
  })
})

describe('EscrowClient — token e revogação (ADR-082)', () => {
  it('o getter de token acompanha o refresh a cada request', async () => {
    const seen: string[] = []
    let current = 'tok-1'
    const fetchFn = (async (_url: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>).Authorization!)
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    const client = createEscrowClient({ baseUrl: 'http://escrow.test', token: () => current, fetchFn })
    await client.retrieve()
    current = 'tok-2'
    await client.retrieve()
    expect(seen).toEqual(['Bearer tok-1', 'Bearer tok-2'])
  })

  it('revokeOthers: só 200 é revogado; o resto, e a falha de rede, é unavailable', async () => {
    const answering = (status: number) =>
      createEscrowClient({
        baseUrl: 'http://escrow.test',
        token: 't',
        fetchFn: (async () => new Response('{}', { status })) as unknown as typeof fetch,
      })
    expect(await answering(200).revokeOthers()).toEqual({ kind: 'revoked' })
    for (const status of [401, 409, 502, 503]) expect(await answering(status).revokeOthers()).toEqual({ kind: 'unavailable' })
    const broken = createEscrowClient({
      baseUrl: 'http://escrow.test',
      token: 't',
      fetchFn: (async () => {
        throw new TypeError('network')
      }) as unknown as typeof fetch,
    })
    expect(await broken.revokeOthers()).toEqual({ kind: 'unavailable' })
  })
})

describe('createPeopleClient (ADR-083)', () => {
  const answering = (status: number, body: unknown = {}): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status })) as typeof fetch
  const client = (fetchFn: typeof fetch, timeoutMs?: number) =>
    createPeopleClient({ baseUrl: 'http://escrow.test/', token: 'tok', fetchFn, timeoutMs })
  const person = { email: 'a@b.c', name: 'A', kind: 'member' as const }

  it('isAdmin: só 200 com admin true; falha é false', async () => {
    expect(await client(answering(200, { admin: true })).isAdmin()).toBe(true)
    expect(await client(answering(200, { admin: false })).isAdmin()).toBe(false)
    expect(await client(answering(502)).isAdmin()).toBe(false)
    expect(await client((() => Promise.reject(new Error('net'))) as typeof fetch).isAdmin()).toBe(false)
  })

  it('invite: 201 criado e 201 completed são o mesmo desfecho', async () => {
    const created = { userId: '@u-x:t', kind: 'member' }
    const expected = { kind: 'invited', userId: '@u-x:t', personKind: 'member' }
    expect(await client(answering(201, created)).invite(person)).toEqual(expected)
    expect(await client(answering(201, { ...created, completed: ['org'] })).invite(person)).toEqual(expected)
  })

  it.each([
    [409, 'exists'],
    [403, 'forbidden'],
    [400, 'rejected'],
    [502, 'unavailable'],
    [504, 'unavailable'],
  ])('invite: %i → %s', async (status, kind) => {
    expect(await client(answering(status)).invite(person)).toEqual({ kind })
  })

  it('invite: 201 malformado é unavailable', async () => {
    expect(await client(answering(201, {})).invite(person)).toEqual({ kind: 'unavailable' })
  })

  it('o timeout aborta a chamada e vira unavailable', async () => {
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('aborted')))
      })) as typeof fetch
    expect(await client(hanging, 5).invite(person)).toEqual({ kind: 'unavailable' })
  })

  it('remove: DELETE com o id codificado; 200 removido, 404 rejeitado, 5xx indisponível', async () => {
    const seen: Array<[string, string]> = []
    const spy = (async (url: string, init: RequestInit) => {
      seen.push([url, init.method!])
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    expect(await client(spy).remove('@u-x:t')).toEqual({ kind: 'removed' })
    expect(seen).toEqual([['http://escrow.test/v1/people/%40u-x%3At', 'DELETE']])
    expect(await client(answering(404)).remove('@u-x:t')).toEqual({ kind: 'rejected' })
    expect(await client(answering(403, { error: 'forbidden' })).remove('@u-x:t')).toEqual({ kind: 'forbidden' })
    expect(await client(answering(502)).remove('@u-x:t')).toEqual({ kind: 'unavailable' })
  })

  it('agentes: 403 é forbidden em criar, editar, reemitir e remover', async () => {
    const no = client(answering(403, { error: 'forbidden' }))
    expect(await no.createAgent({ name: 'X', color: 'areia' })).toEqual({ kind: 'forbidden' })
    expect(await no.updateAgent('@a-x:t', { name: 'Y' })).toEqual({ kind: 'forbidden' })
    expect(await no.reissueAgent('@a-x:t')).toEqual({ kind: 'forbidden' })
    expect(await no.removeAgent('@a-x:t')).toEqual({ kind: 'forbidden' })
  })
})

// ADR-118 dec. 4 e 5 (fatia 1c): a leitura do papel e o verbo de promover/rebaixar, com as formas reais do
// `org` (org/src/admins.ts): 409 traz `{ reason, userId }`, 403/400 trazem `{ error }`.
describe('createPeopleClient — papel de admin (ADR-118)', () => {
  const answering = (status: number, body: unknown = {}): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status })) as typeof fetch
  const client = (fetchFn: typeof fetch, timeoutMs?: number) =>
    createPeopleClient({ baseUrl: 'http://escrow.test/', token: 'tok', fetchFn, timeoutMs })
  const hanging = ((_url: string, init: RequestInit) =>
    new Promise((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')))
    })) as typeof fetch

  it('access: GET /v1/org/access; 200 traz os dois conjuntos', async () => {
    const seen: Array<[string, string]> = []
    const spy = (async (url: string, init: RequestInit) => {
      seen.push([url, init.method!])
      return new Response(JSON.stringify({ admins: ['@a:t'], withoutAccess: ['@b:t', '@a-r:t'] }), { status: 200 })
    }) as typeof fetch
    expect(await client(spy).access()).toEqual({ kind: 'access', admins: ['@a:t'], withoutAccess: ['@b:t', '@a-r:t'] })
    expect(seen).toEqual([['http://escrow.test/v1/org/access', 'GET']])
  })

  it.each([
    [403, { error: 'forbidden' }, 'forbidden'],
    [400, { error: 'bad_request' }, 'rejected'],
    [404, { error: 'not_found' }, 'rejected'],
    [502, { error: 'admin_unavailable' }, 'unavailable'],
    [200, { admins: ['@a:t'] }, 'unavailable'],
    [200, { admins: ['@a:t'], withoutAccess: [1] }, 'unavailable'],
  ])('access: %i %j → %s', async (status, body, kind) => {
    expect(await client(answering(status, body)).access()).toEqual({ kind })
  })

  it('access: prazo e rede viram unavailable', async () => {
    expect(await client(hanging, 5).access()).toEqual({ kind: 'unavailable' })
    expect(await client((() => Promise.reject(new Error('net'))) as typeof fetch).access()).toEqual({ kind: 'unavailable' })
  })

  it('setAdmin: PUT promove, DELETE rebaixa, no id codificado, corpo vazio', async () => {
    const seen: Array<[string, string, unknown]> = []
    const spy = (async (url: string, init: RequestInit) => {
      seen.push([url, init.method!, init.body])
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    expect(await client(spy).setAdmin('@u-x:t', true)).toEqual({ kind: 'done' })
    expect(await client(spy).setAdmin('@u-x:t', false)).toEqual({ kind: 'done' })
    expect(seen).toEqual([
      ['http://escrow.test/v1/people/%40u-x%3At/admin', 'PUT', undefined],
      ['http://escrow.test/v1/people/%40u-x%3At/admin', 'DELETE', undefined],
    ])
  })

  it.each([
    [200, { userId: '@u:t', admin: true }, 'done'],
    [400, { error: 'bad_target' }, 'rejected'],
    [403, { error: 'forbidden' }, 'forbidden'],
    [404, { error: 'not_found' }, 'rejected'],
    [409, { reason: 'is_agent', userId: '@a-x:t', kind: 'agent' }, 'rejected'],
    [409, { reason: 'not_member', userId: '@u:t' }, 'not_member'],
    [409, { reason: 'last_admin', userId: '@u:t' }, 'last_admin'],
    [409, { reason: 'something_new' }, 'rejected'],
    [502, { error: 'admin_unavailable' }, 'unavailable'],
  ])('setAdmin: %i %j → %s', async (status, body, kind) => {
    expect(await client(answering(status, body)).setAdmin('@u:t', true)).toEqual({ kind })
  })

  it('setAdmin: prazo e rede viram unavailable', async () => {
    expect(await client(hanging, 5).setAdmin('@u:t', false)).toEqual({ kind: 'unavailable' })
    expect(await client((() => Promise.reject(new Error('net'))) as typeof fetch).setAdmin('@u:t', true)).toEqual({
      kind: 'unavailable',
    })
  })
})
