import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Shutdown ordenado ao SIGTERM (PLANO-RELEASE-PUBLICA §8.41) ───────────────────────
// O escrow sobe como PROCESSO FILHO (mesmo idioma de spawn + readback de porta de
// test/integration/escrow-mas.test.ts), contra um introspector FAKE e lento local: a
// request fica em voo pelo tempo do delay, o SIGTERM chega no meio, e o drain tem que
// completá-la (store + audit + resposta) antes do exit 0. Sem stack — roda no job `escrow`.

const INTROSPECT_DELAY_MS = 1_000

let introspector: Server
let introspectionUrl: string
// Resolvida quando o fake RECEBE o POST de introspecção — antes do delay. É o marco de
// "request em voo" para o SIGTERM; nada de sleep fixo para garantir ordem.
let introspectionReceived: () => void = () => {}

const children: ChildProcess[] = []
const storeDirs: string[] = []

interface Escrow {
  child: ChildProcess
  base: string
  storeDir: string
  stdout: () => string
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

async function spawnEscrow(): Promise<Escrow> {
  const storeDir = await mkdtemp(join(tmpdir(), 'escrow-shutdown-'))
  storeDirs.push(storeDir)
  const serverPath = fileURLToPath(new URL('../../src/server.ts', import.meta.url))
  const child = spawn(process.execPath, ['--experimental-strip-types', serverPath], {
    env: {
      ...process.env,
      ESCROW_PORT: '0',
      ESCROW_STORE_DIR: storeDir,
      ESCROW_ORG_KEY: Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString(
        'base64',
      ),
      ESCROW_INTROSPECTION_URL: introspectionUrl,
      ESCROW_CLIENT_ID: 'shutdown-test-client',
      ESCROW_CLIENT_SECRET: 'shutdown-test-secret',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  children.push(child)
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  )
  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
  })
  // Readback da porta (PF-3): primeira linha do stdout é {"listening": <porta>}.
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('escrow did not report a port')), 10_000)
    const onData = (): void => {
      const line = buffer.split('\n')[0]
      if (buffer.includes('\n') && line) {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        resolve((JSON.parse(line) as { listening: number }).listening)
      }
    }
    child.stdout.on('data', onData)
    void exited.then(({ code }) => reject(new Error(`escrow exited early (${code})`)))
  })
  return { child, base: `http://127.0.0.1:${port}`, storeDir, stdout: () => buffer, exited }
}

function withinMs<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} > ${ms} ms`)), ms)),
  ])
}

beforeAll(async () => {
  introspector = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    req.resume()
    req.on('end', () => {
      introspectionReceived()
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ active: true, sub: 'drain-sub', username: 'alice' }))
      }, INTROSPECT_DELAY_MS)
    })
  })
  await new Promise<void>((resolve) => introspector.listen(0, '127.0.0.1', resolve))
  introspectionUrl = `http://127.0.0.1:${(introspector.address() as AddressInfo).port}/oauth2/introspect`
})

afterAll(async () => {
  await new Promise<void>((resolve) => introspector.close(() => resolve()))
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  await Promise.all(storeDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('escrow ao SIGTERM (drain + exit 0)', () => {
  it('SIGTERM com depósito em voo: a request completa, o audit registra, exit 0', async () => {
    const escrow = await spawnEscrow()
    const received = new Promise<void>((resolve) => {
      introspectionReceived = resolve
    })
    const secret = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString(
      'base64',
    )
    const put = fetch(`${escrow.base}/v1/secret`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer x', 'content-type': 'application/json' },
      body: JSON.stringify({ secret }),
    })

    await received
    escrow.child.kill('SIGTERM')

    const res = await put
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ created: true })

    const { code, signal } = await withinMs(escrow.exited, 10_000, 'exit after SIGTERM')
    expect(code).toBe(0)
    expect(signal).toBeNull()

    const audit = (await readFile(join(escrow.storeDir, 'audit.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(audit).toEqual([expect.objectContaining({ sub: 'drain-sub', verb: 'put', outcome: 'created' })])

    expect(escrow.stdout()).toContain('{"evt":"shutdown","signal":"SIGTERM"}')
    expect(escrow.stdout()).not.toContain('shutdown-cap')
  }, 15_000)

  it('SIGTERM sem request em voo: exit 0 imediato', async () => {
    const escrow = await spawnEscrow()
    escrow.child.kill('SIGTERM')
    const { code, signal } = await withinMs(escrow.exited, 2_000, 'exit after idle SIGTERM')
    expect(code).toBe(0)
    expect(signal).toBeNull()
  }, 15_000)
})
