import type { IconProps } from './index'

// Chevron: points down; the Archived section header rotates it via CSS when expanded (ADR-076) —
// one glyph, no second icon.
export function Chevron({ size = 16 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}
