// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Dialog } from '../../src/ui/primitives'

afterEach(cleanup)

describe('Dialog role', () => {
  it('is a dialog by default', () => {
    const { getByRole, queryByRole } = render(
      <Dialog title="Título" onClose={() => {}}>
        corpo
      </Dialog>,
    )
    expect(getByRole('dialog', { name: 'Título' })).toBeTruthy()
    expect(queryByRole('alertdialog')).toBeNull()
  })

  it('takes alertdialog, and nothing else changes', () => {
    const { getByRole, queryByRole } = render(
      <Dialog role="alertdialog" title="Título" onClose={() => {}}>
        corpo
      </Dialog>,
    )
    const surface = getByRole('alertdialog', { name: 'Título' })
    expect(surface.getAttribute('aria-modal')).toBe('true')
    expect(queryByRole('dialog')).toBeNull()
  })
})
