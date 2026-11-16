import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import config, { AGENT_DISCOVERY_PATH, agentDiscoveryMiddleware } from '../vite.config'

// PLANO-AGENTES §0.3.9 item 1: the dev and preview servers answer the agent discovery document the
// Caddyfile answers in production — JSON, the namespace's homeserver and the same-origin /escrow.

function call(url: string) {
  const res = { statusCode: 0, headers: {} as Record<string, string>, body: '' }
  let passed = false
  agentDiscoveryMiddleware('http://localhost:18008')(
    { url } as IncomingMessage,
    {
      set statusCode(v: number) {
        res.statusCode = v
      },
      setHeader: (k: string, v: string) => void (res.headers[k.toLowerCase()] = v),
      end: (b: string) => void (res.body = b),
    } as unknown as ServerResponse,
    () => {
      passed = true
    },
  )
  return { ...res, passed }
}

describe('agent discovery in dev/preview (§0.3.9 item 1)', () => {
  it('answers the document as application/json', () => {
    const r = call(AGENT_DISCOVERY_PATH)
    expect(r.passed).toBe(false)
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toBe('application/json')
    expect(JSON.parse(r.body)).toEqual({ server: 'http://localhost:18008', account: '/escrow' })
  })

  it('ignores a query string, and passes every other path on', () => {
    expect(call(`${AGENT_DISCOVERY_PATH}?x=1`).statusCode).toBe(200)
    for (const url of ['/', '/index.html', '/.well-known/tayet', `${AGENT_DISCOVERY_PATH}/x`, '/escrow/v1/secret']) {
      expect(call(url).passed, url).toBe(true)
    }
  })

  it('is a serve/preview plugin of the config, with no build hook', () => {
    const plugin = (config.plugins ?? []).flat().find((p) => p && typeof p === 'object' && 'name' in p && p.name === 'tayet-agent-discovery') as
      | Record<string, unknown>
      | undefined
    expect(plugin).toBeDefined()
    expect(Object.keys(plugin!).sort()).toEqual(['configurePreviewServer', 'configureServer', 'name'])
  })
})
