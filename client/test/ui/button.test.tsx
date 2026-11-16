// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Button } from '../../src/ui/primitives'

// The variant is a semantic role carried by data-variant; its dress is CSS (jsdom computes no cascade).

afterEach(cleanup)

describe('Button', () => {
  it('carries the danger role on data-variant', () => {
    const { getByRole } = render(<Button variant="danger">Sair</Button>)
    expect(getByRole('button').getAttribute('data-variant')).toBe('danger')
  })
})
