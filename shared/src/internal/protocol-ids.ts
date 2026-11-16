import type { Brand } from '../domain/brand'
import type { ChannelId, UserId, MessageId, MediaRef, AccessId } from '../domain'

// Protocol identity — branded Matrix concepts. These live ONLY inside acl/internal/ and
// are NEVER exported by the acl/index.ts barrel (PLANO-FASE-1 §1.1). Branding them stops
// a raw protocol id from being passed where a domain id is expected, even within the ACL.
export type Mxid = Brand<string, 'Mxid'> // @user:server.com
export type RoomId = Brand<string, 'RoomId'> // !xYzAbC:server.com
export type EventId = Brand<string, 'EventId'> // $abc...

// ── The single place ADR-008's reinterpretation lives ───────────────────────────────────
// ADR-008 (Opt 1): the runtime value of a domain id IS the protocol id, branded. So the
// conversion both ways is a pure re-brand with no parsing. Confining it here (inside the
// ACL) means nothing above the barrel ever depends on this equivalence — migrating to a
// token scheme later (ADR-008 trigger) is an edit to these functions alone.
//
// Inbound branding: raw SDK strings → domain ids (cross the barrel).
export const brandChannelId = (roomId: string): ChannelId => roomId as ChannelId
export const brandUserId = (mxid: string): UserId => mxid as UserId
export const brandMessageId = (eventId: string): MessageId => eventId as MessageId

// Reverse: domain id → the raw protocol string the SDK expects (never leaves the ACL).
export const channelIdToRaw = (id: ChannelId): string => id
export const userIdToRaw = (id: UserId): string => id
export const messageIdToRaw = (id: MessageId): string => id

// MediaRef is an OPAQUE token minted by the ACL (NOT an mxc://) — ADR-009.
export const brandMediaRef = (token: string): MediaRef => token as MediaRef
export const mediaRefToRaw = (ref: MediaRef): string => ref

// AccessId (ADR-018): the runtime value IS the underlying device id of the access, branded as
// AccessId. Same pure re-brand as the ids above — the consumer treats it as opaque (never parses
// it), and acknowledgeAccess unbrands it back to the device id the recognized set is keyed by.
export const brandAccessId = (deviceId: string): AccessId => deviceId as AccessId
export const accessIdToRaw = (id: AccessId): string => id
