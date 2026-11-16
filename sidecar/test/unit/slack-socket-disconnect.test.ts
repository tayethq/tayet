import { describe, it, expect, afterEach } from 'vitest'
import { App, LogLevel } from '@slack/bolt'
import { connect, isOpen, open, socketUrl } from '../support/slack-socket'
import { GENERAL, TOKEN, message, refusal, startSlack, type SlackHarness } from '../support/slack-world'

// `disconnect` (PLANO-AGENTES §0.3.12, S-f2): `refresh_requested` on a clean shutdown (the SDK reopens with
// a new ticket), `link_disabled` on the revocation (then apps.connections.open → token_revoked, the
// upgrade → 503).

let h: SlackHarness | undefined
let app: App | undefined
afterEach(async () => {
  await app?.stop().catch(() => {})
  app = undefined
  await h?.close()
  h = undefined
})

describe('Socket Mode — disconnect', () => {
  it('a clean shutdown sends refresh_requested, then closes', async () => {
    h = await startSlack()
    const s = await open(h)
    await s.next((f) => f.type === 'hello')
    const closing = h.close()
    expect(await s.next((f) => f.type === 'disconnect')).toEqual({ type: 'disconnect', reason: 'refresh_requested', debug_info: { host: 'tayet-agent' } })
    await s.closed
    await closing
    expect(h.logs).toContainEqual({ evt: 'socket-close', connections: 0, reason: 'refresh_requested' })
    h = undefined
  })

  it('the revocation sends link_disabled and closes; then open → token_revoked and the upgrade → 503', async () => {
    h = await startSlack()
    const url = await socketUrl(h)
    const s = await open(h)
    await s.next((f) => f.type === 'hello')
    const revoking = h.api.revoke(2_000, 0)
    expect(await s.next((f) => f.type === 'disconnect')).toEqual({ type: 'disconnect', reason: 'link_disabled', debug_info: { host: 'tayet-agent' } })
    await s.closed
    await revoking
    expect(await refusal(h.client(), 'apps.connections.open')).toBe('token_revoked')
    const r = await connect(url)
    expect(isOpen(r) ? 101 : r.status).toBe(503)
    // No event goes out after the revocation.
    expect(h.logs.filter((l) => l.evt === 'socket-open')).toHaveLength(1)
  })

  it('a client that does not close is cut after the grace', async () => {
    h = await startSlack()
    const s = await open(h)
    // A client that never answers the close handshake.
    ;(s.ws as unknown as { _socket: { pause(): void } })._socket.pause()
    const t0 = Date.now()
    await h.close()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
    h = undefined
  })

  it('Bolt reopens with a new ticket after refresh_requested (the sidecar restarted on the same port)', async () => {
    h = await startSlack()
    const port = Number(new URL(h.url).port)
    app = new App({ token: TOKEN, appToken: TOKEN, socketMode: true, clientOptions: { slackApiUrl: `${h.url}/slack/api/` }, logLevel: LogLevel.ERROR })
    const got: string[] = []
    app.event('message', ({ event }) => {
      got.push((event as { ts: string }).ts)
      return Promise.resolve()
    })
    await app.start()
    await h.close()
    // The new run: same port and token, another ticket table.
    h = await startSlack({ port })
    await expect.poll(() => h?.logs.some((l) => l.evt === 'socket-open'), { timeout: 15_000, interval: 100 }).toBe(true)
    h.world.emit({ type: 'message.received', conversation: GENERAL.id, message: message({ id: '1731000002.000100', text: 'depois do restart' }) })
    await expect.poll(() => got).toEqual(['1731000002.000100'])
  }, 30_000)
})
