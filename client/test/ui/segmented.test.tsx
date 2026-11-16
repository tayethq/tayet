// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { Segmented } from '../../src/ui/primitives'

const options = [
  { value: 'a', label: 'Um' },
  { value: 'b', label: 'Dois' },
] as const

afterEach(cleanup)

describe('Segmented (ADR-036; joined rail, account-access.md §2)', () => {
  it('renders a labelled group whose active segment alone is pressed and carries --on', () => {
    const { getByRole } = render(
      <Segmented ariaLabel="Tipo" value="b" options={options} onChange={() => {}} />,
    )
    const group = getByRole('group', { name: 'Tipo' })
    expect(group.className).toBe('ui-segmented')
    const off = getByRole('button', { name: 'Um' })
    const on = getByRole('button', { name: 'Dois' })
    expect(off.getAttribute('aria-pressed')).toBe('false')
    expect(off.className).toBe('ui-segmented__segment')
    expect(on.getAttribute('aria-pressed')).toBe('true')
    expect(on.className).toBe('ui-segmented__segment ui-segmented__segment--on')
  })

  it('`fill` adds the modifier that splits the width', () => {
    const { getByRole } = render(
      <Segmented ariaLabel="Tipo" value="a" options={options} onChange={() => {}} fill />,
    )
    expect(getByRole('group').className).toBe('ui-segmented ui-segmented--fill')
  })

  it('reports the clicked value', () => {
    const onChange = vi.fn()
    const { getByRole } = render(
      <Segmented ariaLabel="Tipo" value="a" options={options} onChange={onChange} />,
    )
    fireEvent.click(getByRole('button', { name: 'Dois' }))
    expect(onChange).toHaveBeenCalledWith('b')
  })
})
