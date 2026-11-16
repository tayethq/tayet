import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mintOidcSession } from '../support/mint-oidc.ts'

// ── Gate local de integração da rotação (PLANO-FASE-2-ESCROW-D1 §5.2) ────────────────
// Extensão do gate de C1: MESMO harness (spawn por strip-types, porta 0 + readback,
// mint OIDC headless compartilhado — mintOidcSession, ../support/mint-oidc.ts) e MESMO
// teardown (processo morto + tmpdir removido sempre), em
// arquivo IRMÃO com spawn/tmpdir próprios — o match exato da auditoria de C1 permanece
// válido (PF-2 da D1). Auto-skip sem stack (issue #7; PF-3). Este gate NÃO usa bob:
// o gate de C1 roda em paralelo e executa kill-sessions bob (PF-3 da D1) — o ciclo
// principal é da alice e o sujeito virgem é usuário per-run (register-user).
// Os 10 asserts do §5.2 na ordem; o assert 6 (corrida do CAS — a variável novel)
// fica por ÚLTIMO no arquivo.

const MAS_URL = process.env.TAYET_MAS_URL ?? 'http://localhost:8080'
const MAS_CONTAINER = process.env.TAYET_MAS_CONTAINER ?? 'spike-mas-1'
const MAS_CONFIG = process.env.TAYET_MAS_CONFIG ?? '/config/config.yaml'
const CLIENT_ID = '00000000000000000000ESCR0W'
const CLIENT_SECRET = 'tayet-dev-stack-throwaway-escrow-introspection'

function stackUp(): boolean {
  try {
    execSync(`curl -sf -m 3 ${MAS_URL}/.well-known/openid-configuration`, { stdio: 'ignore' })
    execSync(`docker exec ${MAS_CONTAINER} mas-cli --version`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Usuário per-run (PF-3 da D1; padrão do harness de C2): o assert de sujeito virgem
// exige mundo virgem no MAS compartilhado. Senha throwaway classe-README.
function registerUser(username: string): void {
  execSync(
    `docker exec ${MAS_CONTAINER} mas-cli manage register-user -c ${MAS_CONFIG} --yes --ignore-password-complexity --password d1-throwaway-pw ${username} 2>&1`,
    { stdio: 'ignore' },
  )
}

let child: ChildProcess | undefined
let storeDir: string
let base: string
let aliceToken: string
let virginToken: string
const auditSnapshots: string[] = []

// Segredos do ciclo: o depositado (assert 1) e o rotacionado (assert 2 em diante).
const FIRST_BYTES = globalThis.crypto.getRandomValues(new Uint8Array(32))
const FIRST_B64 = Buffer.from(FIRST_BYTES).toString('base64')
const ROTATED_BYTES = globalThis.crypto.getRandomValues(new Uint8Array(32))
const ROTATED_B64 = Buffer.from(ROTATED_BYTES).toString('base64')

let etag1: string // E1: do PUT do assert 1
let etag2: string // E2: da rotação do assert 2

async function auditRaw(): Promise<string> {
  return readFile(join(storeDir, 'audit.jsonl'), 'utf8').catch(() => '')
}

async function auditEntries(): Promise<Array<Record<string, unknown>>> {
  return (await auditRaw())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

async function secretFiles(): Promise<string[]> {
  return (await readdir(storeDir)).filter((n) => n !== 'audit.jsonl' && n !== 'sessions')
}

async function blobAtRest(): Promise<Buffer> {
  const [file] = await secretFiles()
  return readFile(join(storeDir, file!))
}

function request(
  method: 'PUT' | 'GET' | 'POST',
  path: string,
  opts: { token?: string; body?: string; ifMatch?: string } = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.token !== undefined ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.ifMatch !== undefined ? { 'If-Match': opts.ifMatch } : {}),
    },
    body: opts.body,
  })
}

describe.skipIf(!stackUp())('gate rotação escrow↔MAS (stack real; D1 §5.2)', () => {
  beforeAll(async () => {
    storeDir = await mkdtemp(join(tmpdir(), 'escrow-rotate-gate-'))
    const serverPath = fileURLToPath(new URL('../../src/server.ts', import.meta.url))
    child = spawn(process.execPath, ['--experimental-strip-types', serverPath], {
      env: {
        ...process.env,
        ESCROW_PORT: '0',
        ESCROW_STORE_DIR: storeDir,
        ESCROW_ORG_KEY: Buffer.from(
          globalThis.crypto.getRandomValues(new Uint8Array(32)),
        ).toString('base64'), // gerada por run; jamais sai do env (§6)
        ESCROW_INTROSPECTION_URL: `${MAS_URL}/oauth2/introspect`,
        ESCROW_CLIENT_ID: CLIENT_ID,
        ESCROW_CLIENT_SECRET: CLIENT_SECRET,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const port = await new Promise<number>((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => reject(new Error('escrow did not report a port')), 15_000)
      child!.stdout!.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const line = buffer.split('\n')[0]
        if (buffer.includes('\n') && line) {
          clearTimeout(timer)
          resolve((JSON.parse(line) as { listening: number }).listening)
        }
      })
      child!.on('exit', (code) => reject(new Error(`escrow exited early (${code})`)))
    })
    base = `http://127.0.0.1:${port}`
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${base}/healthz`)).status === 200) break
      } catch {
        /* ainda subindo */
      }
      if (i > 50) throw new Error('escrow /healthz never came up')
      await new Promise((r) => setTimeout(r, 100))
    }
    aliceToken = (await mintOidcSession('alice', 'alicepass123')).accessToken
    const virgin = `d1rot${Math.random().toString(36).slice(2, 10)}`
    registerUser(virgin)
    virginToken = (await mintOidcSession(virgin, 'd1-throwaway-pw')).accessToken
  }, 60_000)

  afterAll(async () => {
    try {
      if (child && !child.killed) {
        const gone = new Promise((resolve) => child!.once('exit', resolve))
        child.kill('SIGTERM')
        await Promise.race([gone, new Promise((r) => setTimeout(r, 3_000))])
        if (child.exitCode === null) child.kill('SIGKILL')
      }
    } catch {
      /* best-effort */
    }
    await rm(storeDir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('1. etag no ciclo normal: PUT 201 devolve ETag E1; GET 200 devolve o MESMO E1', async () => {
    const put = await request('PUT', '/v1/secret', {
      token: aliceToken,
      body: JSON.stringify({ secret: FIRST_B64 }),
    })
    expect(put.status).toBe(201)
    etag1 = put.headers.get('etag')!
    expect(etag1).toMatch(/^[0-9a-f]{32}$/)
    const get = await request('GET', '/v1/secret', { token: aliceToken })
    expect(get.status).toBe(200)
    expect(get.headers.get('etag')).toBe(etag1)
    auditSnapshots.push(await auditRaw())
  }, 30_000)

  it('2. rotação feliz: If-Match=E1 → 200 + E2 ≠ E1; GET devolve o segredo NOVO + E2; blob mudou', async () => {
    const blobBefore = await blobAtRest()
    const rot = await request('POST', '/v1/secret/rotate', {
      token: aliceToken,
      ifMatch: etag1,
      body: JSON.stringify({ secret: ROTATED_B64 }),
    })
    expect(rot.status).toBe(200)
    expect(await rot.json()).toEqual({ rotated: true })
    etag2 = rot.headers.get('etag')!
    expect(etag2).toMatch(/^[0-9a-f]{32}$/)
    expect(etag2).not.toBe(etag1)
    const get = await request('GET', '/v1/secret', { token: aliceToken })
    expect(((await get.json()) as { secret: string }).secret).toBe(ROTATED_B64)
    expect(get.headers.get('etag')).toBe(etag2)
    expect((await blobAtRest()).equals(blobBefore)).toBe(false)
    auditSnapshots.push(await auditRaw())
  }, 30_000)

  it('3. sujeito virgem: rotate → 404; storage intocado (nenhum arquivo novo)', async () => {
    const filesBefore = await secretFiles()
    const res = await request('POST', '/v1/secret/rotate', {
      token: virginToken,
      ifMatch: etag2,
      body: JSON.stringify({ secret: FIRST_B64 }),
    })
    expect(res.status).toBe(404)
    expect(await secretFiles()).toEqual(filesBefore)
    auditSnapshots.push(await auditRaw())
  }, 30_000)

  it('4. etag velho: rotate com If-Match=E1 → 412; GET ainda devolve o segredo do assert 2 + E2', async () => {
    const blobBefore = await blobAtRest()
    const res = await request('POST', '/v1/secret/rotate', {
      token: aliceToken,
      ifMatch: etag1,
      body: JSON.stringify({ secret: Buffer.from('intruso').toString('base64') }),
    })
    expect(res.status).toBe(412)
    const get = await request('GET', '/v1/secret', { token: aliceToken })
    expect(((await get.json()) as { secret: string }).secret).toBe(ROTATED_B64)
    expect(get.headers.get('etag')).toBe(etag2)
    expect((await blobAtRest()).equals(blobBefore)).toBe(true) // byte a byte intocado
    auditSnapshots.push(await auditRaw())
  }, 30_000)

  it('5. If-Match ausente → 428; storage intocado', async () => {
    const blobBefore = await blobAtRest()
    const res = await request('POST', '/v1/secret/rotate', {
      token: aliceToken,
      body: JSON.stringify({ secret: Buffer.from('sem-precondicao').toString('base64') }),
    })
    expect(res.status).toBe(428)
    expect((await blobAtRest()).equals(blobBefore)).toBe(true)
    auditSnapshots.push(await auditRaw())
  }, 30_000)

  it('7. token inválido → 401 em rotate; auditoria unauthorized; storage intocado', async () => {
    const blobBefore = await blobAtRest()
    const res = await request('POST', '/v1/secret/rotate', {
      token: 'mct_garbage',
      ifMatch: etag2,
      body: JSON.stringify({ secret: FIRST_B64 }),
    })
    expect(res.status).toBe(401)
    expect((await blobAtRest()).equals(blobBefore)).toBe(true)
    const last = (await auditEntries()).at(-1)!
    expect(last.verb).toBe('rotate')
    expect(last.outcome).toBe('unauthorized')
    expect(last).not.toHaveProperty('sub')
    auditSnapshots.push(await auditRaw())
  }, 30_000)

  it('8. write-once preservado (regressão do 017): PUT no sujeito do assert 2 → 409', async () => {
    const res = await request('PUT', '/v1/secret', {
      token: aliceToken,
      body: JSON.stringify({ secret: FIRST_B64 }),
    })
    expect(res.status).toBe(409)
    const get = await request('GET', '/v1/secret', { token: aliceToken })
    expect(((await get.json()) as { secret: string }).secret).toBe(ROTATED_B64)
    auditSnapshots.push(await auditRaw())
  }, 30_000)

  it('9. auditoria: verbo rotate com desfechos corretos para 2–5 e 7; append-only; zero material', async () => {
    const entries = await auditEntries()
    expect(
      entries.filter((e) => e.verb === 'rotate').map((e) => e.outcome),
    ).toEqual([
      'rotated', // 2
      'not_found', // 3
      'stale', // 4
      'missing_precondition', // 5
      'unauthorized', // 7
    ])
    // identidade do token: rotate autenticados da alice com o MESMO sub do PUT
    const subs = entries.filter((e) => e.sub !== undefined).map((e) => e.sub)
    const aliceSub = entries.find((e) => e.verb === 'put')!.sub
    expect(aliceSub).toBeTruthy()
    const virginSub = entries.find((e) => e.verb === 'rotate' && e.outcome === 'not_found')!.sub
    expect(virginSub).toBeTruthy()
    expect(virginSub).not.toBe(aliceSub)
    expect(new Set(subs).size).toBe(2) // só alice e o usuário virgem per-run
    // append-only: cada snapshot é prefixo do seguinte (offsets só crescem)
    const final = await auditRaw()
    for (let i = 0; i < auditSnapshots.length; i++) {
      expect(final.startsWith(auditSnapshots[i]!)).toBe(true)
      if (i > 0) expect(auditSnapshots[i]!.startsWith(auditSnapshots[i - 1]!)).toBe(true)
    }
    // nenhum byte do segredo novo nem do velho (nem etags) na auditoria; nomes de
    // arquivo tampouco carregam material
    expect(final).not.toContain(FIRST_B64)
    expect(final).not.toContain(ROTATED_B64)
    expect(final).not.toContain(etag1)
    expect(final).not.toContain(etag2)
    expect(final).not.toContain(aliceToken)
    for (const name of await secretFiles()) {
      expect(name).toMatch(/^[0-9a-f]{64}$/)
    }
  }, 30_000)

  it('10. ciphertext at rest: segredo novo (e o velho, e suas base64) ausentes do store dir', async () => {
    for (const file of await secretFiles()) {
      const raw = await readFile(join(storeDir, file))
      expect(raw.includes(Buffer.from(ROTATED_BYTES))).toBe(false)
      expect(raw.includes(Buffer.from(ROTATED_B64))).toBe(false)
      expect(raw.includes(Buffer.from(FIRST_BYTES))).toBe(false)
      expect(raw.includes(Buffer.from(FIRST_B64))).toBe(false)
    }
  }, 30_000)

  it('6. corrida do CAS (variável novel, por último): dois rotates, mesmo If-Match → um 200 e um 412', async () => {
    // etag corrente real (E2 segue válido após 4/5/7/8, mas o gate não assume: re-lê)
    const current = (await request('GET', '/v1/secret', { token: aliceToken })).headers.get(
      'etag',
    )!
    const secretA = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString(
      'base64',
    )
    const secretB = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString(
      'base64',
    )
    const [resA, resB] = await Promise.all([
      request('POST', '/v1/secret/rotate', {
        token: aliceToken,
        ifMatch: current,
        body: JSON.stringify({ secret: secretA }),
      }),
      request('POST', '/v1/secret/rotate', {
        token: aliceToken,
        ifMatch: current,
        body: JSON.stringify({ secret: secretB }),
      }),
    ])
    expect([resA.status, resB.status].sort()).toEqual([200, 412])
    // o segredo final é o do vencedor — GET confere bytes e etag
    const winner = resA.status === 200 ? { res: resA, secret: secretA } : { res: resB, secret: secretB }
    const get = await request('GET', '/v1/secret', { token: aliceToken })
    expect(((await get.json()) as { secret: string }).secret).toBe(winner.secret)
    expect(get.headers.get('etag')).toBe(winner.res.headers.get('etag'))
    // exatamente um rotated e um stale novos na auditoria
    const tail = (await auditEntries()).slice(-3, -1).map((e) => [e.verb, e.outcome])
    expect(tail.sort()).toEqual([
      ['rotate', 'rotated'],
      ['rotate', 'stale'],
    ])
  }, 30_000)
})
