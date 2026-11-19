import { describe, it, expect, afterEach } from 'vitest'
import { ReadError } from '../../src/core/read'
import { WriteError } from '../../src/core/write'
import type { PanelFacade, PanelWrite } from '../../src/core/panels'
import { GENERAL } from '../support/slack-world'
import { callTool, idShapeLeaks, startMcp, type Era, type McpHarness, type ToolAnswer } from '../support/mcp-world'

// The pinned panel tools (A3-6; ADR-091, Proposto, dec. 13; PLANO-AGENTES §0.3.16 item 13): set_panel and
// clear_panel over a fake facade — the shapes, Markdown by default, the native limits and preflight, the
// facade's errors, and no facade.

function fakePanels() {
  const calls: unknown[] = []
  let pending = false
  const panels: PanelFacade = {
    set: (c, w: PanelWrite) => {
      calls.push(['set', c, w])
      if (c === 'CBBBBBBBBBB') return Promise.reject(new WriteError('not_member'))
      if (c === 'CZZZZZZZZZZ') return Promise.reject(new ReadError('conversation_not_found'))
      pending = true
      return Promise.resolve({ conversation: c, pending: true })
    },
    clear: (c) => {
      calls.push(['clear', c])
      return Promise.resolve(pending ? { conversation: c, pending: true as const } : { conversation: c, pending: false as const })
    },
    get: (c) => Promise.resolve({ conversation: c, panel: null, pending }),
  }
  return { panels, calls }
}

let h: McpHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

const ok = (a: ToolAnswer): Record<string, unknown> => {
  expect(a.isError).not.toBe(true)
  expect(JSON.parse(a.content[0]?.text ?? 'null')).toEqual(a.structuredContent)
  expect(idShapeLeaks(a.structuredContent)).toEqual([])
  return a.structuredContent as Record<string, unknown>
}
const refused = (a: ToolAnswer): string => {
  expect(a.isError).toBe(true)
  return a.content[0]?.text ?? ''
}

describe.each<Era>(['legacy', 'modern'])('panel tools (%s era)', (era) => {
  it('set_panel: answers when queued; Markdown by default; the title passes; markdown: false is literal', async () => {
    const f = fakePanels()
    h = await startMcp({ panels: f.panels })
    const c = await h.client(era)
    expect(ok(await callTool(c, 'set_panel', { conversation: GENERAL.id, text: 'Build **verde**', title: 'Verificar o cofre' }))).toEqual({ conversation: GENERAL.id, pending: true })
    ok(await callTool(c, 'set_panel', { conversation: GENERAL.id, text: '**cru**', markdown: false }))
    expect(f.calls).toEqual([
      ['set', GENERAL.id, { text: 'Build **verde**', title: 'Verificar o cofre', rich: [{ t: 'p', children: [{ t: 'text', text: 'Build ' }, { t: 'strong', children: [{ t: 'text', text: 'verde' }] }] }] }],
      ['set', GENERAL.id, { text: '**cru**' }],
    ])
  })

  it('clear_panel: `pending: false` with nothing to clear, `pending: true` once a write waits', async () => {
    const f = fakePanels()
    h = await startMcp({ panels: f.panels })
    const c = await h.client(era)
    expect(ok(await callTool(c, 'clear_panel', { conversation: GENERAL.id }))).toEqual({ conversation: GENERAL.id, pending: false })
    ok(await callTool(c, 'set_panel', { conversation: GENERAL.id, text: 'x' }))
    expect(ok(await callTool(c, 'clear_panel', { conversation: GENERAL.id }))).toEqual({ conversation: GENERAL.id, pending: true })
  })

  it('the limits and the preflight before the facade; the facade’s refusals keep their codes', async () => {
    const f = fakePanels()
    h = await startMcp({ panels: f.panels })
    const c = await h.client(era)
    expect(refused(await callTool(c, 'set_panel', { conversation: GENERAL.id, text: '  ' }))).toBe('invalid_argument')
    expect(refused(await callTool(c, 'set_panel', { conversation: GENERAL.id, text: 'x'.repeat(8 * 1024 + 1) }))).toBe('payload_too_large')
    expect(refused(await callTool(c, 'set_panel', { conversation: GENERAL.id, text: 'com @alice:tayet.local' }))).toBe('content_refused')
    const inTitle = await callTool(c, 'set_panel', { conversation: GENERAL.id, text: 'ok', title: 'sala !abc:tayet.local' })
    expect(refused(inTitle)).toBe('content_refused')
    expect(inTitle.structuredContent).toEqual({ code: 'content_refused', refused: [{ field: 'panel.title', pattern: 'conversation_id' }] })
    expect(f.calls).toEqual([])
    expect(refused(await callTool(c, 'set_panel', { conversation: 'CBBBBBBBBBB', text: 'x' }))).toBe('not_member')
    expect(refused(await callTool(c, 'set_panel', { conversation: 'CZZZZZZZZZZ', text: 'x' }))).toBe('conversation_not_found')
  })

  it('without the facade both answer `unavailable`', async () => {
    h = await startMcp()
    const c = await h.client(era)
    expect(refused(await callTool(c, 'set_panel', { conversation: GENERAL.id, text: 'x' }))).toBe('unavailable')
    expect(refused(await callTool(c, 'clear_panel', { conversation: GENERAL.id }))).toBe('unavailable')
  })
})
