import type { IconProps } from './index'

// More: a afordância de overflow — meatballs horizontais ("..."). Substitui o glifo ⚙ literal no
// channel-header. Pontos são preenchidos: fill currentColor / stroke none por ponto (a família é
// stroke-only, mas ponto exige fill; C6 mantido via currentColor, nunca hex).
export function More({ size = 16 }: IconProps) {
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
      <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  )
}
