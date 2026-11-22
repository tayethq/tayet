// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { encode } from 'uqr'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OpenOnPhoneDialog } from '../../src/ui/components/OpenOnPhoneDialog'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy } from '../support/copy'

// "Abrir no celular" (account-access.md §13.1; PLANO-MOBILE M7 Q1, Q2): what is encoded, how it is named and
// that the address is written nowhere (P1).

vi.mock('uqr', async (original) => {
  const real = await original<typeof import('uqr')>()
  return { ...real, encode: vi.fn(real.encode) }
})

afterEach(() => {
  cleanup()
  vi.mocked(encode).mockClear()
  window.history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})

async function open() {
  const onClose = vi.fn()
  const view = render(<OpenOnPhoneDialog onClose={onClose} />)
  await waitFor(() => expect(view.getByRole('img', { name: copy.account.openOnPhoneCode })).toBeTruthy())
  return { ...view, onClose }
}

describe('"Abrir no celular"', () => {
  it("encodes the app's origin and nothing else, whatever the page's path and query", async () => {
    window.history.replaceState(null, '', '/algum/caminho?code=abc&state=def#frag')
    await open()
    expect(encode).toHaveBeenCalledTimes(1)
    expect(vi.mocked(encode).mock.calls[0]![0]).toBe(window.location.origin)
  })

  it('draws every dark module of the matrix, with the quiet zone', async () => {
    const view = await open()
    const { size, data } = vi.mocked(encode).mock.results[0]!.value as ReturnType<typeof encode>
    const svg = view.getByRole('img', { name: copy.account.openOnPhoneCode })
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${size} ${size}`)
    const drawn = [...svg.querySelector('path')!.getAttribute('d')!.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map((m) => `${m[1]},${m[2]}`)
    expect(drawn).toEqual(data.flatMap((r, y) => r.flatMap((dark, x) => (dark ? [`${x},${y}`] : []))))
    for (const at of drawn) {
      for (const n of at.split(',').map(Number)) {
        expect(n).toBeGreaterThanOrEqual(4)
        expect(n).toBeLessThan(size - 4)
      }
    }
  })

  it('never writes the address: not as text, not in any attribute', async () => {
    const view = await open()
    const { origin, host, hostname } = window.location
    const html = view.container.innerHTML
    for (const part of [origin, host, hostname]) expect(html).not.toContain(part)
    expect(view.container.querySelector('a, [title], input')).toBeNull()
    expect(findProtocolLeaksInText(html)).toEqual([])
  })

  it('the shell: title, paragraph, code, help, and "Fechar" as the only action of the footer', async () => {
    const view = await open()
    expect(view.getByRole('dialog', { name: copy.account.openOnPhone })).toBeTruthy()
    expect([...view.container.querySelector('.data-export__body')!.children].map((el) => el.textContent)).toEqual([
      copy.account.openOnPhoneBody,
      '',
      copy.account.openOnPhoneHelp,
    ])
    const buttons = view.container.querySelectorAll<HTMLButtonElement>('.ui-dialog__footer button')
    expect([...buttons].map((b) => b.textContent)).toEqual([copy.dialog.close])
    fireEvent.click(buttons[0]!)
    expect(view.onClose).toHaveBeenCalledTimes(1)
  })

  it('a failed encoder leaves the square empty and logs no address', async () => {
    vi.mocked(encode).mockImplementationOnce(() => {
      throw new Error(window.location.origin)
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = render(<OpenOnPhoneDialog onClose={() => {}} />)
    await waitFor(() => expect(error).toHaveBeenCalledWith('[open-on-phone] encoder not loaded'))
    expect(view.queryByRole('img')).toBeNull()
  })

  it('the encoder is only ever a dynamic import of the dialog', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'components', 'OpenOnPhoneDialog.tsx'), 'utf8')
    expect(src).toContain("import('uqr')")
    expect(src).not.toMatch(/from 'uqr'/)
  })
})
