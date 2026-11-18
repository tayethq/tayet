import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MatrixError, Method } from 'matrix-js-sdk'
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'
import {
  readAcknowledged,
  ACKNOWLEDGED_DEVICES_KEY,
  LEGACY_ACKNOWLEDGED_DEVICES_KEY,
} from '../src/acl/internal/acknowledged-devices'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import {
  addPendingRecognition,
  readPendingRecognitions,
  PENDING_RECOGNITIONS_CAP,
} from '../src/acl/internal/pending-recognitions'
import { brandAccessId, accessIdToRaw } from '@tayet/shared/internal'
import * as barrel from '../src/acl'
import type { DomainEvent, Device, AccessId, AclTelemetry, Timestamp } from '../src/acl'

// Unit coverage for the ADR-018 contract (commit 3): the union member, the read-union-write of
// the recognized set, AccessId opacity, the exhaustiveness guard, and the surface invariant that
// the account-data key never crosses the barrel. The detection-against-the-real-service variable
// is the integration gate's job (commit 5), not here.

const dev = (id: string, friendlyName: string): Device => ({ id: id as Device['id'], friendlyName, current: false })

describe('account.newAccess — union member (ADR-018 §2.1)', () => {
  it('is a valid DomainEvent with access/device/at, no channelId', () => {
    const e: DomainEvent = {
      t: 'account.newAccess',
      access: brandAccessId('ABCDEFGHIJ'),
      device: dev('ABCDEFGHIJ', 'iPhone de Ana'),
      at: 1_700_000_000_000 as Timestamp,
    }
    expect(e.t).toBe('account.newAccess')
    // It is an ACCOUNT event — it carries no channelId (global stream only).
    expect('channelId' in e).toBe(false)
    if (e.t === 'account.newAccess') {
      expect(e.device.friendlyName).toBe('iPhone de Ana')
      expect(typeof e.at).toBe('number')
    }
  })

  it('is handled by an exhaustive switch over DomainEvent (fail-closed guard)', () => {
    // If a future change drops account.newAccess or adds a member without a case, tsc fails here
    // (assertNever). This is the compile-time exhaustiveness guard the union extension exercises.
    const assertNever = (x: never): never => {
      throw new Error(`unhandled DomainEvent: ${JSON.stringify(x)}`)
    }
    const kindOf = (e: DomainEvent): 'channel' | 'account' | 'connection' | 'user' => {
      switch (e.t) {
        case 'message.received':
        case 'message.edited':
        case 'message.removed':
        case 'message.status':
        case 'reaction.changed':
        case 'channel.changed':
        case 'channel.added':
        case 'channel.removed':
        case 'member.changed':
        case 'content.unsupported':
        case 'panels.changed':
        case 'commands.changed':
        case 'form.opened':
        case 'form.changed':
          return 'channel'
        case 'connection.changed':
          return 'connection'
        // ADR-074 dec. 4: search.state is the state of the account's local search index — channel-less.
        case 'device.attention':
        case 'account.newAccess':
        case 'account.accessRecognized':
        case 'search.state':
        case 'people.changed':
          return 'account'
        // ADR-056: global per-person fact — channel-less like the account bucket, but about
        // ANOTHER user, not this account.
        case 'user.presence':
          return 'user'
        default:
          return assertNever(e)
      }
    }
    const e: DomainEvent = {
      t: 'account.newAccess',
      access: brandAccessId('DEV1'),
      device: dev('DEV1', 'Laptop'),
      at: 1 as Timestamp,
    }
    expect(kindOf(e)).toBe('account')
  })
})

describe('AccessId opacity (ADR-008 / ADR-018)', () => {
  it('round-trips the underlying device id without parsing it', () => {
    // The runtime value IS the device id, branded — a pure re-brand both ways.
    const deviceId = 'GHIJKLMNOP'
    const access: AccessId = brandAccessId(deviceId)
    expect(accessIdToRaw(access)).toBe(deviceId)
  })

  it('is skipped by the leak-scan even when its value carries protocol shape', () => {
    // `access` (and the opaque `id`) may legitimately be protocol-shaped (ADR-008 residual). The
    // scan must skip them yet still inspect friendlyName — proven by the negative case below.
    const clean: DomainEvent = {
      t: 'account.newAccess',
      access: brandAccessId('@spoof:tayet.local'),
      device: dev('!spoofed:tayet.local', 'Ana — iPhone'),
      at: 1 as Timestamp,
    }
    expect(findProtocolLeaks(clean)).toEqual([])

    // Negative control: a protocol term in friendlyName (a NON-opaque field) DOES leak — proving
    // the scan is live, not vacuously green.
    const dirty: DomainEvent = {
      t: 'account.newAccess',
      access: brandAccessId('DEV2'),
      device: dev('DEV2', 'megolm session backup'),
      at: 1 as Timestamp,
    }
    expect(findProtocolLeaks(dirty).length).toBeGreaterThan(0)
  })
})

describe('recognized set — reading the persisted value (ADR-018 §4 / PF-2)', () => {
  it('reads an absent or malformed value as the empty set', () => {
    expect(readAcknowledged(undefined).size).toBe(0)
    expect(readAcknowledged(null).size).toBe(0)
    expect(readAcknowledged({}).size).toBe(0)
    expect(readAcknowledged({ devices: 'nope' }).size).toBe(0)
    expect(readAcknowledged({ devices: [1, 'OK', null] })).toEqual(new Set(['OK']))
  })
})

describe('account-data key never crosses the barrel (surface invariant)', () => {
  it('is not reachable from any barrel export', () => {
    // The key is a protocol detail confined to acl/internal — the public surface must not expose
    // it (neither as an export name nor as a runtime value).
    expect(ACKNOWLEDGED_DEVICES_KEY).toBe('io.tayet.acknowledged_devices')
    const names = Object.keys(barrel)
    const keys = [ACKNOWLEDGED_DEVICES_KEY, LEGACY_ACKNOWLEDGED_DEVICES_KEY]
    expect(names.some((n) => /acknowledged/i.test(n) || keys.some((k) => n.includes(k)))).toBe(false)
    const runtimeValues = Object.values(barrel).filter((v) => typeof v === 'string') as string[]
    expect(runtimeValues).not.toContain(ACKNOWLEDGED_DEVICES_KEY)
    // The legacy key is just as internal: it never crosses the barrel either.
    expect(runtimeValues).not.toContain(LEGACY_ACKNOWLEDGED_DEVICES_KEY)
  })
})

describe('legacy acknowledged-devices key (namespace rename)', () => {
  // The recognized set moved to the io.tayet.* namespace. Accounts that acknowledged accesses
  // before the rename only have the legacy key: the read is the UNION of both keys, the write
  // goes to the current key only, and the legacy key is never written nor deleted.
  const noopTelemetry: AclTelemetry = { untranslated: () => {} }

  function gatewayWith(accountData: Map<string, unknown>) {
    const writes: Array<{ type: string; content: unknown; method: unknown; keepAlive: unknown }> = []
    const fakeClient = {
      getUserId: () => '@u:tayet.local',
      getAccountData: (type: string) => {
        const content = accountData.get(type)
        return content === undefined ? undefined : { getContent: () => content }
      },
      // The write goes through the SDK's http-api (setAccountDataRaw's path), not setAccountData (§8.30).
      http: {
        authedRequest: async (method: unknown, path: string, _q: unknown, content: unknown, opts?: { keepAlive?: boolean }) => {
          const type = decodeURIComponent(path.split('/account_data/')[1] ?? '')
          writes.push({ type, content, method, keepAlive: opts?.keepAlive })
          accountData.set(type, content)
          return {}
        },
      },
    }
    const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
    ;(gateway as unknown as { client: unknown }).client = fakeClient
    const internals = gateway as unknown as { loadAcknowledged(): void; acknowledgedDevices: Set<string> }
    return { gateway, internals, writes }
  }

  it('legacy-only content is recognized on load', () => {
    const data = new Map<string, unknown>([[LEGACY_ACKNOWLEDGED_DEVICES_KEY, { devices: ['DEV_OLD'] }]])
    const { internals } = gatewayWith(data)
    internals.loadAcknowledged()
    expect(internals.acknowledgedDevices).toEqual(new Set(['DEV_OLD']))
  })

  it('a new acknowledgement writes the union to the current key only; the legacy key is untouched', async () => {
    const data = new Map<string, unknown>([[LEGACY_ACKNOWLEDGED_DEVICES_KEY, { devices: ['DEV_OLD'] }]])
    const { gateway, internals, writes } = gatewayWith(data)
    internals.loadAcknowledged()
    gateway.acknowledgeAccess(brandAccessId('DEV_NEW'))
    await new Promise((r) => setTimeout(r, 0)) // persistAcknowledged is fire-and-forget

    expect(writes.map((w) => w.type)).toEqual([ACKNOWLEDGED_DEVICES_KEY])
    expect(new Set((data.get(ACKNOWLEDGED_DEVICES_KEY) as { devices: string[] }).devices)).toEqual(
      new Set(['DEV_OLD', 'DEV_NEW']),
    )
    expect(data.get(LEGACY_ACKNOWLEDGED_DEVICES_KEY)).toEqual({ devices: ['DEV_OLD'] })

    // A cold start re-reads both keys: the union still holds every acknowledged access.
    const cold = gatewayWith(data)
    cold.internals.loadAcknowledged()
    expect(cold.internals.acknowledgedDevices).toEqual(new Set(['DEV_OLD', 'DEV_NEW']))
  })

  // §8.30: "Fui eu, dispensar" followed at once by a reload or a close killed the write with the page
  // (the next boot re-announced the access). The PUT goes with keepalive so it outlives the unload.
  it('the acknowledgement PUT goes with keepAlive, to the current key', async () => {
    const data = new Map<string, unknown>()
    const { gateway, internals, writes } = gatewayWith(data)
    internals.loadAcknowledged()
    gateway.acknowledgeAccess(brandAccessId('DEV_NEW'))
    await new Promise((r) => setTimeout(r, 0))

    expect(writes).toEqual([
      { type: ACKNOWLEDGED_DEVICES_KEY, content: { devices: ['DEV_NEW'] }, method: Method.Put, keepAlive: true },
    ])
  })

  it('both keys present → union (current-only and legacy-only entries both survive)', () => {
    expect(readAcknowledged({ devices: ['A'] }, { devices: ['B', 7] })).toEqual(new Set(['A', 'B']))
  })
})

describe('account.accessRecognized — the recognized set is the account\'s (ADR-063)', () => {
  // Fake client for the detection path: own device list, synced account-data cache, the server copy
  // of the keys behind http.authedRequest, and the AccountData listener the ACL wires.
  const noopTelemetry: AclTelemetry = { untranslated: () => {} }
  const ME = 'DEV_ME'

  function detectionWith(opts: { devices: string[]; cache?: string[]; server?: string[] | 'fail' }) {
    const listeners = new Map<string, Array<(...a: unknown[]) => void>>()
    const serverReads: string[] = []
    const fakeClient = {
      getUserId: () => '@u:tayet.local',
      getDeviceId: () => ME,
      getDevices: async () => ({ devices: opts.devices.map((device_id) => ({ device_id })) }),
      getAccountData: (type: string) =>
        type === ACKNOWLEDGED_DEVICES_KEY && opts.cache ? { getContent: () => ({ devices: opts.cache }) } : undefined,
      http: {
        authedRequest: async (_m: unknown, path: string) => {
          serverReads.push(path)
          if (opts.server === 'fail') throw new Error('network')
          if (path.endsWith(encodeURIComponent(ACKNOWLEDGED_DEVICES_KEY)) && opts.server) return { devices: opts.server }
          throw new MatrixError({ errcode: 'M_NOT_FOUND', error: 'not found' })
        },
      },
      on: (ev: string, fn: (...a: unknown[]) => void) => listeners.set(ev, [...(listeners.get(ev) ?? []), fn]),
      off: () => {},
    }
    const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
    ;(gateway as unknown as { client: unknown }).client = fakeClient
    const events: DomainEvent[] = []
    gateway.subscribe((e) => events.push(e))
    const start = () =>
      (gateway as unknown as { startAccessDetection(c: unknown): Promise<void> }).startAccessDetection(fakeClient)
    const accountData = (type: string, devices: string[]) =>
      (listeners.get('accountData') ?? []).forEach((fn) => fn({ getType: () => type, getContent: () => ({ devices }) }))
    const kinds = () => events.map((e) => e.t)
    return { gateway, events, start, accountData, kinds, serverReads }
  }

  it('retracts a notice when the account-data set grows with that access (another session dismissed it)', async () => {
    const d = detectionWith({ devices: [ME, 'DEV_B'] })
    await d.start()
    expect(d.kinds()).toEqual(['account.newAccess'])
    d.accountData(ACKNOWLEDGED_DEVICES_KEY, ['DEV_B'])
    expect(d.events[1]).toEqual({ t: 'account.accessRecognized', access: brandAccessId('DEV_B') })
    // Exactly once: the echo of the same set changes nothing.
    d.accountData(ACKNOWLEDGED_DEVICES_KEY, ['DEV_B'])
    expect(d.kinds()).toEqual(['account.newAccess', 'account.accessRecognized'])
  })

  it('the legacy key counts too', async () => {
    const d = detectionWith({ devices: [ME, 'DEV_B'] })
    await d.start()
    d.accountData(LEGACY_ACKNOWLEDGED_DEVICES_KEY, ['DEV_B'])
    expect(d.kinds()).toEqual(['account.newAccess', 'account.accessRecognized'])
  })

  it('does not emit for an access this session never announced, and stops announcing it', async () => {
    const d = detectionWith({ devices: [ME] })
    await d.start()
    d.accountData(ACKNOWLEDGED_DEVICES_KEY, ['DEV_C'])
    expect(d.events).toEqual([])
  })

  it('this session\'s own dismissal does not echo back as a retraction', async () => {
    const d = detectionWith({ devices: [ME, 'DEV_B'] })
    await d.start()
    d.gateway.acknowledgeAccess(brandAccessId('DEV_B'))
    d.accountData(ACKNOWLEDGED_DEVICES_KEY, ['DEV_B'])
    expect(d.kinds()).toEqual(['account.newAccess'])
  })

  it('ignores other account-data keys', async () => {
    const d = detectionWith({ devices: [ME, 'DEV_B'] })
    await d.start()
    d.accountData('m.direct', ['DEV_B'])
    expect(d.kinds()).toEqual(['account.newAccess'])
  })

  it('boot reads the server copy: a stale synced cache does not re-announce a dismissed access (§8.23)', async () => {
    const d = detectionWith({ devices: [ME, 'DEV_B'], cache: [], server: ['DEV_B'] })
    await d.start()
    expect(d.events).toEqual([])
  })

  it('boot reads the server copy once even with nothing to announce (ADR-063, adendo); the legacy key is never re-read', async () => {
    const quiet = detectionWith({ devices: [ME, 'DEV_C'], cache: ['DEV_C'], server: ['DEV_C'] })
    await quiet.start()
    expect(quiet.serverReads).toHaveLength(1)
    expect(quiet.serverReads[0]).toContain(encodeURIComponent(ACKNOWLEDGED_DEVICES_KEY))
    const pending = detectionWith({ devices: [ME, 'DEV_B'], server: ['DEV_B'] })
    await pending.start()
    expect(pending.serverReads).toHaveLength(1)
    expect(pending.serverReads[0]).toContain(encodeURIComponent(ACKNOWLEDGED_DEVICES_KEY))
  })

  it('an account with no recognized set yet (server 404) still announces', async () => {
    const d = detectionWith({ devices: [ME, 'DEV_B'] })
    await d.start()
    expect(d.kinds()).toEqual(['account.newAccess'])
  })

  it('server read failing keeps the cache read (benign re-notification, never a hidden access)', async () => {
    const d = detectionWith({ devices: [ME, 'DEV_B', 'DEV_C'], cache: ['DEV_C'], server: 'fail' })
    await d.start()
    expect(d.events.map((e) => (e.t === 'account.newAccess' ? accessIdToRaw(e.access) : e.t))).toEqual(['DEV_B'])
  })
})

describe('the write\'s base is the in-memory set, serialized and coalesced (ADR-063, adendo; §8.31)', () => {
  // Fake client: own device list, synced cache, the server copy behind http.authedRequest (GET, which
  // can be held to model a pending boot read), PUTs recorded and optionally held (an in-flight write),
  // and the listeners the ACL wires (AccountData, DevicesUpdated).
  const noopTelemetry: AclTelemetry = { untranslated: () => {} }
  const ME = 'DEV_ME'
  const tick = () => new Promise((r) => setTimeout(r, 0))

  function harness(opts: { devices: string[]; cache?: string[]; server?: string[] | 'fail'; holdRead?: boolean; holdPuts?: boolean }) {
    let devices = opts.devices
    const listeners = new Map<string, Array<(...a: unknown[]) => void>>()
    const puts: string[][] = []
    const heldPuts: Array<() => void> = []
    let releaseRead: (() => void) | undefined
    let deviceListReads = 0
    const serverGet = async () => {
      if (opts.server === 'fail') throw new Error('network')
      if (opts.server) return { devices: opts.server }
      throw new MatrixError({ errcode: 'M_NOT_FOUND', error: 'not found' })
    }
    const fakeClient = {
      getUserId: () => '@u:tayet.local',
      getDeviceId: () => ME,
      getDevices: async () => {
        deviceListReads++
        return { devices: devices.map((device_id) => ({ device_id })) }
      },
      getAccountData: (type: string) =>
        type === ACKNOWLEDGED_DEVICES_KEY && opts.cache ? { getContent: () => ({ devices: opts.cache }) } : undefined,
      http: {
        authedRequest: async (method: unknown, _path: string, _q: unknown, body?: { devices: string[] }, ro?: { keepAlive?: boolean }) => {
          if (method === Method.Put) {
            expect(ro?.keepAlive).toBe(true)
            puts.push([...body!.devices].sort())
            if (opts.holdPuts) await new Promise<void>((r) => heldPuts.push(r))
            return {}
          }
          if (opts.holdRead) await new Promise<void>((r) => (releaseRead = r))
          return serverGet()
        },
      },
      on: (ev: string, fn: (...a: unknown[]) => void) => listeners.set(ev, [...(listeners.get(ev) ?? []), fn]),
      off: () => {},
    }
    const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
    ;(gateway as unknown as { client: unknown }).client = fakeClient
    const events: DomainEvent[] = []
    gateway.subscribe((e) => events.push(e))
    const start = () =>
      (gateway as unknown as { startAccessDetection(c: unknown): Promise<void> }).startAccessDetection(fakeClient)
    const emit = (ev: string, ...args: unknown[]) => (listeners.get(ev) ?? []).forEach((fn) => fn(...args))
    return {
      gateway,
      events,
      start,
      puts,
      ack: (id: string) => gateway.acknowledgeAccess(brandAccessId(id)),
      echo: (devices: string[]) =>
        emit('accountData', { getType: () => ACKNOWLEDGED_DEVICES_KEY, getContent: () => ({ devices }) }),
      devicesUpdated: (next: string[]) => {
        devices = next
        emit(CryptoEvent.DevicesUpdated, ['@u:tayet.local'])
      },
      releaseRead: () => releaseRead?.(),
      releasePut: () => heldPuts.shift()?.(),
      deviceListReads: () => deviceListReads,
    }
  }

  it('a stale synced cache is not the base: the PUT carries what the boot read found on the server', async () => {
    const h = harness({ devices: [ME, 'DEV_B'], cache: [], server: ['DEV_X'] })
    await h.start()
    h.ack('DEV_B')
    await tick()
    expect(h.puts).toEqual([['DEV_B', 'DEV_X']])
  })

  it('sync echoes join the base', async () => {
    const h = harness({ devices: [ME, 'DEV_B'], server: [] })
    await h.start()
    h.echo(['DEV_E'])
    h.ack('DEV_B')
    await tick()
    expect(h.puts).toEqual([['DEV_B', 'DEV_E']])
  })

  it('the server read runs on every boot, even with nothing to announce (path A)', async () => {
    const h = harness({ devices: [ME], cache: [], server: ['DEV_GONE'] })
    await h.start()
    await tick()
    h.devicesUpdated([ME, 'DEV_Y'])
    await tick()
    h.ack('DEV_Y')
    await tick()
    expect(h.puts).toEqual([['DEV_GONE', 'DEV_Y']])
  })

  it('one PUT in flight; acknowledgements during it coalesce into ONE more PUT with the whole set (path B)', async () => {
    const h = harness({ devices: [ME, 'DEV_B', 'DEV_C', 'DEV_D'], server: [], holdPuts: true })
    await h.start()
    h.ack('DEV_B')
    await tick()
    h.ack('DEV_C')
    h.ack('DEV_D')
    await tick()
    expect(h.puts).toEqual([['DEV_B']])
    h.releasePut()
    await tick()
    expect(h.puts).toEqual([['DEV_B'], ['DEV_B', 'DEV_C', 'DEV_D']])
    h.releasePut()
    await tick()
    expect(h.puts).toHaveLength(2)
  })

  // §8.38 D1 (T2): the DevicesUpdated scan used to announce from the stale cache while the boot read
  // was pending (the "third path" of §8.31, kept then as a benign side effect). Deterministic: the boot
  // GET is held until the scan has run, then released.
  it('a DevicesUpdated scan with a candidate waits for the pending boot read: nothing is announced before it (§8.38 D1)', async () => {
    const h = harness({ devices: [ME], cache: [], server: ['DEV_B'], holdRead: true })
    void h.start()
    await tick()
    h.devicesUpdated([ME, 'DEV_B'])
    await tick()
    await tick()
    expect(h.deviceListReads(), 'precondition: the DevicesUpdated scan ran').toBe(2)
    expect(h.events).toEqual([])
    h.releaseRead()
    await tick()
    await tick()
    // DEV_B was already recognized on the server: no notice, so no retraction either.
    expect(h.events).toEqual([])
  })

  it('the same wait for an access the server lacks: announced once the read settles; the write waits for it too', async () => {
    const h = harness({ devices: [ME], cache: [], server: ['DEV_X'], holdRead: true })
    void h.start()
    await tick()
    h.devicesUpdated([ME, 'DEV_B'])
    await tick()
    expect(h.events).toEqual([])
    h.releaseRead()
    await tick()
    await tick()
    expect(h.events.map((e) => e.t)).toEqual(['account.newAccess'])
    h.ack('DEV_B')
    await tick()
    expect(h.puts).toEqual([['DEV_B', 'DEV_X']])
  })

  it('no candidate, no wait: a DevicesUpdated scan with nothing new returns while the boot read is pending', async () => {
    const h = harness({ devices: [ME], cache: ['DEV_B'], server: ['DEV_B'], holdRead: true })
    void h.start()
    await tick()
    h.devicesUpdated([ME, 'DEV_B'])
    await tick()
    expect(h.deviceListReads()).toBe(2)
    expect(h.events).toEqual([])
  })

  it('a failed boot read degrades without blocking: the write goes with the set as it is', async () => {
    const h = harness({ devices: [ME, 'DEV_B'], cache: ['DEV_C'], server: 'fail' })
    await h.start()
    h.ack('DEV_B')
    await tick()
    expect(h.puts).toEqual([['DEV_B', 'DEV_C']])
  })

  it('short-circuit compares with what this session knows is on the server, not with the cache', async () => {
    const known = harness({ devices: [ME], server: ['DEV_B'] })
    await known.start()
    known.ack('DEV_B')
    await tick()
    expect(known.puts).toEqual([])
    // Same cache content, but the server copy is unknown (read failed): the write goes.
    const unknown = harness({ devices: [ME], cache: ['DEV_B'], server: 'fail' })
    await unknown.start()
    unknown.ack('DEV_B')
    await tick()
    expect(unknown.puts).toEqual([['DEV_B']])
  })
})

describe('pending dismissals bridge a reload (ADR-063, adendo 2; §8.38 D2)', () => {
  // localStorage of a browser, Map-backed (the unit environment is Node, where there is none).
  class MemoryStorage implements Storage {
    private m = new Map<string, string>()
    get length() {
      return this.m.size
    }
    clear() {
      this.m.clear()
    }
    getItem(k: string) {
      return this.m.get(k) ?? null
    }
    key(i: number) {
      return [...this.m.keys()][i] ?? null
    }
    removeItem(k: string) {
      this.m.delete(k)
    }
    setItem(k: string, v: string) {
      this.m.set(k, v)
    }
  }
  const noopTelemetry: AclTelemetry = { untranslated: () => {} }
  const ME = 'DEV_ME'
  const USER = '@u:tayet.local'
  const tick = () => new Promise((r) => setTimeout(r, 0))
  let storage: MemoryStorage
  beforeEach(() => {
    storage = new MemoryStorage()
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
  })
  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage
  })

  function harness(opts: { devices: string[]; cache?: string[]; server?: string[] | 'fail'; holdRead?: boolean; failPuts?: boolean }) {
    let devices = opts.devices
    const listeners = new Map<string, Array<(...a: unknown[]) => void>>()
    const puts: string[][] = []
    let releaseRead: (() => void) | undefined
    const fakeClient = {
      getUserId: () => USER,
      getDeviceId: () => ME,
      getDevices: async () => ({ devices: devices.map((device_id) => ({ device_id })) }),
      getAccountData: (type: string) =>
        type === ACKNOWLEDGED_DEVICES_KEY && opts.cache ? { getContent: () => ({ devices: opts.cache }) } : undefined,
      http: {
        authedRequest: async (method: unknown, _path: string, _q: unknown, body?: { devices: string[] }) => {
          if (method === Method.Put) {
            puts.push([...body!.devices].sort())
            if (opts.failPuts) throw new MatrixError({ errcode: 'M_UNKNOWN', error: 'boom' })
            return {}
          }
          if (opts.holdRead) await new Promise<void>((r) => (releaseRead = r))
          if (opts.server === 'fail') throw new Error('network')
          if (opts.server) return { devices: opts.server }
          throw new MatrixError({ errcode: 'M_NOT_FOUND', error: 'not found' })
        },
      },
      on: (ev: string, fn: (...a: unknown[]) => void) => listeners.set(ev, [...(listeners.get(ev) ?? []), fn]),
      off: () => {},
      // signOut's teardown
      getAccessToken: () => 'tok',
      getRefreshToken: () => undefined,
      getCrypto: () => undefined,
      stopClient: () => {},
      clearStores: async () => {},
    }
    const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
    ;(gateway as unknown as { client: unknown }).client = fakeClient
    const events: DomainEvent[] = []
    gateway.subscribe((e) => events.push(e))
    const emit = (ev: string, ...args: unknown[]) => (listeners.get(ev) ?? []).forEach((fn) => fn(...args))
    return {
      gateway,
      events,
      puts,
      start: () => (gateway as unknown as { startAccessDetection(c: unknown): Promise<void> }).startAccessDetection(fakeClient),
      ack: (id: string) => gateway.acknowledgeAccess(brandAccessId(id)),
      echo: (devs: string[]) => emit('accountData', { getType: () => ACKNOWLEDGED_DEVICES_KEY, getContent: () => ({ devices: devs }) }),
      devicesUpdated: (next: string[]) => {
        devices = next
        emit(CryptoEvent.DevicesUpdated, [USER])
      },
      releaseRead: () => releaseRead?.(),
    }
  }

  it('the dismissal is recorded synchronously, before the PUT leaves', async () => {
    const h = harness({ devices: [ME, 'DEV_B'], server: [] })
    await h.start()
    h.ack('DEV_B')
    expect(readPendingRecognitions(USER)).toEqual(['DEV_B'])
    expect(h.puts).toEqual([]) // the PUT is fire-and-forget: not out yet in this tick
    await tick()
    expect(h.puts).toEqual([['DEV_B']])
  })

  it('the key name carries no protocol term and not the account id', () => {
    addPendingRecognition(USER, 'DEV_B')
    const key = storage.key(0)!
    expect(key).toMatch(/^tayet\.pending-recognitions\.[0-9a-f]{8}$/)
    expect(key).not.toContain(USER)
  })

  // T1, unit side: the previous page's PUT has not landed — the server read does not have the access.
  it('boot: a pending dismissal the server lacks is not announced, and is written again after the boot read', async () => {
    addPendingRecognition(USER, 'DEV_B')
    const h = harness({ devices: [ME, 'DEV_B'], cache: [], server: ['DEV_X'] })
    await h.start()
    await tick()
    await tick()
    expect(h.events).toEqual([])
    expect(h.puts).toEqual([['DEV_B', 'DEV_X']])
  })

  it('boot: the pending list covers the DevicesUpdated scan too, before the boot read', async () => {
    addPendingRecognition(USER, 'DEV_B')
    const h = harness({ devices: [ME], cache: [], server: [], holdRead: true })
    void h.start()
    await tick()
    h.devicesUpdated([ME, 'DEV_B'])
    await tick()
    h.releaseRead()
    await tick()
    await tick()
    expect(h.events).toEqual([])
  })

  it('an entry leaves the list when the server read contains it (and no PUT is needed)', async () => {
    addPendingRecognition(USER, 'DEV_B')
    const h = harness({ devices: [ME, 'DEV_B'], server: ['DEV_B'] })
    await h.start()
    await tick()
    expect(readPendingRecognitions(USER)).toEqual([])
    expect(h.puts).toEqual([])
  })

  it('an entry leaves the list when a sync echo contains it', async () => {
    const h = harness({ devices: [ME, 'DEV_B', 'DEV_C'], server: [] })
    await h.start()
    h.ack('DEV_B')
    h.ack('DEV_C')
    h.echo(['DEV_B'])
    expect(readPendingRecognitions(USER)).toEqual(['DEV_C'])
  })

  it('a failed PUT keeps the entry; the next boot writes it again', async () => {
    const first = harness({ devices: [ME, 'DEV_B'], server: [], failPuts: true })
    await first.start()
    first.ack('DEV_B')
    await tick()
    expect(readPendingRecognitions(USER)).toEqual(['DEV_B'])
    const next = harness({ devices: [ME, 'DEV_B'], server: [] })
    await next.start()
    await tick()
    await tick()
    expect(next.events).toEqual([])
    expect(next.puts).toEqual([['DEV_B']])
  })

  it('a hint, never the truth: the list only adds, nothing it holds removes an access', async () => {
    addPendingRecognition(USER, 'DEV_B')
    const h = harness({ devices: [ME, 'DEV_B', 'DEV_C'], cache: ['DEV_C'], server: ['DEV_C'] })
    await h.start()
    await tick()
    await tick()
    expect(h.events).toEqual([])
    expect(h.puts).toEqual([['DEV_B', 'DEV_C']])
  })

  it(`the list is capped at ${PENDING_RECOGNITIONS_CAP}, oldest dropped`, () => {
    for (let i = 0; i < PENDING_RECOGNITIONS_CAP + 6; i++) addPendingRecognition(USER, `D${i}`)
    const list = readPendingRecognitions(USER)
    expect(list).toHaveLength(PENDING_RECOGNITIONS_CAP)
    expect(list[0]).toBe('D6')
    expect(list.at(-1)).toBe(`D${PENDING_RECOGNITIONS_CAP + 5}`)
  })

  it('storage unavailable: the dismissal still goes to the server (behaviour before the list)', async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      get() {
        throw new Error('SecurityError')
      },
      configurable: true,
    })
    const h = harness({ devices: [ME, 'DEV_B'], server: [] })
    await h.start()
    h.ack('DEV_B')
    await tick()
    expect(h.puts).toEqual([['DEV_B']])
  })

  // T4
  it('sign-out wipes the pending list', async () => {
    const h = harness({ devices: [ME, 'DEV_B'], server: [], failPuts: true })
    await h.start()
    h.ack('DEV_B')
    await tick()
    expect(readPendingRecognitions(USER)).toEqual(['DEV_B'])
    await h.gateway.signOut()
    expect(storage.length).toBe(0)
  })
})
