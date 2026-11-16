// Entry point of `tayet-agent` (bundled to dist/cli.js by build.mjs) and the ONLY owner of the
// process: the core (boot.ts) returns a handle or throws ExitError; exits and signals live here.
// Once the Core is ready, the local API starts (api/start.ts, §0.3.6 adj. 8): an address in use ends
// the run with 73 after a clean shutdown of the core; a revocation answers 503 and tells the open
// streams (`agent.revoked`) before the exit 78.
//
// A boot that rotated the credential (self-reissue, S-h) throws RelaunchError BEFORE the local API is
// started: the process is relaunched once (relaunch.ts — execve, or a child where it does not exist).
//
// Subcommands are dispatched BEFORE anything of the daemon is loaded (PLANO-AGENTES §0.3.13 item 7):
// `tayet-agent mcp …` is the stdio bridge (mcp/bridge.ts), which never opens the store (ADR-087 dec.
// 5(c)) and must not load the SDK, classic-level or the core. The daemon's modules are imported
// dynamically on its own path; build.mjs splits them into chunks so their external imports (the SDK,
// classic-level, …) are not hoisted into dist/cli.js.
import type { ApiServer } from './api/server'
import { EXIT, ExitError, RelaunchError } from './exit-codes'

// The cwd the operator launched in, before the boot chdirs into the store (step 8): a relaunch after a
// self-reissue goes back to it (relaunch.ts).
const launchCwd = process.cwd()
const argv = process.argv.slice(2)

if (argv[0] === 'mcp') {
  const { runBridge } = await import('./mcp/bridge')
  process.exit(await runBridge(argv.slice(1)))
} else {
  await daemon()
}

async function daemon(): Promise<void> {
  const { installRejectionGuard } = await import('./process-guard')
  const { log } = await import('./log')
  installRejectionGuard()
  try {
    const { main } = await import('./boot')
    const { parseCli } = await import('./args')
    const { AddressInUseError, startLocalApi } = await import('./api/start')
    const core = await main(argv)
    if (core !== null) {
      let api: ApiServer | null = null
      // ADR-087 dec. 8: on 'revoking' (before the wipe) the API refuses everything and flushes
      // `agent.revoked`; on 'revoked' the core already wiped, wrote REVOKED and logged, and 78 tells
      // the operator's restart policy to stop.
      let apiRevoked: Promise<void> = Promise.resolve()
      core.on('revoking', () => {
        if (api !== null) apiRevoked = api.revoke()
      })
      core.on('revoked', () => {
        void apiRevoked.finally(() => process.exit(EXIT.credentialRefused))
      })
      let signalled = false
      const onSignal = (signal: string): void => {
        if (signalled) return
        signalled = true
        log({ evt: 'shutdown', signal })
        const closing = api !== null ? api.close() : Promise.resolve()
        closing
          .then(() => core.shutdown())
          .then(
            () => process.exit(EXIT.ok),
            (err: unknown) => {
              log({ evt: 'shutdown-error', message: String(err) })
              process.exit(EXIT.unexpected)
            },
          )
      }
      process.on('SIGTERM', () => onSignal('SIGTERM'))
      process.on('SIGINT', () => onSignal('SIGINT'))

      const cli = parseCli(argv)
      if (!cli.help) {
        try {
          api = await startLocalApi(core, cli.listen, log, { ...(cli.slackActionsUrl !== undefined && { actionsUrl: cli.slackActionsUrl }) })
        } catch (err) {
          if (!(err instanceof AddressInUseError)) throw err
          log({
            evt: 'fatal',
            stage: 'listen',
            address: `${cli.listen.host}:${cli.listen.port}`,
            message: 'the local API address is in use (another agent on this machine?); give this agent its own --listen host:port',
          })
          await core.shutdown()
          process.exit(EXIT.addressInUse)
        }
      }
    }
  } catch (err) {
    if (err instanceof RelaunchError) {
      const { relaunch } = await import('./relaunch')
      await relaunch(launchCwd)
    }
    if (err instanceof ExitError) {
      if (err.line !== undefined) log(err.line)
      process.exit(err.code)
    }
    log({ evt: 'fatal', stage: 'unexpected', message: err instanceof Error ? err.message : String(err) })
    process.exit(EXIT.unexpected)
  }
}
