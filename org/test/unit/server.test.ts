import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createOrgServer } from '../../src/server.ts'
import { jsonlAudit } from '../../src/audit.ts'
import { masAdmin } from '../../src/mas-admin.ts'
import { createAdmins } from '../../src/admins.ts'
import { createAgents } from '../../src/agents.ts'
import { createPeople, randomLocalpart } from '../../src/people.ts'
import { homeserver } from '../../src/synapse.ts'
import { fakeFetch, fakeIntrospector, PROVIDER, SERVER, seed } from '../support/fake-org.ts'

// The org service's own surface: liveness, and nothing of the escrow's.

let dir: string
let server: Server
let base: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'org-server-'))
  const fake = seed()
  const fetchFn = fakeFetch(fake)
  const admin = masAdmin({ url: 'http://mas:8081', tokenUrl: 'http://mas:8080/oauth2/token', clientId: 'id', clientSecret: 's', fetchFn })
  const synapse = homeserver({ url: 'http://synapse:8008', fetchFn, sleep: () => Promise.resolve() })
  const audit = jsonlAudit(join(dir, 'audit.jsonl'))
  server = createOrgServer({
    introspector: fakeIntrospector(fake),
    audit,
    people: createPeople({ masAdmin: admin, synapse, audit, randomId: randomLocalpart, serverName: SERVER, providerId: PROVIDER, custodyUsername: 'cofre' }),
    agents: createAgents({ masAdmin: admin, synapse, audit, randomId: randomLocalpart, serverName: SERVER }),
    admins: createAdmins({ masAdmin: admin, synapse, audit, serverName: SERVER, custodyUsername: 'cofre' }),
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise((r) => server.close(r))
  await rm(dir, { recursive: true, force: true })
})

describe('org server', () => {
  it('GET /healthz → 200 without a token, and is not audited', async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(await readFile(join(dir, 'audit.jsonl'), 'utf8').catch(() => '')).toBe('')
  })

  it.each([
    ['GET', '/v1/secret'],
    ['PUT', '/v1/sessions'],
    ['POST', '/v1/account/revoke-others'],
    ['GET', '/v1/people'],
  ])('%s %s → 404', async (method, path) => {
    const res = await fetch(`${base}${path}`, { method, headers: { Authorization: 'Bearer tok-alice' } })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })
})
