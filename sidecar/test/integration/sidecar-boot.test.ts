import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ESCROW_URL, HS_URL, mintOidcSession, stackUp, startWellKnown, until, whoamiStatus } from '../support/stack'
import { evt, startSidecar, type SidecarProcess } from '../support/sidecar-process'
import { startHuman, type Human } from '../support/human'
import { conversationToken } from '../../src/api/ids'

// S-b1 against the stack (PLANO-AGENTES §0.3.5): a real agent credential (alice creates it through
// the escrow's /v1/agents, ADR-086), a local discovery document pointing at TAYET_HS_URL, and
// dist/cli.js spawned as the operator would run it. Boot to sync, the instance lock, revocation by
// deleting the agent, the reboot after it, and a person's credential refused.

const STACK = stackUp()
const rand = (): string => Math.random().toString(36).slice(2, 8)
// Poll with the 30 s ceiling of ADR-086 dec. 8 (introspection cache < 1 s), for the token's 401 and
// for the sidecar's exit (measured on the spike: 109 ms from the DELETE to exit 78).
const SIDECAR_REVOKE_CEILING_MS = 30_000

describe.skipIf(!STACK)('sidecar S-b1 ↔ stack: boot, lock, revocation (ADR-087 decs. 1–3, 8)', () => {
  let alice: string
  let agent: { userId: string; token: string; deviceId: string } | undefined
  let removed = false
  let wellKnown: Awaited<ReturnType<typeof startWellKnown>>
  let store: string
  let first: SidecarProcess | undefined

  const escrow = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${ESCROW_URL}/v1/agents${path}`, {
      method,
      headers: { Authorization: `Bearer ${alice}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  const args = (token: string): string[] => ['--server', wellKnown.url, '--token', token, '--store', store]

  beforeAll(async () => {
    alice = (await mintOidcSession('alice', 'alicepass123')).accessToken
    const res = await escrow('POST', '', { name: `Sidecar Probe ${rand()}` })
    expect(res.status).toBe(201)
    agent = (await res.json()) as NonNullable<typeof agent>
    wellKnown = await startWellKnown(HS_URL)
    store = await mkdtemp(join(tmpdir(), 'sidecar-it-'))
  }, 120_000)

  afterAll(async () => {
    await first?.stop()
    if (agent !== undefined && !removed) await escrow('DELETE', `/${encodeURIComponent(agent.userId)}`)
    await wellKnown?.close()
    if (store !== undefined) await rm(store, { recursive: true, force: true })
  }, 60_000)

  it('1. boots to an active sync (the transition is logged)', async () => {
    const a = agent!
    first = startSidecar(args(a.token))
    await first.waitFor((l) => l.evt === 'sync-state' && l.to === 'SYNCING', 90_000)
    expect(first.lines.find(evt('discovered'))).toMatchObject({ via: 'well-known' })
    // §0.3.12 item 9: the whoami line carries no id (the device id only under --debug).
    expect(first.lines.find(evt('whoami'))).toEqual({ evt: 'whoami' })
    expect(JSON.parse(await readFile(join(store, 'identity.json'), 'utf8'))).toMatchObject({
      deviceId: a.deviceId,
      userId: a.userId,
      server: HS_URL,
    })
  }, 120_000)

  it('2. a 2nd process on the same store exits 75; the 1st keeps running', async () => {
    const second = startSidecar(args(agent!.token))
    expect(await second.exited).toBe(75)
    expect(second.lines.at(-1)).toMatchObject({ evt: 'lock-busy' })
    expect(existsSync(join(store, 'REMEDIATION_NEEDED'))).toBe(false)
    expect(first!.child.exitCode).toBeNull()
  }, 120_000)

  it('3. deleting the agent revokes: the 1st exits 78 with REVOKED and the device store wiped', async () => {
    const a = agent!
    const t0 = Date.now()
    expect((await escrow('DELETE', `/${encodeURIComponent(a.userId)}`)).status).toBeLessThan(300)
    removed = true
    await until(async () => ((await whoamiStatus(a.token)) === 401 ? true : undefined), 30_000, 'whoami 401 after DELETE')
    const code = await Promise.race([
      first!.exited,
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), SIDECAR_REVOKE_CEILING_MS)),
    ])
    expect(code).toBe(78)
    console.log(`[sidecar-it] revocation → exit 78 in ${Date.now() - t0} ms`)
    expect(first!.lines.find(evt('credential-refused'))).toMatchObject({ stage: 'runtime' })
    expect(JSON.parse(await readFile(join(store, 'REVOKED'), 'utf8'))).toMatchObject({ deviceId: a.deviceId })
    expect(existsSync(join(store, 'indexeddb'))).toBe(false)
    expect(existsSync(join(store, 'identity.json'))).toBe(false)
    expect(existsSync(join(store, 'storage.key'))).toBe(true)
  }, 120_000)

  it('4. a reboot with the same token exits 78 at boot, with no new wipe', async () => {
    const before = (await readdir(store)).sort()
    const revokedAt = (await stat(join(store, 'REVOKED'))).mtimeMs
    const p = startSidecar(args(agent!.token))
    expect(await p.exited).toBe(78)
    expect(p.lines.at(-1)).toMatchObject({ evt: 'credential-refused', stage: 'boot', errcode: 'M_UNKNOWN_TOKEN' })
    expect((await readdir(store)).sort()).toEqual(before)
    expect((await stat(join(store, 'REVOKED'))).mtimeMs).toBe(revokedAt)
  }, 60_000)

  it("5. a person's credential (not `a-`) exits 77 before any store is touched", async () => {
    const empty = await mkdtemp(join(tmpdir(), 'sidecar-it-person-'))
    try {
      const p = startSidecar(['--server', wellKnown.url, '--token', alice, '--store', empty])
      expect(await p.exited).toBe(77)
      expect(await readdir(empty)).toEqual([])
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  }, 60_000)
})

// S-h against the stack (PLANO-AGENTES §0.3.14; ADR-087 addendum decs. 3 and 9): the self-reissue on a
// store loss, through dist/cli.js, with the escrow's real POST /v1/agents/:id/reissue. Two agents (the
// escrow allows one self-reissue per agent per 60 s) in ONE encrypted room of alice's (the stack's
// createRoom limit is shared). After each rotation the agent sends through its local API and the person
// decrypts it from the new device. Nothing here logs a token, an mxid or a device id.
describe.skipIf(!STACK)('sidecar S-h ↔ stack: self-reissue on store loss (§0.3.14)', () => {
  type Agent = { userId: string; token: string; deviceId: string }
  let alice: string
  let person: Human
  let wellKnown: Awaited<ReturnType<typeof startWellKnown>>
  const agents: Agent[] = []
  const stores: string[] = []
  const procs: SidecarProcess[] = []
  let room = ''
  let a: Agent
  let storeA = ''

  const escrow = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${ESCROW_URL}/v1/agents${path}`, {
      method,
      headers: { Authorization: `Bearer ${alice}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  const createAgent = async (): Promise<Agent> => {
    const res = await escrow('POST', '', { name: `Sidecar Reissue ${rand()}` })
    expect(res.status).toBe(201)
    const agent = (await res.json()) as Agent
    agents.push(agent)
    return agent
  }
  const newStore = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'sidecar-sh-it-'))
    stores.push(dir)
    return dir
  }
  const run = (token: string, store: string): SidecarProcess => {
    const p = startSidecar(['--server', wellKnown.url, '--token', token, '--store', store])
    procs.push(p)
    return p
  }
  // The last api-listening line (after a relaunch, the relaunched boot's).
  const listening = async (p: SidecarProcess): Promise<string> => {
    await p.waitFor(evt('api-listening'), 120_000)
    return p.lines.filter(evt('api-listening')).at(-1)!.url as string
  }
  // The agent writes through its local API; the person decrypts it.
  const sendAndDecrypt = async (store: string, url: string, agent: Agent): Promise<void> => {
    const local = (await readFile(join(store, 'local.token'), 'utf8')).trim()
    const text = `after the reissue ${rand()}`
    const conv = conversationToken(room, false)
    await until(
      async () => ((await fetch(`${url}/v1/conversations/${conv}`, { headers: { authorization: `Bearer ${local}` } })).status === 200 ? true : undefined),
      60_000,
      'the conversation in the relaunched agent',
    )
    const res = await fetch(`${url}/v1/conversations/${conv}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${local}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    expect(res.status).toBe(200)
    const got = await person.waitForMessage((m) => m.sender === agent.userId && m.body === text, 90_000)
    expect(got.wireType).toBe('m.room.encrypted')
  }
  // Whether the server lists keys for this device (alice's token: any user may query keys).
  const keysPublished = async (agent: Agent, deviceId: string): Promise<boolean> => {
    const res = await fetch(`${HS_URL}/_matrix/client/v3/keys/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_keys: { [agent.userId]: [deviceId] } }),
    })
    const body = (await res.json()) as { device_keys?: Record<string, Record<string, unknown>> }
    return body.device_keys?.[agent.userId]?.[deviceId] !== undefined
  }
  const sha256 = (t: string): string => createHash('sha256').update(t).digest('hex')
  const credentialOf = async (store: string): Promise<{ token: string; seededFrom: string; rotatedAt: string }> =>
    JSON.parse(await readFile(join(store, 'credential'), 'utf8')) as { token: string; seededFrom: string; rotatedAt: string }

  beforeAll(async () => {
    alice = (await mintOidcSession('alice', 'alicepass123')).accessToken
    person = await startHuman(alice)
    wellKnown = await startWellKnown(HS_URL)
    a = await createAgent()
    storeA = await newStore()
    const p = run(a.token, storeA)
    await listening(p)
    room = await person.createEncryptedRoom([a.userId])
    await p.waitFor((l) => l.evt === 'joined' && l.conversation === conversationToken(room, false), 90_000)
    await person.waitForMembership(room, a.userId, 'join')
    expect(await p.stop()).toBe(0)
  }, 240_000)

  afterAll(async () => {
    for (const p of procs) await p.stop()
    person?.stop()
    for (const agent of agents) await escrow('DELETE', `/${encodeURIComponent(agent.userId)}`)
    console.log(`[sidecar-sh-it] a- accounts created: ${agents.length}, deleted: ${agents.length}`)
    await wellKnown?.close()
    for (const dir of stores) await rm(dir, { recursive: true, force: true })
  }, 90_000)

  it('6. indexeddb/ deleted, marker kept → keys-diverged → self-reissue → relaunch → the person decrypts from the new device', async () => {
    await rm(join(storeA, 'indexeddb'), { recursive: true, force: true })
    expect(existsSync(join(storeA, 'identity.json'))).toBe(true)
    const p = run(a.token, storeA)
    const url = await listening(p)
    expect(p.lines.find(evt('self-reissue-started'))).toEqual({ evt: 'self-reissue-started', reason: 'keys-diverged' })
    const rotated = p.lines.findIndex(evt('credential-rotated'))
    expect(rotated).toBeGreaterThan(0)
    expect(p.lines.slice(0, rotated).some(evt('api-listening'))).toBe(false)
    expect(p.lines.slice(rotated).some(evt('credential-from-store'))).toBe(true)
    const cred = await credentialOf(storeA)
    expect(cred.seededFrom).toBe(sha256(a.token))
    expect(cred.token).not.toBe(a.token)
    // The seed died in the kill; the device changed.
    await until(async () => ((await whoamiStatus(a.token)) === 401 ? true : undefined), 30_000, 'the seed token refused')
    const marker = JSON.parse(await readFile(join(storeA, 'identity.json'), 'utf8')) as { deviceId: string }
    expect(marker.deviceId).not.toBe(a.deviceId)
    expect(existsSync(join(storeA, 'REMEDIATION_NEEDED'))).toBe(false)
    await sendAndDecrypt(storeA, url, a)
    expect(await p.stop()).toBe(0)
    for (const stream of [p.stdout(), p.stderr()]) {
      expect(stream).not.toContain(a.token)
      expect(stream).not.toContain(cred.token)
      expect(stream).not.toContain(a.userId)
      expect(stream).not.toContain(marker.deviceId)
    }
  }, 300_000)

  it('7. the admin reissues in the product after the rotation → the new --token boots, the stale credential file is removed', async () => {
    const stale = (await credentialOf(storeA)).token
    const res = await escrow('POST', `/${encodeURIComponent(a.userId)}/reissue`)
    expect(res.status).toBe(201)
    const admin = (await res.json()) as { token: string; deviceId: string }
    // ADR-086 dec. 8: the killed credential is refused within the introspection grace (< 1 s).
    await until(async () => ((await whoamiStatus(stale)) === 401 ? true : undefined), 30_000, 'the stored credential refused')
    const p = run(admin.token, storeA)
    await listening(p)
    expect(p.lines.some(evt('credential-stale-removed'))).toBe(true)
    expect(p.lines.some(evt('credential-from-store'))).toBe(false)
    expect(p.lines.some(evt('self-reissue-started'))).toBe(false)
    expect(existsSync(join(storeA, 'credential'))).toBe(false)
    expect(JSON.parse(await readFile(join(storeA, 'identity.json'), 'utf8'))).toMatchObject({ deviceId: admin.deviceId })
    expect(await p.stop()).toBe(0)
  }, 240_000)

  it('8. F7: the whole directory lost with the --token alive → the device had published keys → self-reissue → the person decrypts', async () => {
    const b = await createAgent()
    const storeB = await newStore()
    // A 1st boot of a new agent: its device has no keys (the escrow's mint uploads none) → no reissue.
    expect(await keysPublished(b, b.deviceId)).toBe(false)
    const first = run(b.token, storeB)
    await listening(first)
    expect(first.lines.some(evt('self-reissue-started'))).toBe(false)
    await person.invite(room, b.userId)
    await first.waitFor((l) => l.evt === 'joined' && l.conversation === conversationToken(room, false), 90_000)
    await person.waitForMembership(room, b.userId, 'join')
    expect(await first.stop()).toBe(0)
    // The precondition: the device published keys.
    expect(await keysPublished(b, b.deviceId)).toBe(true)
    await rm(storeB, { recursive: true, force: true })
    const p = run(b.token, storeB)
    const url = await listening(p)
    expect(p.lines.find(evt('self-reissue-started'))).toEqual({ evt: 'self-reissue-started', reason: 'store-lost' })
    expect((await credentialOf(storeB)).seededFrom).toBe(sha256(b.token))
    await sendAndDecrypt(storeB, url, b)
    expect(await p.stop()).toBe(0)
  }, 300_000)
})
