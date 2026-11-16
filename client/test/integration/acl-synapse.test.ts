import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, Channel } from '../../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'
import { HOMESERVER, synapseReachable, createRoom, sendText } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { admitToOrg } from '../support/org-membership'

// ── P1 gate #1 (PLANO-FASE-1-TRADUTORES §4.1): drive the REAL Fase 0 Synapse and assert that
// what crosses the barrel is pure domain — no protocol shapes in any user-facing field. The
// translators are exercised end-to-end against real /sync data, not a mock.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const FIXTURE_TEXT = 'hello from the integration fixture'

describe.skipIf(!SYNAPSE)('ACL ↔ Synapse (integration)', () => {
  let acl: Acl
  let channel: Channel
  const roomName = `tayet-int-${process.pid}-${Math.floor(Math.random() * 1e6)}`

  beforeAll(async () => {
    const [user] = await freshUsers(['syn'])
    const token = user.token
    await admitToOrg(token) // Role deriva de kind (ADR-083 dec. 4): fresco sem convite é guest.
    // Seed a deterministic room BEFORE connecting, so the initial sync includes it.
    const roomId = await createRoom(token, { name: roomName, topic: 'integration topic' })
    await sendText(token, roomId, FIXTURE_TEXT)

    acl = createAcl({
      mode: 'strict', // strict: any untranslatable concept throws (red test before shipping)
      telemetry: noopTelemetry,
      serverUrl: HOMESERVER,
    })
    await acl.connect(token as Parameters<Acl['connect']>[0])

    const channels = await acl.getChannels()
    const found = channels.find((c) => c.name === `#${roomName}`)
    if (!found) throw new Error(`fixture channel not found among ${channels.map((c) => c.name).join(', ')}`)
    channel = found
  }, 180_000)

  afterAll(async () => {
    await acl?.disconnect()
  })

  it('getChannels yields clean domain (name #-prefixed, no protocol leak)', async () => {
    const channels = await acl.getChannels()
    expect(channels.length).toBeGreaterThan(0)
    expect(channel.name).toBe(`#${roomName}`)
    expect(channel.kind).toBe('private')
    expect(channel.topic).toBe('integration topic')
    expect(findProtocolLeaks(channels)).toEqual([])
    // PR-β invariant (peer ⟺ dm): a non-DM channel never carries the DM-peer fields — asserted
    // structurally (`in`), not by value, so an explicit-undefined regression is caught too.
    for (const c of channels.filter((x) => x.kind !== 'dm')) {
      expect('peer' in c).toBe(false)
      expect('peerAvatar' in c).toBe(false)
    }
  })

  it('getChannel round-trips by opaque id', async () => {
    const again = await acl.getChannel(channel.id)
    expect(again.id).toBe(channel.id)
    expect(again.name).toBe(channel.name)
    expect(findProtocolLeaks(again)).toEqual([])
  })

  it('getMembers maps PL≥50→admin and never leaks protocol (display names clean)', async () => {
    // alice created the room → PL 100 → admin (the lossy PL→Role decision). Polled: her kind is read
    // from the org channel, which she joins right after the connect resolves (ADR-083 dec. 2).
    await vi.waitFor(
      async () => expect((await acl.getMembers(channel.id)).some((m) => m.role === 'admin')).toBe(true),
      { timeout: 30_000, interval: 100 },
    )
    const members = await acl.getMembers(channel.id)
    expect(members.length).toBeGreaterThan(0)
    expect(members.every((m) => ['admin', 'member', 'guest'].includes(m.role))).toBe(true)
    // roles are domain enums, never a numeric power level
    expect(members.every((m) => typeof m.role === 'string')).toBe(true)
    expect(findProtocolLeaks(members)).toEqual([])
  })

  it('getTimeline returns the text message as a clean text body', async () => {
    const page = await acl.getTimeline(channel.id)
    const texts = page.items.filter((m) => m.body.kind === 'text')
    expect(texts.some((m) => m.body.kind === 'text' && m.body.text === FIXTURE_TEXT)).toBe(true)
    expect(findProtocolLeaks(page.items)).toEqual([])
  })

  it('getDevices yields clean domain devices', async () => {
    const devices = await acl.getDevices()
    expect(devices.length).toBeGreaterThan(0)
    expect(findProtocolLeaks(devices)).toEqual([])
  })
})

// Always-present marker so the file is never an empty suite when Synapse is down.
describe('ACL ↔ Synapse (availability)', () => {
  it(SYNAPSE ? 'stack reachable — integration ran' : 'stack down — integration skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
