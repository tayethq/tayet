// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRef } from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { ScreenHeader } from '../../src/ui/primitives'
import { t } from '../../src/ui/i18n'

// ScreenHeader: back on the left, the title over an optional subtitle, an
// optional leading block and action. Its geometry is CSS (jsdom computes no cascade).

afterEach(cleanup)

describe('ScreenHeader', () => {
  it('back is a named button that calls onBack; the title is a heading', () => {
    const onBack = vi.fn()
    const { getByRole } = render(<ScreenHeader title="Thread" onBack={onBack} />)
    const back = getByRole('button', { name: t('dialog.back') })
    fireEvent.click(back)
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(getByRole('heading', { level: 2, name: 'Thread' })).toBeTruthy()
  })

  it('subtitle, leading block and action render in order; without a subtitle there is no subtitle node', () => {
    const { container, rerender } = render(
      <ScreenHeader
        title="#financeiro"
        subtitle="Fechamento do mês"
        leading={<span data-testid="lead" />}
        action={<button type="button">Detalhes</button>}
        onBack={() => {}}
      />,
    )
    const header = container.querySelector('header.ui-screen-header')!
    const kids = [...header.children].map((el) => el.className || el.getAttribute('data-testid') || el.textContent)
    expect(kids).toEqual(['ui-screen-header__back', 'lead', 'ui-screen-header__heading', 'Detalhes'])
    expect(header.querySelector('.ui-screen-header__subtitle')?.textContent).toBe('Fechamento do mês')
    rerender(<ScreenHeader title="Thread" onBack={() => {}} />)
    expect(container.querySelector('.ui-screen-header__subtitle')).toBeNull()
  })

  it('backRef reaches the back button (the stack focuses it on push)', () => {
    const ref = createRef<HTMLButtonElement>()
    render(<ScreenHeader title="x" onBack={() => {}} backRef={ref} />)
    expect(ref.current?.classList.contains('ui-screen-header__back')).toBe(true)
  })
})
