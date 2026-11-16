// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import { DataExportDialog } from '../../src/ui/components/DataExportDialog'
import type { Channel, ChannelId, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy } from '../support/copy'
import { controlledExport } from '../support/data-export-fake'

// P1 gate for the data export dialog (mirrors the other *-render-scan files): every state is rendered and
// its innerHTML (text and attributes) scanned for protocol shapes. The gap list's conversations carry
// REAL protocol-shaped ids and peers (the ADR-008 residual); only their names may reach the screen.
// Node's Blob stands in for jsdom's, which has no arrayBuffer() (see data-export-dialog.test.tsx).

const realBlob = globalThis.Blob
const realCreate = URL.createObjectURL
beforeAll(() => {
  globalThis.Blob = NodeBlob as unknown as typeof Blob
  URL.createObjectURL = (() => 'blob:scan/1') as typeof URL.createObjectURL
})
afterAll(() => {
  globalThis.Blob = realBlob
  URL.createObjectURL = realCreate
})
afterEach(cleanup)

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const unread = { count: 0, mentions: 0 }
const gaps: Array<{ channel: Channel; gaps: number }> = [
  { channel: { id: cid('!pub:tayet.local'), name: '#geral', kind: 'public', memberCount: 3, unread }, gaps: 2 },
  { channel: { id: cid('!priv:tayet.local'), name: '#diretoria', kind: 'private', memberCount: 3, unread }, gaps: 14 },
  {
    channel: { id: cid('!dm:tayet.local'), name: 'Bruna Lima', kind: 'dm', memberCount: 2, unread, peer: uid('@bruna:tayet.local') },
    gaps: 3,
  },
  {
    channel: {
      id: cid('!grp:tayet.local'),
      name: 'Ana, Caio',
      kind: 'group',
      memberCount: 3,
      unread,
      participants: [uid('@ana:tayet.local'), uid('@caio:tayet.local')],
    },
    gaps: 1,
  },
]

const flush = () => act(async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
})

const scan = (html: string) => expect(findProtocolLeaksInText(html)).toEqual([])

describe('DOM render-scan (P1) — data export dialog', () => {
  it('leaks no protocol shape in parado, preparando, falha, pronto or incompleto', async () => {
    const fake = controlledExport()
    const { container, getByRole, getByText } = render(<DataExportDialog onExport={fake.verb} onClose={() => {}} />)
    scan(container.innerHTML) // parado

    fireEvent.click(getByRole('button', { name: copy.dataExport.prepare }))
    act(() => fake.push({ t: 'progress', done: 2, total: 5 }))
    await flush()
    expect(getByRole('progressbar')).toBeTruthy()
    scan(container.innerHTML) // preparando

    act(() => fake.fail())
    await flush()
    expect(getByRole('alert')).toBeTruthy()
    scan(container.innerHTML) // falha

    fireEvent.click(getByRole('button', { name: copy.dataExport.prepare }))
    act(() => fake.push({ t: 'progress', done: 5, total: 5 }))
    act(() =>
      fake.push({ t: 'done', totals: { conversations: 5, messages: 9, deleted: 0, attachments: 0, gaps: 0 }, incomplete: [] }),
    )
    await waitFor(() => expect(getByText(copy.dataExport.ready)).toBeTruthy())
    scan(container.innerHTML) // pronto
    cleanup()

    const again = controlledExport()
    const second = render(<DataExportDialog onExport={again.verb} onClose={() => {}} />)
    fireEvent.click(second.getByRole('button', { name: copy.dataExport.prepare }))
    act(() => again.push({ t: 'done', totals: { conversations: 5, messages: 9, deleted: 0, attachments: 0, gaps: 20 }, incomplete: gaps }))
    await waitFor(() => expect(second.getByText(copy.dataExport.readyWithGaps)).toBeTruthy())
    const html = second.container.innerHTML
    scan(html) // incompleto
    for (const name of ['geral', 'diretoria', 'Bruna Lima', 'Ana, Caio']) expect(second.container.textContent).toContain(name)
    expect(html).not.toContain('tayet.local')
  })
})
