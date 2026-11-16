// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { createAcl } from '../../src/acl'
import type { Acl, AccessId, AclTelemetry, DomainEvent } from '../../src/acl'
import { NewAccessBanner } from '../../src/ui/components/NewAccessBanner'
import { findProtocolLeaks, findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { HOMESERVER, synapseReachable, mintToken, whoami, whoamiDevice } from '../support/synapse'
import { registerUser } from '../support/escrow-harness'

// ── Gate de integração da fatia D2 (PLANO-FASE-2-D2 §5.2) — asserts 1–6. ────────────────────
// Stack Synapse/MAS real. A variável NOVEL é a detecção do delta de device list do PRÓPRIO
// usuário contra o serviço real: segundo login aparece, dispara exatamente um evento,
// auto-exclusão do self, reconhecer silencia o cold start. Usuário FRESCO por run (register-user
// browserless) para um mundo virgem de account data. Auto-skip sem a stack (PF-3 / issue #7).
// SEM escrow (D2 é independente de D1) e, por fileParallelism:false (vite.config), NUNCA
// concorrente com o gate do escrow (lição de D1).

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

type NewAccessEvent = Extract<DomainEvent, { t: 'account.newAccess' }>
const newAccessFor = (events: DomainEvent[], deviceId: string): NewAccessEvent[] =>
  events.filter(
    (e): e is NewAccessEvent =>
      e.t === 'account.newAccess' && String((e as NewAccessEvent).device.id) === deviceId,
  )

async function until<T>(get: () => T | undefined | Promise<T | undefined>, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 150))
  }
}

const authed = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } })

describe.skipIf(!SYNAPSE)('gate D2 — notificação passiva de novo acesso (§5.2, asserts 1–6)', () => {
  const suffix = `${process.pid}${Math.floor(Math.random() * 1e6)}`
  const userA = `d2a${suffix}`

  const instances: Array<Pick<Acl, 'disconnect'>> = []
  const track = (events: DomainEvent[]) => (e: DomainEvent) => events.push(e)

  let mxidA: string
  let tokenA1: string
  let aliceA: Acl
  const aEvents: DomainEvent[] = []

  // Read the persisted recognized set straight from the server (external observation), so a cold
  // start is only triggered once the acknowledgement has actually been echoed over /sync.
  const acknowledgedOnServer = async (): Promise<Set<string>> => {
    const res = await fetch(
      `${HOMESERVER}/_matrix/client/v3/user/${encodeURIComponent(mxidA)}/account_data/io.tayet.acknowledged_devices`,
      authed(tokenA1),
    )
    if (res.status !== 200) return new Set()
    const body = (await res.json()) as { devices?: unknown }
    return new Set(Array.isArray(body.devices) ? body.devices.filter((d): d is string => typeof d === 'string') : [])
  }

  beforeAll(async () => {
    registerUser(userA)
    tokenA1 = await mintToken(userA)
    mxidA = await whoami(tokenA1)

    aliceA = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await aliceA.connect(tokenA1 as Parameters<Acl['connect']>[0])
    instances.push(aliceA)
    aliceA.subscribe(track(aEvents))
  }, 240_000)

  afterAll(async () => {
    for (const i of instances.splice(0)) {
      try {
        await i.disconnect()
      } catch {
        /* best-effort */
      }
    }
  }, 60_000)

  it('1. segundo acesso dispara exatamente um evento, com o device de B e `at` plausível', async () => {
    const tokenB = await mintToken(userA)
    const deviceB = await whoamiDevice(tokenB)
    const aliceB = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await aliceB.connect(tokenB as Parameters<Acl['connect']>[0])
    instances.push(aliceB)

    const ev = await until(() => newAccessFor(aEvents, deviceB)[0])
    // A's only non-self device is B → exactly one new-access event total, and it is B's.
    expect(newAccessFor(aEvents, deviceB).length).toBe(1)
    expect(aEvents.filter((e) => e.t === 'account.newAccess').length).toBe(1)
    expect(typeof ev.device.friendlyName).toBe('string')
    // `at` is the observed instant of the entry — recent, not in the future.
    const at = ev.at as unknown as number
    expect(at).toBeLessThanOrEqual(Date.now())
    expect(at).toBeGreaterThan(Date.now() - 600_000)
  })

  it('2. auto-exclusão do self: B não recebe account.newAccess do PRÓPRIO device', async () => {
    const tokenB2 = await mintToken(userA)
    const deviceB2 = await whoamiDevice(tokenB2)
    const bEvents: DomainEvent[] = []
    const aliceB2 = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await aliceB2.connect(tokenB2 as Parameters<Acl['connect']>[0])
    instances.push(aliceB2)
    aliceB2.subscribe(track(bEvents))

    // B2 will (correctly) notify about OTHER unacknowledged devices; wait for its scan to produce
    // something, then assert it never fired for its OWN device.
    await until(() => (bEvents.some((e) => e.t === 'account.newAccess') ? true : undefined))
    expect(newAccessFor(bEvents, deviceB2)).toEqual([])
  })

  it('3. reconhecer silencia o cold start: A reconhece o device e um cold start não re-emite', async () => {
    // Pick a device A has been notified about and acknowledge it via the FROZEN verb (the AccessId
    // runtime value IS the device id — ADR-018). Then wait for the server to reflect it.
    const target = aEvents.find((e): e is NewAccessEvent => e.t === 'account.newAccess')!
    const targetDevice = String(target.device.id)
    aliceA.acknowledgeAccess(target.access)
    await until(async () => ((await acknowledgedOnServer()).has(targetDevice) ? true : undefined))

    // Cold start = a fresh login of A. It re-reads the recognized set BEFORE the first delta, so it
    // must NOT re-emit for the acknowledged device (it MAY emit for still-unacknowledged ones).
    const tokenA3 = await mintToken(userA)
    const a3Events: DomainEvent[] = []
    const aliceA3 = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await aliceA3.connect(tokenA3 as Parameters<Acl['connect']>[0])
    instances.push(aliceA3)
    aliceA3.subscribe(track(a3Events))

    // Positive signal that A3's scan ran: it notifies about some OTHER unacknowledged device.
    await until(() => (a3Events.some((e) => e.t === 'account.newAccess') ? true : undefined))
    expect(newAccessFor(a3Events, targetDevice)).toEqual([])
  })

  it('4. cold start virgem não re-notifica em massa: todos os devices reconhecidos → zero eventos', async () => {
    // Acknowledge EVERY current device of the account (self of the acknowledging session is already
    // excluded; the rest are recognized here), then a brand-new session must emit ZERO. Acknowledge
    // SEQUENTIALLY, waiting for each to land on the server before the next — the precondition is set
    // up one write at a time. (Concurrent writes of one session no longer clobber: they are serialized
    // and coalesced, ADR-063 adendo — proven in acl-ack-union-base.test.ts.)
    const all = await aliceA.getDevices()
    for (const d of all) {
      const id = String(d.id)
      aliceA.acknowledgeAccess(id as unknown as AccessId)
      await until(async () => ((await acknowledgedOnServer()).has(id) ? true : undefined))
    }

    const tokenA4 = await mintToken(userA)
    const a4Events: DomainEvent[] = []
    const aliceA4 = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await aliceA4.connect(tokenA4 as Parameters<Acl['connect']>[0])
    instances.push(aliceA4)
    aliceA4.subscribe(track(a4Events))

    // Wait until A4 sees the full device list (so its baseline scan had the real data), then settle
    // and assert it emitted no new-access at all — every pre-existing device was acknowledged and
    // its own device is self-excluded.
    await until(async () => ((await aliceA4.getDevices()).length >= all.length ? true : undefined))
    await new Promise((r) => setTimeout(r, 3_000))
    expect(a4Events.filter((e) => e.t === 'account.newAccess')).toEqual([])
  })

  it('5. P1 no barrel: nenhum account.newAccess que cruzou o barrel carrega forma de protocolo', () => {
    const events = aEvents.filter((e) => e.t === 'account.newAccess')
    expect(events.length).toBeGreaterThan(0)
    for (const e of events) expect(findProtocolLeaks(e)).toEqual([])
  })

  it('6. P1 no DOM (render-scan): o banner renderiza limpo e o AccessId não aparece na tela', () => {
    const ev = aEvents.find((e): e is NewAccessEvent => e.t === 'account.newAccess')!
    const { container } = render(
      <NewAccessBanner
        accesses={[{ access: ev.access, friendlyName: ev.device.friendlyName }]}
        onDismiss={() => {}}
      />,
    )
    expect(container.textContent ?? '').toContain('Novo acesso à sua conta')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
    // The opaque AccessId is returned to acknowledgeAccess only — it never reaches the DOM.
    expect(container.innerHTML).not.toContain(String(ev.access))
    cleanup()
  })
})
