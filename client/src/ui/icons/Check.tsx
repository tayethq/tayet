import type { IconProps } from './index'

// Check: a single tick (manifest workspace.md §25.1 item 2, the export's glyph drawn on the family's
// 24 grid — its 16-unit path scaled by 1.5).
export function Check({ size = 16 }: IconProps) {
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
      <path d="M4.875 12.75 9.75 17.625 19.125 6.75" />
    </svg>
  )
}
