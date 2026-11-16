// The MCP server of the sidecar (ADR-087 dec. 5(c); PLANO-AGENTES §0.3.13): `POST /mcp` on the local API's
// own listener (Streamable HTTP; the stdio bridge of S-g2 talks to this route and never opens the store).
//
// Stateless (item 2): `createMcpHandler` with a factory — one server/transport pair per request, both
// protocol eras (the 2025 `initialize` handshake, served by the SDK's stateless fallback, and the
// 2026-07-28 per-request envelope). No session, no resumability, no `list_changed`.
//
// Every request, in the listener's order (api/server.ts): Host (421) → Origin (403) — both answered by the
// listener before this layer — → revoked (503) → Bearer (401) → the method (only POST; 405) → the body
// (the listener's limit, 413). The refusals of this layer carry a JSON-RPC error body. The SDK's own DNS
// rebinding protection is not used: the listener's checks are the defense.
import { createMcpHandler, McpServer, type McpHttpHandler } from '@modelcontextprotocol/server'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { version } from '../../../package.json'
import type { ReadFacade } from '../../core/read'
import type { WriteFacade } from '../../core/write'
import type { ApprovalFacade } from '../../core/approvals'
import type { PanelFacade } from '../../core/panels'
import type { CommandsFacade } from '../../core/commands'
import type { EventBus } from '../bus'
import type { ApiMe } from '../contract'
import { logLeaks, scanEdge } from '../edge'
import { parsedBodyOf, sendWebResponse, toWebRequest } from './adapter'
import { registerTools } from './tools'
import { createWaits, type SetTimer, type Waits } from './wait'

type Log = (line: Record<string, unknown>) => void

export const MCP_PATH = '/mcp'
export const SERVER_NAME = 'tayet-agent'
// On close, how long the answers already decided (a wait ended `unavailable`) get to leave.
export const CLOSE_GRACE_MS = 500

export interface McpLayerOptions {
  read: ReadFacade
  write: WriteFacade
  log: Log
  bus: EventBus
  // The approval cards (A3-3b); absent → the card tools answer `unavailable`.
  approvals?: ApprovalFacade
  // The pinned panel (A3-6); absent → the panel tools answer `unavailable`.
  panels?: PanelFacade
  // The agent's commands (A4-2a); absent → the command tools answer `unavailable`.
  commands?: CommandsFacade
  // The clock of wait_for_mention (unit tests).
  setTimer?: SetTimer
}

export type McpRefusal = 'revoked' | 'unauthorized' | 'method_not_allowed'

export interface McpLayer {
  owns(path: string): boolean
  // A refusal of the listener's order, answered with a JSON-RPC error body.
  refuse(res: ServerResponse, why: McpRefusal): void
  // The request, once it passed the order; `body` was read by the listener under its limit.
  handle(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void>
  // Shutdown: pending waits answer `unavailable`, in-flight exchanges are aborted.
  close(): Promise<void>
}

const REFUSAL: Record<McpRefusal, { status: number; code: number; headers?: Record<string, string> }> = {
  revoked: { status: 503, code: -32001 },
  unauthorized: { status: 401, code: -32002 },
  method_not_allowed: { status: 405, code: -32003, headers: { allow: 'POST' } },
}

// One line, then the id rule the agent must follow (§0.3.13, S-g1 prompt).
export function instructionsOf(me: ApiMe | null): string {
  const who = me !== null ? `Você é o agente "${me.name}" (${me.id}) no workspace ${me.workspace}; kind: ${me.kind}. ` : ''
  return (
    `${who}Ids são opacos; \`conversation\` e \`cursor\` vêm das próprias respostas. ` +
    'Para pedir uma decisão a uma pessoa, use request_approval e espere a resposta com wait_for_approval (chame de novo enquanto vier timedOut).'
  )
}

export function createMcpLayer(opts: McpLayerOptions): McpLayer {
  const { log } = opts
  const waits: Waits = createWaits(opts.bus, opts.setTimer)
  const controllers = new Set<AbortController>()
  const inFlight = new Set<Promise<void>>()

  // The agent, read once (retried after a failure); it passes the edge before it enters the instructions.
  let meCache: Promise<ApiMe | null> | null = null
  const me = (): Promise<ApiMe | null> => {
    meCache ??= opts.read.me().then(
      (value) => {
        const leaks = scanEdge(value)
        if (leaks.length === 0) return value
        logLeaks(log, 'mcp:instructions', leaks)
        return null
      },
      (err: unknown) => {
        meCache = null
        log({ evt: 'mcp-error', name: err instanceof Error ? err.name : typeof err })
        return null
      },
    )
    return meCache
  }

  const handler: McpHttpHandler = createMcpHandler(
    async () => {
      // `listChanged: false`: the tool set never changes (the SDK turns it on by default on registerTool).
      const server = new McpServer({ name: SERVER_NAME, version }, { instructions: instructionsOf(await me()), capabilities: { tools: { listChanged: false } } })
      registerTools(server, { read: opts.read, write: opts.write, log, waits, ...(opts.approvals !== undefined && { approvals: opts.approvals }), ...(opts.panels !== undefined && { panels: opts.panels }), ...(opts.commands !== undefined && { commands: opts.commands }) })
      return server
    },
    {
      legacy: 'stateless',
      // Never the message: an SDK error may carry a request's content.
      onerror: (err) => log({ evt: 'mcp-error', name: err.name }),
    },
  )

  // One exchange: the client going away aborts it (a wait_for_mention in flight ends).
  const serve = async (req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> => {
    const controller = new AbortController()
    controllers.add(controller)
    const abort = (): void => {
      if (!res.writableFinished) controller.abort()
    }
    res.once('close', abort)
    try {
      const response = await handler.fetch(toWebRequest(req, body, controller.signal), parsedBodyOf(body))
      await sendWebResponse(res, response)
    } finally {
      res.off('close', abort)
      controllers.delete(controller)
    }
  }

  return {
    owns: (path) => path === MCP_PATH,

    refuse(res, why) {
      const r = REFUSAL[why]
      const raw = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: r.code, message: why } })
      res.writeHead(r.status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': String(Buffer.byteLength(raw)),
        ...r.headers,
      })
      res.end(raw)
    },

    handle(req, res, body) {
      const p = serve(req, res, body)
      inFlight.add(p)
      void p.finally(() => inFlight.delete(p)).catch(() => {})
      return p
    },

    async close() {
      // The pending waits answer `unavailable` and those answers go out before the listener closes the
      // connections (bounded); whatever is still running is then aborted.
      waits.close()
      await Promise.race([Promise.allSettled([...inFlight]), new Promise<void>((r) => setTimeout(r, CLOSE_GRACE_MS))])
      for (const c of controllers) c.abort()
      await handler.close()
    },
  }
}
