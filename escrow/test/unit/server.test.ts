import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createEscrowServer, MAX_BODY_BYTES } from '../../src/server.ts'
import { IdpUnavailableError, type Introspector } from '../../src/auth.ts'
import { etagOf, importOrgKey } from '../../src/crypto.ts'
import { fileSessionStore } from '../../src/custody-store.ts'
import { fileStore } from '../../src/store.ts'
import { jsonlAudit } from '../../src/audit.ts'

// Introspector fake (PLANO §4 commit 5): tokens conhecidos → sujeito; 'tok-inactive'
// simula active:false; 'tok-idp-down' simula MAS fora do ar. Conta chamadas para o
// assert de "healthz não introspecta".
function fakeIntrospector(): Introspector & { calls: number } {
  const subjects: Record<string, string> = {
    'tok-alice': 'sub-alice-01KTW95XRNB4KPFKRFGYFV7BY7',
    'tok-bob': 'sub-bob-01KTW95XX5M79VDTBEMA6B5TN7',
  }
  return {
    calls: 0,
    subjectOf(token) {
      this.calls += 1
      if (token === 'tok-idp-down') return Promise.reject(new IdpUnavailableError())
      return Promise.resolve(subjects[token] ?? null)
    },
    // Rotas de custódia não são exercitadas aqui (sessions.test.ts); o método existe
    // só para satisfazer o port estendido.
    identityOf(token) {
      this.calls += 1
      if (token === 'tok-idp-down') return Promise.reject(new IdpUnavailableError())
      const sub = subjects[token]
      return Promise.resolve(sub ? { sub, username: token.replace('tok-', '') } : null)
    },
    accessOf: () => Promise.resolve(null),
  }
}

const SECRET_BYTES = globalThis.crypto.getRandomValues(new Uint8Array(32))
const SECRET_B64 = Buffer.from(SECRET_BYTES).toString('base64')

let dir: string
let server: Server
let base: string
let introspector: ReturnType<typeof fakeIntrospector>

async function auditLines(): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(dir, 'audit.jsonl'), 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

async function secretFiles(): Promise<string[]> {
  return (await readdir(dir)).filter((n) => n !== 'audit.jsonl' && n !== 'sessions')
}

function request(
  method: 'PUT' | 'GET' | 'POST',
  path: string,
  opts: { token?: string; body?: string; contentType?: string; ifMatch?: string } = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.token !== undefined ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined
        ? { 'Content-Type': opts.contentType ?? 'application/json' }
        : {}),
      ...(opts.ifMatch !== undefined ? { 'If-Match': opts.ifMatch } : {}),
    },
    body: opts.body,
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'escrow-server-'))
  introspector = fakeIntrospector()
  server = createEscrowServer({
    store: fileStore(dir),
    introspector,
    orgKey: await importOrgKey(
      Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
    ),
    audit: jsonlAudit(join(dir, 'audit.jsonl')),
    sessionStore: fileSessionStore(join(dir, 'sessions')),
    custodyUsername: 'cofre',
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
})

describe('escrow HTTP surface (PLANO §3.2/§3.3, fake introspector)', () => {
  it('PUT 201 → GET 200 round-trips the exact bytes for the token subject', async () => {
    const put = await request('PUT', '/v1/secret', {
      token: 'tok-alice',
      body: JSON.stringify({ secret: SECRET_B64 }),
    })
    expect(put.status).toBe(201)
    const get = await request('GET', '/v1/secret', { token: 'tok-alice' })
    expect(get.status).toBe(200)
    const { secret } = (await get.json()) as { secret: string }
    expect(secret).toBe(SECRET_B64)
  })

  it('is write-once: second PUT → 409 and the first secret survives', async () => {
    await request('PUT', '/v1/secret', { token: 'tok-alice', body: JSON.stringify({ secret: SECRET_B64 }) })
    const again = await request('PUT', '/v1/secret', {
      token: 'tok-alice',
      body: JSON.stringify({ secret: Buffer.from('outro').toString('base64') }),
    })
    expect(again.status).toBe(409)
    expect(((await again.json()) as { error: string }).error).toBe('conflict')
    const get = await request('GET', '/v1/secret', { token: 'tok-alice' })
    expect(((await get.json()) as { secret: string }).secret).toBe(SECRET_B64)
  })

  it('derives identity from the token ONLY: bob does not see alice; no field can change that', async () => {
    await request('PUT', '/v1/secret', { token: 'tok-alice', body: JSON.stringify({ secret: SECRET_B64 }) })
    const bob = await request('GET', '/v1/secret', { token: 'tok-bob' })
    expect(bob.status).toBe(404)
    // campo desconhecido (tentativa de userId no corpo) é malformado por contrato → 400
    const smuggled = await request('PUT', '/v1/secret', {
      token: 'tok-bob',
      body: JSON.stringify({ secret: SECRET_B64, userId: 'sub-alice-01KTW95XRNB4KPFKRFGYFV7BY7' }),
    })
    expect(smuggled.status).toBe(400)
    // query string tampouco existe como canal
    const viaQuery = await request('GET', '/v1/secret?user=alice', { token: 'tok-bob' })
    expect(viaQuery.status).toBe(404)
  })

  it('401 is indistinguishable across causes and never touches the storage', async () => {
    const noHeader = await request('PUT', '/v1/secret', { body: JSON.stringify({ secret: SECRET_B64 }) })
    const inactive = await request('PUT', '/v1/secret', {
      token: 'tok-inactive',
      body: JSON.stringify({ secret: SECRET_B64 }),
    })
    const garbage = await request('GET', '/v1/secret', { token: 'mct_garbage' })
    for (const res of [noHeader, inactive, garbage]) expect(res.status).toBe(401)
    // corpos idênticos: nenhuma pista da causa
    const bodies = await Promise.all([noHeader.text(), inactive.text(), garbage.text()])
    expect(new Set(bodies).size).toBe(1)
    expect(bodies[0]).toBe(JSON.stringify({ error: 'unauthorized' }))
    // storage intocado; auditoria registra unauthorized SEM sub
    expect(await secretFiles()).toHaveLength(0)
    const lines = await auditLines()
    expect(lines).toHaveLength(3)
    for (const line of lines) {
      expect(line.outcome).toBe('unauthorized')
      expect(line).not.toHaveProperty('sub')
    }
  })

  it('GET without a deposit → 404', async () => {
    const res = await request('GET', '/v1/secret', { token: 'tok-alice' })
    expect(res.status).toBe(404)
  })

  it('rejects malformed bodies with 400: not JSON, wrong type, bad base64, empty, extra field', async () => {
    for (const body of [
      'not json',
      JSON.stringify('string'),
      JSON.stringify({}),
      JSON.stringify({ secret: 123 }),
      JSON.stringify({ secret: 'not base64!!' }),
      JSON.stringify({ secret: '' }),
      JSON.stringify({ secret: SECRET_B64, extra: 1 }),
    ]) {
      const res = await request('PUT', '/v1/secret', { token: 'tok-alice', body })
      expect(res.status).toBe(400)
    }
    // Content-Type errado idem
    const wrongType = await request('PUT', '/v1/secret', {
      token: 'tok-alice',
      body: JSON.stringify({ secret: SECRET_B64 }),
      contentType: 'text/plain',
    })
    expect(wrongType.status).toBe(400)
  })

  it(`rejects bodies over ${MAX_BODY_BYTES} bytes with 413`, async () => {
    const big = JSON.stringify({ secret: 'A'.repeat(MAX_BODY_BYTES * 2) })
    const res = await request('PUT', '/v1/secret', { token: 'tok-alice', body: big })
    expect(res.status).toBe(413)
  })

  it('responds 503 when the IdP is unreachable — the escrow does not decide alone', async () => {
    for (const method of ['PUT', 'GET'] as const) {
      const res = await request(method, '/v1/secret', {
        token: 'tok-idp-down',
        ...(method === 'PUT' ? { body: JSON.stringify({ secret: SECRET_B64 }) } : {}),
      })
      expect(res.status).toBe(503)
    }
    expect(await secretFiles()).toHaveLength(0)
  })

  it('healthz answers 200 without auth, without introspection and without audit', async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(introspector.calls).toBe(0)
    expect(await auditLines()).toHaveLength(0)
  })

  it('unknown routes → 404', async () => {
    expect((await fetch(`${base}/v2/secret`)).status).toBe(404)
    expect((await fetch(`${base}/v1/secret`, { method: 'POST' })).status).toBe(404)
  })

  it('serves a tampered blob as an opaque 500 — never best-effort bytes', async () => {
    await request('PUT', '/v1/secret', { token: 'tok-alice', body: JSON.stringify({ secret: SECRET_B64 }) })
    const [file] = await secretFiles()
    const stored = await readFile(join(dir, file!))
    stored[stored.length - 1] = stored[stored.length - 1]! ^ 0x01
    await rm(join(dir, file!))
    await writeFile(join(dir, file!), stored)
    const res = await request('GET', '/v1/secret', { token: 'tok-alice' })
    expect(res.status).toBe(500)
    expect(await res.text()).toBe(JSON.stringify({ error: 'internal' }))
  })

  it('PUT 201 e GET 200 expõem ETag do blob corrente (D1 §2.2; aditivo, corpo intocado)', async () => {
    const put = await request('PUT', '/v1/secret', {
      token: 'tok-alice',
      body: JSON.stringify({ secret: SECRET_B64 }),
    })
    expect(put.status).toBe(201)
    const putEtag = put.headers.get('etag')
    expect(putEtag).toMatch(/^[0-9a-f]{32}$/)
    expect(await put.json()).toEqual({ created: true }) // corpo do PUT inalterado
    const get = await request('GET', '/v1/secret', { token: 'tok-alice' })
    expect(get.headers.get('etag')).toBe(putEtag)
    // o etag É o do blob at-rest corrente (derivado na leitura, nunca persistido)
    const [file] = await secretFiles()
    expect(etagOf(new Uint8Array(await readFile(join(dir, file!))))).toBe(putEtag)
  })

  it('rotate 200: troca real — GET subsequente devolve segredo novo + etag novo', async () => {
    const put = await request('PUT', '/v1/secret', {
      token: 'tok-alice',
      body: JSON.stringify({ secret: SECRET_B64 }),
    })
    const e1 = put.headers.get('etag')!
    const newSecret = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32)))
    const rot = await request('POST', '/v1/secret/rotate', {
      token: 'tok-alice',
      ifMatch: e1,
      body: JSON.stringify({ secret: newSecret.toString('base64') }),
    })
    expect(rot.status).toBe(200)
    expect(await rot.json()).toEqual({ rotated: true })
    const e2 = rot.headers.get('etag')!
    expect(e2).toMatch(/^[0-9a-f]{32}$/)
    expect(e2).not.toBe(e1)
    const get = await request('GET', '/v1/secret', { token: 'tok-alice' })
    expect(((await get.json()) as { secret: string }).secret).toBe(newSecret.toString('base64'))
    expect(get.headers.get('etag')).toBe(e2)
  })

  it('rotate NUNCA cria: sujeito virgem → 404 e nenhuma escrita no storage', async () => {
    const res = await request('POST', '/v1/secret/rotate', {
      token: 'tok-alice',
      ifMatch: '0'.repeat(32),
      body: JSON.stringify({ secret: SECRET_B64 }),
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('not_found')
    expect(await secretFiles()).toHaveLength(0)
  })

  it('rotate com etag velho → 412 e storage byte a byte intocado', async () => {
    const put = await request('PUT', '/v1/secret', {
      token: 'tok-alice',
      body: JSON.stringify({ secret: SECRET_B64 }),
    })
    const e1 = put.headers.get('etag')!
    const rot1 = await request('POST', '/v1/secret/rotate', {
      token: 'tok-alice',
      ifMatch: e1,
      body: JSON.stringify({ secret: Buffer.from('novo').toString('base64') }),
    })
    expect(rot1.status).toBe(200)
    const [file] = await secretFiles()
    const atRest = await readFile(join(dir, file!))
    // e1 ficou velho após a rotação acima
    const rot2 = await request('POST', '/v1/secret/rotate', {
      token: 'tok-alice',
      ifMatch: e1,
      body: JSON.stringify({ secret: Buffer.from('intruso').toString('base64') }),
    })
    expect(rot2.status).toBe(412)
    expect(((await rot2.json()) as { error: string }).error).toBe('precondition_failed')
    expect((await readFile(join(dir, file!))).equals(atRest)).toBe(true)
  })

  it('rotate sem If-Match → 428, antes de tocar o storage', async () => {
    await request('PUT', '/v1/secret', { token: 'tok-alice', body: JSON.stringify({ secret: SECRET_B64 }) })
    const [file] = await secretFiles()
    const atRest = await readFile(join(dir, file!))
    const res = await request('POST', '/v1/secret/rotate', {
      token: 'tok-alice',
      body: JSON.stringify({ secret: Buffer.from('novo').toString('base64') }),
    })
    expect(res.status).toBe(428)
    expect(((await res.json()) as { error: string }).error).toBe('precondition_required')
    expect((await readFile(join(dir, file!))).equals(atRest)).toBe(true)
  })

  it('rotate com token inativo → 401 antes do storage, indistinguível entre causas', async () => {
    const res = await request('POST', '/v1/secret/rotate', {
      token: 'tok-inactive', // o fake devolve null (active:false)
      ifMatch: '0'.repeat(32),
      body: JSON.stringify({ secret: SECRET_B64 }),
    })
    expect(res.status).toBe(401)
    expect(await res.text()).toBe(JSON.stringify({ error: 'unauthorized' }))
    expect(await secretFiles()).toHaveLength(0)
  })

  it('write-once intacto: PUT pós-rotate → 409', async () => {
    const put = await request('PUT', '/v1/secret', {
      token: 'tok-alice',
      body: JSON.stringify({ secret: SECRET_B64 }),
    })
    await request('POST', '/v1/secret/rotate', {
      token: 'tok-alice',
      ifMatch: put.headers.get('etag')!,
      body: JSON.stringify({ secret: Buffer.from('novo').toString('base64') }),
    })
    const again = await request('PUT', '/v1/secret', {
      token: 'tok-alice',
      body: JSON.stringify({ secret: SECRET_B64 }),
    })
    expect(again.status).toBe(409)
  })

  it('auditoria do rotate: os cinco desfechos, com verbo próprio (D1 §2.3)', async () => {
    // unauthorized (sem sub) → depois o ciclo autenticado: not_found, rotated, stale,
    // missing_precondition
    await request('POST', '/v1/secret/rotate', {
      token: 'tok-inactive',
      ifMatch: '0'.repeat(32),
      body: JSON.stringify({ secret: SECRET_B64 }),
    })
    await request('POST', '/v1/secret/rotate', {
      token: 'tok-alice',
      ifMatch: '0'.repeat(32),
      body: JSON.stringify({ secret: SECRET_B64 }),
    }) // not_found
    const put = await request('PUT', '/v1/secret', {
      token: 'tok-alice',
      body: JSON.stringify({ secret: SECRET_B64 }),
    })
    const e1 = put.headers.get('etag')!
    await request('POST', '/v1/secret/rotate', {
      token: 'tok-alice',
      ifMatch: e1,
      body: JSON.stringify({ secret: Buffer.from('novo').toString('base64') }),
    }) // rotated
    await request('POST', '/v1/secret/rotate', {
      token: 'tok-alice',
      ifMatch: e1,
      body: JSON.stringify({ secret: Buffer.from('outro').toString('base64') }),
    }) // stale
    await request('POST', '/v1/secret/rotate', {
      token: 'tok-alice',
      body: JSON.stringify({ secret: Buffer.from('outro').toString('base64') }),
    }) // missing_precondition
    const rotateLines = (await auditLines()).filter((l) => l.verb === 'rotate')
    expect(rotateLines.map((l) => l.outcome)).toEqual([
      'unauthorized',
      'not_found',
      'rotated',
      'stale',
      'missing_precondition',
    ])
    expect(rotateLines[0]).not.toHaveProperty('sub')
    for (const line of rotateLines.slice(1)) {
      expect(line.sub).toBe('sub-alice-01KTW95XRNB4KPFKRFGYFV7BY7')
    }
    // nenhum etag de segredo na auditoria (D1 §2.3: não logar)
    const raw = await readFile(join(dir, 'audit.jsonl'), 'utf8')
    expect(raw).not.toContain(e1)
  })

  it('keeps every byte of secret material out of audit and out of error responses', async () => {
    await request('PUT', '/v1/secret', { token: 'tok-alice', body: JSON.stringify({ secret: SECRET_B64 }) })
    await request('PUT', '/v1/secret', { token: 'tok-alice', body: JSON.stringify({ secret: SECRET_B64 }) }) // 409
    await request('GET', '/v1/secret', { token: 'tok-bob' }) // 404
    await request('GET', '/v1/secret', { token: 'mct_garbage' }) // 401
    const auditRaw = await readFile(join(dir, 'audit.jsonl'), 'utf8')
    expect(auditRaw).not.toContain(SECRET_B64)
    expect(auditRaw).not.toContain('tok-alice') // nenhum token na auditoria
    // trilha completa e na ordem: created, conflict, not_found, unauthorized
    const outcomes = (await auditLines()).map((l) => l.outcome)
    expect(outcomes).toEqual(['created', 'conflict', 'not_found', 'unauthorized'])
    // entradas autenticadas carregam o sujeito do token
    const lines = await auditLines()
    expect(lines[0]!.sub).toBe('sub-alice-01KTW95XRNB4KPFKRFGYFV7BY7')
    expect(lines[2]!.sub).toBe('sub-bob-01KTW95XX5M79VDTBEMA6B5TN7')
    // o segredo cru tampouco está em claro no storage
    for (const file of await secretFiles()) {
      const bytes = await readFile(join(dir, file))
      expect(bytes.includes(Buffer.from(SECRET_BYTES))).toBe(false)
      expect(bytes.includes(Buffer.from(SECRET_B64))).toBe(false)
    }
  })
})
