import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { whoami } from '../../src/whoami'
import { startFakeServer, type FakeServer } from '../support/fake-server'

// Classification of the boot's whoami (rodada 2 do #333): only 401/403 are a refused credential;
// any other definitive answer is a server problem, never a reason to reissue.

let fake: FakeServer
beforeAll(async () => {
  fake = await startFakeServer()
})
afterAll(async () => {
  await fake.close()
})
const call = () => whoami(fake.url, 'tok', { deadlineMs: 1_000 })

describe('whoami', () => {
  it.each([
    ['ok', { kind: 'ok', userId: '@a-abcdefghijkl:fake.local', deviceId: 'FAKEDEV001' }],
    ['unknown-token', { kind: 'refused', status: 401, errcode: 'M_UNKNOWN_TOKEN' }],
    ['forbidden', { kind: 'refused', status: 403, errcode: 'M_FORBIDDEN' }],
    ['no-device', { kind: 'no-device', userId: '@a-abcdefghijkl:fake.local' }],
    ['not-found', { kind: 'bad-server', status: 404 }],
    ['html', { kind: 'bad-server', status: 200 }],
    ['no-user', { kind: 'bad-server', status: 200 }],
  ] as const)('%s', async (mode, expected) => {
    fake.set({ whoami: mode })
    expect(await call()).toEqual(expected)
  })
})
