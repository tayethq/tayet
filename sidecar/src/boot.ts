// Boot and runtime of the sidecar core (ADR-087 decs. 1–3, 8; PLANO-AGENTES §0.3.5).
//
// BOOT ORDER (§0.3.5 adj. 10 — one order, with or without --store; do not reorder):
//   1. CLI (64);
//   2. discovery from the product URL (69);
//   3. whoami — 401/403 here exit 78 with no wipe and no sentinel (adj. 7); any other definitive
//      answer is a server problem → 69; not an agent → 77. S-h (§0.3.14 items 2–3): the --token is
//      tried first; only when it is refused, the credential the agent reissued for itself
//      (<store>/credential, seeded from this --token; credential.ts) is read — the one read of the
//      store before the lock, read-only — and, if the server accepts it, it is the token of the run
//      (`credential-from-store`); refused or absent → 78 as before;
//  3b. operator, from the escrow (PLANO-AGENTES §0.3.10 item 4), still touching nothing local: no
//      escrow discovered (`direct`) → 69; escrow unreachable or answering oddly → 69; 401/403 → 78
//      with no wipe and no sentinel; no operator recorded → 78 `operator-unknown`. Cached for the run;
//      the value and the response are never logged;
//   4. store path (--store, resolved against the launch cwd at the start of run(), or the S2.2 default,
//      which needs the localpart from 3);
//   5. instance.lock — the FIRST step that touches the store; busy → 75, nothing else read (P-S1).
//      Then the credential file under the lock: a token read from it must be the same bytes again
//      (else 75 `credential-changed`); a --token accepted while the file exists means the admin
//      reissued in the product → the file is removed (`credential-stale-removed`) — unless the file's
//      token is the one alive (the --token inside the introspection grace of its own kill);
//   6. storage.key and local.token (O_EXCL, 0600, 1st boot; --rotate-local-token replaces the local
//      token right after 5 and exits 0);
//   7. marker + sentinel, decided with the whoami of 3 (no second call): mismatch → 65; REVOKED of the
//      same device → 78; REMEDIATION_NEEDED of the same device → self-reissue; new device → wipe and
//      go on (adj. 4). No marker: the device's published keys are asked (device-keys.ts) before any
//      crypto — keys published = the whole store was lost → self-reissue; none = a 1st boot;
//   8. chdir(store) — node-indexeddb resolves `${cwd}/indexeddb` as a singleton on import;
//   9. dbManager.loadCache() BEFORE node-indexeddb/auto and the SDK (custody agent's order); failure →
//      self-reissue;
//  10. initRustCrypto, persistent and encrypted by storage.key; failure or keys diverged → self-reissue;
//  11. marker written; sync started.
//
// The boot returns a `Core` handle (read, write, shutdown, on('state' | 'revoked')); it never exits the
// process nor installs signal handlers — cli.ts alone owns the process: a boot that must end it
// throws ExitError(code), and cli.ts turns that, the 'revoked' event and SIGTERM/SIGINT into exits.
//
// Self-reissue (ADR-087 addendum S-h; PLANO-AGENTES §0.3.14): on the triggers of steps 7, 9 and 10 the
// boot writes REMEDIATION_NEEDED (as before), stops the client if one exists, and asks the escrow ONCE
// for a new credential with the token of the run (reissue.ts). 201 → <store>/credential is written
// BEFORE the device is wiped, the lock is released and the boot throws RelaunchError: cli.ts relaunches
// the process once (TAYET_AGENT_ROTATED=1), always before the local API listens. Refusals and failures
// map to 70 or 78 (`rotate` below). Never with TAYET_AGENT_ROTATED=1, never within 10 min of the last
// rotation, never on step 6 (storage.key / local.token), never on a refused credential.
//
// Runtime: M_UNKNOWN_TOKEN on any SDK request (sync and sends included) means the credential
// accepted at 3 was revoked (ADR-087 dec. 8): fail the send queue with `revoked`, stop, wipe the
// device, write REVOKED, emit 'revoked' (cli.ts → exit 78). Never reissue (ADR-087 dec. 8): a revocation
// is not a store loss.
// Auto-join: only the operator's invites are accepted (PLANO-AGENTES §0.3.10 item 2), through the
// custody agent's join queue (core/join.ts); any other invite is refused by leaving the room.
// Writes: core/write.ts (the tokenized facade) → core/queue.ts (the only retry owner; the SDK's
// scheduler never retries) over the write gateway core/send.ts; uploads outside the queue.
// Shutdown (Core.shutdown): fail pending sends `stopped` → stop sync → flushWrites() → checkpoint →
// release the lock.
import { join, resolve } from 'node:path'
import type { MatrixClient } from 'matrix-js-sdk'
import { parseCli, USAGE, UsageError, type CliOptions } from './args'
import { declareAtBoot, readSlackManifest, type SlackManifest } from './slack-manifest'
import { discover, DiscoveryError, type Discovery } from './discovery'
import { EXIT, ExitError, RelaunchError, type ExitCode } from './exit-codes'
import { UnavailableError } from './http'
import { log, registerSecret, routeConsole } from './log'
import { lookupOperator } from './operator'
import {
  findCredential,
  parseCredential,
  readCredentialRaw,
  removeCredential,
  seedHash,
  underFloor,
  writeCredential,
  type CredentialRead,
} from './credential'
import { deviceKeysPublished } from './device-keys'
import { selfReissue } from './reissue'
import {
  acquireLock,
  defaultStoreDir,
  ensureLocalToken,
  ensureStorageKey,
  ensureStoreDir,
  FILES,
  LockBusyError,
  planBoot,
  readMarker,
  readSentinel,
  rotateLocalToken,
  wipeDevice,
  writeJsonAtomic,
  writeSentinel,
  type IdentityMarker,
  type InstanceLock,
} from './store'
import { AGENT_LOCALPART, localpartOf, whoami, type Whoami } from './whoami'
import { writeCheckpoint } from './checkpoint'
import { markClientStopping } from './process-guard'
import { backfillDirect, createJoinLoop, createJoinPorts } from './core/join'
import { ApprovalWatch, createApprovalCore, createCardReader, locateWith } from './core/approvals'
import { createPanelCore } from './core/panels'
import { createAnchoredScheduler } from './core/anchored'
import { createCommandsCore } from './core/commands'
import { createReadSide, infraAccounts } from './core/read'
import { personToken as personTokenOf } from './api/ids'
import { createWriteGateway } from './core/send'
import { createWriteQueue } from './core/write-queue'
import { createWriteFacade } from './core/write'
import { createCoreEvents, type Core } from './core/handle'
import { personToken } from './api/ids'

const NETWORK_DEADLINE_MS = 120_000
const CHECKPOINT_MS = 10_000
// The custody agent's tick (agent/src/main.ts TICK_MS): join queue cadence.
const JOIN_TICK_MS = 3_000

// Ends the boot: cli.ts logs `line` and exits with `code`.
function exit(code: ExitCode, line?: Record<string, unknown>): never {
  throw new ExitError(code, line)
}

// Step 3b (PLANO-AGENTES §0.3.10 item 4). The escrow's answer is never logged; only its status.
async function learnOperator(found: Discovery, token: string): Promise<string> {
  if (found.account === undefined) {
    exit(EXIT.unavailable, {
      evt: 'fatal',
      stage: 'operator',
      message:
        found.via === 'direct'
          ? 'no account service on a development URL without a discovery document; the agent needs it to learn its operator'
          : 'the discovery document names no account service; the agent needs it to learn its operator',
    })
  }
  try {
    const looked = await lookupOperator(found.account, token, { deadlineMs: NETWORK_DEADLINE_MS })
    if (looked.kind === 'refused') {
      exit(EXIT.credentialRefused, {
        evt: 'credential-refused',
        stage: 'operator',
        status: looked.status,
        message: 'the credential was refused; reissue it in the product and restart with the new one',
      })
    }
    if (looked.kind === 'unknown') {
      exit(EXIT.credentialRefused, {
        evt: 'operator-unknown',
        message: 'this agent has no operator recorded; an organization admin must recreate it',
      })
    }
    if (looked.kind === 'bad-escrow') {
      exit(EXIT.unavailable, {
        evt: 'fatal',
        stage: 'operator',
        status: looked.status,
        message: 'the account service did not answer as expected; check the product URL',
      })
    }
    return looked.operator
  } catch (err) {
    if (err instanceof UnavailableError) exit(EXIT.unavailable, { evt: 'fatal', stage: 'operator', message: err.message })
    throw err
  }
}

// Step 3 for one token: the identity, or the refusal (401/403) for the caller to decide on; every other
// outcome ends the boot as before (69 server problem / unreachable, 77 not an agent).
type Identity = { userId: string; deviceId: string }
async function askWhoami(server: string, token: string): Promise<{ kind: 'ok'; identity: Identity } | Extract<Whoami, { kind: 'refused' }>> {
  try {
    const who = await whoami(server, token, { deadlineMs: NETWORK_DEADLINE_MS })
    if (who.kind === 'refused') return who
    if (who.kind === 'bad-server') {
      exit(EXIT.unavailable, {
        evt: 'fatal',
        stage: 'whoami',
        status: who.status,
        message: 'the discovered server did not answer as expected; check the product URL',
      })
    }
    if (who.kind === 'no-device' || !AGENT_LOCALPART.test(localpartOf(who.userId))) {
      exit(EXIT.notAgent, { evt: 'fatal', stage: 'whoami', message: 'this credential is not an agent credential' })
    }
    return { kind: 'ok', identity: { userId: who.userId, deviceId: who.deviceId } }
  } catch (err) {
    if (err instanceof UnavailableError) exit(EXIT.unavailable, { evt: 'fatal', stage: 'whoami', message: err.message })
    throw err
  }
}

const REISSUE_IN_PRODUCT = 'ask a workspace admin to reissue the credential in the product, and restart with the new one'

// null = nothing to run (--help).
export async function main(argv: string[]): Promise<Core | null> {
  // 1. CLI
  let cli
  let manifest: SlackManifest | undefined
  try {
    cli = parseCli(argv)
    // PLANO-AGENTES §0.3.25 items 1–2: the Slack manifest is read and checked before anything else runs; out of
    // the rules → 64, the message naming the entry and the rule (never the content).
    if (!cli.help && cli.slackManifest !== undefined) manifest = readSlackManifest(resolve(cli.slackManifest))
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${USAGE}\n`)
      exit(EXIT.usage, { evt: 'fatal', stage: 'usage', message: err.message })
    }
    throw err
  }
  if (cli.help) {
    process.stdout.write(`${USAGE}\n`)
    return null
  }
  registerSecret(cli.token)
  routeConsole(cli.debug)
  if (manifest !== undefined && (manifest.cut.descriptions > 0 || manifest.cut.hints > 0)) {
    log({ evt: 'slack-manifest-cut', descriptions: manifest.cut.descriptions, hints: manifest.cut.hints })
  }
  return run(cli, manifest)
}

async function run(cli: CliOptions, manifest?: SlackManifest): Promise<Core> {
  // Step 8 chdirs into the store, so every store path must be absolute before it (here the cwd is still the launch cwd).
  const store = cli.store !== undefined ? resolve(cli.store) : undefined
  // 2. Discovery
  let found: Discovery
  try {
    found = await discover(cli.server, { deadlineMs: NETWORK_DEADLINE_MS })
  } catch (err) {
    if (err instanceof DiscoveryError) exit(EXIT.unavailable, { evt: 'fatal', stage: 'discovery', message: err.message })
    throw err
  }
  if (found.via === 'direct') {
    log({ evt: 'discovery-direct', warning: 'no discovery document; using the URL as the server (development only)' })
  }
  const server = found.server
  log({ evt: 'discovered', via: found.via })

  // 3. whoami (no store touched yet). The --token first; the stored credential only if it is refused.
  // `token` is the credential of the run from here on (3b, the SDK, the self-reissue).
  let token = cli.token
  let fromStore: CredentialRead | null = null
  let identity: Identity
  const first = await askWhoami(server, cli.token)
  if (first.kind === 'ok') {
    identity = first.identity
  } else {
    // The one read of the store before the lock (§0.3.14 item 2), read-only.
    const found = await findCredential({ store, server, seed: cli.token })
    const second = found !== null ? (registerSecret(found.credential.token), await askWhoami(server, found.credential.token)) : null
    if (found === null || second === null || second.kind !== 'ok') {
      exit(EXIT.credentialRefused, {
        evt: 'credential-refused',
        stage: 'boot',
        status: first.status,
        errcode: first.errcode ?? null,
        message: 'the credential was refused; reissue it in the product and restart with the new one',
      })
    }
    identity = second.identity
    token = found.credential.token
    fromStore = found
    log({ evt: 'credential-from-store' })
  }
  // §0.3.12 item 9: no protocol id in a default log line; the device id only under --debug.
  const debug = (fields: Record<string, unknown>): Record<string, unknown> => (cli.debug ? fields : {})
  log({ evt: 'whoami', ...debug({ deviceId: identity.deviceId }) })

  // 3b. Operator (escrow; no store touched yet). Never logged.
  const operator = await learnOperator(found, token)
  log({ evt: 'operator-known' })

  // 4. Store path
  const storeDir = store ?? defaultStoreDir(server, personToken(identity.userId))
  await ensureStoreDir(storeDir)

  // 5. instance.lock — first touch of the store
  let lock: InstanceLock
  try {
    lock = await acquireLock(storeDir)
  } catch (err) {
    if (err instanceof LockBusyError) {
      exit(EXIT.locked, { evt: 'lock-busy', message: 'another instance is already using this store directory', store: storeDir })
    }
    throw err
  }
  log({ evt: 'store', store: storeDir })

  // --rotate-local-token (§0.3.6 adj. 2): with the lock held, nothing else runs; the new token is in
  // <store>/local.token, never on a stream.
  if (cli.rotateLocalToken) {
    await rotateLocalToken(storeDir)
    await lock.close()
    exit(EXIT.ok, { evt: 'local-token-rotated', file: join(storeDir, FILES.localToken) })
  }

  // 5b. The credential file, with the lock held (§0.3.14 items 2–3).
  const onDisk = await readCredentialRaw(storeDir)
  if (fromStore !== null) {
    if (onDisk !== fromStore.raw) {
      await lock.close()
      exit(EXIT.locked, {
        evt: 'credential-changed',
        message: 'the stored credential changed while this process started (another instance?); restart it',
      })
    }
  } else if (onDisk !== null) {
    // The --token was accepted and a stored credential exists. Normally the admin reissued in the
    // product and the file is stale. One exception: right after a rotation the seed --token is still
    // accepted for < 1 s (the introspection grace, ADR-086 dec. 8) while the file holds the live
    // credential — asking the file's token tells them apart (refused → stale).
    const stored = parseCredential(onDisk)
    let alive: Awaited<ReturnType<typeof askWhoami>> | null = null
    if (stored !== null) {
      registerSecret(stored.token)
      alive = await askWhoami(server, stored.token)
    }
    if (stored !== null && alive !== null && alive.kind === 'ok' && alive.identity.userId === identity.userId) {
      token = stored.token
      identity = alive.identity
      fromStore = { credential: stored, raw: onDisk, dir: storeDir }
      log({ evt: 'credential-from-store' })
    } else if (alive === null || alive.kind === 'refused') {
      await removeCredential(storeDir)
      log({ evt: 'credential-stale-removed' })
    }
  }


  const events = createCoreEvents()
  // Read by haltForRemediation (a crypto failure caused by a revocation is not a store failure).
  let revoking: Promise<void> | null = null
  // Set right before the self-reissue's POST: the escrow kills the token of the run, and an
  // M_UNKNOWN_TOKEN that this provokes in a client already created is not a revocation (no REVOKED,
  // no 78).
  let rotating = false
  // Stops the client before the POST once one exists (step 10).
  let stopForReissue: (() => Promise<void>) | null = null
  let interval: ReturnType<typeof setInterval> | undefined = undefined
  let joinInterval: ReturnType<typeof setInterval> | undefined = undefined

  // A revocation that lands while the boot is still running: the revoke path logs and cleans up; the
  // boot only waits for it and ends with 78 (no marker written over the wipe, no sync restarted).
  const endIfRevoked = async (): Promise<void> => {
    if (revoking === null) return
    await revoking
    throw new ExitError(EXIT.credentialRefused)
  }

  const haltForRemediation = async (reason: string, message?: string): Promise<never> => {
    await endIfRevoked()
    log({ evt: 'identity-reset', reason, ...(message !== undefined ? { message } : {}) })
    await writeSentinel(storeDir, 'remediation', {
      deviceId: identity.deviceId,
      reason,
      ...(message !== undefined ? { message } : {}),
    })
    exit(EXIT.remediation, {
      evt: 'remediation-needed',
      reason,
      message: 'the local store of the agent is unusable; reissue the credential in the product and restart with the new one',
    })
  }

  // Self-reissue (§0.3.14; the response map of §8.25). The sentinel is written first, as before: every
  // outcome but the 201 keeps it, and the next boot meets it again (same device → this path again).
  const rotate = async (reason: string, message?: string): Promise<never> => {
    await endIfRevoked()
    // The sentinel of step 7 is already there, with its own reason: kept as written.
    if (reason !== 'sentinel') {
      log({ evt: 'identity-reset', reason, ...(message !== undefined ? { message } : {}) })
      await writeSentinel(storeDir, 'remediation', {
        deviceId: identity.deviceId,
        reason,
        ...(message !== undefined ? { message } : {}),
      })
    }
    if (process.env.TAYET_AGENT_ROTATED === '1') {
      exit(EXIT.remediation, {
        evt: 'remediation-needed',
        reason,
        message: 'the local store of the agent is unusable again right after an automatic reissue; reissue the credential in the product and restart with the new one',
      })
    }
    if (fromStore !== null && underFloor(fromStore.credential)) {
      exit(EXIT.remediation, {
        evt: 'self-reissue-refused',
        reason: 'floor',
        message: 'the credential was already reissued automatically less than 10 minutes ago; reissue it in the product and restart with the new one',
      })
    }
    rotating = true
    if (stopForReissue !== null) await stopForReissue()
    log({ evt: 'self-reissue-started', reason })
    // learnOperator ended the boot (69) when the document names no account service.
    const out = await selfReissue(found.account as string, identity.userId, token)
    if (out.kind === 'ok') {
      registerSecret(out.token)
      await writeCredential(storeDir, {
        token: out.token,
        seededFrom: fromStore?.credential.seededFrom ?? seedHash(cli.token),
        rotatedAt: new Date().toISOString(),
      })
      await wipeDevice(storeDir, { sentinels: true })
      await lock.close()
      log({
        evt: 'credential-rotated',
        ...debug({ deviceId: out.deviceId }),
        file: join(storeDir, FILES.credential),
        message: 'the credential was reissued automatically; the --token in your configuration is no longer valid (it stays the seed)',
      })
      throw new RelaunchError()
    }
    const unusable = 'the local store of the agent is unusable and automatic recovery was not possible; reissue the credential in the product and restart with the new one'
    if (out.kind === 'too-soon') exit(EXIT.remediation, { evt: 'self-reissue-refused', reason: 'too-soon', message: unusable })
    if (out.kind === 'partial' && out.step === 'session') exit(EXIT.remediation, { evt: 'self-reissue-failed', step: 'session', message: unusable })
    if (out.kind === 'partial') {
      exit(EXIT.credentialRefused, { evt: 'self-reissue-failed', step: out.step, message: `the old credential is gone and no new one was issued; ${REISSUE_IN_PRODUCT}` })
    }
    if (out.kind === 'refused' || out.kind === 'not-found') {
      exit(EXIT.credentialRefused, { evt: 'self-reissue-refused', status: out.status, message: REISSUE_IN_PRODUCT })
    }
    if (out.kind === 'not-agent') exit(EXIT.remediation, { evt: 'self-reissue-refused', status: out.status, message: unusable })
    // network, or an answer the escrow should not give (another status, a 201 without a token).
    exit(EXIT.remediation, { evt: 'self-reissue-failed', stage: 'network', ...(out.kind === 'unexpected' ? { status: out.status } : {}), message: unusable })
  }

  // 6. storage.key + local.token (§0.3.6 adj. 2: both survive the wipes, both are secrets)
  let storageKey: Uint8Array
  let localToken: string
  try {
    const k = await ensureStorageKey(storeDir)
    registerSecret(k.encoded)
    storageKey = k.key
    if (k.created) log({ evt: 'storage-key-created' })
    const t = await ensureLocalToken(storeDir)
    registerSecret(t.token)
    localToken = t.token
    if (t.created) log({ evt: 'local-token-created', file: join(storeDir, FILES.localToken) })
  } catch (err) {
    return haltForRemediation('store-unusable', String(err))
  }

  // 7. Marker + sentinel, with the whoami of step 3
  const markerAt7 = await readMarker(storeDir)
  const sentinelAt7 = await readSentinel(storeDir)
  const plan = planBoot({ marker: markerAt7, sentinel: sentinelAt7, identity, server })
  if (plan.action === 'mismatch') {
    exit(EXIT.storeMismatch, {
      evt: 'fatal',
      stage: 'store',
      field: plan.field,
      message: 'this store directory belongs to another agent or server; nothing was deleted — use another --store',
    })
  }
  // REMEDIATION_NEEDED of this very device: a self-reissue trigger. A sentinel whose device is unknown
  // (unreadable, no marker) halts as before.
  if (plan.action === 'halt' && plan.sentinel === 'remediation' && (sentinelAt7?.deviceId ?? markerAt7?.deviceId) === identity.deviceId) {
    return rotate('sentinel')
  }
  if (plan.action === 'halt') {
    exit(plan.sentinel === 'revoked' ? EXIT.credentialRefused : EXIT.remediation, {
      evt: plan.sentinel === 'revoked' ? 'revoked' : 'remediation-needed',
      sentinel: plan.sentinel,
      message: 'restart with a newly issued credential',
    })
  }
  if (plan.action === 'wipe') {
    log({ evt: 'identity-reset', reason: plan.reason, ...debug({ previousDeviceId: plan.previousDeviceId ?? null, deviceId: identity.deviceId }) })
    await wipeDevice(storeDir, { sentinels: true })
  }
  // No marker (1st boot, or after a wipe): has this device already published keys? Before any crypto.
  if ((await readMarker(storeDir)) === null) {
    let keys
    try {
      keys = await deviceKeysPublished(server, token, identity, { deadlineMs: NETWORK_DEADLINE_MS })
    } catch (err) {
      if (err instanceof UnavailableError) exit(EXIT.unavailable, { evt: 'fatal', stage: 'device-keys', message: err.message })
      throw err
    }
    if (keys.kind === 'refused') {
      exit(EXIT.credentialRefused, {
        evt: 'credential-refused',
        stage: 'device-keys',
        status: keys.status,
        message: 'the credential was refused; reissue it in the product and restart with the new one',
      })
    }
    if (keys.kind === 'bad-server') {
      exit(EXIT.unavailable, { evt: 'fatal', stage: 'device-keys', status: keys.status, message: 'the server did not answer as expected; check the product URL' })
    }
    if (keys.kind === 'published') return rotate('store-lost')
  }

  // 8–9. chdir → loadCache → shim → SDK
  process.chdir(storeDir)
  const { default: dbManager } = await import('node-indexeddb/dbManager')
  try {
    await dbManager.loadCache()
  } catch (err) {
    return rotate('store-unusable', String(err))
  }
  await import('node-indexeddb/auto')
  const sdk = await import('matrix-js-sdk')

  const client: MatrixClient = sdk.createClient({
    baseUrl: server,
    userId: identity.userId,
    deviceId: identity.deviceId,
    accessToken: token,
    // §0.3.5 adj. 9 / section E: createClient always installs a MatrixScheduler, whose default
    // retries up to 4 times honouring retry_after. `-1` = never retry (the event goes NOT_SENT and
    // the promise rejects): the send queue is the only owner of the retry.
    scheduler: new sdk.MatrixScheduler(() => -1),
  })

  // ── Writes: gateway (one attempt) + queue (ADR-087 dec. 7; §0.3.7 item 4) ──
  // A new transaction id per attempt (queue.ts header); `cancel` targets the last one.
  const queue = createWriteQueue({
    gateway: createWriteGateway(client),
    makeTxnId: () => client.makeTxnId(),
    onRevoked: () => void revoke(),
    log,
  })

  // ── Revocation (ADR-087 dec. 8): only M_UNKNOWN_TOKEN, only for the token accepted at step 3 ──
  const revoke = (): Promise<void> => {
    // The self-reissue killed this token on purpose (rotating): not a revocation.
    if (rotating) return Promise.resolve()
    if (revoking !== null) return revoking
    revoking = (async () => {
      log({ evt: 'revoked', stage: 'runtime', ...debug({ deviceId: identity.deviceId }) })
      events.revoking()
      void watch.stop()
      panels.stop()
      void commands.stop()
      queue.close({ kind: 'revoked' })
      clearInterval(interval)
      clearInterval(joinInterval)
      markClientStopping()
      client.stopClient()
      try {
        await dbManager.flushWrites()
      } catch {
        // The store is being deleted; a failed flush changes nothing.
      }
      await wipeDevice(storeDir, { sentinels: false })
      await writeSentinel(storeDir, 'revoked', { deviceId: identity.deviceId })
      await lock.close().catch(() => {})
      log({
        evt: 'credential-refused',
        stage: 'runtime',
        message: 'the credential was revoked; the local store was deleted. Reissue it in the product and restart with the new one',
      })
      events.revoked()
    })()
    return revoking
  }
  client.on(sdk.HttpApiEvent.SessionLoggedOut, (err) => {
    if (err.errcode === 'M_UNKNOWN_TOKEN') void revoke()
  })

  stopForReissue = async () => {
    queue.close({ kind: 'stopped' })
    markClientStopping()
    client.stopClient()
    await dbManager.flushWrites().catch(() => {})
  }

  // 10. Crypto
  try {
    await client.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: 'tayet-agent', storageKey })
  } catch (err) {
    return rotate('store-unusable', String(err))
  }
  await endIfRevoked()
  const crypto = client.getCrypto()
  if (crypto === undefined) throw new Error('getCrypto() undefined after initRustCrypto')
  const ownKeys = await crypto.getOwnDeviceKeys()
  const marker = await readMarker(storeDir)
  if (marker !== null && (ownKeys.ed25519 !== marker.ed25519 || ownKeys.curve25519 !== marker.curve25519)) {
    // Same device, new keys: the store was recreated underneath. Running on is the zombie (custody
    // agent A1): sentinel + self-reissue (a new device), never this one again.
    return rotate('keys-diverged')
  }

  // 11. Marker + sync
  await endIfRevoked()
  await writeJsonAtomic(join(storeDir, FILES.marker), {
    deviceId: identity.deviceId,
    ed25519: ownKeys.ed25519,
    curve25519: ownKeys.curve25519,
    userId: identity.userId,
    server,
  } satisfies IdentityMarker)
  log({ evt: 'identity', ...debug({ deviceId: identity.deviceId, ed25519: ownKeys.ed25519 }) })

  const checkpointFile = join(storeDir, FILES.checkpoint)
  let syncHealthy = false
  let syncState: string | null = null

  const joins = createJoinLoop(createJoinPorts(client, log, operator), () => ({ healthy: syncHealthy, state: syncState }))
  // Read path (S-c1): created before startClient so it sees the first healthy sync. The write path
  // (S-c2) shares its resolver: one set of reverse lookups, one ts index, one file map.
  const { facade: read, resolver, announce, bindApprovals, bindCommands } = createReadSide(client, log)
  // ADR-091 (A3-3): the approval cards — one reader of card state (the same rule and order as the client),
  // the watch of the agent's open cards (kept in the store) and the facade of the routes.
  const infra = infraAccounts(identity.userId)
  const [custodian, systemAccount] = [...infra]
  const cards = createCardReader(client, () => ({ custodian, systemAccount }), () => identity.userId)
  let sealCard: (roomId: string, eventId: string) => Promise<void> = () => Promise.reject(new Error('not ready'))
  const watch = new ApprovalWatch({
    file: join(storeDir, FILES.approvals),
    reader: cards,
    locate: locateWith(resolver),
    seal: (roomId, eventId) => sealCard(roomId, eventId),
    personToken: personTokenOf,
    emit: announce,
    log,
  })
  await watch.load()
  const writeDeps = { client, resolver, enqueue: (job: Parameters<typeof queue.enqueue>[0]) => queue.enqueue(job), onRevoked: () => void revoke(), log }
  const approvals = createApprovalCore({ ...writeDeps, reader: cards, watch })
  sealCard = approvals.seal
  bindApprovals(approvals.approvalOf)
  // ADR-087 dec. 8: an unknown token on an upload/download (outside the queue) revokes as the queue does.
  const write = createWriteFacade({ ...writeDeps, editCard: approvals.editCard })
  // ADR-091 dec. 13 (A3-6) and ADR-093 (A4-2a): the agent's pinned panel and its commands manifest share ONE
  // scheduler (core/anchored.ts) above the write queue — it takes its turn only when the queue is empty
  // (messages first), and with both kinds pending it alternates, the panel first.
  const anchored = createAnchoredScheduler(['panel', 'commands'], { queueIdle: () => queue.size === 0, log })
  const panels = createPanelCore({
    client,
    resolver,
    enqueue: writeDeps.enqueue,
    queueIdle: () => queue.size === 0,
    accounts: () => ({ custodian, systemAccount }),
    log,
    scheduler: anchored,
    // A person's entry re-edits the manifest after the panel (§0.3.22 item 7).
    afterEntry: (roomId) => commands.entry(roomId),
  })
  const commands = createCommandsCore({ client, resolver, enqueue: writeDeps.enqueue, scheduler: anchored, file: join(storeDir, FILES.commands), log })
  await commands.load()
  // ADR-093 (A4-2b): a message carries `command` only for a name in the set declared now.
  bindCommands((name) => commands.declares(name))
  // Live events count only after the first healthy sync (the initial sync is history, not news).
  let livePrepared = false
  // Answers to the watched cards, their late decryption and their removal re-read the card. A person's live
  // entry re-edits the panel of that conversation (§0.3.16 item 16; read.ts emits `member.changed` for the
  // same event, but only while the API listens — the re-edit cannot depend on that).
  client.on(sdk.RoomEvent.Timeline, (ev, room, toStart, removed, data) => {
    if (toStart !== true && !removed) watch.noteEvent(ev)
    if (livePrepared && room !== undefined && toStart !== true && !removed && data.liveEvent === true) panels.noteEvent(ev, room)
  })
  client.on(sdk.MatrixEventEvent.Decrypted, (ev) => watch.noteEvent(ev))
  let directBackfilled = false

  client.on(sdk.ClientEvent.Sync, (next: string) => {
    const wasHealthy = syncHealthy
    syncHealthy = next === 'PREPARED' || next === 'SYNCING'
    if (next !== syncState) {
      log({ evt: 'sync-state', from: syncState, to: next })
      syncState = next
    }
    // ADR-093 (A4-2a): once per run, on the first healthy sync, only what differs from the hashes is written.
    // §0.3.25 item 3: with --slack-manifest, the manifest's set is declared instead, by the PUT path (the hashes
    // per conversation keep what did not change from being written again); a later PUT holds until the next boot.
    if (syncHealthy && !livePrepared) void declareAtBoot(commands, manifest, log)
    if (syncHealthy) livePrepared = true
    if (syncHealthy !== wasHealthy) events.state(syncHealthy ? 'online' : 'offline')
    if (syncHealthy && !wasHealthy) void joins.tick()
    // ADR-091 (A3-3): the boot and every sync that comes back read the open cards again.
    if (syncHealthy && !wasHealthy) watch.recheckAll()
    // §0.3.6 adj. 10: once per run, on the first healthy sync (the rooms and m.direct are loaded).
    if (syncHealthy && !directBackfilled) {
      directBackfilled = true
      backfillDirect(client, infraAccounts(identity.userId), log).catch((err: unknown) => {
        log({ evt: 'direct-backfill-error', message: String(err) })
      })
    }
  })
  // A new invite is joined at once; the interval covers the retries the queue scheduled.
  client.on(sdk.RoomEvent.MyMembership, (room, membership) => {
    joins.observe(room.roomId, membership)
    // A conversation joined gets the manifest; one left is forgotten (after the boot's reconcile only).
    if (livePrepared) commands.noteMembership(room.roomId, membership)
    if (membership === 'invite') void joins.tick()
  })

  interval = setInterval(() => {
    if (!syncHealthy || revoking !== null) return
    writeCheckpoint(checkpointFile, { lastAliveTs: Date.now() }).catch((err: unknown) => {
      log({ evt: 'checkpoint-error', message: String(err) })
    })
  }, CHECKPOINT_MS)
  joinInterval = setInterval(() => void joins.tick(), JOIN_TICK_MS)

  let stopping: Promise<void> | null = null
  const shutdown = (): Promise<void> => {
    // A revocation in progress ends the process with 78 through 'revoked'; a shutdown never races it.
    if (revoking !== null) return new Promise<void>(() => {})
    if (stopping !== null) return stopping
    stopping = (async () => {
      const watchStopped = watch.stop()
      panels.stop()
      const commandsStopped = commands.stop()
      queue.close({ kind: 'stopped' })
      clearInterval(interval)
      clearInterval(joinInterval)
      markClientStopping()
      client.stopClient()
      await dbManager.flushWrites()
      if (syncHealthy) await writeCheckpoint(checkpointFile, { lastAliveTs: Date.now() })
      await watchStopped
      await commandsStopped
      await lock.close()
    })()
    return stopping
  }

  await client.startClient({
    initialSyncLimit: 30,
    // The SDK's pending event of a send stays out of the timeline (no optimistic echo); the queue
    // cancels it by transaction id when an attempt fails.
    pendingEventOrdering: sdk.PendingEventOrdering.Detached,
  })
  await endIfRevoked()
  log({ evt: 'started' })

  return {
    read,
    write,
    approvals: approvals.facade,
    panels: panels.facade,
    commands: commands.facade,
    storeDir,
    productUrl: cli.server,
    localToken,
    state: () => (syncHealthy ? 'online' : 'offline'),
    shutdown,
    on: events.on,
  }
}
