// The MCP server's unit harness (S-g1, PLANO-AGENTES §0.3.13): the Slack tests' in-memory facades
// (slack-world.ts), the real local API server with `/mcp` on an ephemeral port, and the real MCP client
// (`Client` + `StreamableHTTPClientTransport`) in either protocol era.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { PROTOCOL_PATTERNS } from '@tayet/shared/leak-scan'
import { createApiServer, type ApiServer } from '../../src/api/server'
import type { SetTimer } from '../../src/api/mcp/wait'
import type { ApprovalFacade } from '../../src/core/approvals'
import type { PanelFacade } from '../../src/core/panels'
import type { CommandsFacade } from '../../src/core/commands'
import { createWorld, TOKEN, type World } from './slack-world'

export { TOKEN }

export type Era = 'legacy' | 'modern'
export const MODERN = '2026-07-28'

export interface McpHarness {
  world: World
  api: ApiServer
  url: string
  logs: Array<Record<string, unknown>>
  // A connected client (the 2025 handshake, or the 2026-07-28 era pinned).
  client(era?: Era, token?: string): Promise<Client>
  // A raw POST/GET to /mcp (what the client cannot send: no token, an Origin, …).
  raw(init?: RequestInit): Promise<{ status: number; headers: Headers; body: unknown }>
  close(): Promise<void>
}

export async function startMcp(opts: { world?: World; setTimer?: SetTimer; approvals?: ApprovalFacade; panels?: PanelFacade; commands?: CommandsFacade } = {}): Promise<McpHarness> {
  const world = opts.world ?? createWorld()
  const logs: Array<Record<string, unknown>> = []
  const api = createApiServer({
    read: world.read,
    write: world.write,
    state: () => 'online',
    token: TOKEN,
    listen: { host: '127.0.0.1', port: 0 },
    log: (l) => logs.push(l),
    ...(opts.approvals !== undefined && { approvals: opts.approvals }),
    ...(opts.panels !== undefined && { panels: opts.panels }),
    ...(opts.commands !== undefined && { commands: opts.commands }),
    mcp: { ...(opts.setTimer !== undefined && { setTimer: opts.setTimer }) },
  })
  const url = await api.start()
  const clients: Client[] = []
  return {
    world,
    api,
    url,
    logs,
    async client(era = 'legacy', token = TOKEN) {
      const client = new Client({ name: 'mcp-test', version: '0.0.0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: MODERN } } } : {})
      const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } })
      await client.connect(transport)
      clients.push(client)
      return client
    },
    async raw(init = {}) {
      const res = await fetch(`${url}/mcp`, {
        method: 'POST',
        ...init,
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(init.headers as Record<string, string>) },
      })
      const text = await res.text()
      let body: unknown = text
      try {
        body = JSON.parse(text)
      } catch {
        // SSE or empty: the raw text.
      }
      return { status: res.status, headers: res.headers, body }
    },
    async close() {
      await Promise.all(clients.map((c) => c.close().catch(() => {})))
      await api.close()
    },
  }
}

// The tests' own scan over a whole native value: no protocol id shape anywhere (mxid, room id, event id,
// media URI, the `u-`/`a-` localparts). The Slack tests' idLeaks also checks Slack's id keys, which do
// not fit the native shapes (a message's `id` is its ts).
const ID_SHAPES = PROTOCOL_PATTERNS.filter((p) => ['mxid', 'room-id', 'event-id', 'mxc-uri', 'opaque-localpart', 'agent-localpart'].includes(p.name))
export function idShapeLeaks(v: unknown): string[] {
  const out: string[] = []
  const walk = (x: unknown, path: string): void => {
    if (typeof x === 'string') for (const p of ID_SHAPES) if (p.re.test(x)) out.push(`${path}: ${p.name}`)
    if (Array.isArray(x)) x.forEach((y, i) => walk(y, `${path}[${i}]`))
    else if (x !== null && typeof x === 'object') for (const [k, y] of Object.entries(x)) walk(y, `${path}.${k}`)
  }
  walk(v, '$')
  return out
}

// A tool's answer, typed loosely for the asserts.
export interface ToolAnswer {
  isError?: boolean
  content: Array<{ type: string; text: string }>
  structuredContent?: Record<string, unknown>
}

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolAnswer
}
