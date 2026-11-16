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

describe('--slack-actions-url', () => {
  const base = ['--server', 'https://chat.x', '--token', 't']
  it('absent → undefined', () => {
    expect(parseCli(base)).toMatchObject({ slackActionsUrl: undefined })
  })
  it.each([
    ['http://127.0.0.1:3000/slack/actions', 'http://127.0.0.1:3000/slack/actions'],
    ['http://localhost:3000/slack/actions', 'http://localhost:3000/slack/actions'],
    ['http://[::1]:3000/slack/actions', 'http://[::1]:3000/slack/actions'],
    ['http://127.0.0.2:8080/', 'http://127.0.0.2:8080/'],
    ['  http://127.0.0.1:3000/x  ', 'http://127.0.0.1:3000/x'],
  ])('accepted: %s', (value, href) => {
    expect(parseCli([...base, '--slack-actions-url', value])).toMatchObject({ slackActionsUrl: href })
  })
  it.each([
    ['https://127.0.0.1:3000/slack/actions', '--slack-actions-url must be http (the destination is on this machine)'],
    ['ftp://127.0.0.1/x', '--slack-actions-url must be http (the destination is on this machine)'],
    ['http://govern.example.com/slack/actions', '--slack-actions-url must point at this machine (127.0.0.1, ::1 or localhost)'],
    ['http://10.0.0.5:3000/slack/actions', '--slack-actions-url must point at this machine (127.0.0.1, ::1 or localhost)'],
    ['http://127.example.com/slack/actions', '--slack-actions-url must point at this machine (127.0.0.1, ::1 or localhost)'],
    ['http://0.0.0.0:3000/', '--slack-actions-url must point at this machine (127.0.0.1, ::1 or localhost)'],
    ['', '--slack-actions-url needs a URL'],
    ['   ', '--slack-actions-url needs a URL'],
    ['not a url', '--slack-actions-url is not a URL'],
    ['127.0.0.1:3000/slack/actions', '--slack-actions-url is not a URL'],
    ['http://user:pw@127.0.0.1:3000/', '--slack-actions-url must not carry credentials'],
  ])('refused: %j', (value, message) => {
    expect(() => parseCli([...base, '--slack-actions-url', value])).toThrow(new UsageError(message))
  })
  it('the usage error names the rule, never the value', () => {
    try {
      parseCli([...base, '--slack-actions-url', 'https://secret-host-value.example/x'])
      expect.unreachable()
    } catch (err) {
      expect(String(err)).not.toContain('secret-host-value')
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
