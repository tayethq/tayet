// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { PeopleFilter, matchesName } from '../../src/ui/components/PeopleFilter'
import { copy } from '../support/copy'

// The filter of people (new-conversation.md §6.2, §9 items 10–11), its own component since PLANO-MOBILE §0.22 P4:
// the same markup and classes "Nova conversa" had, now shared with the channel's two pickers.
afterEach(cleanup)

describe('PeopleFilter', () => {
  it('keeps the markup: the label box, the icon, the field and the ✕ only with a term', () => {
    const onChange = vi.fn()
    const ui = render(<PeopleFilter value="" onChange={onChange} />)
    const box = ui.container.firstElementChild!
    expect(box.tagName).toBe('LABEL')
    expect(box.className).toBe('compose-dialog__filter')
    expect([...box.children].map((c) => c.className)).toEqual(['compose-dialog__filter-icon', 'compose-dialog__filter-input'])
    const input = ui.getByRole('textbox', { name: copy.newConversation.filterPeople })
    expect(input.getAttribute('placeholder')).toBe(copy.newConversation.filterPeople)
    fireEvent.change(input, { target: { value: 'an' } })
    expect(onChange).toHaveBeenCalledWith('an')
    ui.rerender(<PeopleFilter value="an" onChange={onChange} />)
    fireEvent.click(ui.getByRole('button', { name: copy.people.clearFilter }))
    expect(onChange).toHaveBeenLastCalledWith('')
  })

  it('Enter never submits a form from the field', () => {
    const submit = vi.fn((e: Event) => e.preventDefault())
    const ui = render(
      <form onSubmit={(e) => submit(e.nativeEvent)}>
        <PeopleFilter value="x" onChange={() => {}} />
      </form>,
    )
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    ui.getByRole('textbox').dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('matches the name only, without accents and case; an empty term matches all', () => {
    const agent = { displayName: 'Resumo semanal', operatorName: 'Gisele Rocha' }
    expect(matchesName('GISÉ')({ displayName: 'Gisele Rocha' })).toBe(true)
    expect(matchesName('gisele')(agent)).toBe(false)
    expect(matchesName('  ')(agent)).toBe(true)
  })
})
