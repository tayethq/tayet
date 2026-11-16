// The data export's zip writer (ADR-096 dec. 6; PLANO-EXPORT-DADOS §0.3.6 item 13). Pure: no DOM, no
// dependency. Stored entries only (no compression); names in UTF-8 with general-purpose bit 11; the CRC-32
// is computed before the local header is written, so there is no data descriptor. The data is read in
// 8 MiB slices for the CRC and never copied: each entry is one Blob (its local header and its data), and
// finish() returns one Blob of those Blobs plus the central directory. ZIP64 (APPNOTE 4.3.14, 4.4 and
// 4.5.3) is used only when a limit of the classic format is reached, or when `forceZip64` asks for it
// (the test reads the ZIP64 shape back from a small archive).

export interface ZipWriter {
  /** Appends an entry. Text is written as UTF-8. Calls run one after another, in call order. */
  add(path: string, data: Blob | string): Promise<void>
  /** Ends the archive. No add() may follow, and every add() must have settled. */
  finish(): Blob
}

export interface ZipWriterOptions {
  forceZip64?: boolean
  /** The entries' modification time (DOS, local time). Defaults to the moment of creation. */
  now?: Date
}

const SLICE = 8 * 1024 * 1024
const MAX16 = 0xffff
const MAX32 = 0xffffffff
const VERSION_CLASSIC = 20
const VERSION_ZIP64 = 45
const FLAG_UTF8 = 0x0800
// "Version made by" names the host as Unix (3): readers then take the names as written (UTF-8, bit 11)
// instead of translating them from a DOS code page, and the external attributes carry a regular file's
// mode, 0644, so an extracted file is readable.
const HOST_UNIX = 3 << 8
const FILE_MODE = (0o100644 << 16) >>> 0

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 (IEEE 802.3), resumable: pass the previous value to continue over the next bytes. */
export function crc32(bytes: Uint8Array, previous = 0): number {
  let c = (previous ^ MAX32) >>> 0
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ MAX32) >>> 0
}

async function crcOf(blob: Blob): Promise<number> {
  let crc = 0
  for (let start = 0; start < blob.size; start += SLICE) {
    crc = crc32(new Uint8Array(await blob.slice(start, start + SLICE).arrayBuffer()), crc)
  }
  return crc
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107)
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

// Little-endian field writer over a fixed-size buffer.
class Fields {
  readonly bytes: Uint8Array<ArrayBuffer>
  private readonly view: DataView
  private at = 0
  constructor(size: number) {
    this.bytes = new Uint8Array(size)
    this.view = new DataView(this.bytes.buffer)
  }
  u16(v: number): this {
    this.view.setUint16(this.at, v, true)
    this.at += 2
    return this
  }
  u32(v: number): this {
    this.view.setUint32(this.at, v >>> 0, true)
    this.at += 4
    return this
  }
  u64(v: number): this {
    this.view.setBigUint64(this.at, BigInt(v), true)
    this.at += 8
    return this
  }
  raw(b: Uint8Array<ArrayBuffer>): this {
    this.bytes.set(b, this.at)
    this.at += b.length
    return this
  }
}

interface Entry {
  name: Uint8Array<ArrayBuffer>
  crc: number
  size: number
  offset: number
  zip64: boolean
}

export function createZipWriter(options: ZipWriterOptions = {}): ZipWriter {
  const force = options.forceZip64 === true
  const { time, date } = dosDateTime(options.now ?? new Date())
  const encoder = new TextEncoder()
  const entries: Entry[] = []
  const parts: Blob[] = []
  let offset = 0
  let queue: Promise<void> = Promise.resolve()
  let finished = false

  async function write(path: string, input: Blob | string): Promise<void> {
    const data = typeof input === 'string' ? new Blob([encoder.encode(input)]) : input
    const name = encoder.encode(path)
    const crc = await crcOf(data)
    const size = data.size
    const zip64 = force || size >= MAX32 || offset >= MAX32
    // Local header: with ZIP64, both sizes go to the extra field (APPNOTE 4.5.3).
    const extra = zip64 ? 20 : 0
    const header = new Fields(30 + name.length + extra)
      .u32(0x04034b50)
      .u16(zip64 ? VERSION_ZIP64 : VERSION_CLASSIC)
      .u16(FLAG_UTF8)
      .u16(0)
      .u16(time)
      .u16(date)
      .u32(crc)
      .u32(zip64 ? MAX32 : size)
      .u32(zip64 ? MAX32 : size)
      .u16(name.length)
      .u16(extra)
      .raw(name)
    if (zip64) header.u16(0x0001).u16(16).u64(size).u64(size)
    parts.push(new Blob([header.bytes, data]))
    entries.push({ name, crc, size, offset, zip64 })
    offset += header.bytes.length + size
  }

  return {
    add(path, data) {
      if (finished) return Promise.reject(new Error('zip: add after finish'))
      const next = queue.then(() => write(path, data))
      // A failed entry fails its own add(); the queue keeps going for the next one.
      queue = next.catch(() => {})
      return next
    },

    finish() {
      if (finished) throw new Error('zip: finish twice')
      finished = true
      const central: Uint8Array<ArrayBuffer>[] = []
      let centralSize = 0
      for (const e of entries) {
        // Central header: with ZIP64, sizes and offset go to the extra field, in that order.
        const extra = e.zip64 ? 28 : 0
        const record = new Fields(46 + e.name.length + extra)
          .u32(0x02014b50)
          .u16(HOST_UNIX | (e.zip64 ? VERSION_ZIP64 : VERSION_CLASSIC))
          .u16(e.zip64 ? VERSION_ZIP64 : VERSION_CLASSIC)
          .u16(FLAG_UTF8)
          .u16(0)
          .u16(time)
          .u16(date)
          .u32(e.crc)
          .u32(e.zip64 ? MAX32 : e.size)
          .u32(e.zip64 ? MAX32 : e.size)
          .u16(e.name.length)
          .u16(extra)
          .u16(0)
          .u16(0)
          .u16(0)
          .u32(FILE_MODE)
          .u32(e.zip64 ? MAX32 : e.offset)
          .raw(e.name)
        if (e.zip64) record.u16(0x0001).u16(24).u64(e.size).u64(e.size).u64(e.offset)
        central.push(record.bytes)
        centralSize += record.bytes.length
      }
      const centralOffset = offset
      const count = entries.length
      const zip64End =
        force ||
        entries.some((e) => e.zip64) ||
        count >= MAX16 ||
        centralOffset >= MAX32 ||
        centralSize >= MAX32
      const tail: Uint8Array<ArrayBuffer>[] = []
      if (zip64End) {
        const endOffset = centralOffset + centralSize
        tail.push(
          new Fields(56)
            .u32(0x06064b50)
            .u64(44)
            .u16(HOST_UNIX | VERSION_ZIP64)
            .u16(VERSION_ZIP64)
            .u32(0)
            .u32(0)
            .u64(count)
            .u64(count)
            .u64(centralSize)
            .u64(centralOffset).bytes,
          new Fields(20).u32(0x07064b50).u32(0).u64(endOffset).u32(1).bytes,
        )
      }
      tail.push(
        new Fields(22)
          .u32(0x06054b50)
          .u16(0)
          .u16(0)
          .u16(zip64End ? MAX16 : count)
          .u16(zip64End ? MAX16 : count)
          .u32(zip64End ? MAX32 : centralSize)
          .u32(zip64End ? MAX32 : centralOffset)
          .u16(0).bytes,
      )
      return new Blob([...parts, ...central, ...tail], { type: 'application/zip' })
    },
  }
}
