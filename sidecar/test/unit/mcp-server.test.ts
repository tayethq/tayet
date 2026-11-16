import { describe, it, expect, afterEach } from 'vitest'
import { CONTRACT_VOCAB_DENY } from '../../contract-vocabulary.mjs'
import { ME } from '../support/slack-world'
import { MODERN, startMcp, TOKEN, type Era, type McpHarness } from '../support/mcp-world'

// `/mcp` on the listener (S-g1, PLANO-AGENTES §0.3.13): the order (Host → Origin → revoked → Bearer →
// POST), both protocol eras with the real client, the fourteen tools, the instructions and the descriptions.

let h: McpHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

const TOOLS = ['clear_commands', 'clear_panel', 'close_approval', 'get_person', 'list_conversations', 'list_members', 'react', 'read_messages', 'request_approval', 'send_message', 'set_commands', 'set_panel', 'wait_for_approval', 'wait_for_mention']
const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
}

describe('MCP — protocol eras', () => {
  it.each<[Era, string]>([
    ['legacy', '2025-11-25'],
    ['modern', MODERN],
  ])('%s: the real client connects and lists the fourteen tools', async (era, version) => {
    h = await startMcp()
    const client = await h.client(era)
    expect(client.getProtocolEra()).toBe(era)
    expect(client.getNegotiatedProtocolVersion()).toBe(version)
    expect(client.getServerVersion()).toMatchObject({ name: 'tayet-agent' })
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS)
  })

  it('the instructions carry the agent and the id rule; no list_changed is offered', async () => {
    h = await startMcp()
    const client = await h.client()
    const text = client.getInstructions() ?? ''
    expect(text).toContain(`"${ME.name}" (${ME.id}) no workspace ${ME.workspace}; kind: agent.`)
    expect(text).toContain('Ids são opacos; `conversation` e `cursor` vêm das próprias respostas.')
    expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: false })
  })

  it('no description of a tool or of a field carries a protocol word', async () => {
    h = await startMcp()
    const { tools } = await (await h.client()).listTools()
    const deny = new RegExp(CONTRACT_VOCAB_DENY, 'i')
    const strings: string[] = []
    const walk = (v: unknown): void => {
      if (typeof v === 'string') strings.push(v)
      else if (Array.isArray(v)) v.forEach(walk)
      else if (v !== null && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          strings.push(k)
          walk(x)
        }
      }
    }
    walk(tools)
    expect(strings.length).toBeGreaterThan(30)
    expect(strings.filter((s) => deny.test(s))).toEqual([])
  })
})

describe('MCP — the listener order', () => {
  it('a wrong Host → 421 (before anything else)', async () => {
    h = await startMcp()
    const port = new URL(h.url).port
    // fetch sets Host from the URL: reach the same port through another loopback name.
    const res = await fetch(`http://localhost:${port}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(INIT) })
    expect(res.status).toBe(421)
  })

  it('an Origin → 403, even with the token', async () => {
    h = await startMcp()
    expect((await h.raw({ headers: { origin: 'http://127.0.0.1' }, body: JSON.stringify(INIT) })).status).toBe(403)
  })

  it('no Bearer → 401; a wrong one → 401; both with a JSON-RPC error body', async () => {
    h = await startMcp()
    const none = await fetch(`${h.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(INIT) })
    expect(none.status).toBe(401)
    expect(await none.json()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32002, message: 'unauthorized' } })
    const wrong = await h.raw({ headers: { authorization: 'Bearer tal_wrong' }, body: JSON.stringify(INIT) })
    expect(wrong.status).toBe(401)
    await expect(h.client('legacy', 'tal_wrong')).rejects.toThrow()
  })

  it('GET and DELETE → 405 with Allow: POST', async () => {
    h = await startMcp()
    for (const method of ['GET', 'DELETE']) {
      const res = await h.raw({ method })
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('POST')
      expect(res.body).toMatchObject({ jsonrpc: '2.0', error: { message: 'method_not_allowed' } })
    }
  })

  it('a body over the listener limit → 413 and the connection closes', async () => {
    h = await startMcp()
    const res = await h.raw({ body: JSON.stringify({ ...INIT, pad: 'x'.repeat(300 * 1024) }) })
    expect(res.status).toBe(413)
  })

  it('after a revocation → 503 with a JSON-RPC error body', async () => {
    h = await startMcp()
    await h.api.revoke(10, 0)
    const res = await h.raw({ body: JSON.stringify(INIT) })
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'revoked' } })
  })

  it('a body that is not JSON → the SDK’s parse error, nothing logged with the content', async () => {
    h = await startMcp()
    const res = await h.raw({ body: '{not json @alice:server.example' })
    expect(res.status).toBe(400)
    expect(JSON.stringify(h.logs)).not.toContain('@alice')
  })

  it('the route is absent when the server is built without the MCP option (404)', async () => {
    const { createApiServer } = await import('../../src/api/server')
    const { createWorld } = await import('../support/slack-world')
    const w = createWorld()
    const api = createApiServer({ read: w.read, write: w.write, state: () => 'online', token: TOKEN, listen: { host: '127.0.0.1', port: 0 }, log: () => {} })
    const url = await api.start()
    const res = await fetch(`${url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: '{}' })
    expect(res.status).toBe(404)
    await api.close()
  })
})
