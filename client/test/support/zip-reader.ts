import { crc32 } from 'node:zlib'

// A zip reader for the tests of the data export (PLANO-EXPORT-DADOS §0.3.6 item 14): Node only, no
// dependency, used by the unit tests and by the browser E2E. It reads what the writer (src/ui/zip.ts)
// promises and fails loudly on anything else: stored entries, UTF-8 names (bit 11), no data descriptor,
// the classic end record or the ZIP64 one with its locator. Every entry is read through the central
// directory AND its local header, which must agree; the CRC is checked against Node's zlib.crc32.

export interface ZipEntry {
  name: string
  data: Buffer
  crc: number
  /** The entry carries the ZIP64 extra field. */
  zip64: boolean
  /** DOS date and time of the central header. */
  dosDate: number
  dosTime: number
}

export interface ZipArchive {
  entries: ZipEntry[]
  /** The archive ends with the ZIP64 end record and locator. */
  zip64: boolean
}

const MAX16 = 0xffff
const MAX32 = 0xffffffff

function fail(message: string): never {
  throw new Error(`zip-reader: ${message}`)
}

function u64(buf: Buffer, at: number): number {
  const v = buf.readBigUInt64LE(at)
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) fail('64-bit value out of range')
  return Number(v)
}

// The ZIP64 extended information extra field (0x0001), holding only the fields that are 0xFFFFFFFF in
// the header, in the order uncompressed size, compressed size, local header offset (APPNOTE 4.5.3).
function zip64Extra(extra: Buffer, want: { size: boolean; csize: boolean; offset: boolean }) {
  for (let at = 0; at + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(at)
    const len = extra.readUInt16LE(at + 2)
    if (id === 0x0001) {
      let p = at + 4
      const out: { size?: number; csize?: number; offset?: number } = {}
      const next = (): number => {
        if (p + 8 > at + 4 + len) fail('short ZIP64 extra field')
        const v = u64(extra, p)
        p += 8
        return v
      }
      if (want.size) out.size = next()
      if (want.csize) out.csize = next()
      if (want.offset) out.offset = next()
      return out
    }
    at += 4 + len
  }
  return undefined
}

export function readZip(buf: Buffer): ZipArchive {
  let eocd = -1
  for (let at = buf.length - 22; at >= Math.max(0, buf.length - 22 - MAX16); at--) {
    if (buf.readUInt32LE(at) === 0x06054b50) {
      eocd = at
      break
    }
  }
  if (eocd < 0) fail('no end of central directory record')
  if (buf.readUInt16LE(eocd + 20) !== 0) fail('archive comment')
  let count = buf.readUInt16LE(eocd + 10)
  let cdSize = buf.readUInt32LE(eocd + 12)
  let cdOffset = buf.readUInt32LE(eocd + 16)
  if (buf.readUInt16LE(eocd + 8) !== count) fail('entries on this disk differ from the total')

  const locator = eocd - 20
  const zip64 = locator >= 0 && buf.readUInt32LE(locator) === 0x07064b50
  if (zip64) {
    const end = u64(buf, locator + 8)
    if (buf.readUInt32LE(end) !== 0x06064b50) fail('ZIP64 locator does not point at the ZIP64 end record')
    if (u64(buf, end + 4) !== 44) fail('ZIP64 end record size')
    if (end + 56 !== locator) fail('ZIP64 end record is not right before its locator')
    count = u64(buf, end + 32)
    if (u64(buf, end + 24) !== count) fail('ZIP64 entries on this disk differ from the total')
    cdSize = u64(buf, end + 40)
    cdOffset = u64(buf, end + 48)
    if (cdOffset + cdSize !== end) fail('central directory does not end at the ZIP64 end record')
  } else {
    if (count === MAX16 || cdSize === MAX32 || cdOffset === MAX32) fail('ZIP64 sentinel without a ZIP64 end record')
    if (cdOffset + cdSize !== eocd) fail('central directory does not end at the end record')
  }

  const entries: ZipEntry[] = []
  let at = cdOffset
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) fail(`central header ${i}: bad signature`)
    const flags = buf.readUInt16LE(at + 8)
    const method = buf.readUInt16LE(at + 10)
    const dosTime = buf.readUInt16LE(at + 12)
    const dosDate = buf.readUInt16LE(at + 14)
    const crc = buf.readUInt32LE(at + 16)
    let csize = buf.readUInt32LE(at + 20)
    let size = buf.readUInt32LE(at + 24)
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const commentLen = buf.readUInt16LE(at + 32)
    let offset = buf.readUInt32LE(at + 42)
    const nameBytes = buf.subarray(at + 46, at + 46 + nameLen)
    const extra = buf.subarray(at + 46 + nameLen, at + 46 + nameLen + extraLen)
    if (method !== 0) fail(`entry ${i}: compressed (method ${method})`)
    if (!(flags & 0x0800)) fail(`entry ${i}: name without the UTF-8 flag`)
    if (flags & 0x0008) fail(`entry ${i}: data descriptor`)
    const want = { size: size === MAX32, csize: csize === MAX32, offset: offset === MAX32 }
    const big = want.size || want.csize || want.offset
    if (big) {
      const z = zip64Extra(extra, want) ?? fail(`entry ${i}: ZIP64 sentinel without the extra field`)
      if (z.size !== undefined) size = z.size
      if (z.csize !== undefined) csize = z.csize
      if (z.offset !== undefined) offset = z.offset
    }
    if (csize !== size) fail(`entry ${i}: stored sizes differ`)
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes)

    if (buf.readUInt32LE(offset) !== 0x04034b50) fail(`${name}: bad local header signature`)
    const lFlags = buf.readUInt16LE(offset + 6)
    const lNameLen = buf.readUInt16LE(offset + 26)
    const lExtraLen = buf.readUInt16LE(offset + 28)
    if (lFlags !== flags || buf.readUInt16LE(offset + 8) !== method) fail(`${name}: local header disagrees on flags or method`)
    if (buf.readUInt32LE(offset + 14) !== crc) fail(`${name}: local header disagrees on the CRC`)
    if (!buf.subarray(offset + 30, offset + 30 + lNameLen).equals(nameBytes)) fail(`${name}: local header disagrees on the name`)
    let lSize = buf.readUInt32LE(offset + 22)
    if (lSize === MAX32) {
      const lExtra = buf.subarray(offset + 30 + lNameLen, offset + 30 + lNameLen + lExtraLen)
      lSize = zip64Extra(lExtra, { size: true, csize: true, offset: false })?.size ?? fail(`${name}: local ZIP64 sentinel without the extra field`)
    }
    if (lSize !== size) fail(`${name}: local header disagrees on the size`)
    const start = offset + 30 + lNameLen + lExtraLen
    const data = buf.subarray(start, start + size)
    if (data.length !== size) fail(`${name}: truncated data`)
    const actual = crc32(data) >>> 0
    if (actual !== crc) fail(`${name}: CRC ${actual.toString(16)} does not match ${crc.toString(16)}`)
    entries.push({ name, data, crc, zip64: big, dosDate, dosTime })
    at += 46 + nameLen + extraLen + commentLen
  }
  if (at !== cdOffset + cdSize) fail('central directory size does not match its records')
  return { entries, zip64 }
}
