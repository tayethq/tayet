import type { ButtonHTMLAttributes } from 'react'
import type { Size } from './types'

// Button (leaf, ADR-036). `variant` = semantic role, never a loose style:
//   - fill      — accent fill, accent-fg text (the primary action; compose's submit).
//   - secondary — bordered, transparent (the quiet action; compose's cancel).
//   - ghost     — borderless, muted (an icon/low-emphasis action).
//   - danger    — bordered, danger text (a destructive trigger — the quiet danger).
//   - danger-fill — danger fill, accent-fg text (the destructive CONFIRM — the loud danger).
// `size` maps to a density row token (--density-{size}-row-height); `type` defaults to 'button' so
// a Button never accidentally submits a form. The touch floor (44 on coarse pointers, ADR-036
// dec. 5) lives in the primitive's CSS, not per-surface.
//
// fill + secondary are dogfooded by NewConversationDialog (PR-1a); danger + danger-fill are wired by
// the ChannelManagementPanel danger-zone + confirm (PR-1b, their first consumer); ghost awaits its.

export type ButtonVariant = 'fill' | 'secondary' | 'ghost' | 'danger' | 'danger-fill'

export function Button({
  variant = 'fill',
  size = 'cotidiano',
  type = 'button',
  className,
  ...rest
}: {
  variant?: ButtonVariant
  size?: Size
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={className ? `ui-button ${className}` : 'ui-button'}
      data-variant={variant}
      data-size={size}
      {...rest}
    />
  )
}
