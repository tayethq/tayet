import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// Guard for ADR-057 norm 1 by construction (addendum of 24/Nov/2026, issue #421). matrix-js-sdk
// 41.6.0's `invite` builds and uploads a history bundle (shareRoomHistoryWithUser) before the
// membership change whenever the room's visibility is `shared` (ours, norm 3). Every invite the ACL
// sends goes through the private `inviteDirect` of matrix-client.ts, a direct POST to the server.
// This test reproves any call to an `invite` method under src/acl, so a new call to the SDK verb
// cannot land. Allowed: the escrow's people client (`people.invite` / `people?.invite`), which
// provisions a person and is not the SDK. The walk reads the files directly (explicit path, no
// grep `--include`, CLAUDE.md tooling note), mirroring the fixture style of test/boundary.test.ts.

const ACL_DIR = fileURLToPath(new URL('../../src/acl', import.meta.url))
const CLIENT_DIR = fileURLToPath(new URL('../..', import.meta.url))

// `.invite(` (with optional `?.` and whitespace, also across a line break) or `['invite'](`.
const INVITE_CALL = /(\?\.|\.)\s*invite\s*\(|\[\s*['"`]invite['"`]\s*\]\s*\(/g
const ALLOWED_RECEIVER = /people\s*$/

export function sdkInviteCalls(source: string): number[] {
  const lines: number[] = []
  for (const match of source.matchAll(INVITE_CALL)) {
    const before = source.slice(0, match.index)
    if (ALLOWED_RECEIVER.test(before)) continue
    lines.push(before.split('\n').length)
  }
  return lines
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return tsFiles(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

describe('ADR-057 norm 1: no SDK invite under src/acl (addendum of 24/Nov/2026)', () => {
  it('src/acl has no call to an invite method outside inviteDirect', () => {
    const files = tsFiles(ACL_DIR)
    expect(files.length).toBeGreaterThan(0)
    const offenders = files.flatMap((file) =>
      sdkInviteCalls(readFileSync(file, 'utf8')).map((line) => `${relative(CLIENT_DIR, file)}:${line}`),
    )
    expect(offenders).toEqual([])
  })

  it('the helper exists and is the one direct invite', () => {
    const source = readFileSync(join(ACL_DIR, 'internal', 'matrix-client.ts'), 'utf8')
    expect(source).toContain('private async inviteDirect(')
    expect(source.match(/\/invite`/g) ?? []).toHaveLength(1)
  })

  describe('negative cases: the guard catches what it must', () => {
    it.each([
      ['the gateway client', 'await this.require().invite(roomId, custodian)\n'],
      ['a local client', 'await client.invite(roomId, custodian)\n'],
      ['optional chaining', 'await this.client?.invite(roomId, userId)\n'],
      ['split across lines', 'await client\n  .invite(roomId, userId)\n'],
      ['bracket access', "await client['invite'](roomId, userId)\n"],
    ])('%s is caught', (_label, code) => {
      expect(sdkInviteCalls(code)).not.toEqual([])
    })

    it.each([
      ['the escrow people client', 'await (this.people?.invite({ name, email, kind }) ?? fallback)\n'],
      ['the people client without optional chaining', 'await this.people.invite({ name })\n'],
      ['the helper', 'await this.inviteDirect(client, roomId, custodian)\n'],
      ['an invite member reading', "const rule = room.getJoinRule() === 'invite'\n"],
    ])('%s is not caught', (_label, code) => {
      expect(sdkInviteCalls(code)).toEqual([])
    })

    it('reports the line of the offending call', () => {
      expect(sdkInviteCalls('const a = 1\n\nawait client.invite(r, u)\n')).toEqual([3])
    })
  })
})
