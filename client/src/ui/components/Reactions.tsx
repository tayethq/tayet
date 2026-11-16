import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Reaction } from '@tayet/client'
import { Plus } from '../icons'
import { t } from '../i18n'

// Minimal reactions UI (manifest workspace.md §11 items 2–3): existing aggregates as toggle chips
// (highlighted when mine) plus the quick picker. Emoji keys are exact (no normalization) — matching
// the ACL.
const QUICK = ['👍', '🎉', '❤️']

// What a popover can be clipped by: the scrollers that hold a message row.
const CLIP = '.timeline, .thread-panel__root, .thread-panel__replies'

// The quick picker and its trigger, the same popover for the row's `+` and the bar's "Reagir" (§4.10).
// Local markup, below the ADR-036 dec. 3 bar: one consumer, two triggers. It opens above the trigger,
// and below it where the scroller would clip it (the first row on screen).
export function QuickReact({ className, onPick }: { className: string; onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false)
  const [below, setBelow] = useState(false)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)

  const close = (): void => {
    setOpen(false)
    setBelow(false)
  }
  const closeToTrigger = (): void => {
    close()
    triggerRef.current?.focus()
  }

  useLayoutEffect(() => {
    if (!open) return
    const picker = pickerRef.current
    if (!picker) return
    const clip = picker.closest(CLIP)?.getBoundingClientRect()
    if (clip && picker.getBoundingClientRect().top < clip.top) setBelow(true)
    picker.querySelector('button')?.focus()
  }, [open])

  // A click outside closes; focus returns to the trigger unless that click gave it to another control.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent): void => {
      const target = e.target as Element
      if (anchorRef.current?.contains(target)) return
      const focused = document.activeElement
      const stranded = focused === document.body || !!pickerRef.current?.contains(focused)
      close()
      if (stranded) triggerRef.current?.focus()
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [open])

  return (
    <span
      className="reaction-anchor"
      ref={anchorRef}
      onKeyDown={(e) => {
        if (open && e.key === 'Escape') {
          e.stopPropagation()
          closeToTrigger()
        }
      }}
    >
      <button
        type="button"
        className={className}
        ref={triggerRef}
        title={t('timeline.reactOpen')}
        aria-label={t('timeline.reactOpen')}
        aria-expanded={open}
        onClick={() => (open ? closeToTrigger() : setOpen(true))}
      >
        <Plus />
      </button>
      {open && (
        <div
          className={below ? 'reaction-picker reaction-picker--below' : 'reaction-picker'}
          role="group"
          aria-label={t('timeline.reactOpen')}
          ref={pickerRef}
        >
          {QUICK.map((e) => (
            <button
              key={e}
              type="button"
              className="reaction-picker__option"
              aria-label={t('timeline.react', { emoji: e })}
              onClick={() => {
                onPick(e)
                closeToTrigger()
              }}
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

export function Reactions({
  reactions,
  onToggle,
}: {
  reactions: Reaction[]
  onToggle: (emoji: string) => void
}) {
  if (reactions.length === 0) return null
  return (
    <div className="reactions">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          className={r.mine ? 'reaction reaction--mine' : 'reaction'}
          aria-pressed={r.mine}
          onClick={() => onToggle(r.emoji)}
        >
          <span className="reaction__emoji">{r.emoji}</span>
          <span className="reaction__count">{r.count}</span>
        </button>
      ))}
      <QuickReact className="reaction reaction--add" onPick={onToggle} />
    </div>
  )
}
