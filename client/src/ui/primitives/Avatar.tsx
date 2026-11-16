import { useState } from 'react'
import type { Presence } from '@tayet/client'
import type { Size } from './types'

// Avatar (leaf, ADR-036 — addendum dec. 5: modo-imagem). An initial-in-a-box: a decorative monogram
// beside a name. Protocol-agnostic by construction — it receives a plain `label` string (the caller
// passes e.g. displayName.slice(0, 1)), never a User nor any id. With `src` (a URL ALREADY resolved —
// the caller obtains it via useMedia; the primitive NEVER touches MediaRef/resolveMedia, staying
// protocol-agnostic) it renders the photo, with the monogram as the canonical fallback (no src, still
// resolving, or a broken image). `aria-hidden` always: the adjacent name is the accessible text, the
// avatar is pure affordance; the img is decorative (alt="").
//
// `variant` = semantic role: `greige` (the canonical rounded square — raised surface, strong border,
// muted text; the default monogram) or `accent` (accent-wash/accent). `size` maps to
// --density-{size}-avatar, never a loose px.
//
// `presence` (ADR-036 addendum Jul/2026 — orthogonal prop, NOT a variant: any variant composes
// with/without the dot). Without it the DOM is byte-identical to the bare form — a tested invariant,
// so non-adhering call sites are untouched. With it, the box's overflow:hidden forces the dot to a
// SIBLING inside a relative wrapper (decorative, no semantics — the box keeps its aria-hidden, the
// dot is aria-hidden too). The dot renders ONLY when online (line idiom, workspace.md §7: away/
// offline/unknown have no visual form on a line — the wrapper stays, keeping structure stable
// across transitions).

export type AvatarVariant = 'greige' | 'accent'

export function Avatar({
  label,
  src,
  variant = 'greige',
  size = 'cotidiano',
  presence,
}: {
  label: string
  src?: string
  variant?: AvatarVariant
  size?: Size
  presence?: Presence
}) {
  // Tracks the src that failed to load so a fresh src (a new photo) re-tries rather than staying stuck
  // on the monogram. A broken img → onError sets failedSrc === src → showImage false → monogram.
  const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined)
  const showImage = Boolean(src) && src !== failedSrc
  const box = (
    <span
      className="ui-avatar"
      data-variant={variant}
      data-size={size}
      data-image={showImage ? 'true' : undefined}
      aria-hidden="true"
    >
      {showImage ? (
        <img className="ui-avatar__img" src={src} alt="" onError={() => setFailedSrc(src)} />
      ) : (
        label
      )}
    </span>
  )
  if (presence === undefined) return box
  return (
    <span className="ui-avatar-wrap">
      {box}
      {presence === 'online' && (
        <span className="ui-avatar__dot" data-presence="online" aria-hidden="true" />
      )}
    </span>
  )
}
