// Type-only wire shapes the translator reads (ADR-088): no wasm, no SDK value, no lib DOM.

// The attachment key, structurally: the JWK fields the Matrix media spec puts in `file.key`
// (AES-CTR). A DOM `JsonWebKey` assigns to it and it assigns back (every field optional, shared
// names, same types), so the client's WebCrypto/wasm code is unchanged; the shared package
// compiles without lib DOM (ADR-088 dec. 5).
export interface AttachmentKey {
  kty?: string
  key_ops?: string[]
  alg?: string
  k?: string
  ext?: boolean
}

// The EncryptedFile shape we consume off a media event's `file` (matrix-js-sdk does not
// re-export the type from its root; we read it structurally). AES-CTR with a JWK key,
// per the Matrix media spec.
export interface EncryptedFile {
  url: string
  key: AttachmentKey
  iv: string
  hashes: { [alg: string]: string }
  v: string
}

// ADR-068: the server's unread counts, per room and per thread (captured in client
// src/acl/internal/server-unread.ts).
export type ServerCounts = { total: number; highlight: number }
export type RoomServerUnread = { room: ServerCounts; threads: ReadonlyMap<string, ServerCounts> }
