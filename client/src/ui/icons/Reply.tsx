import type { IconProps } from './index'

// Reply: a return arrow curving back into the conversation.
export function Reply({ size = 16 }: IconProps) {
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
      <path d="M9 17 4 12l5-5" />
      <path d="M4 12h12a4 4 0 0 1 4 4v2" />
    </svg>
  )
}
