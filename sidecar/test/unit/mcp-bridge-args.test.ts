import { describe, it, expect } from 'vitest'
import { UsageError, USAGE } from '../../src/args'
import { parseBridgeCli } from '../../src/mcp/args'

// `tayet-agent mcp --store <dir> [--listen <host:port>]` (S-g2, PLANO-AGENTES §0.3.13 item 5).
describe('mcp args', () => {
  it('--store is mandatory', () => {
    expect(() => parseBridgeCli([])).toThrow(new UsageError('missing --store'))
    expect(() => parseBridgeCli(['--store', '  '])).toThrow(UsageError)
  })

  it('--store alone: no listen override', () => {
    expect(parseBridgeCli(['--store', '/tmp/agent'])).toEqual({ store: '/tmp/agent', listen: undefined })
  })

  it('--listen overrides the URL of api.json', () => {
    expect(parseBridgeCli(['--store', '/s', '--listen', '127.0.0.1:7900'])).toEqual({ store: '/s', listen: { host: '127.0.0.1', port: 7900 } })
    expect(() => parseBridgeCli(['--store', '/s', '--listen', 'nope'])).toThrow(new UsageError('--listen must be host:port'))
  })

  it('the daemon flags and positionals are refused', () => {
    expect(() => parseBridgeCli(['--store', '/s', '--token', 'x'])).toThrow(UsageError)
    expect(() => parseBridgeCli(['--store', '/s', 'extra'])).toThrow(UsageError)
  })

  it('the daemon USAGE names the subcommand', () => {
    expect(USAGE).toContain('tayet-agent mcp --store <dir> [--listen <host:port>]')
  })
})
