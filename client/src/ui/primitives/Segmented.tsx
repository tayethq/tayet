// Segmented (leaf, ADR-036). A single-select rail of mutually-exclusive options rendered as a
// role=group of aria-pressed buttons (the active segment reads accent-wash/accent). Generic over a
// string value union — protocol-agnostic: the caller maps its own domain enum to {value, label}.
// The rail hugs its content; `fill` splits the available width evenly between the segments. `disabled`
// holds every segment while the caller's verb runs (the role pair, channel-management.md §13.2 item 4).

export type SegmentedOption<T extends string> = { value: T; label: string }

export function Segmented<T extends string>({
  ariaLabel,
  value,
  options,
  onChange,
  fill = false,
  disabled = false,
}: {
  ariaLabel: string
  value: T
  options: ReadonlyArray<SegmentedOption<T>>
  onChange: (value: T) => void
  fill?: boolean
  disabled?: boolean
}) {
  return (
    <div
      className={fill ? 'ui-segmented ui-segmented--fill' : 'ui-segmented'}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const on = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            className={
              on ? 'ui-segmented__segment ui-segmented__segment--on' : 'ui-segmented__segment'
            }
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
