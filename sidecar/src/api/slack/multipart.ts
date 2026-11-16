// A hand-written multipart/form-data parser for ONE route: the upload_url of the upload v2 flow
// (PLANO-AGENTES §0.3.12 item 6; no multipart dependency). It takes the whole body (already bounded by
// the caller) and accepts exactly ONE file field — @slack/web-api's filesUploadV2 posts the bytes as a
// single field `body` with a filename. Other (non-file) fields are ignored.
// Refused (`invalid_arguments`): no boundary, a body that does not follow the delimiters, a part
// without headers, no file field, more than one file field.
import { SlackError } from './errors'

export interface FilePart {
  // The part's filename and Content-Type, as sent (informative: the name comes from getUploadURLExternal).
  filename: string
  type: string | undefined
  data: Buffer
}

const CRLF = Buffer.from('\r\n')
const HEADERS_END = Buffer.from('\r\n\r\n')
const PARAM = /;\s*([A-Za-z0-9_*-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g

const bad = (): SlackError => new SlackError('invalid_arguments')

function params(value: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of value.matchAll(PARAM)) {
    let v = (m[2] as string).trim()
    if (v.startsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, '$1')
    out.set((m[1] as string).toLowerCase(), v)
  }
  return out
}

// The boundary of a `multipart/form-data` Content-Type; undefined when absent or malformed.
export function boundaryOf(contentType: string | undefined): string | undefined {
  if (contentType === undefined) return undefined
  const semi = contentType.indexOf(';')
  const type = (semi < 0 ? contentType : contentType.slice(0, semi)).trim().toLowerCase()
  if (type !== 'multipart/form-data' || semi < 0) return undefined
  const b = params(contentType.slice(semi)).get('boundary')
  return b !== undefined && b.length >= 1 && b.length <= 70 && !/[\r\n]/.test(b) ? b : undefined
}

export function parseFilePart(body: Buffer, boundary: string): FilePart {
  const delimiter = Buffer.from(`--${boundary}`)
  const next = Buffer.concat([CRLF, delimiter])
  // The first delimiter opens the body, or follows a preamble ending in CRLF.
  let pos = body.subarray(0, delimiter.length).equals(delimiter) ? 0 : body.indexOf(next)
  if (pos < 0) throw bad()
  if (pos > 0) pos += CRLF.length
  pos += delimiter.length
  let file: FilePart | null = null
  for (;;) {
    // After a delimiter: `--` closes the body; CRLF opens a part.
    if (body.subarray(pos, pos + 2).toString('latin1') === '--') break
    if (!body.subarray(pos, pos + 2).equals(CRLF)) throw bad()
    const start = pos + 2
    const end = body.indexOf(next, start)
    if (end < 0) throw bad()
    const part = body.subarray(start, end)
    const split = part.indexOf(HEADERS_END)
    if (split < 0) throw bad()
    let disposition: Map<string, string> | null = null
    let type: string | undefined
    for (const line of part.subarray(0, split).toString('utf8').split('\r\n')) {
      const colon = line.indexOf(':')
      if (colon < 0) throw bad()
      const name = line.slice(0, colon).trim().toLowerCase()
      const value = line.slice(colon + 1).trim()
      if (name === 'content-disposition') {
        if (!/^form-data\s*(;|$)/i.test(value)) throw bad()
        disposition = params(value)
      } else if (name === 'content-type') {
        type = value
      }
    }
    if (disposition === null || !disposition.has('name')) throw bad()
    const filename = disposition.get('filename')
    if (filename !== undefined) {
      if (file !== null) throw bad()
      file = { filename, type, data: part.subarray(split + HEADERS_END.length) }
    }
    pos = end + next.length
  }
  if (file === null) throw bad()
  return file
}
