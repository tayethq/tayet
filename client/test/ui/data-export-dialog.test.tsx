// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import { render, cleanup, fireEvent, act, waitFor, within } from '@testing-library/react'
import { DataExportDialog } from '../../src/ui/components/DataExportDialog'
import { exportFileName, formatSize } from '../../src/ui/useDataExport'
import { ptBR } from '../../src/ui/i18n/pt-BR'
import type { Channel, ChannelId, DataExportPart } from '../../src/acl'
import { controlledExport, noExport } from '../support/data-export-fake'
import { readZip } from '../support/zip-reader'
import { fill } from '../support/copy'

// The data export dialog and its hook (manifesto account-access.md §12; ADR-096 dec. 6;
// PLANO-EXPORT-DADOS §0.3.6). The verb is a fake whose parts the test hands out. Copy is asserted by the
// catalog's value (ADR-080 D5).
//
// jsdom's Blob has no arrayBuffer(), which the zip writer reads the CRC with; the browser's has. This file
// runs on Node's Blob, and captures the object URL's Blob to read the archive back.

const copy = ptBR.dataExport
const realBlob = globalThis.Blob
const urls = new Map<string, Blob>()
let revoked: string[] = []

beforeAll(() => {
  globalThis.Blob = NodeBlob as unknown as typeof Blob
  let n = 0
  URL.createObjectURL = ((blob: Blob) => {
    const url = `blob:test/${++n}`
    urls.set(url, blob)
    return url
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = ((url: string) => {
    revoked.push(url)
  }) as typeof URL.revokeObjectURL
})
afterAll(() => {
  globalThis.Blob = realBlob
})
afterEach(() => {
  cleanup()
  urls.clear()
  revoked = []
  vi.restoreAllMocks()
})

const cid = (s: string): ChannelId => s as unknown as ChannelId
const channel = (kind: Channel['kind'], name: string, id: string): Channel => ({
  id: cid(id),
  name,
  kind,
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
})

const done = (
  conversations: number,
  incomplete: Array<{ channel: Channel; gaps: number }> = [],
): DataExportPart => ({
  t: 'done',
  totals: { conversations, messages: 4, deleted: 0, attachments: 1, gaps: incomplete.reduce((s, g) => s + g.gaps, 0) },
  incomplete,
})

// Lets the hook's async loop take the parts handed out so far.
const flush = () => act(async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
})

function setup() {
  const fake = controlledExport()
  const onClose = vi.fn()
  const view = render(<DataExportDialog onExport={fake.verb} onClose={onClose} />)
  const dialog = () => view.getByRole('dialog', { name: copy.title })
  const button = (name: string) => within(dialog()).getByRole('button', { name })
  return { fake, onClose, view, dialog, button }
}

async function startPreparing() {
  const s = setup()
  fireEvent.click(s.button(copy.prepare))
  await flush()
  return s
}

describe('DataExportDialog — parado', () => {
  it('shows the artboard copy; "Preparar cópia" has the focus; Cancelar, ✕ and Esc close', () => {
    const { dialog, button, onClose } = setup()
    const text = dialog().textContent ?? ''
    for (const line of [copy.title, copy.intro, copy.includesLabel, ...Object.values(copy.includes), copy.othersExcluded])
      expect(text).toContain(line)
    expect(within(dialog()).getByRole('list', { name: copy.includesLabel }).querySelectorAll('li')).toHaveLength(6)
    expect(within(dialog()).queryByRole('alert')).toBeNull()
    expect(document.activeElement).toBe(button(copy.prepare))
    fireEvent.click(button(ptBR.account.cancel))
    fireEvent.click(button(ptBR.dialog.close))
    fireEvent.keyDown(dialog(), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(3)
  })
})

describe('DataExportDialog — preparando', () => {
  it('passes the catalog README, the unnamed-access copy and a signal to the verb', async () => {
    const { fake } = await startPreparing()
    expect(fake.runs).toHaveLength(1)
    const { opts } = fake.runs[0]!
    expect(opts.readme).toBe(copy.readme)
    expect(opts.unnamedAccess).toBe(ptBR.account.accessUnknown)
    expect(opts.signal).toBeInstanceOf(AbortSignal)
    expect(opts.signal!.aborted).toBe(false)
  })

  it('status, count per conversation and a determinate bar; "Cancelar" has the focus', async () => {
    const { fake, dialog, button } = await startPreparing()
    expect(within(dialog()).getByRole('status').textContent).toContain(copy.preparing)
    act(() => fake.push({ t: 'progress', done: 0, total: 3 }))
    await flush()
    const bar = within(dialog()).getByRole('progressbar', { name: copy.preparingLabel })
    expect(within(dialog()).getByRole('status').textContent).toContain(fill(copy.progress.other, { done: 0, n: 3 }))
    expect([bar.getAttribute('aria-valuemin'), bar.getAttribute('aria-valuemax'), bar.getAttribute('aria-valuenow')]).toEqual(['0', '3', '0'])
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('0%')
    act(() => fake.push({ t: 'progress', done: 1, total: 3 }))
    await flush()
    expect(bar.getAttribute('aria-valuenow')).toBe('1')
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('33%')
    expect(within(dialog()).getByText(fill(copy.progress.other, { done: 1, n: 3 }))).toBeTruthy()
    expect(dialog().textContent).toContain(copy.keepOpen)
    expect(document.activeElement).toBe(button(ptBR.account.cancel))
    expect(within(dialog()).queryByRole('button', { name: copy.prepare })).toBeNull()
  })

  it('a single conversation reads in the singular; an account with none reads "0 de 0 conversas" at 0%', async () => {
    const { fake, dialog } = await startPreparing()
    act(() => fake.push({ t: 'progress', done: 0, total: 0 }))
    await flush()
    const bar = within(dialog()).getByRole('progressbar')
    expect(within(dialog()).getByText(fill(copy.progress.other, { done: 0, n: 0 }))).toBeTruthy()
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('0%')
    expect(bar.getAttribute('aria-valuemax')).toBe('0')
    act(() => fake.push({ t: 'progress', done: 1, total: 1 }))
    await flush()
    expect(within(dialog()).getByText(fill(copy.progress.one, { done: 1, n: 1 }))).toBeTruthy()
  })

  it('"Cancelar" goes back to parado at once, aborts the signal and ignores the run afterwards', async () => {
    const { fake, dialog, button } = await startPreparing()
    act(() => fake.push({ t: 'progress', done: 1, total: 3 }))
    await flush()
    fireEvent.click(button(ptBR.account.cancel))
    expect(within(dialog()).getByRole('button', { name: copy.prepare })).toBeTruthy()
    expect(fake.runs[0]!.opts.signal!.aborted).toBe(true)
    await flush()
    // The aborted verb rejects; nothing of that run reaches the screen.
    expect(within(dialog()).queryByRole('alert')).toBeNull()
    expect(within(dialog()).queryByRole('progressbar')).toBeNull()
    expect(fake.runs[0]!.finished).toBe(true)
    expect(document.activeElement).toBe(button(copy.prepare))
  })

  it('closing during the preparation (✕) closes and aborts: unmounting the dialog cancels', async () => {
    const { fake, button, onClose, view } = await startPreparing()
    fireEvent.click(button(ptBR.dialog.close))
    expect(onClose).toHaveBeenCalledOnce()
    view.unmount()
    expect(fake.runs[0]!.opts.signal!.aborted).toBe(true)
  })
})

describe('DataExportDialog — falha', () => {
  it('a rejection that is not a cancel is the failure state; "Preparar cópia" starts over and drops the error', async () => {
    const { fake, dialog, button } = await startPreparing()
    act(() => fake.push({ t: 'progress', done: 1, total: 3 }))
    act(() => fake.fail(new Error('connection')))
    await flush()
    const alert = within(dialog()).getByRole('alert')
    expect(alert.textContent).toBe(copy.failed)
    // The failure is parado with the error line at the end of the body (§12.1 item 7).
    expect(dialog().textContent).toContain(copy.intro)
    expect(document.activeElement).toBe(button(copy.prepare))
    fireEvent.click(button(copy.prepare))
    await flush()
    expect(fake.runs).toHaveLength(2)
    expect(within(dialog()).queryByRole('alert')).toBeNull()
    expect(within(dialog()).getByRole('progressbar')).toBeTruthy()
  })

  it('a zip writer failure is the failure state too, and the iterator is closed', async () => {
    const { fake, dialog } = await startPreparing()
    const broken = new Blob(['x'])
    broken.slice = () => {
      throw new Error('gone')
    }
    act(() => fake.push({ t: 'attachment', path: 'attachments/c1/m1-a.pdf', data: broken }))
    await flush()
    expect(within(dialog()).getByRole('alert').textContent).toBe(copy.failed)
    expect(fake.closed).toBe(1)
  })

  it('parts that end without the last one are a failure', async () => {
    const fake = controlledExport()
    const ended = (opts: Parameters<typeof fake.verb>[0]) => {
      fake.verb(opts)
      return noExport()
    }
    const view = render(<DataExportDialog onExport={ended} onClose={() => {}} />)
    fireEvent.click(view.getByRole('button', { name: copy.prepare }))
    await flush()
    expect(view.getByRole('alert').textContent).toBe(copy.failed)
  })
})

describe('DataExportDialog — pronto', () => {
  async function ready(conversations = 3) {
    const s = await startPreparing()
    act(() => s.fake.push({ t: 'progress', done: 0, total: conversations }))
    act(() => s.fake.push({ t: 'attachment', path: 'attachments/c1/m1-relatório.pdf', data: new Blob([new Uint8Array([1, 2, 3])]) }))
    act(() => s.fake.push({ t: 'file', path: 'conversations/c1.json', content: '{}\n' }))
    act(() => s.fake.push({ t: 'progress', done: conversations, total: conversations }))
    act(() => s.fake.push({ t: 'file', path: 'README.txt', content: copy.readme + '\n' }))
    act(() => s.fake.push(done(conversations)))
    await waitFor(() => expect(within(s.dialog()).getByText(copy.ready)).toBeTruthy())
    return s
  }

  it('title, summary with the zip size, warning; "Baixar arquivo" in the body has the focus; "Fechar" closes', async () => {
    const { dialog, button, onClose, fake } = await ready()
    const [url, blob] = [...urls.entries()][0]!
    expect(url).toBeTruthy()
    const text = dialog().textContent ?? ''
    expect(text).toContain(`${fill(copy.conversations.other, { n: 3 })} · ${formatSize(blob.size, 'pt-BR')}`)
    expect(text).toContain(copy.warning)
    expect(text).not.toContain(copy.readyWithGaps)
    expect(within(dialog()).queryByRole('list')).toBeNull()
    expect(document.activeElement).toBe(button(copy.download))
    // The download sits in the body; the footer holds only "Fechar".
    const footer = dialog().querySelector('.ui-dialog__footer')!
    expect([...footer.querySelectorAll('button')].map((b) => b.textContent)).toEqual([ptBR.dialog.close])
    // The loop left at `done`: the iterator was closed.
    expect(fake.closed).toBe(1)
    fireEvent.click(within(footer as HTMLElement).getByRole('button', { name: ptBR.dialog.close }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('the archive holds the parts at the root, with the paths the boundary gave', async () => {
    await ready()
    const blob = [...urls.values()][0]!
    expect(blob.type).toBe('application/zip')
    const archive = readZip(Buffer.from(await blob.arrayBuffer()))
    expect(archive.entries.map((e) => e.name)).toEqual(['attachments/c1/m1-relatório.pdf', 'conversations/c1.json', 'README.txt'])
    expect([...archive.entries[0]!.data]).toEqual([1, 2, 3])
    expect(archive.entries[2]!.data.toString('utf8')).toBe(copy.readme + '\n')
  })

  it('"Baixar arquivo" fires a temporary <a download> each time; closing revokes the URL', async () => {
    const clicks: Array<{ href: string; download: string; attached: boolean }> = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ href: this.href, download: this.download, attached: this.isConnected })
    })
    const { button, view } = await ready()
    const url = [...urls.keys()][0]!
    fireEvent.click(button(copy.download))
    fireEvent.click(button(copy.download))
    expect(clicks).toHaveLength(2)
    for (const c of clicks) {
      expect(c.href).toBe(url)
      expect(c.download).toMatch(/^tayet-export-\d{4}-\d{2}-\d{2}\.zip$/)
      expect(c.download).toBe(exportFileName(new Date()))
      expect(c.attached).toBe(true)
    }
    expect(document.querySelectorAll('a[download]')).toHaveLength(0)
    expect(revoked).toEqual([])
    view.unmount()
    expect(revoked).toEqual([url])
  })

  it('one conversation reads in the singular', async () => {
    const { dialog } = await ready(1)
    expect(dialog().textContent).toContain(`${fill(copy.conversations.one, { n: 1 })} · `)
  })
})

describe('DataExportDialog — incompleto', () => {
  async function incomplete(gaps: Array<{ channel: Channel; gaps: number }>) {
    const s = await startPreparing()
    act(() => s.fake.push({ t: 'progress', done: 0, total: 6 }))
    act(() => s.fake.push(done(6, gaps)))
    await waitFor(() => expect(within(s.dialog()).getByText(copy.readyWithGaps)).toBeTruthy())
    return s
  }

  it('lists each conversation with its mark column, bare name and message count; no "Tentar de novo"', async () => {
    const { dialog, button } = await incomplete([
      { channel: channel('public', '#geral', '!pub:tayet.local'), gaps: 1 },
      { channel: channel('private', '#diretoria', '!priv:tayet.local'), gaps: 14 },
      { channel: channel('dm', 'Bruna Lima', '!dm:tayet.local'), gaps: 3 },
      { channel: channel('group', 'Ana, Caio', '!grp:tayet.local'), gaps: 2 },
    ])
    const text = dialog().textContent ?? ''
    expect(text).toContain(fill(copy.gapsIntro.other, { n: 4 }))
    expect(text).toContain(copy.warning)
    const rows = [...dialog().querySelectorAll('.data-export__gap')] as HTMLElement[]
    expect(rows).toHaveLength(4)
    const mark = (row: HTMLElement) => row.querySelector('.data-export__mark') as HTMLElement
    const name = (row: HTMLElement) => row.querySelector('.data-export__gap-name')!.textContent
    expect(rows.map(name)).toEqual(['geral', 'diretoria', 'Bruna Lima', 'Ana, Caio'])
    expect(mark(rows[0]!).textContent).toBe('#')
    expect(within(mark(rows[1]!)).getByRole('img', { name: ptBR.channel.privateMark })).toBeTruthy()
    expect(mark(rows[2]!).textContent).toBe('')
    expect(mark(rows[3]!).textContent).toBe('')
    expect(rows.map((r) => r.lastElementChild!.textContent)).toEqual([
      fill(copy.gapMessages.one, { n: 1 }),
      fill(copy.gapMessages.other, { n: 14 }),
      fill(copy.gapMessages.other, { n: 3 }),
      fill(copy.gapMessages.other, { n: 2 }),
    ])
    expect(within(dialog()).queryByRole('button', { name: ptBR.account.resetTryAgain })).toBeNull()
    expect(document.activeElement).toBe(button(copy.download))
  })

  it('one conversation with gaps reads in the singular', async () => {
    const { dialog } = await incomplete([{ channel: channel('private', '#diretoria', '!priv:tayet.local'), gaps: 1 }])
    expect(dialog().textContent).toContain(fill(copy.gapsIntro.one, { n: 1 }))
  })
})

describe('file name and size', () => {
  it('names the file with the local date', () => {
    expect(exportFileName(new Date(2026, 0, 5, 23, 59))).toBe('tayet-export-2026-01-05.zip')
  })

  it('decimal units: the largest with a value of 1 or more, one decimal under 10 (H1: "214 MB")', () => {
    expect(formatSize(214e6, 'pt-BR')).toBe('214 MB')
    expect(formatSize(12_345_678, 'pt-BR')).toBe('12 MB')
    expect(formatSize(9_400_000, 'pt-BR')).toBe('9,4 MB')
    expect(formatSize(1_500, 'pt-BR')).toBe('1,5 kB')
    expect(formatSize(2.5e9, 'pt-BR')).toBe('2,5 GB')
    expect(formatSize(999, 'pt-BR')).toBe('999 bytes')
  })

  it('rounding decides the decimal place', () => {
    expect(formatSize(9_960_000, 'pt-BR')).toBe('10 MB')
    expect(formatSize(9_940_000, 'pt-BR')).toBe('9,9 MB')
    expect(formatSize(9_960, 'pt-BR')).toBe('10 kB')
  })

  it('rounding decides the unit', () => {
    expect(formatSize(999_600, 'pt-BR')).toBe('1,0 MB')
    expect(formatSize(999_400, 'pt-BR')).toBe('999 kB')
    expect(formatSize(999_600_000, 'pt-BR')).toBe('1,0 GB')
  })
})
