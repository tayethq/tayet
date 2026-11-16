import { describe, it, expect, afterAll } from 'vitest'
import { ClientPrefix, Method } from 'matrix-js-sdk'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import type { Acl } from '../../src/acl'
import { HOMESERVER, synapseReachable, whoami } from '../support/synapse'
import { bootstrapSettled, crossSigningOnServer, masterKeyOnServer, watchInFlight } from '../support/cross-signing-ready'
import { mintOidcSession } from '../support/mint-oidc'
import { spawnEscrow, registerUser, type EscrowProcess } from '../support/escrow-harness'
import {
  adminScopeReachable,
  allowCrossSigningReplacementWithoutUia,
  killSessions,
  mintAdminToken,
} from '../support/synapse-admin'

// ADR-082 dec. 1, Conformidade: the approval probe against the Synapse of the stack. The reset depends
// on the order inside the upload (authorization before validation): this test pins it, and fails on
// a bump that changes it. The approval is opened through the admin window, the same server flag the
// MAS page sets (asserted by the access-reset E2E, which goes through the page).
// The final proof (the approval survives the probe) is the RAW upload the window covers, not the SDK:
// the SDK's bootstrapCrossSigning writes the new keys to 4S, and the gateway only holds the 4S key
// during a recovery pass (matrix-client.ts:729) — after the connect's pass it always fails, and it
// only passed before by landing inside that pass (#7, PLANO-RELEASE-PUBLICA §8.101). The user is
// disposable: the identity is left inconsistent on purpose (master only, no ssk/usk).

const SYNAPSE = synapseReachable()
const ADMIN_SCOPE = adminScopeReachable()

describe.skipIf(!SYNAPSE || !ADMIN_SCOPE)('sondagem da aprovação (ADR-082 dec. 1)', () => {
  const user = `d3p${process.pid}${Math.floor(Math.random() * 1e6)}`
  let escrow: EscrowProcess | undefined
  let storeDir: string | undefined
  let gateway: MatrixGateway | undefined
  let restoreFetch: (() => void) | undefined
  const prevEnv = process.env.TAYET_ESCROW_URL

  afterAll(async () => {
    await gateway?.disconnect().catch(() => undefined)
    restoreFetch?.()
    killSessions(user)
    await escrow?.kill()
    if (storeDir) await rm(storeDir, { recursive: true, force: true }).catch(() => undefined)
    if (prevEnv === undefined) delete process.env.TAYET_ESCROW_URL
    else process.env.TAYET_ESCROW_URL = prevEnv
  }, 60_000)

  it('distingue sem janela de com janela, sem consumir a aprovação', async () => {
    storeDir = await mkdtemp(join(tmpdir(), 'escrow-probe-gate-'))
    escrow = await spawnEscrow(storeDir, Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64'))
    process.env.TAYET_ESCROW_URL = escrow.base
    registerUser(user)
    const { accessToken } = await mintOidcSession(user, 'gatepass123')
    const watch = watchInFlight()
    restoreFetch = watch.restore
    gateway = new MatrixGateway({ mode: 'strict', telemetry: { untranslated: () => {} }, serverUrl: HOMESERVER })
    await gateway.connect(accessToken as Parameters<Acl['connect']>[0])
    const client = gateway['client']!
    // Ready = read from the SERVER, not from the device (#7, PLANO-RELEASE-PUBLICA §8.101). Two
    // races: (1) the local crypto reports its public keys before the upload lands, and without a
    // master key Synapse skips the approval and answers the probe's empty key with a 400
    // (`expected true to be false` below); (2) the connect's bootstrap keeps writing 4S, secrets and
    // backup after that upload, and the bootstrapCrossSigning at the end would race it with no 4S key
    // in hand (`getSecretStorageKey callback returned falsey`).
    const mxid = await whoami(accessToken)
    await expect.poll(() => crossSigningOnServer(accessToken, mxid, watch.wire.raw), { timeout: 60_000 }).toBe(true)
    await bootstrapSettled(watch.wire, accessToken, mxid, 'probe')
    const probe = (): Promise<boolean> => gateway!['approvalGranted'](client)

    // Sem janela: 401 com os flows, e a sondagem não muda isso.
    expect(await probe()).toBe(false)
    expect(await probe()).toBe(false)

    await allowCrossSigningReplacementWithoutUia(mintAdminToken(user), mxid)

    // Com janela: a sondagem vê a aprovação quantas vezes for preciso; ela segue de pé.
    expect(await probe()).toBe(true)
    expect(await probe()).toBe(true)
    expect(await probe()).toBe(true)

    // A prova de que não consumiu: o upload de verdade ainda passa, e é ele que a consome. Synapse só
    // checa estrutura na master key (user_id, usage, uma chave de 32 bytes; sem assinatura) — 32 bytes
    // aleatórios bastam (e2e_keys.py:1694–1699, types/__init__.py:1773–1775).
    const pub = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64').replace(/=+$/, '')
    const masterKey = { user_id: mxid, usage: ['master'], keys: { [`ed25519:${pub}`]: pub } }
    const uploaded = await client.http
      .authedRequest(Method.Post, '/keys/device_signing/upload', undefined, { master_key: masterKey }, { prefix: ClientPrefix.V3 })
      .then(() => 200, (e: { httpStatus?: number }) => e.httpStatus ?? -1)
    expect(uploaded).toBe(200)
    expect(await probe()).toBe(false)
    expect(Object.values((await masterKeyOnServer(accessToken, mxid))?.keys ?? {})).toEqual([pub])
  }, 200_000)
})

describe('sondagem da aprovação (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
