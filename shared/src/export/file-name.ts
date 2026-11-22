// File names inside an export folder (format v1, "attachment path"). The name a person gave a file is
// user content: it may carry path separators, control characters or characters Windows refuses, and it
// may be arbitrarily long. The sanitized name is safe on the common file systems and inside a zip.

const MAX_NAME_LENGTH = 100

// Known media types → extension, for a nameless file and for the profile picture. Anything else gets
// no extension rather than a guess.
const EXTENSION_BY_MIMETYPE: Readonly<Record<string, string>> = {
  'application/json': 'json',
  'application/msword': 'doc',
  'application/pdf': 'pdf',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/zip': 'zip',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'text/plain': 'txt',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}

/** The extension for a media type, without the dot, or undefined when the type is not known. */
export function extensionForMimetype(mimetype: string): string | undefined {
  const base = mimetype.split(';')[0]?.trim().toLowerCase() ?? ''
  return Object.prototype.hasOwnProperty.call(EXTENSION_BY_MIMETYPE, base) ? EXTENSION_BY_MIMETYPE[base] : undefined
}

// Path separators and the characters Windows reserves in a file name; C0/C1 control characters are
// dropped by code point in isUnsafe.
const RESERVED = new Set(['/', '\\', '<', '>', ':', '"', '|', '?', '*'])

function isUnsafe(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0
  return RESERVED.has(ch) || cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)
}

const SPACE_OR_DOT = /^[\s.]$/

// The trims walk in from the ends, one character at a time: a pattern anchored only at the end retries
// from every character of an inner run, which is quadratic.
export function trimEndSpacesAndDots(s: string): string {
  let end = s.length
  while (end > 0 && SPACE_OR_DOT.test(s.charAt(end - 1))) end--
  return s.slice(0, end)
}

export function trimSpacesAndDots(s: string): string {
  const kept = trimEndSpacesAndDots(s)
  let start = 0
  while (start < kept.length && SPACE_OR_DOT.test(kept.charAt(start))) start++
  return kept.slice(start)
}

/**
 * A file name safe to write inside the export folder. Strips path separators, control characters and
 * the characters Windows reserves; normalizes to NFC; drops the leading and trailing spaces and dots
 * Windows refuses; cuts the name to 100 characters keeping the extension. An empty result becomes
 * `file`, with the extension of `mimetype` when that type is known.
 */
export function sanitizeExportFileName(name: string, mimetype = ''): string {
  const cleaned = trimSpacesAndDots(
    Array.from(name.normalize('NFC'))
      .filter((ch) => !isUnsafe(ch))
      .join(''),
  )
  if (cleaned === '') {
    const ext = extensionForMimetype(mimetype)
    return ext ? `file.${ext}` : 'file'
  }
  const chars = Array.from(cleaned) // code points: a cut never splits a surrogate pair
  if (chars.length <= MAX_NAME_LENGTH) return cleaned
  const dot = cleaned.lastIndexOf('.')
  const ext = dot > 0 ? Array.from(cleaned.slice(dot)) : []
  if (ext.length === 0 || ext.length >= MAX_NAME_LENGTH / 2) return trimEndSpacesAndDots(chars.slice(0, MAX_NAME_LENGTH).join(''))
  const base = trimEndSpacesAndDots(chars.slice(0, MAX_NAME_LENGTH - ext.length).join(''))
  return base + ext.join('')
}
