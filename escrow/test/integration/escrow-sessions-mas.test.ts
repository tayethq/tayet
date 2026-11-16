import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mintOidcSession } from '../support/mint-oidc.ts'

// ── Gate de integração da custódia de sessão (ADR-057 dec. 5 / PLANO-CRIPTO-COBERTURA
// PR-2) ─ padrão do escrow-mas.test.ts: escrow como processo filho contra o MAS REAL,
// tokens mat_ cunhados por auth-code+PKCE headless. Usuários FRESCOS por run
// (register-user, o caminho browserless documentado da dev-stack) — inclusive `cofre`,
// a identidade de custódia (F3), validando o DEFAULT do wiring (ESCROW_CUSTODY_USERNAME
// ausente). Nada de alice/bob: o gate irmão mata sessões do bob (kill-sessions) e
// compartilhar usuários entre arquivos concorrentes cruzaria os asserts. Auto-skip sem
// a stack (issue #7 manda no regime).

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
    execSync(`docker exec ${MAS_CONTAINER} mas-cli --version`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// register-user tolera "User already exists" (idempotência entre runs — o `cofre` fica).
function registerUser(username: string, password: string): void {
  try {
    execSync(
      `docker exec ${MAS_CONTAINER} mas-cli manage register-user -c ${MAS_CONFIG} --yes --ignore-password-complexity --password ${password} ${username} 2>&1`,
      { encoding: 'utf8' },
    )
  } catch (err) {
    const out = String((err as { stdout?: unknown }).stdout ?? err)
    if (!out.includes('User already exists')) throw err
  }
}

const RUN = randomBytes(4).toString('hex')
const ADDRESSED_USER = `enda${RUN}` // endereçado no depósito
const OUTSIDER_USER = `endb${RUN}` // autenticado, jamais endereçado
const PASSWORD = 'custodypass123'

const ROOM_ID = `!custodia${RUN}:localhost`
const SESSION_ID = `sessao-${RUN}`
// Entry no shape do export Megolm (spike C2); o retrieve deve devolvê-la byte-idêntica.
const SESSION_ENTRY = {
  algorithm: 'm.megolm.v1.aes-sha2',
  room_id: ROOM_ID,
  session_id: SESSION_ID,
  session_key: `AgAA-material-${RUN}`,
  sender_key: 'curve25519-sender-key-do-gate',
  sender_claimed_keys: { ed25519: 'ed25519-claimed-do-gate' },
  forwarding_curve25519_key_chain: [],
}

let child: ChildProcess | undefined
let storeDir: string
let base: string
let cofreToken: string
let addressedToken: string
let outsiderToken: string

function request(
  method: 'PUT' | 'GET',
  opts: { token?: string; body?: string } = {},
): Promise<Response> {
  return fetch(`${base}/v1/sessions`, {
    method,
    headers: {
      ...(opts.token !== undefined ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body,
  })
}

function depositBody(): string {
  return JSON.stringify({
    room_id: ROOM_ID,
    session_id: SESSION_ID,
    addressed: [ADDRESSED_USER],
    session: SESSION_ENTRY,
  })
}

describe.skipIf(!stackUp())('gate custódia de sessão ↔ MAS (stack real; ADR-057 dec. 5)', () => {
  beforeAll(async () => {
    registerUser('cofre', PASSWORD)
    registerUser(ADDRESSED_USER, PASSWORD)
    registerUser(OUTSIDER_USER, PASSWORD)
    storeDir = await mkdtemp(join(tmpdir(), 'escrow-sessions-gate-'))
    const serverPath = fileURLToPath(new URL('../../src/server.ts', import.meta.url))
    child = spawn(process.execPath, ['--experimental-strip-types', serverPath], {
      env: {
        ...process.env,
        ESCROW_PORT: '0',
        ESCROW_STORE_DIR: storeDir,
        ESCROW_ORG_KEY: Buffer.from(
          globalThis.crypto.getRandomValues(new Uint8Array(32)),
        ).toString('base64'),
        ESCROW_INTROSPECTION_URL: `${MAS_URL}/oauth2/introspect`,
        ESCROW_CLIENT_ID: CLIENT_ID,
        ESCROW_CLIENT_SECRET: CLIENT_SECRET,
        // ESCROW_CUSTODY_USERNAME deliberadamente AUSENTE: o gate prova o default `cofre`.
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
    cofreToken = (await mintOidcSession('cofre', PASSWORD)).accessToken
    addressedToken = (await mintOidcSession(ADDRESSED_USER, PASSWORD)).accessToken
    outsiderToken = (await mintOidcSession(OUTSIDER_USER, PASSWORD)).accessToken
  }, 90_000)

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

  it('0. introspecção ao vivo popula username — a dependência do retrieve (§0.3)', async () => {
    const res = await fetch(`${MAS_URL}/oauth2/introspect`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token: addressedToken }),
    })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { active?: boolean; sub?: string; username?: string }
    expect(data.active).toBe(true)
    expect(data.sub).toBeTruthy()
    expect(data.username).toBe(ADDRESSED_USER)
  }, 30_000)

  it('1. depósito com o token do cofre (default do wiring) → 201; redepósito → 200 exists', async () => {
    const first = await request('PUT', { token: cofreToken, body: depositBody() })
    expect(first.status).toBe(201)
    expect(await first.json()).toEqual({ outcome: 'created' })
    const again = await request('PUT', { token: cofreToken, body: depositBody() })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ outcome: 'exists' })
  }, 30_000)

  it('2. depósito com token de usuário comum (válido no MAS) → 403 forbidden', async () => {
    const res = await request('PUT', { token: addressedToken, body: depositBody() })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('forbidden')
  }, 30_000)

  it('3. retrieve do endereçado devolve a entry byte-idêntica à depositada', async () => {
    const res = await request('GET', { token: addressedToken })
    expect(res.status).toBe(200)
    const { sessions } = (await res.json()) as { sessions: unknown[] }
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toEqual(SESSION_ENTRY)
    expect(JSON.stringify(sessions[0])).toBe(JSON.stringify(SESSION_ENTRY))
  }, 30_000)

  it('4. retrieve de usuário autenticado NÃO endereçado → 200 com array vazio', async () => {
    const res = await request('GET', { token: outsiderToken })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { sessions: unknown[] }).sessions).toEqual([])
  }, 30_000)

  it('5. retrieve da identidade de custódia (token válido no MAS) → 403 forbidden (ADR-069)', async () => {
    const res = await request('GET', { token: cofreToken })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('forbidden')
  }, 30_000)
})
