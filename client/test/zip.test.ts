import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 as zlibCrc32 } from 'node:zlib'
import { createZipWriter, crc32 } from '../src/ui/zip'
import { readZip } from './support/zip-reader'

// The data export's zip writer (PLANO-EXPORT-DADOS §0.3.6 items 13 and 14), read back by the tests' own
// reader and by the system's `unzip -t`, in the classic shape and in the ZIP64 one forced on a small
// archive (H3 of the screen PR).

async function bytesOf(blob: Blob): Promise<Buffer> {
  return Buffer.from(await blob.arrayBuffer())
}

// The system's unzip, which tests every entry's CRC. Its output is the evidence.
function unzipTest(zip: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'zip-test-'))
  try {
    const file = join(dir, 'a.zip')
    writeFileSync(file, zip)
    // A UTF-8 locale, or unzip prints the bit-11 names in the terminal's legacy charset.
    return execFileSync('unzip', ['-t', file], {
      encoding: 'utf8',
      env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const NAMES = ['README.txt', 'conversations/c1.json', 'attachments/c1/m2-relatório ção.pdf', 'empty.txt']

async function sample(forceZip64: boolean): Promise<{ zip: Buffer; binary: Buffer }> {
  const binary = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 31) & 0xff))
  const w = createZipWriter({ forceZip64, now: new Date(2026, 10, 14, 13, 45, 31) })
  await w.add(NAMES[0]!, 'Esta pasta é uma cópia.\n')
  await w.add(NAMES[1]!, '{\n  "a": 1\n}\n')
  await w.add(NAMES[2]!, new Blob([binary]))
  await w.add(NAMES[3]!, '')
  const blob = w.finish()
  expect(blob.type).toBe('application/zip')
  return { zip: await bytesOf(blob), binary }
}

describe('zip writer', () => {
  it('CRC-32 matches the known vectors and zlib, and resumes across slices', () => {
    const enc = new TextEncoder()
    expect(crc32(enc.encode(''))).toBe(0)
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(enc.encode('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339)
    const data = enc.encode('relatório de ação — ✓')
    expect(crc32(data)).toBe(zlibCrc32(data) >>> 0)
    expect(crc32(data.subarray(7), crc32(data.subarray(0, 7)))).toBe(crc32(data))
  })

  for (const forceZip64 of [false, true]) {
    const mode = forceZip64 ? 'ZIP64 forced' : 'classic'
    it(`${mode}: reads back text, Blob, an accented name and an empty entry, in order`, async () => {
      const { zip, binary } = await sample(forceZip64)
      const archive = readZip(zip)
      expect(archive.zip64).toBe(forceZip64)
      expect(archive.entries.map((e) => e.name)).toEqual(NAMES)
      expect(archive.entries.every((e) => e.zip64 === forceZip64)).toBe(true)
      const [readme, conv, pdf, empty] = archive.entries
      expect(readme!.data.toString('utf8')).toBe('Esta pasta é uma cópia.\n')
      expect(conv!.data.toString('utf8')).toBe('{\n  "a": 1\n}\n')
      expect(pdf!.data.equals(binary)).toBe(true)
      expect(empty!.data.length).toBe(0)
      expect(empty!.crc).toBe(0)
      // DOS date/time of the creation moment: 2026-11-14 13:45:30 (two-second resolution).
      expect(readme!.dosDate).toBe(((2026 - 1980) << 9) | (11 << 5) | 14)
      expect(readme!.dosTime).toBe((13 << 11) | (45 << 5) | 15)
    })

    it(`${mode}: the system's unzip -t passes every entry`, async () => {
      const { zip } = await sample(forceZip64)
      const out = unzipTest(zip)
      console.info(`[zip] unzip -t (${mode}):\n${out}`)
      expect(out).toMatch(/No errors detected/)
      for (const name of NAMES) expect(out).toContain(name)
    })
  }

  it('an empty archive is valid', async () => {
    const w = createZipWriter()
    const zip = await bytesOf(w.finish())
    expect(zip.length).toBe(22)
    expect(readZip(zip).entries).toEqual([])
  })

  it('reads a Blob larger than one 8 MiB slice for the CRC', async () => {
    const big = Buffer.alloc(8 * 1024 * 1024 + 5, 7)
    big[big.length - 1] = 9
    const w = createZipWriter()
    await w.add('big.bin', new Blob([big]))
    const [entry] = readZip(await bytesOf(w.finish())).entries
    expect(entry!.crc).toBe(zlibCrc32(big) >>> 0)
    expect(entry!.data.equals(big)).toBe(true)
  })

  it('adds run in call order even when not awaited one by one', async () => {
    const w = createZipWriter()
    await Promise.all([w.add('a', 'A'), w.add('b', new Blob(['B'])), w.add('c', 'C')])
    expect(readZip(await bytesOf(w.finish())).entries.map((e) => `${e.name}=${e.data.toString()}`)).toEqual([
      'a=A',
      'b=B',
      'c=C',
    ])
  })

  it('a Blob that cannot be read rejects its add; add after finish rejects; finish twice throws', async () => {
    const w = createZipWriter()
    const broken = new Blob(['x'])
    broken.slice = () => {
      throw new Error('gone')
    }
    await expect(w.add('broken', broken)).rejects.toThrow('gone')
    await w.add('ok', 'fine')
    expect(readZip(await bytesOf(w.finish())).entries.map((e) => e.name)).toEqual(['ok'])
    await expect(w.add('late', 'x')).rejects.toThrow()
    expect(() => w.finish()).toThrow()
  })
})
