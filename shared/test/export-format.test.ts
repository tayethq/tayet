// Open data export format v1 (ADR-096 dec. 2, 3, 4, 5, 7 and 8).
//
// Golden example: the builder's output for the fixed inputs in export-golden-input.ts is compared byte
// for byte with test/fixtures/export-v1/<case>/. Besides the files the builder returns, each case holds
// `attachment-paths.txt`: the paths the builder handed back for bytes the caller writes (one per line).
// To rewrite the fixtures after an intended format change, run from shared/:
//
//   UPDATE_EXPORT_GOLDEN=1 npx vitest run test/export-format.test.ts
//
// and review the diff: a change in those bytes is a change in the public format. Copy the changed files
// of the complete case into the example of EXPORT-FORMAT.md; the last test checks they match verbatim.

import { beforeAll, describe, it, expect } from 'vitest'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findProtocolLeaksInText } from '../src/leak-scan'
import {
  createExportBuilder,
  EXPORT_FORMAT_VERSION,
  InvalidExportError,
  readExportManifest,
  sanitizeExportFileName,
  UnsupportedExportVersionError,
  type ExportConversationFile,
  type ExportManifest,
} from '../src'
import { COMPLETE, MINIMAL, keysOf, runExport, type GoldenInput, type GoldenOutput } from './export-golden-input'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'export-v1')
const UPDATE = process.env.UPDATE_EXPORT_GOLDEN === '1'
const CASES: [string, GoldenInput][] = [
  ['complete', COMPLETE],
  ['minimal', MINIMAL],
]

function asTree(out: GoldenOutput): Map<string, string> {
  const tree = new Map<string, string>()
  for (const f of out.files) tree.set(f.path, f.content)
  tree.set('attachment-paths.txt', out.attachmentPaths.join('\n') + '\n')
  return tree
}

function readTree(root: string): Map<string, string> {
  const tree = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else tree.set(relative(root, full).split('\\').join('/'), readFileSync(full, 'utf8'))
    }
  }
  walk(root)
  return tree
}

function files(out: GoldenOutput): Record<string, string> {
  return Object.fromEntries(out.files.map((f) => [f.path, f.content]))
}

describe('golden example', () => {
  for (const [name, input] of CASES) {
    it(`${name}: the output matches test/fixtures/export-v1/${name}/ byte for byte`, () => {
      const produced = asTree(runExport(input))
      const dir = join(FIXTURES, name)
      if (UPDATE) {
        rmSync(dir, { recursive: true, force: true })
        for (const [path, content] of produced) {
          mkdirSync(dirname(join(dir, path)), { recursive: true })
          writeFileSync(join(dir, path), content)
        }
      }
      const golden = readTree(dir)
      expect([...produced.keys()].sort()).toEqual([...golden.keys()].sort())
      for (const [path, content] of produced) expect(content, path).toBe(golden.get(path))
    })
  }

  it('the complete case covers every item type and both profile shapes', () => {
    const out = files(runExport(COMPLETE))
    const types = new Set<string>()
    for (const [path, content] of Object.entries(out)) {
      if (!path.startsWith('conversations/')) continue
      for (const item of (JSON.parse(content) as ExportConversationFile).items) types.add(item.type)
    }
    expect([...types].sort()).toEqual(['approvalResponse', 'deleted', 'message', 'unreadable', 'unsupported'])
    const manifest = JSON.parse(out['manifest.json']!) as ExportManifest
    expect(manifest.conversations.map((c) => c.kind).sort()).toEqual(['dm', 'group', 'private', 'public'])
    expect(Object.keys(JSON.parse(files(runExport(MINIMAL))['account.json']!).profile)).toEqual(['fullName'])
  })
})

describe('items', () => {
  const out = files(runExport(COMPLETE))
  const c1 = JSON.parse(out['conversations/c1.json']!) as ExportConversationFile
  const byText = (text: string) => c1.items.find((i) => i.type === 'message' && i.text === text)

  it('a thread root or replied-to message of the person in the file is referenced; another\'s is only flagged', () => {
    const root = byText('Abro uma thread para o orçamento.')!
    expect(byText('Primeiro número: dentro do previsto.')).toMatchObject({ inThread: true, threadRoot: root.id, isReply: false })
    const other = byText('Concordo com a proposta.')!
    expect(other).toMatchObject({ inThread: true, isReply: false })
    expect(other).not.toHaveProperty('threadRoot')
    const replyOther = byText('Pode ser na quinta.')!
    expect(replyOther).toMatchObject({ inThread: false, isReply: true })
    expect(replyOther).not.toHaveProperty('replyTo')
    expect(byText('Corrigindo: na sexta.')).toMatchObject({ isReply: true, replyTo: replyOther.id })
  })

  it('a deleted marker carries id and send time only', () => {
    const deleted = c1.items.find((i) => i.type === 'deleted')!
    expect(Object.keys(deleted)).toEqual(['type', 'id', 'sentAt'])
  })

  it('items come in ascending send time, ties keep the input order', () => {
    const b = createExportBuilder({ ...MINIMAL.start })
    const w = b.openConversation({ key: 'k', name: 'n', kind: 'private' })
    w.add({ type: 'message', key: 'late', sentAt: 2000, text: 'late' })
    w.add({ type: 'message', key: 'tie-a', sentAt: 1000, text: 'a' })
    w.add({ type: 'message', key: 'tie-b', sentAt: 1000, text: 'b' })
    const items = (JSON.parse(w.close().content) as ExportConversationFile).items
    expect(items.map((i) => (i.type === 'message' ? i.text : ''))).toEqual(['a', 'b', 'late'])
  })

  it('misuse fails without echoing a key', () => {
    const key = '@u-abcdefghij23:tayet.local'
    const b = createExportBuilder({ ...MINIMAL.start })
    const w = b.openConversation({ key, name: 'n', kind: 'private' })
    w.add({ type: 'deleted', key, sentAt: 1 })
    const errors: unknown[] = []
    for (const run of [
      () => w.add({ type: 'deleted', key, sentAt: 2 }),
      () => b.openConversation({ key, name: 'n', kind: 'private' }),
      () => b.finish('texto'),
    ]) {
      try {
        run()
      } catch (e) {
        errors.push(e)
      }
    }
    expect(errors).toHaveLength(3)
    for (const e of errors) expect(String((e as Error).message)).not.toContain(key)
    w.close()
    expect(() => w.add({ type: 'deleted', key: 'other', sentAt: 3 })).toThrow()
    b.finish('texto')
    expect(() => b.openConversation({ key: 'x', name: 'n', kind: 'private' })).toThrow()
  })
})

describe('determinism', () => {
  it('two runs over the same input give the same bytes', () => {
    for (const [, input] of CASES) expect(runExport(input)).toEqual(runExport(input))
  })

  it('the key order of rich nodes in the input does not change the bytes', () => {
    const run = (rich: unknown) => {
      const b = createExportBuilder({ ...MINIMAL.start })
      const w = b.openConversation({ key: 'k', name: 'n', kind: 'private' })
      w.add({ type: 'message', key: 'm', sentAt: 1, text: 'x', rich: rich as never })
      return w.close().content
    }
    expect(run([{ children: [{ text: 'x', t: 'text' }], t: 'p' }])).toBe(run([{ t: 'p', children: [{ t: 'text', text: 'x' }] }]))
  })

  it('every JSON file is two-space indented with one final newline', () => {
    for (const f of runExport(COMPLETE).files) {
      expect(f.content.endsWith('\n') && !f.content.endsWith('\n\n'), f.path).toBe(true)
      if (f.path.endsWith('.json')) expect(f.content, f.path).toBe(JSON.stringify(JSON.parse(f.content), null, 2) + '\n')
    }
  })
})

describe('no key in the output', () => {
  for (const [name, input] of CASES) {
    it(`${name}: no file carries a protocol shape or any input key`, () => {
      const out = runExport(input)
      const keys = keysOf(input)
      expect(keys.length).toBeGreaterThan(0)
      for (const content of [...out.files.map((f) => f.content), ...out.attachmentPaths]) {
        expect(findProtocolLeaksInText(content)).toEqual([])
        for (const key of keys) expect(content.includes(key)).toBe(false)
      }
    })
  }
})

describe('counts', () => {
  for (const [name, input] of CASES) {
    it(`${name}: the manifest counts match the items, per conversation and in the totals`, () => {
      const out = files(runExport(input))
      const manifest = JSON.parse(out['manifest.json']!) as ExportManifest
      const sum = { conversations: 0, messages: 0, deleted: 0, attachments: 0, gaps: 0 }
      for (const entry of manifest.conversations) {
        const { items } = JSON.parse(out[entry.file]!) as ExportConversationFile
        const expected = {
          messages: items.filter((i) => i.type === 'message' || i.type === 'approvalResponse').length,
          deleted: items.filter((i) => i.type === 'deleted').length,
          attachments: items.filter((i) => i.type === 'message' && i.attachment?.file !== undefined).length,
          gaps:
            items.filter((i) => i.type === 'unreadable').length +
            items.filter((i) => i.type === 'message' && i.attachment?.missing === true).length,
        }
        expect({ messages: entry.messages, deleted: entry.deleted, attachments: entry.attachments, gaps: entry.gaps }).toEqual(expected)
        sum.conversations += 1
        sum.messages += expected.messages
        sum.deleted += expected.deleted
        sum.attachments += expected.attachments
        sum.gaps += expected.gaps
      }
      expect(manifest.totals).toEqual(sum)
    })
  }

  it('every conversation has a file, even with no item', () => {
    const out = files(runExport(COMPLETE))
    const manifest = JSON.parse(out['manifest.json']!) as ExportManifest
    for (const entry of manifest.conversations) expect(out[entry.file], entry.file).toBeDefined()
    expect(manifest.conversations.find((c) => c.name === 'geral')).toMatchObject({ messages: 0, deleted: 0, attachments: 0, gaps: 0 })
  })
})

describe('sanitizeExportFileName', () => {
  it('strips path separators', () => {
    expect(sanitizeExportFileName('../../etc/passwd')).toBe('etcpasswd')
    expect(sanitizeExportFileName('a\\b/c.txt')).toBe('abc.txt')
  })

  it('strips control characters', () => {
    expect(sanitizeExportFileName('re\u0000la\u001ftó\u007fri\u0085o.pdf')).toBe('relatório.pdf')
  })

  it('strips the characters Windows reserves, and leading or trailing dots and spaces', () => {
    expect(sanitizeExportFileName('a<b>c:d"e|f?g*h.txt')).toBe('abcdefgh.txt')
    expect(sanitizeExportFileName('  nota.txt. ')).toBe('nota.txt')
  })

  it('cuts a long name to 100 characters keeping the extension', () => {
    const out = sanitizeExportFileName('a'.repeat(300) + '.pdf')
    expect(Array.from(out)).toHaveLength(100)
    expect(out.endsWith('.pdf')).toBe(true)
    const emoji = sanitizeExportFileName('😀'.repeat(150) + '.png')
    expect(Array.from(emoji)).toHaveLength(100)
    expect(emoji.endsWith('😀.png')).toBe(true)
  })

  it('an empty name becomes `file`, with the extension of a known media type', () => {
    expect(sanitizeExportFileName('', 'application/pdf')).toBe('file.pdf')
    expect(sanitizeExportFileName('///', 'image/png; charset=binary')).toBe('file.png')
    expect(sanitizeExportFileName('', 'application/x-unknown')).toBe('file')
  })

  it('normalizes decomposed Unicode to NFC', () => {
    const decomposed = 'relato\u0301rio.pdf'
    expect(sanitizeExportFileName(decomposed)).toBe('relat\u00f3rio.pdf')
  })
})

describe('readExportManifest', () => {
  // Read lazily: in update mode the golden test above writes the file first.
  let golden = ''
  beforeAll(() => {
    golden = readFileSync(join(FIXTURES, 'complete', 'manifest.json'), 'utf8')
  })

  it('accepts the golden example', () => {
    const manifest = readExportManifest(golden)
    expect(manifest).toEqual(JSON.parse(golden))
  })

  it('refuses a wrong format', () => {
    const wrong = JSON.stringify({ ...JSON.parse(golden), format: 'other' })
    expect(() => readExportManifest(wrong)).toThrow(InvalidExportError)
    expect(() => readExportManifest('not json')).toThrow(InvalidExportError)
  })

  it('refuses a newer version with its own error', () => {
    const newer = JSON.stringify({ ...JSON.parse(golden), formatVersion: EXPORT_FORMAT_VERSION + 1 })
    expect(() => readExportManifest(newer)).toThrow(UnsupportedExportVersionError)
  })

  it('ignores unknown fields', () => {
    const base = JSON.parse(golden) as ExportManifest & Record<string, unknown>
    const extended = {
      ...base,
      origin: 'future',
      conversations: base.conversations.map((c) => ({ ...c, pinned: true })),
      totals: { ...base.totals, reactions: 4 },
    }
    expect(readExportManifest(JSON.stringify(extended))).toEqual(base)
  })

  it('refuses a malformed known field', () => {
    const bad = JSON.stringify({ ...JSON.parse(golden), totals: { conversations: -1 } })
    expect(() => readExportManifest(bad)).toThrow(InvalidExportError)
  })
})

describe('README', () => {
  it('the README text is required and not empty', () => {
    expect(() => runExport(MINIMAL, '')).toThrow()
    expect(() => runExport(MINIMAL, '  \n')).toThrow()
    expect(files(runExport(MINIMAL, 'texto'))['README.txt']).toBe('texto\n')
  })
})

describe('EXPORT-FORMAT.md', () => {
  it('the example in the format document is the golden example, verbatim', () => {
    const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'EXPORT-FORMAT.md'), 'utf8')
    const golden = readTree(join(FIXTURES, 'complete'))
    golden.delete('attachment-paths.txt')
    for (const [path, content] of golden) {
      const lang = path.endsWith('.json') ? 'json' : 'text'
      expect(doc.includes('### `' + path + '`\n\n```' + lang + '\n' + content + '```\n'), path).toBe(true)
    }
  })
})
