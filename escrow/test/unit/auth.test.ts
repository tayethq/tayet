import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { IdpUnavailableError, rfc7662Introspector, type Introspector } from '../../src/auth.ts'

// IdP stub: devolve o que o caso pedir, e captura a última request para os asserts de
// shape (client_secret_basic + x-www-form-urlencoded com o token — PF-1 item 1).
let idp: Server
let url: string
let respond: (status: number, body: string, delayMs?: number) => void
let lastRequest: { auth?: string; contentType?: string; body: string }

beforeEach(async () => {
  let current = { status: 200, body: '{"active": false}', delayMs: 0 }
  respond = (status, body, delayMs = 0) => {
    current = { status, body, delayMs }
  }
  idp = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')))
    req.on('end', () => {
      lastRequest = {
        auth: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: raw,
      }
      setTimeout(() => {
        res.writeHead(current.status, { 'content-type': 'application/json' })
        res.end(current.body)
      }, current.delayMs)
    })
  })
  await new Promise<void>((resolve) => idp.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(idp.address() as AddressInfo).port}/oauth2/introspect`
})

afterEach(async () => {
  await new Promise((resolve) => idp.close(resolve))
})

function introspector(timeoutMs?: number): Introspector {
  return rfc7662Introspector({ url, clientId: 'escrow-id', clientSecret: 'escrow-secret', timeoutMs })
}

describe('rfc7662Introspector (shape do PF-1)', () => {
  it('resolves sub for an active token, authenticating via client_secret_basic', async () => {
    respond(200, JSON.stringify({ active: true, sub: '01KTW95XRNB4KPFKRFGYFV7BY7', username: 'alice' }))
    expect(await introspector().subjectOf('mct_token')).toBe('01KTW95XRNB4KPFKRFGYFV7BY7')
    expect(lastRequest.auth).toBe(
      `Basic ${Buffer.from('escrow-id:escrow-secret').toString('base64')}`,
    )
    expect(lastRequest.contentType).toContain('application/x-www-form-urlencoded')
    expect(new URLSearchParams(lastRequest.body).get('token')).toBe('mct_token')
  })

  it('maps active:false to null (caller answers an indistinguishable 401)', async () => {
    respond(200, JSON.stringify({ active: false }))
    expect(await introspector().subjectOf('mct_revoked')).toBeNull()
  })

  it('maps active:true WITHOUT a sub to null — never trusts a subject-less token', async () => {
    respond(200, JSON.stringify({ active: true }))
    expect(await introspector().subjectOf('mct_weird')).toBeNull()
  })

  it.each([
    ['500', () => respond(500, '{}')],
    ['401 (credencial de introspecção quebrada)', () => respond(401, '{}')],
    ['JSON inválido', () => respond(200, 'not json')],
  ])('throws IdpUnavailableError on %s', async (_label, setup) => {
    setup()
    await expect(introspector().subjectOf('mct_token')).rejects.toThrow(IdpUnavailableError)
  })

  it('throws IdpUnavailableError on timeout', async () => {
    respond(200, '{"active": true, "sub": "x"}', 5_000)
    await expect(introspector(100).subjectOf('mct_token')).rejects.toThrow(IdpUnavailableError)
  })
})

describe('rfc7662Introspector.identityOf (custódia de sessão, ADR-057 dec. 5)', () => {
  it('resolves sub + username from the same introspection response', async () => {
    respond(200, JSON.stringify({ active: true, sub: '01KTW95XRNB4KPFKRFGYFV7BY7', username: 'alice' }))
    expect(await introspector().identityOf('mat_token')).toEqual({
      sub: '01KTW95XRNB4KPFKRFGYFV7BY7',
      username: 'alice',
    })
  })

  it.each([
    ['active:false', { active: false }],
    ['sem sub', { active: true, username: 'alice' }],
    ['sem username', { active: true, sub: '01KTW95XRNB4KPFKRFGYFV7BY7' }],
    ['username vazio', { active: true, sub: '01KTW95XRNB4KPFKRFGYFV7BY7', username: '' }],
  ])('maps %s to null (caller answers an indistinguishable 401)', async (_label, body) => {
    respond(200, JSON.stringify(body))
    expect(await introspector().identityOf('mat_token')).toBeNull()
  })

  it('throws IdpUnavailableError on 5xx, like subjectOf', async () => {
    respond(500, '{}')
    await expect(introspector().identityOf('mat_token')).rejects.toThrow(IdpUnavailableError)
  })
})

describe('rfc7662Introspector.accessOf (revoke-others, ADR-082 dec. 3)', () => {
  it('device sai do escopo do token', async () => {
    respond(
      200,
      JSON.stringify({
        active: true,
        sub: 'sub-x',
        username: 'ana',
        scope: 'openid urn:matrix:org.matrix.msc2967.client:device:ABC',
      }),
    )
    expect(await introspector().accessOf('mat_token')).toEqual({ sub: 'sub-x', username: 'ana', device: 'ABC' })
  })

  it('sem device no escopo → null (401 no chamador)', async () => {
    respond(200, JSON.stringify({ active: true, sub: 'sub-x', username: 'ana', scope: 'openid' }))
    expect(await introspector().accessOf('mat_token')).toBeNull()
  })
})
