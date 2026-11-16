// Opaque ids at the sidecar's edge (ADR-087 dec. 4; PLANO-AGENTES §0.3.1 S4.1, P-S2, §0.3.6 adj. 3).
// No protocol id leaves the sidecar: conversations, people and the workspace become one-way hashes in
// Slack's shape, stable across every sidecar of the same workspace with no new secret; messages become
// a `ts` derived from the server's instant + a hash of the event id.
//
// - `C…` channel, `D…` direct conversation, `U…` person, `T…` workspace, `F…` file, `B…` the agent's
//   bot id of the Slack layer: the prefix + 10 characters of base32 (50 bits) of sha256("<domain>:<raw>").
//   Separate domains (`c:`, `d:`, `u:`, `t:`, `f:`, `b:`) so a token of one kind never equals one of another.
//   The Slack envelopes' `event_id` is `Ev` + the same hash of the bus entry's id (domain `e:`).
// - `ts` = "<seconds>.<ms, 3 digits><sha256(event id) mod 1000, 3 digits>". It is an INSTANT, not an
//   order: listings follow the timeline (P-S2 adj. 3). Unique per conversation except two events in
//   the same millisecond and the same bucket (1/1000); the reverse index detects it (adj. 4).
//
// Pure (node:crypto only): the reverse lookups live in core/read.ts, which holds the raw ids.
import { createHash } from 'node:crypto'

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const TOKEN_CHARS = 10

function base32(bytes: Uint8Array, chars: number): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff
    bits += 8
    while (bits >= 5 && out.length < chars) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    if (out.length >= chars) break
  }
  return out
}

function hashToken(prefix: string, domain: string, raw: string): string {
  return prefix + base32(createHash('sha256').update(`${domain}:${raw}`).digest(), TOKEN_CHARS)
}

// A group conversation passes `direct = false` (ADR-094 dec. 12): it takes the channel prefix, so its id
// survives the conversion into a channel (the same room, a new kind).
export const conversationToken = (roomId: string, direct: boolean): string =>
  direct ? hashToken('D', 'd', roomId) : hashToken('C', 'c', roomId)
export const personToken = (userId: string): string => hashToken('U', 'u', userId)
// The workspace is the server name: everything after the first ':' of any mxid of it.
export const workspaceToken = (serverName: string): string => hashToken('T', 't', serverName)
export const fileToken = (mediaUri: string): string => hashToken('F', 'f', mediaUri)
// The agent's `bot_id` in the Slack layer (PLANO-AGENTES §0.3.12 item 1): only in `auth.test` and in the
// agent's own events (Bolt reads `user_id` + `bot_id` to drop its own messages). Of the agent's user id.
export const botToken = (userId: string): string => hashToken('B', 'b', userId)

// The `event_id` of a Slack layer envelope (S-f2): `Ev` + the hash of the BUS entry's id (`<epoch>-<seq>`),
// never of a protocol event id.
export const slackEventToken = (busEntryId: string): string => hashToken('Ev', 'e', busEntryId)

export const serverNameOf = (userId: string): string => userId.slice(userId.indexOf(':') + 1)

// Shapes, for input validation (a malformed id is "not found", never a parse error leaking detail).
export const CONVERSATION_TOKEN = /^[CD][A-Z2-7]{10}$/
export const PERSON_TOKEN = /^U[A-Z2-7]{10}$/
export const TS = /^(\d{1,12})\.(\d{6})$/

export function eventSuffix(eventId: string): string {
  return String(BigInt('0x' + createHash('sha256').update(eventId).digest('hex')) % 1000n).padStart(3, '0')
}

export function messageTs(originServerTs: number, eventId: string): string {
  const seconds = Math.floor(originServerTs / 1000)
  const ms = originServerTs - seconds * 1000
  return `${seconds}.${String(ms).padStart(3, '0')}${eventSuffix(eventId)}`
}

export interface ParsedTs {
  // The server instant in milliseconds.
  ms: number
  // The 3-digit hash bucket of the event id.
  suffix: string
  // The whole value as an integer of microsecond-like units, for ordering/filters.
  key: bigint
}

export function parseTs(ts: string): ParsedTs | null {
  const m = TS.exec(ts)
  if (m === null) return null
  const [, seconds, frac] = m as unknown as [string, string, string]
  return {
    ms: Number(seconds) * 1000 + Number(frac.slice(0, 3)),
    suffix: frac.slice(3),
    key: BigInt(seconds) * 1_000_000n + BigInt(frac),
  }
}

// A filter bound (`oldest`/`latest`): a full ts, or seconds with up to 6 decimals, as Slack accepts.
export function parseBound(value: string): bigint | null {
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(value)
  if (m === null) return null
  return BigInt(m[1] as string) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'))
}
