import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createEscrowServer, MAX_SESSION_BODY_BYTES } from '../../src/server.ts'
import { IdpUnavailableError, type Introspector } from '../../src/auth.ts'
import { importOrgKey } from '../../src/crypto.ts'
import { fileSessionStore } from '../../src/custody-store.ts'
import { fileStore } from '../../src/store.ts'
import { jsonlAudit } from '../../src/audit.ts'

// Superfície de custódia de sessão (ADR-057 dec. 5): PUT/GET /v1/sessions com fake
// introspector no idioma do server.test.ts — aqui o fake resolve identityOf (sub +
// username), a chave de endereçamento do retrieve e o discriminador do papel `cofre`.
function fakeIntrospector(): Introspector {
  const identities: Record<string, { sub: string; username: string }> = {
    'tok-cofre': { sub: 'sub-cofre-01KTWA0000000000000000000A', username: 'cofre' },
    'tok-ana': { sub: 'sub-ana-01KTWA0000000000000000000B', username: 'ana' },
    'tok-beto': { sub: 'sub-beto-01KTWA0000000000000000000C', username: 'beto' },
    'tok-carol': { sub: 'sub-carol-01KTWA0000000000000000000D', username: 'carol' },
  }
  return {
    subjectOf(token) {
      if (token === 'tok-idp-down') return Promise.reject(new IdpUnavailableError())
      return Promise.resolve(identities[token]?.sub ?? null)
    },
    identityOf(token) {
      if (token === 'tok-idp-down') return Promise.reject(new IdpUnavailableError())
      return Promise.resolve(identities[token] ?? null)
    },
    accessOf: () => Promise.resolve(null),
  }
}

const ROOM_1 = '!salaUm:example.test'
const ROOM_2 = '!salaDois:example.test'
const SESSION_1 = 'megolm-sessao-um'
const SESSION_2 = 'megolm-sessao-dois'

// Entry no shape do export Megolm provado no spike C2: room_id/session_id ecoados +
// material. O session_key é o "material" dos asserts de vazamento.
function megolmEntry(roomId: string, sessionId: string): Record<string, unknown> {
  return {
    algorithm: 'm.megolm.v1.aes-sha2',
    room_id: roomId,
    session_id: sessionId,
    session_key: `AgAA-material-secreto-${sessionId}`,
    sender_key: 'curve25519-sender-key',
    sender_claimed_keys: { ed25519: 'ed25519-claimed' },
    forwarding_curve25519_key_chain: [],
  }
}

function depositBody(roomId: string, sessionId: string, addressed: unknown): string {
  return JSON.stringify({
    room_id: roomId,
    session_id: sessionId,
    addressed,
    session: megolmEntry(roomId, sessionId),
  })
}

let dir: string
let sessionsDir: string
let server: Server
let base: string

async function auditLines(): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(dir, 'audit.jsonl'), 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

async function sessionFiles(): Promise<string[]> {
  return (await readdir(sessionsDir)).filter((n) => /^[0-9a-f]{64}$/.test(n))
}

function request(
  method: 'PUT' | 'GET' | 'POST',
  opts: { token?: string; body?: string; contentType?: string } = {},
): Promise<Response> {
  return fetch(`${base}/v1/sessions`, {
    method,
    headers: {
      ...(opts.token !== undefined ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined
        ? { 'Content-Type': opts.contentType ?? 'application/json' }
        : {}),
    },
    body: opts.body,
  })
}

async function retrieveOf(token: string): Promise<Array<Record<string, unknown>>> {
  const res = await request('GET', { token })
  expect(res.status).toBe(200)
  return ((await res.json()) as { sessions: Array<Record<string, unknown>> }).sessions
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'escrow-sessions-'))
  sessionsDir = join(dir, 'sessions')
  server = createEscrowServer({
    store: fileStore(dir),
    introspector: fakeIntrospector(),
    orgKey: await importOrgKey(
      Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
    ),
    audit: jsonlAudit(join(dir, 'audit.jsonl')),
    sessionStore: fileSessionStore(sessionsDir),
    custodyUsername: 'cofre',
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
})

describe('custódia de sessão — depósito (PUT /v1/sessions)', () => {
  it('201 created no primeiro depósito; redepósito → 200 exists sem comparar conteúdo', async () => {
    const first = await request('PUT', {
      token: 'tok-cofre',
      body: depositBody(ROOM_1, SESSION_1, ['ana']),
    })
    expect(first.status).toBe(201)
    expect(await first.json()).toEqual({ outcome: 'created' })
    const again = await request('PUT', {
      token: 'tok-cofre',
      body: depositBody(ROOM_1, SESSION_1, ['ana']),
    })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ outcome: 'exists' })
    expect(await sessionFiles()).toHaveLength(1)
  })

  it('write-once sob corrida: dois depósitos simultâneos da mesma sessão → um created, um exists', async () => {
    const [a, b] = await Promise.all([
      request('PUT', { token: 'tok-cofre', body: depositBody(ROOM_1, SESSION_1, ['ana']) }),
      request('PUT', { token: 'tok-cofre', body: depositBody(ROOM_1, SESSION_1, ['ana']) }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 201])
    expect(await sessionFiles()).toHaveLength(1)
  })

  it('token válido de quem não é cofre → 403 forbidden, storage intocado, audit forbidden com sub', async () => {
    const res = await request('PUT', {
      token: 'tok-ana',
      body: depositBody(ROOM_1, SESSION_1, ['ana']),
    })
    expect(res.status).toBe(403)
    expect(await res.text()).toBe(JSON.stringify({ error: 'forbidden' }))
    expect(await sessionFiles()).toHaveLength(0)
    const [line] = await auditLines()
    expect(line).toMatchObject({ verb: 'deposit', outcome: 'forbidden' })
    expect(line!.sub).toBe('sub-ana-01KTWA0000000000000000000B')
  })

  it('401 indistinguível sem token válido; método desconhecido → 404', async () => {
    const noHeader = await request('PUT', { body: depositBody(ROOM_1, SESSION_1, ['ana']) })
    const garbage = await request('PUT', {
      token: 'tok-desconhecido',
      body: depositBody(ROOM_1, SESSION_1, ['ana']),
    })
    for (const res of [noHeader, garbage]) expect(res.status).toBe(401)
    const bodies = await Promise.all([noHeader.text(), garbage.text()])
    expect(new Set(bodies).size).toBe(1)
    for (const line of await auditLines()) {
      expect(line.outcome).toBe('unauthorized')
      expect(line).not.toHaveProperty('sub')
    }
    expect((await request('POST', { token: 'tok-cofre', body: '{}' })).status).toBe(404)
  })

  it('400 para cada violação da allowlist do depósito', async () => {
    const valid = JSON.parse(depositBody(ROOM_1, SESSION_1, ['ana'])) as Record<string, unknown>
    const cases: string[] = [
      'not json',
      JSON.stringify(['array']),
      JSON.stringify({ ...valid, extra: 1 }), // campo extra
      JSON.stringify({ room_id: ROOM_1, session_id: SESSION_1, addressed: ['ana'] }), // sem session
      JSON.stringify({ ...valid, room_id: '' }),
      JSON.stringify({ ...valid, addressed: [] }), // endereçamento vazio
      JSON.stringify({ ...valid, addressed: ['@ana:example.test'] }), // mxid, não localpart
      JSON.stringify({ ...valid, addressed: ['ana:example.test'] }),
      JSON.stringify({ ...valid, addressed: [''] }),
      JSON.stringify({ ...valid, addressed: ['ana', 7] }),
      JSON.stringify({ ...valid, session: 'não-objeto' }),
      JSON.stringify({ ...valid, session: megolmEntry(ROOM_2, SESSION_1) }), // room_id não ecoa
      JSON.stringify({ ...valid, session: megolmEntry(ROOM_1, SESSION_2) }), // session_id não ecoa
    ]
    for (const body of cases) {
      const res = await request('PUT', { token: 'tok-cofre', body })
      expect(res.status).toBe(400)
    }
    const wrongType = await request('PUT', {
      token: 'tok-cofre',
      body: depositBody(ROOM_1, SESSION_1, ['ana']),
      contentType: 'text/plain',
    })
    expect(wrongType.status).toBe(400)
    expect(await sessionFiles()).toHaveLength(0)
  })

  it(`413 acima de ${MAX_SESSION_BODY_BYTES} bytes (limite próprio; MAX_BODY_BYTES do /v1/secret não muda)`, async () => {
    const entry = megolmEntry(ROOM_1, SESSION_1)
    entry.padding = 'A'.repeat(MAX_SESSION_BODY_BYTES * 2)
    const res = await request('PUT', {
      token: 'tok-cofre',
      body: JSON.stringify({ room_id: ROOM_1, session_id: SESSION_1, addressed: ['ana'], session: entry }),
    })
    expect(res.status).toBe(413)
    expect(await sessionFiles()).toHaveLength(0)
  })

  it('503 quando o IdP não responde, em PUT e GET', async () => {
    for (const method of ['PUT', 'GET'] as const) {
      const res = await request(method, {
        token: 'tok-idp-down',
        ...(method === 'PUT' ? { body: depositBody(ROOM_1, SESSION_1, ['ana']) } : {}),
      })
      expect(res.status).toBe(503)
    }
    expect(await sessionFiles()).toHaveLength(0)
  })
})

describe('custódia de sessão — retrieve por endereçamento (GET /v1/sessions)', () => {
  it('norma 1: beto (late joiner) recebe SÓ a sessão que o endereça; ana recebe ambas', async () => {
    await request('PUT', { token: 'tok-cofre', body: depositBody(ROOM_1, SESSION_1, ['ana']) })
    await request('PUT', { token: 'tok-cofre', body: depositBody(ROOM_1, SESSION_2, ['ana', 'beto']) })
    const beto = await retrieveOf('tok-beto')
    expect(beto).toHaveLength(1)
    expect(beto[0]).toEqual(megolmEntry(ROOM_1, SESSION_2))
    // endereçamento é fato de nascimento: nada revoga as duas entregas de ana
    const ana = await retrieveOf('tok-ana')
    expect(ana.map((s) => s.session_id).sort()).toEqual([SESSION_1, SESSION_2].sort())
    for (const entry of ana) {
      expect(entry).toEqual(megolmEntry(ROOM_1, entry.session_id as string))
    }
  })

  it('usuário autenticado sem match → 200 com array vazio (ausência é resposta normal)', async () => {
    await request('PUT', { token: 'tok-cofre', body: depositBody(ROOM_1, SESSION_1, ['ana']) })
    expect(await retrieveOf('tok-carol')).toEqual([])
  })

  it('a identidade de custódia não lê (ADR-069): cofre → 403, endereçado segue lendo', async () => {
    // O cofre é membro ao nascimento de toda sala cifrada, logo endereçado de toda sessão —
    // o cenário real, não um addressed sintético.
    await request('PUT', { token: 'tok-cofre', body: depositBody(ROOM_1, SESSION_1, ['ana', 'cofre']) })
    const res = await request('GET', { token: 'tok-cofre' })
    expect(res.status).toBe(403)
    expect(await res.text()).toBe(JSON.stringify({ error: 'forbidden' })) // sem payload
    const last = (await auditLines()).at(-1)
    expect(last).toMatchObject({ verb: 'retrieve', outcome: 'forbidden', sub: 'sub-cofre-01KTWA0000000000000000000A' })
    expect(await retrieveOf('tok-ana')).toEqual([megolmEntry(ROOM_1, SESSION_1)])
  })

  it('401 sem token válido no retrieve', async () => {
    expect((await request('GET', {})).status).toBe(401)
    expect((await request('GET', { token: 'tok-desconhecido' })).status).toBe(401)
  })

  it('AAD amarra blob à chave: material realocado entre sessões → 500 genérico, nada entregue', async () => {
    await request('PUT', { token: 'tok-cofre', body: depositBody(ROOM_1, SESSION_1, ['ana']) })
    await request('PUT', { token: 'tok-cofre', body: depositBody(ROOM_2, SESSION_2, ['ana']) })
    // Formato do registro (custody-store): u32be keyLen ‖ chave ‖ blob selado. O ataque
    // simulado move o blob selado de S1 para o registro de S2, preservando a chave de S2.
    const [fileA, fileB] = (await sessionFiles()).sort()
    const rawA = await readFile(join(sessionsDir, fileA!))
    const rawB = await readFile(join(sessionsDir, fileB!))
    const prefixLenB = 4 + rawB.readUInt32BE(0)
    const blobA = rawA.subarray(4 + rawA.readUInt32BE(0))
    await writeFile(join(sessionsDir, fileB!), Buffer.concat([rawB.subarray(0, prefixLenB), blobA]))
    const res = await request('GET', { token: 'tok-ana' })
    expect(res.status).toBe(500)
    expect(await res.text()).toBe(JSON.stringify({ error: 'internal' })) // sem detalhe de cripto
    const last = (await auditLines()).at(-1)
    expect(last).toMatchObject({ verb: 'retrieve', outcome: 'error' })
  })
})

describe('custódia de sessão — auditoria', () => {
  it('uma linha por acesso, verbos/desfechos novos, zero material/IDs de sessão', async () => {
    const addressed = ['ana', 'endereacado-distintivo-do-envelope']
    await request('PUT', { token: 'tok-cofre', body: depositBody(ROOM_1, SESSION_1, addressed) }) // created
    await request('PUT', { token: 'tok-cofre', body: depositBody(ROOM_1, SESSION_1, addressed) }) // exists
    await request('PUT', { token: 'tok-ana', body: depositBody(ROOM_1, SESSION_2, ['ana']) }) // forbidden
    await request('GET', { token: 'tok-ana' }) // ok
    await request('GET', {}) // unauthorized
    const lines = await auditLines()
    expect(lines.map((l) => [l.verb, l.outcome])).toEqual([
      ['deposit', 'created'],
      ['deposit', 'exists'],
      ['deposit', 'forbidden'],
      ['retrieve', 'ok'],
      ['retrieve', 'unauthorized'],
    ])
    expect(lines[0]!.sub).toBe('sub-cofre-01KTWA0000000000000000000A')
    expect(lines[3]!.sub).toBe('sub-ana-01KTWA0000000000000000000B')
    // formato burro preservado: nem material, nem room/session id, nem token no audit
    const raw = await readFile(join(dir, 'audit.jsonl'), 'utf8')
    for (const leak of [ROOM_1, SESSION_1, 'AgAA-material-secreto', 'tok-cofre', 'tok-ana']) {
      expect(raw).not.toContain(leak)
    }
    // o material selado at rest tampouco está em claro
    for (const file of await sessionFiles()) {
      const bytes = await readFile(join(sessionsDir, file))
      expect(bytes.includes(Buffer.from(`AgAA-material-secreto-${SESSION_1}`))).toBe(false)
      // endereçados DENTRO do envelope selado: membership não fica em claro at rest
      expect(bytes.includes(Buffer.from('endereacado-distintivo-do-envelope'))).toBe(false)
      expect(bytes.includes(Buffer.from('addressed'))).toBe(false)
    }
  })
})
