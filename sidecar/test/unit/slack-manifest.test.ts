import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCli, USAGE, UsageError } from '../../src/args'
import { commandsOfManifest, declareAtBoot, readSlackManifest } from '../../src/slack-manifest'

// `--slack-manifest <file>` (PLANO-AGENTES §0.3.25 items 1–2; A4-3): the Slack app manifest's slash commands as the
// agent's declared set; out of the rules → a UsageError naming the entry's position and the rule, never the content.

let dir: string | undefined
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

const manifestOf = (slash_commands: unknown) => ({ display_information: { name: 'Deploy bot' }, features: { bot_user: { display_name: 'deploy' }, slash_commands } })
const refusal = (raw: unknown): string => {
  try {
    commandsOfManifest(raw)
    return 'accepted'
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError)
    return (err as Error).message
  }
}

describe('--slack-manifest: the flag', () => {
  const base = ['--server', 'https://chat.x', '--token', 't']
  it('optional; a file path; blank is a usage error; in the usage text', () => {
    expect(parseCli(base)).toMatchObject({ slackManifest: undefined })
    expect(parseCli([...base, '--slack-manifest', 'app.json'])).toMatchObject({ slackManifest: 'app.json' })
    expect(() => parseCli([...base, '--slack-manifest', ' '])).toThrow(UsageError)
    expect(() => parseCli([...base, '--slack-manifest'])).toThrow(UsageError)
    expect(USAGE).toContain('--slack-manifest')
  })
})

describe('--slack-manifest: the commands', () => {
  it('command → name without the slash, lowercase; description; usage_hint → hint (absent or blank → none)', () => {
    const out = commandsOfManifest(
      manifestOf([
        { command: '/Deploy', description: 'Publicar o build', usage_hint: '<ambiente>', url: 'https://x.example/cmd', should_escape: false },
        { command: '/status', description: ' O estado ', usage_hint: '  ' },
        { command: 'rollback', description: 'Voltar' },
      ]),
    )
    expect(out).toEqual({
      commands: [
        { name: 'deploy', description: 'Publicar o build', hint: '<ambiente>' },
        { name: 'status', description: 'O estado' },
        { name: 'rollback', description: 'Voltar' },
      ],
      cut: { descriptions: 0, hints: 0 },
    })
  })

  it('no features, no slash_commands, an empty list → the empty set', () => {
    for (const raw of [{}, { features: {} }, manifestOf([]), { features: { bot_user: {} } }]) expect(commandsOfManifest(raw)).toEqual({ commands: [], cut: { descriptions: 0, hints: 0 } })
  })

  it('a description over 100 or a hint over 60 is cut at the limit with an ellipsis, and counted', () => {
    const long = 'é'.repeat(140)
    const out = commandsOfManifest(manifestOf([
      { command: '/a', description: long, usage_hint: 'h'.repeat(61) },
      { command: '/b', description: 'x'.repeat(100), usage_hint: 'h'.repeat(60) },
      { command: '/c', description: 'y'.repeat(101) },
    ]))
    const [a, b, c] = out.commands
    expect([...a!.description]).toHaveLength(100)
    expect(a!.description).toBe('é'.repeat(99) + '…')
    expect(a!.hint).toBe('h'.repeat(59) + '…')
    expect(b).toEqual({ name: 'b', description: 'x'.repeat(100), hint: 'h'.repeat(60) })
    expect(c!.description).toBe('y'.repeat(99) + '…')
    expect(out.cut).toEqual({ descriptions: 2, hints: 1 })
  })

  it('each rule out → the position and the rule, never the content', () => {
    const secret = 'segredo-xyz'
    const cases: Array<[unknown, string]> = [
      ['not an object', 'the manifest is not a JSON object'],
      [[], 'the manifest is not a JSON object'],
      [{ features: 'x' }, 'features is not an object'],
      [{ features: { slash_commands: {} } }, 'features.slash_commands is not a list'],
      [manifestOf([{ command: '/ok', description: 'x' }, secret]), 'slash command 2 is not an object'],
      [manifestOf([{ description: secret }]), 'slash command 1: command is missing'],
      [manifestOf([{ command: `/${secret} x`, description: 'x' }]), 'slash command 1: the command must be'],
      [manifestOf([{ command: '/', description: 'x' }]), 'slash command 1: the command must be'],
      [manifestOf([{ command: `/${'a'.repeat(33)}`, description: 'x' }]), 'slash command 1: the command must be'],
      [manifestOf([{ command: '/pïng', description: 'x' }]), 'slash command 1: the command must be'],
      [manifestOf([{ command: '/a', description: 'x' }, { command: '/A', description: secret }]), 'slash command 2: the command repeats an earlier one'],
      [manifestOf([{ command: '/a' }]), 'slash command 1: description is missing'],
      [manifestOf([{ command: '/a', description: '   ' }]), 'slash command 1: description is missing'],
      [manifestOf([{ command: '/a', description: 'x', usage_hint: 5 }]), 'slash command 1: usage_hint is not text'],
      [manifestOf([{ command: '/a', description: 'x' }, { command: '/b', description: `${secret}\nline` }]), 'slash command 2: description and usage_hint must be one line each'],
      [manifestOf(Array.from({ length: 26 }, (_, i) => ({ command: `/c${i}`, description: 'x' }))), 'more than 25 slash commands'],
      [manifestOf(Array.from({ length: 25 }, (_, i) => ({ command: `/c${i}`, description: 'é'.repeat(100), usage_hint: 'é'.repeat(60) }))), 'the slash commands are over 8 KiB'],
    ]
    for (const [raw, rule] of cases) {
      const message = refusal(raw)
      expect(message, rule).toContain(`--slack-manifest: ${rule}`)
      expect(message).not.toContain(secret)
    }
    expect(commandsOfManifest(manifestOf(Array.from({ length: 25 }, (_, i) => ({ command: `/c${i}`, description: 'x' })))).commands).toHaveLength(25)
  })

  it('the leak-scan of the write (scanCommandsProbe): an id shape stops the boot; a word of the deny list passes', () => {
    const message = refusal(manifestOf([{ command: '/ok', description: 'x' }, { command: '/b', description: 'veja @alice:example.org' }]))
    expect(message).toBe('--slack-manifest: slash command 2: an internal identifier in the command, the description or the usage_hint')
    expect(message).not.toContain('example.org')
    expect(commandsOfManifest(manifestOf([{ command: '/verify', description: 'Verificar o cofre e o escrow', usage_hint: 'decrypt' }])).commands).toHaveLength(1)
  })
})

describe('--slack-manifest: the file', () => {
  it('JSON read; not JSON (YAML) or unreadable → a usage error without the content', async () => {
    const d = await mkdtemp(join(tmpdir(), 'slack-manifest-'))
    dir = d
    const json = join(d, 'app.json')
    await writeFile(json, JSON.stringify(manifestOf([{ command: '/deploy', description: 'Publicar' }])))
    expect(readSlackManifest(json).commands).toEqual([{ name: 'deploy', description: 'Publicar' }])
    const yaml = join(d, 'app.yaml')
    await writeFile(yaml, 'features:\n  slash_commands:\n    - command: /segredo\n      description: Publicar\n')
    expect(() => readSlackManifest(yaml)).toThrow('--slack-manifest: the file is not JSON (YAML is not accepted)')
    expect(() => readSlackManifest(join(d, 'missing.json'))).toThrow('--slack-manifest: the file cannot be read')
    expect(() => readSlackManifest(d)).toThrow('--slack-manifest: the file cannot be read')
  })
})

describe('--slack-manifest: the declaration at the boot (item 3)', () => {
  const fake = () => {
    const calls: Array<{ op: string; commands?: unknown }> = []
    let fail = false
    return {
      calls,
      failNext: () => (fail = true),
      core: {
        reconcile: () => calls.push({ op: 'reconcile' }),
        facade: {
          set: (commands: unknown) => {
            calls.push({ op: 'set', commands })
            return fail ? Promise.reject(new Error('stopped')) : Promise.resolve({ pending: 0 })
          },
          clear: () => Promise.resolve(null),
          get: () => ({ commands: [], pending: 0 }),
        },
      },
    }
  }

  it('without the flag: the stored set’s reconcile, as before; with it: the PUT path with the manifest’s set, one line with the count', async () => {
    const logs: Array<Record<string, unknown>> = []
    const a = fake()
    await declareAtBoot(a.core, undefined, (l) => logs.push(l))
    expect(a.calls).toEqual([{ op: 'reconcile' }])
    const b = fake()
    const set = [{ name: 'deploy', description: 'Publicar' }]
    await declareAtBoot(b.core, { commands: set, cut: { descriptions: 0, hints: 0 } }, (l) => logs.push(l))
    expect(b.calls).toEqual([{ op: 'set', commands: set }])
    expect(logs).toEqual([{ evt: 'slack-manifest-declared', commands: 1 }])
    const c = fake()
    c.failNext()
    await declareAtBoot(c.core, { commands: [], cut: { descriptions: 0, hints: 0 } }, (l) => logs.push(l))
    expect(logs.at(-1)).toEqual({ evt: 'slack-manifest-failed', name: 'Error' })
  })
})
