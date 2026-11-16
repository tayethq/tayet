// The stdio bridge (ADR-087 dec. 5(c); PLANO-AGENTES §0.3.13 items 3, 5, 7): `tayet-agent mcp --store <dir>`
// speaks MCP over stdio with a client that only speaks stdio (Claude Desktop, …) and forwards to the running
// daemon's `POST /mcp` over local HTTP. "O stdio é ponte para o daemon e nunca abre o store."
//
// - Discovery (item 5): reads <store>/api.json (`url`) and <store>/local.token, read-only, nothing else in
//   the store; never instance.lock. `--listen` replaces the URL (api.json is then not read). The bridge
//   never starts the daemon: no api.json, a dead `pid`, a refused or timed-out first `initialize` → one
//   `bridge-daemon-unreachable` line on stderr and exit 69.
// - Proxy (item 3): the SDK `client` v2 on the daemon's side (`Client` + `StreamableHTTPClientTransport`
//   with the local token as Bearer), not a raw pipe — the 2026 era derives headers from each message. On
//   the stdio side, the low-level `Server` with the `serverInfo`, `capabilities` and `instructions` the
//   daemon answered, served by `serveStdio` (both protocol eras of the stdio client) over a
//   `StdioServerTransport`. Forwarded: `tools/list` and `tools/call`; the SDK answers `initialize` (with the
//   daemon's values) and `ping`; any other method → -32601.
// - A failure of the daemon in the middle (an HTTP error, the connection refused — revocation, crash,
//   shutdown) → `isError` on the pending call, the stdio is closed and the bridge exits 69. A tool answer
//   `revoked` is forwarded and ends the bridge the same way (the daemon is going away with 78).
// - fd 1 is the protocol's alone: the bridge's own lines go to stderr (`bridge-*`), the console is routed to
//   stderr, and the daemon's logger (log.ts) is not imported. Never a token in a line.
import { writeSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { format } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { ProtocolError, Server, type CallToolResult } from '@modelcontextprotocol/server'
import { serveStdio, StdioServerTransport, type StdioServerHandle } from '@modelcontextprotocol/server/stdio'
import { UsageError, type ListenAddress } from '../args'
import { WAIT_MAX_S } from '../api/mcp/contract'
import { EXIT } from '../exit-codes'
import { parseBridgeCli } from './args'

// The store's file names (store.ts FILES; store.ts imports classic-level, so it is not imported here).
const API_FILE = 'api.json'
const LOCAL_TOKEN_FILE = 'local.token'
const LOCAL_TOKEN = /^tal_[A-Za-z0-9_-]{43}$/
const MCP_PATH = '/mcp'

// The first `initialize` against the daemon.
export const CONNECT_TIMEOUT_MS = 10_000
// tools/call: the daemon's longest answer (wait_for_mention, WAIT_MAX_S) plus a margin.
export const CALL_TIMEOUT_MS = (WAIT_MAX_S + 15) * 1000
// After the last answer of a failed daemon, how long the bridge waits for it to leave fd 1.
const FLUSH_GRACE_MS = 200

type Line = Record<string, unknown>

export function bridgeLog(line: Line): void {
  writeSync(2, JSON.stringify(line) + '\n')
}

// fd 1 carries JSON-RPC only: anything a dependency prints goes to stderr.
function routeConsole(): void {
  const sink = (...args: unknown[]): void => {
    writeSync(2, format(...args) + '\n')
  }
  console.log = sink
  console.info = sink
  console.debug = sink
  console.warn = sink
  console.error = sink
  console.trace = sink
}

class Unreachable extends Error {
  constructor(
    readonly reason: string,
    readonly url?: string,
  ) {
    super(reason)
    this.name = 'Unreachable'
  }
}

const urlOf = (l: ListenAddress): string => `http://${l.host.includes(':') ? `[${l.host}]` : l.host}:${l.port}`

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists (another user's); ESRCH: gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface Discovery {
  url: string
  token: string
}

export async function discover(store: string, listen: ListenAddress | undefined): Promise<Discovery> {
  let url: string
  if (listen !== undefined) {
    url = urlOf(listen)
  } else {
    let api: { url?: unknown; pid?: unknown }
    try {
      api = JSON.parse(await readFile(join(store, API_FILE), 'utf8')) as typeof api
    } catch {
      throw new Unreachable('no-api-file')
    }
    if (typeof api.url !== 'string' || typeof api.pid !== 'number') throw new Unreachable('api-file-unreadable')
    url = api.url
    if (!alive(api.pid)) throw new Unreachable('daemon-not-running', url)
  }
  let token: string
  try {
    token = (await readFile(join(store, LOCAL_TOKEN_FILE), 'utf8')).trim()
  } catch {
    throw new Unreachable('no-local-token', url)
  }
  if (!LOCAL_TOKEN.test(token)) throw new Unreachable('local-token-unreadable', url)
  return { url, token }
}

async function connectDaemon(d: Discovery): Promise<Client> {
  const client = new Client({ name: 'tayet-agent-mcp-bridge', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(MCP_PATH, d.url), {
    requestInit: { headers: { authorization: `Bearer ${d.token}` } },
  })
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Unreachable('timeout', d.url)), CONNECT_TIMEOUT_MS)
      }),
    ])
  } catch (err) {
    await client.close().catch(() => {})
    if (err instanceof Unreachable) throw err
    const status = (err as { status?: unknown }).status
    throw new Unreachable(typeof status === 'number' ? `http-${status}` : 'refused', d.url)
  } finally {
    clearTimeout(timer)
  }
  return client
}

const revokedAnswer = (r: CallToolResult): boolean =>
  r.isError === true && (r.structuredContent as { code?: unknown } | undefined)?.code === 'revoked'

// The bridge's run; resolves with the exit code (cli.ts owns process.exit).
export async function runBridge(argv: string[]): Promise<number> {
  routeConsole()
  let opts
  try {
    opts = parseBridgeCli(argv)
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    writeSync(2, `tayet-agent mcp: ${err.message}\n`)
    return EXIT.usage
  }

  let upstream: Client
  try {
    upstream = await connectDaemon(await discover(opts.store, opts.listen))
  } catch (err) {
    if (!(err instanceof Unreachable)) throw err
    bridgeLog({
      evt: 'bridge-daemon-unreachable',
      reason: err.reason,
      ...(err.url !== undefined && { url: err.url }),
      message: 'the agent is not running for this store (start tayet-agent first); the bridge never starts it',
    })
    return EXIT.unavailable
  }
  const serverInfo = upstream.getServerVersion() ?? { name: 'tayet-agent', version: '0.0.0' }
  const capabilities = upstream.getServerCapabilities() ?? { tools: {} }
  const instructions = upstream.getInstructions()

  return new Promise<number>((resolve) => {
    let ending = false
    const end = (code: number, line?: Line): void => {
      if (ending) return
      ending = true
      if (line !== undefined) bridgeLog(line)
      // The last answer is already queued on fd 1: let it leave, then close both sides.
      setTimeout(() => {
        process.stdout.write('', () => {
          void Promise.allSettled([handle.close(), upstream.close()]).then(() => resolve(code))
        })
      }, code === EXIT.ok ? 0 : FLUSH_GRACE_MS)
    }
    // A failure of the daemon: never JSON-RPC's own errors (the daemon answered), always the transport's.
    const daemonFailed = (err: unknown): boolean => !(err instanceof ProtocolError)
    const lost = (err: unknown): void => {
      const status = (err as { status?: unknown }).status
      end(EXIT.unavailable, { evt: 'bridge-daemon-lost', ...(typeof status === 'number' && { status }), name: err instanceof Error ? err.name : typeof err })
    }

    const factory = (): Server => {
      const server = new Server(serverInfo, { capabilities, ...(instructions !== undefined && { instructions }) })
      server.setRequestHandler('tools/list', async (req, ctx) => {
        try {
          return await upstream.listTools(req.params, { signal: ctx.mcpReq.signal })
        } catch (err) {
          if (daemonFailed(err)) lost(err)
          throw err
        }
      })
      server.setRequestHandler('tools/call', async (req, ctx) => {
        try {
          const result = await upstream.callTool(req.params, { signal: ctx.mcpReq.signal, timeout: CALL_TIMEOUT_MS })
          if (revokedAnswer(result)) end(EXIT.unavailable, { evt: 'bridge-daemon-lost', reason: 'revoked' })
          return result
        } catch (err) {
          if (!daemonFailed(err) || ctx.mcpReq.signal.aborted) throw err
          lost(err)
          return { isError: true, content: [{ type: 'text', text: 'unavailable' }], structuredContent: { code: 'unavailable' } }
        }
      })
      return server
    }

    const transport = new StdioServerTransport()
    // `end` runs only from the handlers and listeners below, after this assignment.
    const handle: StdioServerHandle = serveStdio(factory, {
      transport,
      // Never the message: it may carry a request's content.
      onerror: (err) => bridgeLog({ evt: 'bridge-error', name: err.name }),
    })
    // The client closed its side: a normal end.
    process.stdin.once('end', () => end(EXIT.ok))
    process.stdin.once('close', () => end(EXIT.ok))
    process.once('SIGTERM', () => end(EXIT.ok))
    process.once('SIGINT', () => end(EXIT.ok))
  })
}
