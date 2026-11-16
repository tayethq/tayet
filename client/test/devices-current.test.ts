import { describe, it, expect } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry } from '../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'

// P1 boundary assert for Device.current (§8.A3). Mirrors current-user.test.ts: a UNIT harness with
// a fake SDK client (no Synapse, runs in CI). getDevices() derives `current` inside the ACL by
// comparing each device_id against the session's own (client.getDeviceId()) — the SAME shape as
// Message.mine. Only the boolean + the opaque id (ADR-008 residual, skipped by the scanner) cross;
// the raw device_id never becomes renderable.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const MY = '@dev:DEVICEMINE'
const OTHER = '@dev:DEVICEOTHER'

function gatewayWith(
  myDeviceId: string | null,
  sdkDevices: Array<{ device_id: string; display_name?: string }>,
): MatrixGateway {
  const fakeClient = {
    getDeviceId: () => myDeviceId,
    getDevices: async () => ({ devices: sdkDevices }),
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  return gateway
}

describe('Device.current — fronteira P1 (§8.A3)', () => {
  it('current=true só pro acesso próprio; nenhum vazamento de protocolo', async () => {
    const devices = await gatewayWith(MY, [
      { device_id: MY, display_name: 'Notebook' },
      { device_id: OTHER, display_name: 'Celular' },
    ]).getDevices()

    expect(devices.find((d) => d.friendlyName === 'Notebook')!.current).toBe(true)
    expect(devices.find((d) => d.friendlyName === 'Celular')!.current).toBe(false)
    // Só o booleano + o id opaco (residual ADR-008, pulado pelo scanner) cruzam. Nada de device_id
    // cru renderizável.
    expect(findProtocolLeaks(devices)).toEqual([])
  })

  it('getDeviceId null → ninguém é current (degradação graciosa, espelha mine)', async () => {
    const devices = await gatewayWith(null, [{ device_id: 'X', display_name: 'X' }]).getDevices()
    expect(devices.every((d) => !d.current)).toBe(true)
  })
})
