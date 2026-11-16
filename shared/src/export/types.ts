// Open data export format, version 1 (ADR-096 dec. 2, 3, 4, 5, 7 and 8). Pure types and constants:
// the shape of the files in an export folder (output) and the shape of what a caller hands the
// builder (input). Zero protocol vocabulary. The public description of the format is
// shared/EXPORT-FORMAT.md; a change here is a change there.
//
// Output identifiers are synthetic (`p<n>`, `c<n>`, `m<n>`) and only mean something inside one export.
// Input carries an opaque `key` per person, conversation and message: it exists only to correlate
// (a mention to a person, a reply to a message) and is never written. At runtime the key is the
// protocol identifier (ADR-008), which is exactly why it must never reach the output.

import type { RichDoc } from '../domain'

/** The `format` value of every manifest written in this format. */
export const EXPORT_FORMAT = 'tayet-export'

/**
 * The format version this code writes and the highest it reads. A new optional field does not change
 * it; a change that breaks a reader increments it. Readers ignore fields they do not know.
 */
export const EXPORT_FORMAT_VERSION = 1

// ── Output ─────────────────────────────────────────────────────────────────────────────────────────

/** Who the export is about. Only `person` in version 1; the server tool may add a value later. */
export type ExportScope = 'person'

export type ExportPersonKind = 'member' | 'guest' | 'agent'

export type ExportConversationKind = 'public' | 'private' | 'dm' | 'group'

export interface ExportPersonEntry {
  id: string
  name: string
  kind: ExportPersonKind
}

export interface ExportCounts {
  messages: number
  deleted: number
  attachments: number
  gaps: number
}

export interface ExportConversationEntry extends ExportCounts {
  id: string
  file: string
  name: string
  kind: ExportConversationKind
  joinedAt?: string
}

export interface ExportTotals extends ExportCounts {
  conversations: number
}

/** `manifest.json`. */
export interface ExportManifest {
  format: typeof EXPORT_FORMAT
  formatVersion: number
  scope: ExportScope
  createdAt: string
  subject: string
  people: ExportPersonEntry[]
  conversations: ExportConversationEntry[]
  totals: ExportTotals
}

export interface ExportProfile {
  fullName: string
  nickname?: string
  pronouns?: string
  note?: string
  jobTitle?: string
  workEmail?: string
  avatar?: string
}

export interface ExportAccess {
  name: string
  lastSeenAt?: string
  current: boolean
}

/** `account.json`. */
export interface ExportAccount {
  formatVersion: number
  profile: ExportProfile
  accesses: ExportAccess[]
  agents: { person: string }[]
}

export interface ExportAttachment {
  file?: string
  name: string
  mimetype: string
  size?: number
  missing?: true
}

export interface ExportMessageItem {
  type: 'message'
  id: string
  sentAt: string
  editedAt?: string
  text: string
  rich?: RichDoc
  mentions?: string[]
  attachment?: ExportAttachment
  inThread: boolean
  threadRoot?: string
  isReply: boolean
  replyTo?: string
}

export interface ExportDeletedItem {
  type: 'deleted'
  id: string
  sentAt: string
}

export interface ExportUnreadableItem {
  type: 'unreadable'
  id: string
  sentAt: string
}

export interface ExportUnsupportedItem {
  type: 'unsupported'
  id: string
  sentAt: string
}

export interface ExportApprovalResponseItem {
  type: 'approvalResponse'
  id: string
  sentAt: string
  option: string
  requestedBy: string
}

export type ExportItem =
  | ExportMessageItem
  | ExportDeletedItem
  | ExportUnreadableItem
  | ExportUnsupportedItem
  | ExportApprovalResponseItem

/** `conversations/<id>.json`. */
export interface ExportConversationFile {
  formatVersion: number
  conversation: string
  items: ExportItem[]
}

/** One file of the export: its path inside the folder and its text content. */
export interface ExportFile {
  path: string
  content: string
}

// ── Input ──────────────────────────────────────────────────────────────────────────────────────────
// Instants are epoch milliseconds. Every `key` is an opaque correlation string, never written.

export interface ExportPersonInput {
  key: string
  name: string
  kind: ExportPersonKind
}

export interface ExportProfileInput {
  fullName: string
  nickname?: string
  pronouns?: string
  note?: string
  jobTitle?: string
  workEmail?: string
  /** Present when the profile has a picture; the builder returns the path to write it at. */
  avatar?: { mimetype: string }
}

export interface ExportAccessInput {
  name: string
  lastSeenAt?: number
  current: boolean
}

export interface ExportStartInput {
  createdAt: number
  subject: ExportPersonInput
  profile: ExportProfileInput
  accesses: ExportAccessInput[]
  /** Agents the person operates. */
  agents: ExportPersonInput[]
}

export interface ExportConversationInput {
  key: string
  name: string
  kind: ExportConversationKind
  joinedAt?: number
}

export interface ExportAttachmentInput {
  name: string
  mimetype: string
  size?: number
  /** false = the bytes could not be obtained; the attachment is marked missing and counts as a gap. */
  available: boolean
}

export interface ExportMessageInput {
  type: 'message'
  key: string
  sentAt: number
  editedAt?: number
  text: string
  rich?: RichDoc
  mentions?: ExportPersonInput[]
  attachment?: ExportAttachmentInput
  /** Key of the thread root, when the message is in a thread. */
  threadRoot?: string
  /** Key of the message replied to, when the message is a reply. */
  replyTo?: string
}

export interface ExportMarkerInput {
  type: 'deleted' | 'unreadable' | 'unsupported'
  key: string
  sentAt: number
}

export interface ExportApprovalResponseInput {
  type: 'approvalResponse'
  key: string
  sentAt: number
  /** The label of the option the person chose. */
  option: string
  /** The agent that asked. */
  requestedBy: ExportPersonInput
}

export type ExportItemInput = ExportMessageInput | ExportMarkerInput | ExportApprovalResponseInput
