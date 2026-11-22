import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

// What a full screen over the conversation does on the narrow window (PLANO-MOBILE M8): the focus on its back
// while it is in front, given back to what opened it when it leaves; Esc is its back; covered, it stays
// mounted (its scroll survives), hidden and inert. Behaviour only: each surface draws its own screen.
export function useCoveringScreen(onEscape: () => void, covered = false) {
  const backRef = useRef<HTMLButtonElement>(null)
  // Read at the first render, before what had the focus turns inert.
  const [opener] = useState(() => document.activeElement)
  useLayoutEffect(() => {
    if (!covered) backRef.current?.focus()
  }, [covered])
  // After the commit, when what is under is no longer inert. With a modal on screen the focus is the modal's:
  // given back only to an opener inside it (a sheet the agent's form opened over).
  useEffect(
    () => () => {
      if (!(opener instanceof HTMLElement) || !opener.isConnected) return
      const modal = document.querySelector('[aria-modal="true"]')
      if (!modal || modal.contains(opener)) opener.focus()
    },
    [opener],
  )
  const screenProps = {
    'data-stack-covered': covered ? '' : undefined,
    inert: covered,
    onKeyDown: (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onEscape()
    },
  }
  return { backRef, screenProps }
}
