import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mintOidcSession } from '../support/mint-oidc.ts'

// ── Gate local de integração escrow↔MAS (PLANO-FASE-2-ESCROW-C1 §5.2) ────────────────
// O harness sobe o escrow como PROCESSO FILHO (PF-3: node --experimental-strip-types,
// porta 0 + readback por stdout) apontando para o MAS REAL da dev-stack; tokens são
// access tokens OIDC de verdade (mat_), cunhados por fluxo auth-code+PKCE headless contra
// o login MAS-local (mintOidcSession, ../support/mint-oidc.ts). Auto-skip
// sem a stack (issue #7 manda no regime; PF-4). Asserts 1–8, incluindo o 5 (revogação),
// destravado pelo PF-1 item 4 (mas-cli manage kill-sessions).

const MAS_URL = process.env.TAYET_MAS_URL ?? 'http://localhost:8080'
const MAS_CONTAINER = process.env.TAYET_MAS_CONTAINER ?? 'spike-mas-1'
const MAS_CONFIG = process.env.TAYET_MAS_CONFIG ?? '/config/config.yaml'
// Credenciais do cliente de introspecção do escrow — a entrada throwaway de
// infra/dev-stack/mas/config.yaml (§3.7), classe-README, local-only.
const CLIENT_ID = '00000000000000000000ESCR0W'
const CLIENT_SECRET = 'tayet-dev-stack-throwaway-escrow-introspection'

function stackUp(): boolean {
  try {
    execSync(`curl -sf -m 3 ${MAS_URL}/.well-known/openid-configuration`, { stdio: 'ignore' })
    // a imagem do MAS é distroless: mas-cli é o único executável garantido
    execSync(`docker exec ${MAS_CONTAINER} mas-cli --version`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function killSessions(username: string): void {
  execSync(
    `docker exec ${MAS_CONTAINER} mas-cli manage kill-sessions -c ${MAS_CONFIG} ${username} 2>&1`,
    { stdio: 'ignore' },
  )
}

let child: ChildProcess | undefined
let storeDir: string
let base: string
let aliceToken: string
let bobToken: string
const auditSnapshots: string[] = []

const SECRET_BYTES = globalThis.crypto.getRandomValues(new Uint8Array(32))
const SECRET_B64 = Buffer.from(SECRET_BYTES).toString('base64')

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

function request(
  method: 'PUT' | 'GET',
  opts: { token?: string; body?: string } = {},
): Promise<Response> {
  return fetch(`${base}/v1/secret`, {
    method,
    headers: {
      ...(opts.token !== undefined ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body,
  })
}

describe.skipIf(!stackUp())('gate escrow↔MAS (stack real; §5.2)', () => {
  beforeAll(async () => {
    storeDir = await mkdtemp(join(tmpdir(), 'escrow-gate-'))
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
    // Readback da porta (PF-3): primeira linha do stdout é {"listening": <porta>}.
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
    // Poucos tokens, reusados (§6): um da alice, um do bob — cada mint cunha sessão nova.
    aliceToken = (await mintOidcSession('alice', 'alicepass123')).accessToken
    bobToken = (await mintOidcSession('bob', 'bobpass123')).accessToken
  }, 60_000)

  afterAll(async () => {
    // Teardown garantido mesmo sob assert falho (padrão do leave-da-sala dos gates E2E):
    // best-effort, jamais falha a suíte.
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

  it('1. round-trip: PUT 32 bytes aleatórios → 201; GET → bytes idênticos', async () => {
    const put = await request('PUT', { token: aliceToken, body: JSON.stringify({ secret: SECRET_B64 }) })
    expect(put.status).toBe(201)
    const get = await request('GET', { token: aliceToken })
    expect(get.status).toBe(200)
    expect(((await get.json()) as { secret: string }).secret).toBe(SECRET_B64)
    auditSnapshots.push(await auditRaw())
  }, 30_000)

  it('2. write-once: segundo PUT → 409; GET continua devolvendo o primeiro', async () => {
    const again = await request('PUT', {
      token: aliceToken,
      body: JSON.stringify({ secret: Buffer.from('substituto').toString('base64') }),
    })
    expect(again.status).toBe(409)
    const get = await request('GET', { token: aliceToken })
    expect(((await get.json()) as { secret: string }).secret).toBe(SECRET_B64)
    auditSnapshots.push(await auditRaw())
  }, 30_000)

  it('3. isolamento de sujeito: bob → 404 (não existe forma de referenciar alice)', async () => {
    const res = await request('GET', { token: bobToken })
    expect(res.status).toBe(404)
    auditSnapshots.push(await auditRaw())
  }, 30_000)

  it('4. token inválido: 401 em PUT e GET; storage intocado; auditoria unauthorized', async () => {
    const filesBefore = await secretFiles()
    const put = await request('PUT', { token: 'mct_garbage', body: JSON.stringify({ secret: SECRET_B64 }) })
    const get = await request('GET', { token: 'mct_garbage' })
    expect(put.status).toBe(401)
    expect(get.status).toBe(401)
    expect(await secretFiles()).toEqual(filesBefore)
    const tail = (await auditEntries()).slice(-2)
    for (const entry of tail) {
      expect(entry.outcome).toBe('unauthorized')
      expect(entry).not.toHaveProperty('sub')
    }
    auditSnapshots.push(await auditRaw())
  }, 30_000)

  it('5. token revogado → 401 (PF-1 item 4: mas-cli kill-sessions; último uso do token do bob)', async () => {
    killSessions('bob')
    const res = await request('GET', { token: bobToken })
    expect(res.status).toBe(401)
    auditSnapshots.push(await auditRaw())
  }, 30_000)

  it('6. ciphertext at rest: nenhum byte do segredo (nem sua base64) no store dir ou na auditoria', async () => {
    const files = await secretFiles()
    expect(files).toHaveLength(1)
    for (const file of files) {
      const raw = await readFile(join(storeDir, file))
      expect(raw.includes(Buffer.from(SECRET_BYTES))).toBe(false)
      expect(raw.includes(Buffer.from(SECRET_B64))).toBe(false)
    }
    const audit = await auditRaw()
    expect(audit).not.toContain(SECRET_B64)
    expect(audit.includes(SECRET_BYTES.toString())).toBe(false)
    expect(audit).not.toContain(aliceToken)
    expect(audit).not.toContain(bobToken)
  }, 30_000)

  it('7. auditoria: uma entrada por acesso, sujeito/verbo/desfecho corretos, append-only', async () => {
    const entries = await auditEntries()
    expect(entries.map((e) => [e.verb, e.outcome])).toEqual([
      ['put', 'created'], // 1: PUT alice
      ['get', 'ok'], // 1: GET alice
      ['put', 'conflict'], // 2: PUT repetido
      ['get', 'ok'], // 2: GET de conferência
      ['get', 'not_found'], // 3: bob
      ['put', 'unauthorized'], // 4
      ['get', 'unauthorized'], // 4
      ['get', 'unauthorized'], // 5: bob revogado
    ])
    // identidade veio do token: sub de alice consistente, e ≠ do sub de bob
    const subs = entries.map((e) => e.sub)
    expect(subs[0]).toBeTruthy()
    expect(new Set([subs[0], subs[1], subs[2], subs[3]]).size).toBe(1)
    expect(subs[4]).toBeTruthy()
    expect(subs[4]).not.toBe(subs[0])
    // append-only: cada snapshot é prefixo do seguinte (offsets só crescem)
    const final = await auditRaw()
    for (let i = 0; i < auditSnapshots.length; i++) {
      expect(final.startsWith(auditSnapshots[i]!)).toBe(true)
      if (i > 0) expect(auditSnapshots[i]!.startsWith(auditSnapshots[i - 1]!)).toBe(true)
    }
  }, 30_000)

  it('8. health: 200 sem Authorization e não gera entrada de auditoria', async () => {
    const before = (await auditEntries()).length
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect((await auditEntries()).length).toBe(before)
  }, 30_000)
})
