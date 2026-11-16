import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createEscrowServer, type EscrowDeps } from '../../src/server.ts'
import { IdpUnavailableError, type Introspector } from '../../src/auth.ts'
import { importOrgKey } from '../../src/crypto.ts'
import { fileSessionStore } from '../../src/custody-store.ts'
import { fileStore } from '../../src/store.ts'
import { jsonlAudit } from '../../src/audit.ts'
import { deviceOfScope, masAdmin, OriginUnknownError } from '../../src/mas-admin.ts'

// POST /v1/account/revoke-others (ADR-082 dec. 3) contra um MAS falso: o fetch injetado responde a
// admin API no shape medido no MAS 1.27 (id em `data[].id`, atributos em `attributes`, paginação em
// `links.next`). O estado do fake é por usuário: o assert "só o usuário do token" olha o outro.

const DEVICE_SCOPE = 'urn:matrix:org.matrix.msc2967.client:device:'

interface FakeSession {
  id: string
  kind: 'oauth2-sessions' | 'compat-sessions' | 'user-sessions'
  user: string
  scope?: string
  device_id?: string
  user_session_id?: string | null
  finished?: boolean
}

function seed(): FakeSession[] {
  return [
    { id: 'oa-origin', kind: 'oauth2-sessions', user: 'U-ana', scope: `openid ${DEVICE_SCOPE}ORIGIN`, user_session_id: 'br-origin' },
    { id: 'oa-other', kind: 'oauth2-sessions', user: 'U-ana', scope: `openid ${DEVICE_SCOPE}OTHER`, user_session_id: 'br-other' },
    { id: 'co-other', kind: 'compat-sessions', user: 'U-ana', device_id: 'COMPAT', user_session_id: null },
    { id: 'br-origin', kind: 'user-sessions', user: 'U-ana' },
    { id: 'br-other', kind: 'user-sessions', user: 'U-ana' },
    { id: 'oa-beto', kind: 'oauth2-sessions', user: 'U-beto', scope: `openid ${DEVICE_SCOPE}BETO`, user_session_id: 'br-beto' },
    { id: 'br-beto', kind: 'user-sessions', user: 'U-beto' },
  ]
}

function fakeMas(sessions: FakeSession[], opts: { failFinishOf?: string; pageSize?: number } = {}) {
  const calls: string[] = []
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const route = (input: string, init?: RequestInit): Response => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url.pathname}`)
    if (url.pathname === '/oauth2/token') return json(200, { access_token: 'adm', expires_in: 3600 })
    if ((init?.headers as Record<string, string>).authorization !== 'Bearer adm') return json(401, {})

    const byName = /^\/api\/admin\/v1\/users\/by-username\/(.+)$/.exec(url.pathname)
    if (byName) {
      const user = `U-${byName[1]!}`
      return sessions.some((s) => s.user === user) ? json(200, { data: { id: user } }) : json(404, {})
    }
    const finish = /^\/api\/admin\/v1\/([a-z0-9-]+)\/([^/]+)\/finish$/.exec(url.pathname)
    if (finish) {
      if (finish[2] === opts.failFinishOf) return json(500, {})
      const row = sessions.find((s) => s.id === finish[2])
      if (!row) return json(404, {})
      if (row.finished) return json(400, {})
      row.finished = true
      return json(200, {})
    }
    const list = /^\/api\/admin\/v1\/([a-z0-9-]+)$/.exec(url.pathname)
    if (list) {
      const user = url.searchParams.get('filter[user]')
      const rows = sessions.filter((s) => s.kind === list[1] && s.user === user && !s.finished)
      const after = Number(url.searchParams.get('page[after]') ?? 0)
      const size = opts.pageSize ?? rows.length
      const page = rows.slice(after, after + size)
      return json(200, {
        data: page.map((s) => ({
          id: s.id,
          attributes: { scope: s.scope, device_id: s.device_id, user_session_id: s.user_session_id },
        })),
        links: after + size < rows.length ? { next: `${url.pathname}?filter[user]=${user}&page[after]=${after + size}` } : {},
      })
    }
    return json(404, {})
  }
  const fetchFn = ((input: string, init?: RequestInit) => Promise.resolve(route(input, init))) as typeof fetch
  return {
    calls,
    admin: masAdmin({ url: 'http://mas:8081', tokenUrl: 'http://mas:8080/oauth2/token', clientId: 'id', clientSecret: 's', fetchFn }),
  }
}

function fakeIntrospector(): Introspector {
  const accesses: Record<string, { sub: string; username: string; device: string }> = {
    'tok-ana': { sub: 'sub-ana', username: 'ana', device: 'ORIGIN' },
    'tok-ana-compat': { sub: 'sub-ana', username: 'ana', device: 'COMPAT' },
    'tok-ana-ghost': { sub: 'sub-ana', username: 'ana', device: 'GHOST' },
  }
  return {
    subjectOf: () => Promise.resolve(null),
    identityOf: () => Promise.resolve(null),
    accessOf(token) {
      if (token === 'tok-idp-down') return Promise.reject(new IdpUnavailableError())
      return Promise.resolve(accesses[token] ?? null)
    },
  }
}

let dir: string
let server: Server
let base: string
let sessions: FakeSession[]

async function start(accessAdmin: EscrowDeps['accessAdmin']): Promise<void> {
  const deps: EscrowDeps = {
    store: fileStore(dir),
    introspector: fakeIntrospector(),
    orgKey: await importOrgKey(Buffer.from(new Uint8Array(32).fill(7)).toString('base64')),
    audit: jsonlAudit(join(dir, 'audit.jsonl')),
    sessionStore: fileSessionStore(join(dir, 'sessions')),
    custodyUsername: 'cofre',
    ...(accessAdmin ? { accessAdmin } : {}),
  }
  server = createEscrowServer(deps)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const revoke = (token?: string, body?: string): Promise<Response> =>
  fetch(`${base}/v1/account/revoke-others`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(body !== undefined ? { body } : {}),
  })

const active = (): string[] => sessions.filter((s) => !s.finished).map((s) => s.id)

const audit = async (): Promise<Array<Record<string, unknown>>> =>
  (await readFile(join(dir, 'audit.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'escrow-revoke-'))
  sessions = seed()
})

afterEach(async () => {
  await new Promise((r) => server.close(r))
  await rm(dir, { recursive: true, force: true })
})

describe('POST /v1/account/revoke-others', () => {
  it('encerra os três tipos do usuário do token e poupa a origem e a browser session dela', async () => {
    await start(fakeMas(sessions).admin)
    const res = await revoke('tok-ana')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ revoked: { oauth: 1, compat: 1, browser: 1 } })
    expect(active()).toEqual(['oa-origin', 'br-origin', 'oa-beto', 'br-beto'])
  })

  it('só o usuário do token: as sessões de outro usuário ficam intactas', async () => {
    await start(fakeMas(sessions).admin)
    await revoke('tok-ana')
    expect(active()).toEqual(expect.arrayContaining(['oa-beto', 'br-beto']))
  })

  it('atravessa a paginação da admin API', async () => {
    await start(fakeMas(sessions, { pageSize: 1 }).admin)
    expect((await revoke('tok-ana')).status).toBe(200)
    expect(active()).toEqual(['oa-origin', 'br-origin', 'oa-beto', 'br-beto'])
  })

  it('poupa a origem compat quando o token é de sessão compat', async () => {
    await start(fakeMas(sessions).admin)
    expect((await revoke('tok-ana-compat')).status).toBe(200)
    expect(active()).toContain('co-other')
    expect(active()).not.toContain('oa-origin')
  })

  it('idempotente: a segunda varredura não encerra nada e responde 200', async () => {
    await start(fakeMas(sessions).admin)
    await revoke('tok-ana')
    const again = await revoke('tok-ana')
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ revoked: { oauth: 0, compat: 0, browser: 0 } })
    expect(active()).toEqual(['oa-origin', 'br-origin', 'oa-beto', 'br-beto'])
  })

  it('origem não identificada → 409 e NADA encerrado', async () => {
    await start(fakeMas(sessions).admin)
    const res = await revoke('tok-ana-ghost')
    expect(res.status).toBe(409)
    expect(active()).toHaveLength(sessions.length)
    expect((await audit()).at(-1)).toMatchObject({ verb: 'revoke-others', outcome: 'origin_unknown' })
  })

  it('falha do MAS → 502, nunca sucesso, e a repetição completa o que faltou', async () => {
    const { admin } = fakeMas(sessions, { failFinishOf: 'co-other' })
    await start(admin)
    const res = await revoke('tok-ana')
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'admin_unavailable' })
    expect((await audit()).at(-1)).toMatchObject({ verb: 'revoke-others', outcome: 'error' })
    expect((await audit()).at(-1)).not.toHaveProperty('revoked')
  })

  it('sem o client admin configurado → 503', async () => {
    await start(undefined)
    const res = await revoke('tok-ana')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'admin_unavailable' })
  })

  it('401 indistinguível sem token válido, ANTES de tocar o MAS; 503 com o IdP fora', async () => {
    const mas = fakeMas(sessions)
    await start(mas.admin)
    expect((await revoke()).status).toBe(401)
    expect((await revoke('tok-unknown')).status).toBe(401)
    expect(mas.calls).toEqual([])
    expect((await revoke('tok-idp-down')).status).toBe(503)
  })

  it('corpo não-vazio é malformado: identidade só do token', async () => {
    await start(fakeMas(sessions).admin)
    expect((await revoke('tok-ana', '{"username":"beto"}')).status).toBe(400)
    expect(active()).toHaveLength(sessions.length)
  })

  it('audit com contagens, sem id de sessão, device ou token', async () => {
    await start(fakeMas(sessions).admin)
    await revoke('tok-ana')
    const raw = await readFile(join(dir, 'audit.jsonl'), 'utf8')
    expect(JSON.parse(raw.trim())).toMatchObject({
      sub: 'sub-ana',
      verb: 'revoke-others',
      outcome: 'revoked',
      revoked: { oauth: 1, compat: 1, browser: 1 },
    })
    for (const leak of ['oa-other', 'br-other', 'ORIGIN', 'tok-ana']) expect(raw).not.toContain(leak)
  })
})

describe('masAdmin', () => {
  beforeEach(async () => {
    await start(undefined)
  })

  it('o token admin fica em cache entre chamadas', async () => {
    const mas = fakeMas(sessions)
    await mas.admin.revokeOthers('ana', 'ORIGIN')
    await mas.admin.revokeOthers('ana', 'ORIGIN')
    expect(mas.calls.filter((c) => c === 'POST /oauth2/token')).toHaveLength(1)
  })

  it('OriginUnknownError quando o device não está nas sessões ativas', async () => {
    await expect(fakeMas(sessions).admin.revokeOthers('ana', 'GHOST')).rejects.toBeInstanceOf(OriginUnknownError)
  })

  it('deviceOfScope lê os escopos estável e unstable; sem device → null', () => {
    expect(deviceOfScope(`openid ${DEVICE_SCOPE}ABC`)).toBe('ABC')
    expect(deviceOfScope('openid urn:matrix:client:device:XYZ urn:matrix:client:api:*')).toBe('XYZ')
    expect(deviceOfScope('openid')).toBeNull()
    expect(deviceOfScope(undefined)).toBeNull()
  })
})
