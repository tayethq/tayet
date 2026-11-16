import { describe, it, expect } from 'vitest'
import { parseCli, UsageError } from '../../src/args'
import { AGENT_LOCALPART, localpartOf } from '../../src/whoami'

describe('CLI (ADR-087 dec. 1)', () => {
  it('--server and --token; --store and --debug optional', () => {
    expect(parseCli(['--server', 'https://chat.x', '--token', 't0k'])).toEqual({
      help: false, server: 'https://chat.x', token: 't0k', store: undefined, debug: false,
      listen: { host: '127.0.0.1', port: 7878 }, rotateLocalToken: false,
    })
    expect(parseCli(['--server', 'https://chat.x', '--token', 't', '--store', '/s', '--debug'])).toMatchObject({ store: '/s', debug: true })
    expect(parseCli(['--help'])).toEqual({ help: true })
  })

  it('--listen host:port (IPv6 in brackets, port 0 = ephemeral) and --rotate-local-token (§0.3.6 adjs. 2, 8)', () => {
    const base = ['--server', 'https://chat.x', '--token', 't']
    expect(parseCli([...base, '--listen', '127.0.0.1:7879'])).toMatchObject({ listen: { host: '127.0.0.1', port: 7879 } })
    expect(parseCli([...base, '--listen', '[::1]:0'])).toMatchObject({ listen: { host: '::1', port: 0 } })
    expect(parseCli([...base, '--listen', '0.0.0.0:7878'])).toMatchObject({ listen: { host: '0.0.0.0', port: 7878 } })
    expect(parseCli([...base, '--rotate-local-token'])).toMatchObject({ rotateLocalToken: true })
  })

  it.each([
    [[]],
    [['--server', 'https://chat.x']],
    [['--token', 't']],
    [['--server', 'chat.x', '--token', 't']],
    [['--server', 'ftp://chat.x', '--token', 't']],
    [['--server', 'https://chat.x', '--token', 't', '--bogus']],
    [['--server', 'https://chat.x', '--token', 't', 'extra']],
    [['--server', 'https://chat.x', '--token', 't', '--listen', '7878']],
    [['--server', 'https://chat.x', '--token', 't', '--listen', 'localhost:99999']],
    [['--server', 'https://chat.x', '--token', 't', '--listen', ':7878']],
  ])('usage error: %j', (argv) => {
    expect(() => parseCli(argv)).toThrow(UsageError)
  })

  describe('TAYET_AGENT_TOKEN (§0.3.8 item 3)', () => {
    const server = ['--server', 'https://chat.x']
    it('only the variable: it is the credential', () => {
      expect(parseCli(server, { TAYET_AGENT_TOKEN: 'from-env' })).toMatchObject({ token: 'from-env' })
      expect(parseCli(server, { TAYET_AGENT_TOKEN: '  from-env\n' })).toMatchObject({ token: 'from-env' })
    })
    it('both present: --token wins', () => {
      expect(parseCli([...server, '--token', 'from-flag'], { TAYET_AGENT_TOKEN: 'from-env' })).toMatchObject({ token: 'from-flag' })
    })
    it('neither: usage error naming both', () => {
      expect(() => parseCli(server, {})).toThrow(new UsageError('missing --token (or TAYET_AGENT_TOKEN)'))
    })
    it.each([[''], ['   '], ['\t\n']])('variable empty or blank (%j): usage error', (value) => {
      expect(() => parseCli(server, { TAYET_AGENT_TOKEN: value })).toThrow(new UsageError('missing --token (or TAYET_AGENT_TOKEN)'))
    })
    it('a blank --token falls back to the variable', () => {
      expect(parseCli([...server, '--token', ' '], { TAYET_AGENT_TOKEN: 'from-env' })).toMatchObject({ token: 'from-env' })
    })
    it('the usage error never echoes the variable', () => {
      try {
        parseCli(['--bogus'], { TAYET_AGENT_TOKEN: 'secret-env-value' })
      } catch (err) {
        expect(String(err)).not.toContain('secret-env-value')
      }
    })
  })

  it('a usage error never echoes the token', () => {
    try {
      parseCli(['--token', 'secret-token-value', '--bogus'])
    } catch (err) {
      expect(String(err)).not.toContain('secret-token-value')
    }
  })
})

describe('agent localpart (ADR-086 dec. 1)', () => {
  it.each([
    ['@a-abcdefghijkl:x', true],
    ['@a-abcdefghijk1:x', false],
    ['@u-abcdefghijkl:x', false],
    ['@alice:x', false],
    ['@a-abcdefghijklm:x', false],
  ])('%s → %s', (userId, ok) => {
    expect(AGENT_LOCALPART.test(localpartOf(userId))).toBe(ok)
  })
})
