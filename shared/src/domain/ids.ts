import type { Brand } from './brand'

// Domain identity — opaque + stable, branded. These CROSS the ACL boundary (they are
// re-exported by the acl/index.ts barrel) and are the only ids any module above the ACL
// ever sees. Protocol ids (Mxid/RoomId/EventId) live in acl/internal/ and never cross.
//
// ADR-008 (Proposto, Opt 1): the runtime value of a domain id IS the protocol id
// (room id / mxid) branded. Opacity at runtime is an accepted residual — defended by the
// leak-pattern lint + telemetry discipline. Migrating to a token scheme later is an
// ACL-internal change (nothing above the barrel parses the id), so branding now is what
// keeps that migration cheap. See ADR-008.

export type ChannelId = Brand<string, 'ChannelId'>
export type UserId = Brand<string, 'UserId'> // stable user handle
export type MessageId = Brand<string, 'MessageId'>
export type DeviceId = Brand<string, 'DeviceId'> // domain sense, not the SDK device id type

// ADR-018: the stable, opaque identifier of a new ACCOUNT ACCESS (consumed back by
// acknowledgeAccess). Its runtime value IS the underlying DeviceId, branded as AccessId — the
// consumer never parses or shows it (P1: "access" is product vocabulary, "device" is not). Same
// branded-opaque residual as the other ids (ADR-008); the rebrand lives in acl/internal.
export type AccessId = Brand<string, 'AccessId'>

// An agent's form opened for this session: opaque, minted by the ACL, never parsed above it.
export type FormId = Brand<string, 'FormId'>

// ADR-009: an opaque, per-session, NON-persistable reference to media. NOT a deep-link key
// (the persistable key stays Message/Channel/UserId). The bytes are never in the domain — only
// safe synchronous metadata; resolution is lazy via the barrel's resolveMedia(). The runtime
// value is an opaque token (NOT an mxc://), minted by the ACL; transport (SW vs blob) is
// ACL-internal and never crosses the barrel.
export type MediaRef = Brand<string, 'MediaRef'>
