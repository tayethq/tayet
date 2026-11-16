// Command line (ADR-087 dec. 1): `tayet-agent --server <product URL> --token <credential>`.
// TAYET_AGENT_TOKEN is the credential's alternative to --token (Docker, systemd: no credential in argv
// or shell history); with both, --token wins (PLANO-AGENTES §0.3.8 item 3). Neither is ever logged.
import { parseArgs } from 'node:util'
import { isLoopback } from './loopback'

export class UsageError extends Error {}

export const USAGE = `Usage: tayet-agent --server <product URL> --token <credential> [--store <dir>] [--listen <host:port>]
                   [--slack-manifest <file>] [--slack-actions-url <url>] [--debug]
       tayet-agent mcp --store <dir> [--listen <host:port>]

  --server   The product URL (for example https://chat.example.com).
  --token    The agent credential shown when the agent was created or reissued. Alternatively, set
             TAYET_AGENT_TOKEN in the environment (--token wins when both are present).
             If the agent reissued its own credential (store loss), it keeps the new one in
             <store>/credential and this value is only the seed.
  --store    Local directory of the agent (default: per-user data directory).
  --listen   Address of the local API (default 127.0.0.1:7878). Use another port to run several
             agents on one machine. The API always requires the local token (<store>/local.token).
  --slack-manifest
             A Slack app manifest in JSON (YAML is not accepted): its slash commands become the
             agent's commands, declared at every start. A PUT /v1/commands later holds until the
             next start. A manifest out of the rules stops the start, naming the entry and the rule.
  --slack-actions-url
             Deliver the Slack layer's button clicks (block_actions) as signed HTTP POSTs to this URL
             instead of the Socket Mode: http only, on this machine (127.0.0.1, ::1 or localhost). The
             signing secret is the local token. Events and / commands stay on the Socket Mode.
  --rotate-local-token
             Replace the local token and exit (run it with the agent stopped).
  --debug    Add diagnostics: device identifiers in the log, library output on stderr.
  --help     Show this text.

  mcp        The MCP server over stdio, for clients that only speak stdio: a bridge to the running
             agent's local API (found through <store>/api.json, or --listen), which it never starts.`

// The local API's address (PLANO-AGENTES §0.3.6 adj. 8). Port 0 = an ephemeral port (announced in the
// api-listening line and in <store>/api.json).
export interface ListenAddress {
  host: string
  port: number
}
export const DEFAULT_LISTEN: ListenAddress = { host: '127.0.0.1', port: 7878 }

export function parseListen(value: string): ListenAddress {
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:\s[\]]+):(\d{1,5})$/.exec(value.trim())
  const port = m !== null ? Number(m[2]) : NaN
  if (m === null || !Number.isInteger(port) || port > 65535) throw new UsageError('--listen must be host:port')
  const host = (m[1] as string).replace(/^\[|\]$/g, '')
  return { host, port }
}

export interface CliOptions {
  server: string
  token: string
  store: string | undefined
  listen: ListenAddress
  rotateLocalToken: boolean
  debug: boolean
  // `--slack-manifest <file>` (PLANO-AGENTES §0.3.25 item 1): read and checked by the boot (slack-manifest.ts).
  slackManifest: string | undefined
  // `--slack-actions-url <url>`: where the Slack layer POSTs its clicks; absent → the Socket Mode delivers them.
  slackActionsUrl: string | undefined
}


export type Cli = { help: true } | ({ help: false } & CliOptions)

// The environment variable that carries the credential when --token is absent.
export const TOKEN_ENV = 'TAYET_AGENT_TOKEN'

export function parseCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Cli {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        server: { type: 'string' },
        token: { type: 'string' },
        store: { type: 'string' },
        listen: { type: 'string' },
        'slack-manifest': { type: 'string' },
        'slack-actions-url': { type: 'string' },
        'rotate-local-token': { type: 'boolean', default: false },
        debug: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }))
  } catch (err) {
    // parseArgs messages name the option, never its value.
    throw new UsageError(err instanceof Error ? err.message : String(err))
  }
  if (values.help) return { help: true }
  const server = values.server?.trim() ?? ''
  // --token wins; an absent (or blank) --token falls back to the environment.
  const flagToken = values.token?.trim() ?? ''
  const token = flagToken !== '' ? flagToken : (env[TOKEN_ENV]?.trim() ?? '')
  if (server === '') throw new UsageError('missing --server')
  if (token === '') throw new UsageError(`missing --token (or ${TOKEN_ENV})`)
  let url: URL
  try {
    url = new URL(server)
  } catch {
    throw new UsageError('--server is not a URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UsageError('--server must be http(s)')
  const store = values.store?.trim()
  const slackManifest = values['slack-manifest']?.trim()
  if (slackManifest === '') throw new UsageError('--slack-manifest needs a file')
  const listen = values.listen !== undefined ? parseListen(values.listen) : DEFAULT_LISTEN
  const actions = values['slack-actions-url']
  const slackActionsUrl = actions !== undefined ? parseActionsUrl(actions) : undefined
  return {
    help: false,
    server,
    token,
    store: store === '' ? undefined : store,
    listen,
    rotateLocalToken: values['rotate-local-token'],
    debug: values.debug,
    slackManifest,
    slackActionsUrl,
  }
}

// The click destination: http only, on this machine. The error names the rule, never the value.
export function parseActionsUrl(value: string): string {
  const raw = value.trim()
  if (raw === '') throw new UsageError('--slack-actions-url needs a URL')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UsageError('--slack-actions-url is not a URL')
  }
  if (url.protocol !== 'http:') throw new UsageError('--slack-actions-url must be http (the destination is on this machine)')
  if (!isLoopback(url.hostname)) throw new UsageError('--slack-actions-url must point at this machine (127.0.0.1, ::1 or localhost)')
  if (url.username !== '' || url.password !== '') throw new UsageError('--slack-actions-url must not carry credentials')
  return url.href
}
