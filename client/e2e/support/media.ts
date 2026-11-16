import { readFile } from 'node:fs/promises'
import { deflateSync, crc32 } from 'node:zlib'
import { expect, type Locator, type Page } from '@playwright/test'
import { COMPOSER, TIMELINE } from './labels'
import { messages } from './workspace'

// Media of the browser E2E tier, built in memory (no fixture file, no dependency), and the two
// gestures over it: attach through the composer's file chooser, and download from a message row.

// A solid-color PNG of known dimensions.
export function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor RGB
  const rowBytes = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) rowBytes.set([0x3a, 0x6b, 0x5e], 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: height }, () => rowBytes))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// A minimal PDF 1.4: one page with one line of text (Helvetica). The xref offsets are computed, so
// the file is well-formed for any `text`: parentheses and backslashes are escaped, and anything
// outside printable ASCII becomes '?' (the base-14 font has no encoding for it).
export function pdf(text: string): Buffer {
  const escaped = text.replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, (c) => `\\${c}`)
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

// A phone photo, as the camera writes it: the pixels stored sideways and the way up in the EXIF
// Orientation tag. Four quadrants of distinct colors, so where the file's top-left quadrant lands on
// screen tells the orientation the browser applied.
export const QUADRANT_COLORS = {
  red: [214, 38, 38],
  green: [38, 166, 54],
  blue: [40, 64, 214],
  yellow: [236, 208, 40],
} as const
export type QuadrantColor = keyof typeof QUADRANT_COLORS | 'unknown'
// The file's quadrants, as stored: top-left, top-right, bottom-left, bottom-right.
const STORED: ReadonlyArray<keyof typeof QUADRANT_COLORS> = ['red', 'green', 'blue', 'yellow']

// A JPEG of `width`×`height` encoded by the page's own canvas (toBlob, no dependency), brought to Node.
// `plain` is that file; `rotated` is the same bytes with an APP1 EXIF segment right after the SOI saying
// Orientation = 6 (rotate 90° clockwise to display), as a phone held upright writes a landscape sensor's
// frame. `rotated` displayed right is `height`×`width`, with the stored top-left quadrant at the top right.
export async function jpegPhoto(page: Page, width: number, height: number): Promise<{ plain: Buffer; rotated: Buffer }> {
  const base64 = await page.evaluate(
    async ({ width, height, colors }) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')!
      const [w, h] = [width / 2, height / 2]
      colors.forEach((c, i) => {
        ctx.fillStyle = `rgb(${c.join(',')})`
        ctx.fillRect((i % 2) * w, Math.floor(i / 2) * h, w, h)
      })
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.92))
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let s = ''
      for (const b of bytes) s += String.fromCharCode(b)
      return btoa(s)
    },
    { width, height, colors: STORED.map((k) => [...QUADRANT_COLORS[k]]) },
  )
  const plain = Buffer.from(base64, 'base64')
  return { plain, rotated: withExifOrientation(plain, 6) }
}

// The APP1 segment of a minimal big-endian EXIF: one IFD0 entry, Orientation (0x0112, SHORT), and no next IFD.
function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG (no SOI)')
  const tiff = Buffer.alloc(26)
  tiff.write('MM', 0, 'ascii')
  tiff.writeUInt16BE(42, 2)
  tiff.writeUInt32BE(8, 4) // IFD0 right after the header
  tiff.writeUInt16BE(1, 8) // one entry
  tiff.writeUInt16BE(0x0112, 10)
  tiff.writeUInt16BE(3, 12) // SHORT
  tiff.writeUInt32BE(1, 14) // one value
  tiff.writeUInt16BE(orientation, 18) // left-justified in the 4-byte value field
  tiff.writeUInt32BE(0, 22) // no next IFD
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const header = Buffer.alloc(4)
  header.writeUInt16BE(0xffe1, 0)
  header.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)])
}

export interface DrawnImage {
  /** The <img> as laid out. */
  width: number
  height: number
  naturalWidth: number
  naturalHeight: number
  /** The color at the center of each quadrant of the image as the browser draws it. */
  topLeft: QuadrantColor
  topRight: QuadrantColor
  bottomLeft: QuadrantColor
  bottomRight: QuadrantColor
}

// What the browser draws for a decoded <img>: its box, its natural size, and the color of each quadrant,
// read by drawing the element on a canvas (which applies the same orientation as the element). JPEG
// compression moves the colors a little, so each sample goes to the nearest named color within a margin.
export async function drawnImage(image: Locator): Promise<DrawnImage> {
  return image.evaluate(
    (el, colors) => {
      const img = el as HTMLImageElement
      const { width, height } = img.getBoundingClientRect()
      const [w, h] = [img.naturalWidth, img.naturalHeight]
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, w, h)
      const name = (x: number, y: number): string => {
        const [r, g, b] = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data
        let best = 'unknown'
        let bestDistance = 60
        for (const [key, [cr, cg, cb]] of Object.entries(colors)) {
          const d = Math.hypot(r! - cr!, g! - cg!, b! - cb!)
          if (d < bestDistance) [best, bestDistance] = [key, d]
        }
        return best
      }
      return {
        width,
        height,
        naturalWidth: w,
        naturalHeight: h,
        topLeft: name(w / 4, h / 4),
        topRight: name((3 * w) / 4, h / 4),
        bottomLeft: name(w / 4, (3 * h) / 4),
        bottomRight: name((3 * w) / 4, (3 * h) / 4),
      } as DrawnImage
    },
    QUADRANT_COLORS as unknown as Record<string, number[]>,
  )
}

export interface FileToAttach {
  name: string
  mime: string
  bytes: Buffer
}

// Attach a file the way the user does: the composer's "+" opens the system file chooser. Main
// composer only (the thread composer has no attach).
export async function attach(page: Page, file: FileToAttach): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('main').getByLabel(COMPOSER.attach, { exact: true }).click(),
  ])
  await chooser.setFiles({ name: file.name, mimeType: file.mime, buffer: file.bytes })
}

// Download a file from its row ("📎 <name>") and compare what arrives with what was sent, byte for
// byte — the decrypted blob of an encrypted conversation, or the plain media of a public channel.
export async function expectDownload(page: Page, name: string, bytes: Buffer): Promise<void> {
  const link = messages(page).getByRole('link', { name: TIMELINE.fileLink(name), exact: true })
  await expect(link).toBeVisible({ timeout: 60_000 })
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()])
  expect(download.suggestedFilename()).toBe(name)
  const got = await readFile(await download.path())
  expect(got.equals(bytes), `downloaded ${name}: ${got.length} bytes, sent ${bytes.length}`).toBe(true)
}
