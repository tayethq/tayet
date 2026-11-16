import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { createApiServer, type ApiServer } from '../../src/api/server'
import { ALICE, createWorld, GENERAL, message, ME, type World } from '../support/slack-world'
import { DIST_CLI, SIDECAR_ROOT } from '../support/sidecar-process'

// The stdio bridge (S-g2, PLANO-AGENTES §0.3.13 items 3, 5, 7): dist/cli.js `mcp --store <dir>` as a child,
// the real stdio client (`StdioClientTransport`) on one side, and on the other a "daemon" made of the real
// local API (`createApiServer` with `/mcp`) over the Slack tests' in-memory facades, announced in a temp
// store's api.json + local.token. Usage (64), the daemon unreachable (69), the proxy (initialize, tools/list,
// tools/call, -32601 — the real client short-circuits a method the server does not advertise, so the raw
// fd-1 case sends it), the daemon failing in the middle (isError, 69), fd 1 carrying JSON-RPC only, and the
// bridge's path loading neither the SDK, classic-level nor the core.

const LOCAL = `tal_${'b'.repeat(43)}`
const TOOLS = ['clear_commands', 'clear_panel', 'close_approval', 'get_person', 'list_conversations', 'list_members', 'react', 'read_messages', 'request_approval', 'send_message', 'set_commands', 'set_panel', 'wait_for_approval', 'wait_for_mention']

let store: string
let world: World
let api: ApiServer | undefined
let daemonUrl = ''
const clients: Client[] = []

beforeEach(async () => {
  store = await mkdtemp(join(tmpdir(), 'mcp-bridge-'))
})
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  await api?.close()
  api = undefined
  await rm(store, { recursive: true, force: true })
})

// The daemon: the real listener on an ephemeral port, announced as the running daemon does (api.json with
// this test process as the pid, local.token).
async function startDaemon(): Promise<void> {
  world = createWorld()
  api = createApiServer({ read: world.read, write: world.write, state: () => 'online', token: LOCAL, listen: { host: '127.0.0.1', port: 0 }, log: () => {}, mcp: {} })
  daemonUrl = await api.start()
  await writeFile(join(store, 'api.json'), JSON.stringify({ url: daemonUrl, pid: process.pid }))
  await writeFile(join(store, 'local.token'), LOCAL)
}

interface Run {
  code: number | null
  stdout: string
  stderr: string
}

// The bridge as a plain child (stdin closed at once, or fed `input`).
function runBridge(args: string[], input = ''): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DIST_CLI, 'mcp', ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c))
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c))
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

interface Bridged {
  client: Client
  transport: StdioClientTransport
  stderr: () => string
  exited: Promise<number | null>
}

// The real stdio client spawning the bridge.
async function bridged(): Promise<Bridged> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [DIST_CLI, 'mcp', '--store', store], stderr: 'pipe', cwd: SIDECAR_ROOT })
  let err = ''
  const errStream = transport.stderr as import('node:stream').Readable | null
  errStream?.setEncoding('utf8').on('data', (c: string) => (err += c))
  let exit!: (code: number | null) => void
  const exited = new Promise<number | null>((r) => (exit = r))
  const client = new Client({ name: 'bridge-test', version: '0.0.0' })
  await client.connect(transport)
  clients.push(client)
  // The child is spawned by connect(); its exit code is what the bridge returned.
  const child = (transport as unknown as { _process?: import('node:child_process').ChildProcess })._process
  if (child === undefined) throw new Error('StdioClientTransport: no child process')
  if (child.exitCode !== null) exit(child.exitCode)
  else child.once('exit', (code) => exit(code))
  return { client, transport, stderr: () => err, exited }
}

interface Answer {
  isError?: boolean
  content: Array<{ type: string; text: string }>
  structuredContent?: Record<string, unknown>
}
const call = async (c: Client, name: string, args: Record<string, unknown> = {}): Promise<Answer> =>
  (await c.callTool({ name, arguments: args })) as unknown as Answer

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })

describe('mcp bridge — usage and discovery', () => {
  it('no --store → 64, one line on stderr (not the daemon USAGE), stdout empty', async () => {
    const r = await runBridge([])
    expect(r.code).toBe(64)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('tayet-agent mcp: missing --store\n')
  })

  it('api.json absent → 69, bridge-daemon-unreachable on stderr, stdout empty', async () => {
    const r = await runBridge(['--store', store])
    expect(r.code).toBe(69)
    expect(r.stdout).toBe('')
    expect(JSON.parse(r.stderr.trim())).toMatchObject({ evt: 'bridge-daemon-unreachable', reason: 'no-api-file' })
  })

  it('api.json with a dead pid → 69 (the bridge never starts the daemon)', async () => {
    // A pid that existed and is gone: a child that already exited.
    const dead = await new Promise<number>((resolve) => {
      const c = spawn(process.execPath, ['-e', ''])
      c.on('exit', () => resolve(c.pid as number))
    })
    await writeFile(join(store, 'api.json'), JSON.stringify({ url: 'http://127.0.0.1:9', pid: dead }))
    await writeFile(join(store, 'local.token'), LOCAL)
    const r = await runBridge(['--store', store])
    expect(r.code).toBe(69)
    expect(r.stdout).toBe('')
    expect(JSON.parse(r.stderr.trim())).toMatchObject({ evt: 'bridge-daemon-unreachable', reason: 'daemon-not-running', url: 'http://127.0.0.1:9' })
  })

  it('ECONNREFUSED on the first initialize → 69; --listen overrides api.json', async () => {
    const port = await freePort()
    await writeFile(join(store, 'local.token'), LOCAL)
    // No api.json at all: --listen is the URL.
    const r = await runBridge(['--store', store, '--listen', `127.0.0.1:${port}`])
    expect(r.code).toBe(69)
    expect(r.stdout).toBe('')
    expect(JSON.parse(r.stderr.trim())).toMatchObject({ evt: 'bridge-daemon-unreachable', reason: 'refused', url: `http://127.0.0.1:${port}` })
  })

  it('a wrong local token → 69 (the daemon refuses the first initialize), never the token in a line', async () => {
    await startDaemon()
    const wrong = `tal_${'c'.repeat(43)}`
    await writeFile(join(store, 'local.token'), wrong)
    const r = await runBridge(['--store', store])
    expect(r.code).toBe(69)
    expect(r.stdout).toBe('')
    expect(JSON.parse(r.stderr.trim())).toMatchObject({ evt: 'bridge-daemon-unreachable', reason: 'http-401' })
    expect(r.stderr).not.toContain(wrong)
  })
})

describe('mcp bridge — the proxy, with the real stdio client', () => {
  it('initialize carries the daemon’s serverInfo, capabilities and instructions; tools/list has the fourteen', async () => {
    await startDaemon()
    const { client } = await bridged()
    expect(client.getServerVersion()).toMatchObject({ name: 'tayet-agent' })
    expect(client.getInstructions()).toContain(`"${ME.name}" (${ME.id}) no workspace ${ME.workspace}; kind: agent.`)
    expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: false })
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS)
    expect(tools.find((t) => t.name === 'send_message')?.inputSchema).toMatchObject({ type: 'object', required: expect.arrayContaining(['conversation', 'text']) as unknown })
  })

  it('tools/call: list_conversations, and wait_for_mention (a mention, then a short timeout)', async () => {
    await startDaemon()
    const { client } = await bridged()
    const list = await call(client, 'list_conversations')
    expect(list.isError).not.toBe(true)
    expect((list.structuredContent as { conversations: Array<{ id: string }> }).conversations.map((c) => c.id)).toContain(GENERAL.id)

    const pending = call(client, 'wait_for_mention', { timeout_s: 10 })
    // The wait is open on the daemon once its subscription exists.
    await expect.poll(() => (api!.bus as unknown as { listeners: Set<unknown> }).listeners.size, { timeout: 5000 }).toBeGreaterThan(0)
    world.emit({ type: 'mention', conversation: GENERAL.id, message: message({ id: '1730000900.000900', author: ALICE.id, text: 'oi agente', mentionsMe: true }) })
    const got = await pending
    expect(got.structuredContent).toMatchObject({ mention: { conversation: GENERAL.id, message: { id: '1730000900.000900', mentionsMe: true } } })

    const t0 = Date.now()
    const timedOut = await call(client, 'wait_for_mention', { after: (got.structuredContent as { cursor: string }).cursor, timeout_s: 1 })
    expect(timedOut.structuredContent).toMatchObject({ timedOut: true })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
  })

  it('a tool error of the daemon passes through as isError (not a bridge failure)', async () => {
    await startDaemon()
    const b = await bridged()
    const a = await call(b.client, 'read_messages', { conversation: 'CNOPEAAAAAA' })
    expect(a).toMatchObject({ isError: true, content: [{ type: 'text', text: 'conversation_not_found' }] })
    // The bridge is still up.
    expect((await b.client.listTools()).tools).toHaveLength(14)
  })

  it('the client closing stdin ends the bridge with 0', async () => {
    await startDaemon()
    const b = await bridged()
    await b.client.close()
    expect(await b.exited).toBe(0)
  })
})

describe('mcp bridge — the daemon failing in the middle', () => {
  it('a revocation with a wait pending → isError on the pending call, the bridge exits 69', async () => {
    await startDaemon()
    const b = await bridged()
    const pending = call(b.client, 'wait_for_mention', { timeout_s: 30 })
    await expect.poll(() => (api!.bus as unknown as { listeners: Set<unknown> }).listeners.size, { timeout: 5000 }).toBeGreaterThan(0)
    const revoking = api!.revoke(200, 0)
    const a = await pending
    expect(a.isError).toBe(true)
    expect(a.content[0]?.text).toBe('revoked')
    await revoking
    expect(await b.exited).toBe(69)
    expect(b.stderr()).toContain('"evt":"bridge-daemon-lost"')
  })

  it('the daemon answering 503 (revoked, no wait pending) → isError unavailable on the call, exit 69', async () => {
    await startDaemon()
    const b = await bridged()
    await api!.revoke(10, 0)
    const a = await call(b.client, 'list_conversations')
    expect(a).toMatchObject({ isError: true, content: [{ type: 'text', text: 'unavailable' }] })
    expect(await b.exited).toBe(69)
    expect(JSON.parse(b.stderr().trim().split('\n').at(-1) as string)).toMatchObject({ evt: 'bridge-daemon-lost', status: 503 })
  })

  it('the daemon gone (connection refused) → isError unavailable on the call, exit 69', async () => {
    await startDaemon()
    const b = await bridged()
    await api!.close()
    api = undefined
    const a = await call(b.client, 'list_conversations')
    expect(a).toMatchObject({ isError: true, content: [{ type: 'text', text: 'unavailable' }] })
    expect(await b.exited).toBe(69)
  })
})

describe('mcp bridge — fd 1 and the modules it loads', () => {
  it('every byte the bridge writes on fd 1 is a JSON-RPC message; an unknown method → -32601', async () => {
    await startDaemon()
    const msgs = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_conversations', arguments: {} } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read_messages', arguments: { conversation: 'CNOPEAAAAAA' } } },
      { jsonrpc: '2.0', id: 5, method: 'resources/list' },
      { jsonrpc: '2.0', id: 6, method: 'ping' },
    ]
    // One message at a time: the next goes once the previous was answered (the raw child has no client).
    const child = spawn(process.execPath, [DIST_CLI, 'mcp', '--store', store], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    const exited = new Promise<number | null>((r) => child.on('exit', r))
    child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c))
    for (const m of msgs) {
      const before = out.split('\n').length
      child.stdin.write(JSON.stringify(m) + '\n')
      if ('id' in m) await expect.poll(() => out.split('\n').length, { timeout: 10_000 }).toBeGreaterThan(before)
    }
    child.stdin.end()
    expect(await exited).toBe(0)
    expect(out.endsWith('\n')).toBe(true)
    const lines = out.slice(0, -1).split('\n')
    const parsed = lines.map((l) => JSON.parse(l) as { jsonrpc: string; id: number; result?: unknown; error?: { code: number } })
    expect(parsed.every((p) => p.jsonrpc === '2.0')).toBe(true)
    expect(parsed.map((p) => p.id)).toEqual([1, 2, 3, 4, 5, 6])
    expect(parsed.find((p) => p.id === 5)?.error?.code).toBe(-32601)
    expect(parsed.find((p) => p.id === 6)?.result).toEqual({})
  })

  it('the mcp path loads neither matrix-js-sdk, the crypto wasm, classic-level, node-indexeddb nor src/core/**', async () => {
    await startDaemon()
    // A `node --import` hook (registerHooks, the count-hook's technique — ESM has no require.cache) prints
    // every URL loaded; the bridge serves one exchange and ends.
    const hook = `data:text/javascript,${encodeURIComponent(
      "import { registerHooks } from 'node:module'; registerHooks({ load(url, c, next) { process.stderr.write('[load] ' + url + '\\n'); return next(url, c) } })",
    )}`
    const child = spawn(process.execPath, ['--import', hook, DIST_CLI, 'mcp', '--store', store], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c))
    child.stderr.setEncoding('utf8').on('data', (c: string) => (err += c))
    const exited = new Promise<number | null>((r) => child.on('exit', r))
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } }) + '\n')
    await expect.poll(() => out.includes('"id":1'), { timeout: 10_000 }).toBe(true)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_conversations', arguments: {} } }) + '\n')
    await expect.poll(() => out.includes('"id":2'), { timeout: 10_000 }).toBe(true)
    child.stdin.end()
    expect(await exited).toBe(0)
    const loaded = err.split('\n').filter((l) => l.startsWith('[load] ')).map((l) => l.slice(7))
    // The probe works: the bridge's own chunk and the MCP SDK were seen.
    expect(loaded.some((u) => /\/dist\/chunks\/bridge-[^/]+\.js$/.test(u))).toBe(true)
    expect(loaded.some((u) => u.includes('/@modelcontextprotocol/server/'))).toBe(true)
    expect(loaded.some((u) => u.includes('/@modelcontextprotocol/client/'))).toBe(true)
    const forbidden = loaded.filter((u) => /matrix-js-sdk|matrix-sdk-crypto-wasm|classic-level|node-indexeddb|\/dist\/chunks\/(boot|start|log|process-guard)-/.test(u))
    expect(forbidden).toEqual([])
  })
})
