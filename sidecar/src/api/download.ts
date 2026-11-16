// A received file's bytes on the wire (§0.3.7 item 8): shared by the native `GET /v1/files/:id`
// (api/server.ts) and the Slack layer's `url_private` (`GET /slack/files/<F…>`, slack/router.ts, S-f3).
// The bytes come from the core's download() — fetched and decrypted there, once — and are written with
// the same headers on both routes.
import type { ServerResponse } from 'node:http'
import type { Download } from '../core/write'
import { logLeaks, scanContent } from './edge'

type Log = (line: Record<string, unknown>) => void

export const MIMETYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/

// RFC 6266/5987: `filename*=UTF-8''…` (every byte outside the attr-char set percent-encoded).
export const dispositionOf = (name: string): string =>
  `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`

// Writes the file; false (nothing written) when its name would carry a protocol id into a header. The bytes
// are the person's file and never scanned; its name goes in a header: id shapes only.
export function sendDownload(res: ServerResponse, file: Download, log: Log, where: string): boolean {
  const leaks = scanContent(file.name)
  if (leaks.length > 0) {
    logLeaks(log, where, leaks.map((l) => ({ ...l, path: '$.name' })))
    return false
  }
  res.writeHead(200, {
    'content-type': MIMETYPE.test(file.mimetype) ? file.mimetype : 'application/octet-stream',
    'content-length': String(file.bytes.byteLength),
    'content-disposition': dispositionOf(file.name),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength))
  return true
}
