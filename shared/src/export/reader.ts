// Strict reader of `manifest.json` (format v1). Strict about what it knows: `format` must match, the
// version must not be newer than EXPORT_FORMAT_VERSION, and every known field must have its type.
// Lenient about what it does not know: unknown fields are ignored and left out of the result, so a
// newer writer can add optional fields without breaking this reader.

import { InvalidExportError, UnsupportedExportVersionError } from './errors'
import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  type ExportConversationEntry,
  type ExportConversationKind,
  type ExportManifest,
  type ExportPersonEntry,
  type ExportPersonKind,
  type ExportTotals,
} from './types'

type Obj = Record<string, unknown>

const PERSON_KINDS: readonly ExportPersonKind[] = ['member', 'guest', 'agent']
const CONVERSATION_KINDS: readonly ExportConversationKind[] = ['public', 'private', 'dm', 'group']

function fail(field: string): never {
  throw new InvalidExportError(`export: invalid manifest field ${field}`)
}

function obj(v: unknown, field: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(field)
  return v as Obj
}

function str(o: Obj, key: string, field: string): string {
  const v = o[key]
  if (typeof v !== 'string') fail(`${field}.${key}`)
  return v
}

function count(o: Obj, key: string, field: string): number {
  const v = o[key]
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) fail(`${field}.${key}`)
  return v
}

function oneOf<T extends string>(o: Obj, key: string, field: string, allowed: readonly T[]): T {
  const v = str(o, key, field)
  if (!(allowed as readonly string[]).includes(v)) fail(`${field}.${key}`)
  return v as T
}

function list(o: Obj, key: string, field: string): unknown[] {
  const v = o[key]
  if (!Array.isArray(v)) fail(`${field}.${key}`)
  return v
}

/**
 * Parses and validates the text of a `manifest.json`. Throws InvalidExportError when the text is not
 * a manifest of this format, and UnsupportedExportVersionError when its version is newer than the one
 * this code knows.
 */
export function readExportManifest(text: string): ExportManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new InvalidExportError('export: the manifest is not JSON')
  }
  const root = obj(parsed, '$')
  if (root.format !== EXPORT_FORMAT) throw new InvalidExportError('export: not a manifest of this format')
  const version = root.formatVersion
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) fail('$.formatVersion')
  if (version > EXPORT_FORMAT_VERSION) throw new UnsupportedExportVersionError(version, EXPORT_FORMAT_VERSION)

  const people: ExportPersonEntry[] = list(root, 'people', '$').map((raw, i) => {
    const f = `$.people[${i}]`
    const o = obj(raw, f)
    return { id: str(o, 'id', f), name: str(o, 'name', f), kind: oneOf(o, 'kind', f, PERSON_KINDS) }
  })

  const conversations: ExportConversationEntry[] = list(root, 'conversations', '$').map((raw, i) => {
    const f = `$.conversations[${i}]`
    const o = obj(raw, f)
    const joinedAt = o.joinedAt === undefined ? undefined : str(o, 'joinedAt', f)
    return {
      id: str(o, 'id', f),
      file: str(o, 'file', f),
      name: str(o, 'name', f),
      kind: oneOf(o, 'kind', f, CONVERSATION_KINDS),
      ...(joinedAt === undefined ? {} : { joinedAt }),
      messages: count(o, 'messages', f),
      deleted: count(o, 'deleted', f),
      attachments: count(o, 'attachments', f),
      gaps: count(o, 'gaps', f),
    }
  })

  const t = obj(root.totals, '$.totals')
  const totals: ExportTotals = {
    conversations: count(t, 'conversations', '$.totals'),
    messages: count(t, 'messages', '$.totals'),
    deleted: count(t, 'deleted', '$.totals'),
    attachments: count(t, 'attachments', '$.totals'),
    gaps: count(t, 'gaps', '$.totals'),
  }

  return {
    format: EXPORT_FORMAT,
    formatVersion: version,
    scope: oneOf(root, 'scope', '$', ['person'] as const),
    createdAt: str(root, 'createdAt', '$'),
    subject: str(root, 'subject', '$'),
    people,
    conversations,
    totals,
  }
}
