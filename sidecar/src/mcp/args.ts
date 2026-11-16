// Command line of the stdio bridge (PLANO-AGENTES §0.3.13 item 5): `tayet-agent mcp --store <dir>
// [--listen <host:port>]`. `--store` is mandatory: the bridge finds the daemon through <store>/api.json and
// opens the local API with <store>/local.token; `--listen` replaces the URL of api.json. Nothing here
// imports the daemon's modules (cli.ts dispatches before any of them is loaded).
import { parseArgs } from 'node:util'
import { parseListen, UsageError, type ListenAddress } from '../args'

export const BRIDGE_USAGE = 'Usage: tayet-agent mcp --store <dir> [--listen <host:port>]'

export interface BridgeOptions {
  store: string
  listen: ListenAddress | undefined
}

export function parseBridgeCli(argv: string[]): BridgeOptions {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        store: { type: 'string' },
        listen: { type: 'string' },
      },
    }))
  } catch (err) {
    // parseArgs messages name the option, never its value.
    throw new UsageError(err instanceof Error ? err.message : String(err))
  }
  const store = values.store?.trim() ?? ''
  if (store === '') throw new UsageError('missing --store')
  return { store, listen: values.listen !== undefined ? parseListen(values.listen) : undefined }
}
