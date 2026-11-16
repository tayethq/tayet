import { describe, expect, it, vi } from 'vitest'
import { MatrixError } from 'matrix-js-sdk'
import type { Channel, Message } from '@tayet/shared'
import { APPROVAL_RESPONSE_MSGTYPE, RESPONSE_REL_TYPE } from '@tayet/shared/internal'
import type * as Engine from '../src/acl/internal/data-export'
import type { DataExportPorts, ExportEventView } from '../src/acl/internal/data-export'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry } from '../src/acl'

// PLANO-EXPORT-DADOS §0.3.5 item 2: the gateway's card-author port reads only "not found" and "forbidden" as
// an unreadable card; any other server failure fails the export. The gateway's ports are captured (the engine
// is stubbed for the gateway), then the real engine runs with the gateway's cardAuthor and classify.

const captured: { ports?: DataExportPorts<unknown> } = {}
vi.mock('../src/acl/internal/data-export', async (actual) => ({
  ...(await actual<typeof Engine>()),
  runDataExport: (ports: DataExportPorts<unknown>) => {
    captured.ports = ports
    return (async function* () {})()
  },
}))
const { runDataExport } = await vi.importActual<typeof Engine>('../src/acl/internal/data-export')

const ME = '@me:tayet.local'
const ROOM = '!room:tayet.local'
const CARD = '$card:tayet.local'
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

async function gatewayPorts(serverError: MatrixError): Promise<DataExportPorts<unknown>> {
  const client = { getUserId: () => ME, getRoom: () => null, http: { authedRequest: async () => Promise.reject(serverError) } }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = client
  for await (const _ of gateway.exportMyData({ readme: 'r', unnamedAccess: 'u' })) void _
  return captured.ports!
}

function exportWith(gw: DataExportPorts<unknown>) {
  const content = { msgtype: APPROVAL_RESPONSE_MSGTYPE, body: 'Approve', 'm.relates_to': { rel_type: RESPONSE_REL_TYPE, event_id: CARD } }
  const answer: ExportEventView = { id: '$a:tayet.local', type: 'm.room.encrypted', sentAt: 100, redacted: false, wire: content, content, folded: 'response' }
  const ports: DataExportPorts<ExportEventView> = {
    hold: () => () => {},
    alive: () => true,
    conversations: () => [{ key: ROOM, channel: { id: ROOM, name: '#r', kind: 'private' } as unknown as Channel }],
    account: async () => ({ subject: { key: ME, name: 'Me', kind: 'member' }, profile: { fullName: 'Me' }, accesses: [], agents: [] }),
    page: async () => ({ events: [answer] }),
    decrypt: async () => {},
    view: (e) => e,
    translate: () => null as Message | null,
    cardAuthor: (key, card, signal) => gw.cardAuthor(key, card, signal),
    person: () => ({ name: 'Helper', kind: 'agent' }),
    media: async () => new Blob([]),
    mediaType: () => undefined,
    classify: (err) => gw.classify(err),
    now: () => 0,
    sleep: async () => {},
  }
  return (async () => {
    const files: Record<string, string> = {}
    for await (const p of runDataExport(ports, { readme: 'r', unnamedAccess: 'u' })) if (p.t === 'file') files[p.path] = p.content
    return files
  })()
}

describe('data export — the card author port (§0.3.5 item 2)', () => {
  it('a card the server says is not found: the answer is unreadable', async () => {
    const files = await exportWith(await gatewayPorts(new MatrixError({ errcode: 'M_NOT_FOUND', error: 'not found' }, 404)))
    expect(JSON.parse(files['conversations/c1.json']!).items).toEqual([{ type: 'unreadable', id: 'm1', sentAt: new Date(100).toISOString() }])
  })

  it('any other server failure fails the export', async () => {
    const err = new MatrixError({ errcode: 'M_UNKNOWN', error: 'internal' }, 500)
    await expect(exportWith(await gatewayPorts(err))).rejects.toBe(err)
  })
})
