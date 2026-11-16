import type { ResolvedMedia } from '../types'

// Per-session registry of LOCAL media (ADR-009 + ADR-010 decision (a), PLANO-FASE-1-UPLOAD §2).
// When an attachment is shown in its optimistic 'pending' bubble, the ACL mints a LOCAL MediaRef
// mapped to the File/Blob the user picked. resolveMedia of that ref returns an object URL of the
// bytes — the LOCAL preview — before (and, for the rest of the session, regardless of) the upload.
//
// The mxc never enters here: this registry holds only the raw bytes, so resolveMedia of a local ref
// CANNOT leak a protocol identifier (PLANO §6). Confined to acl/internal; never crosses the barrel.
//
// Re-creatable across mounts: the object URL is created on each resolve() and revoked by its own
// release() (so a bubble that unmounts and remounts gets a fresh URL), while the Blob is retained
// for the whole session — that is decision (a): no swap to the remote ref on 'sent'. release() is
// idempotent.
export class LocalMediaRegistry {
  private readonly byToken = new Map<string, { blob: Blob }>()
  private counter = 0

  // Mint an opaque token (NOT an mxc) for a local Blob. The `mrl_` prefix keeps it distinct from
  // the remote registry's `mr_` tokens so resolveMedia can route without ambiguity.
  mint(blob: Blob): string {
    this.counter += 1
    const token = `mrl_${this.counter}`
    this.byToken.set(token, { blob })
    return token
  }

  has(token: string): boolean {
    return this.byToken.has(token)
  }

  // Resolve a local token to a per-mount object URL + idempotent release(). Returns undefined if
  // the token is not local (the caller then falls through to the remote/authenticated path).
  // `variant` is ignored on purpose: there is no server thumbnail for a local preview, so a
  // 'thumbnail' request yields the same object URL (PLANO §2).
  resolve(token: string): ResolvedMedia | undefined {
    const entry = this.byToken.get(token)
    if (!entry) return undefined
    const url = URL.createObjectURL(entry.blob)
    let released = false
    return {
      url,
      release: () => {
        if (released) return
        released = true
        URL.revokeObjectURL(url)
      },
    }
  }

  // Drop the whole registry — the session ended (disconnect). Blobs are per-session (ADR-009/010).
  clear(): void {
    this.byToken.clear()
    this.counter = 0
  }
}
