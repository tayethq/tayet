// Starting the local API once the Core is ready (PLANO-AGENTES §0.3.6 adjs. 2, 8): listen, then write
// <store>/api.json (0600, `{ url, pid }`, never the token) and one `api-listening` line with the URL.
// The process host (cli.ts) owns the exits: EADDRINUSE comes back as AddressInUseError.
import { join } from 'node:path'
import type { ListenAddress } from '../args'
import type { Core } from '../core/handle'
import { FILES, writeJsonAtomic } from '../store'
import { createApiServer, type ApiServer } from './server'

export class AddressInUseError extends Error {
  constructor(readonly address: ListenAddress) {
    super('address in use')
    this.name = 'AddressInUseError'
  }
}

export async function startLocalApi(core: Core, listen: ListenAddress, log: (line: Record<string, unknown>) => void, slack: { actionsUrl?: string } = {}): Promise<ApiServer> {
  const api = createApiServer({
    read: core.read,
    write: core.write,
    ...(core.approvals !== undefined && { approvals: core.approvals }),
    ...(core.forms !== undefined && { forms: core.forms }),
    ...(core.panels !== undefined && { panels: core.panels }),
    ...(core.commands !== undefined && { commands: core.commands }),
    state: () => core.state(),
    token: core.localToken,
    listen,
    log,
    // The Slack layer (S-f, §0.3.12): its upload staging lives in the store (item 6); so does its file of
    // approval cards (A3-4, slack/cards.ts).
    // With `--slack-actions-url`, the clicks leave over HTTP (slack/http-actions.ts).
    slack: { productUrl: core.productUrl, uploadsDir: join(core.storeDir, 'uploads'), cardsFile: join(core.storeDir, FILES.slackCards), ...(slack.actionsUrl !== undefined && { actionsUrl: slack.actionsUrl }) },
    // The MCP server (S-g1, §0.3.13): `POST /mcp` on this listener.
    mcp: {},
  })
  let url: string
  try {
    url = await api.start()
  } catch (err) {
    await api.close().catch(() => {})
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new AddressInUseError(listen)
    throw err
  }
  await writeJsonAtomic(join(core.storeDir, FILES.api), { url, pid: process.pid })
  log({ evt: 'api-listening', url, file: join(core.storeDir, FILES.api) })
  return api
}
