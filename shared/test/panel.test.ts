import { describe, it, expect } from 'vitest'
import {
  PANEL_BLOCK,
  PANEL_MSGTYPE,
  PANEL_REL_TYPE,
  PANEL_TITLE_MAX,
  buildPanelContent,
  buildPanelEditContent,
  readPanelBlock,
} from '../src/internal'
import type { RichDoc } from '../src'

// ADR-091 (Proposto) dec. 12, A3-5 (PLANO-AGENTES §0.3.18 items 1–2): the pinned panel's block, read
// pure, and the builders of a new panel and of its edits (the clear included).

const CREATE_ID = '$create:tayet.local'
const PANEL_ID = '$panel:tayet.local'
const RICH: RichDoc = [{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'hoje' }] }] }]
const wire = (content: unknown): string => JSON.stringify(content)
const panel = (block?: unknown): Record<string, unknown> => ({
  msgtype: PANEL_MSGTYPE,
  body: 'corpo',
  ...(block !== undefined && { [PANEL_BLOCK]: block }),
})

describe('readPanelBlock', () => {
  it('a valid title is read; cleared is false', () => {
    expect(readPanelBlock(panel({ title: 'Produção de hoje' }))).toEqual({ title: 'Produção de hoje', cleared: false })
  })

  it('a title of exactly 75 characters is kept; surrounding space is trimmed', () => {
    const title = 'á'.repeat(PANEL_TITLE_MAX)
    expect(readPanelBlock(panel({ title: `  ${title} ` }))).toEqual({ title, cleared: false })
  })

  it('a title outside the rule leaves the panel without a title (never an error)', () => {
    for (const title of ['x'.repeat(PANEL_TITLE_MAX + 1), 'duas\nlinhas', 'cr\rlf', 'sep arador', '   ', '', 42, null, ['t'], { t: 1 }]) {
      expect(readPanelBlock(panel({ title }))).toEqual({ cleared: false })
    }
  })

  it('the clearing mark', () => {
    expect(readPanelBlock(panel({ cleared: true }))).toEqual({ cleared: true })
    // Only `true` clears.
    expect(readPanelBlock(panel({ cleared: 'yes' }))).toEqual({ cleared: false })
  })

  it('no block → a panel without a title, not cleared', () => {
    expect(readPanelBlock(panel())).toEqual({ cleared: false })
  })

  it('malformed: a block that is not an object, or content that is not a panel → undefined', () => {
    for (const block of ['title', 7, null, ['x'], true]) expect(readPanelBlock(panel(block))).toBeUndefined()
    expect(readPanelBlock({ msgtype: 'm.text', body: 'x', [PANEL_BLOCK]: { title: 't' } })).toBeUndefined()
    expect(readPanelBlock({ body: 'x' })).toBeUndefined()
  })
})

describe('buildPanelContent', () => {
  it('panel type, content, block with the title, relation to the creation event last', () => {
    const content = buildPanelContent('hoje', RICH, 'Produção de hoje', CREATE_ID)
    expect(wire(content)).toBe(
      `{"msgtype":"${PANEL_MSGTYPE}","body":"hoje","format":"org.matrix.custom.html","formatted_body":"<p><strong>hoje</strong></p>",` +
        `"${PANEL_BLOCK}":{"title":"Produção de hoje"},"m.relates_to":{"rel_type":"${PANEL_REL_TYPE}","event_id":"${CREATE_ID}"}}`,
    )
    expect(readPanelBlock(content)).toEqual({ title: 'Produção de hoje', cleared: false })
  })

  it('no title → an empty block', () => {
    const content = buildPanelContent('só texto', undefined, undefined, CREATE_ID)
    expect(wire(content)).toBe(
      `{"msgtype":"${PANEL_MSGTYPE}","body":"só texto","${PANEL_BLOCK}":{},"m.relates_to":{"rel_type":"${PANEL_REL_TYPE}","event_id":"${CREATE_ID}"}}`,
    )
    expect(readPanelBlock(content)).toEqual({ cleared: false })
  })
})

describe('buildPanelEditContent', () => {
  it('an edit: the new content inside m.new_content, the starred fallback, an m.replace to the panel', () => {
    const content = buildPanelEditContent({ text: 'amanhã', title: 'Plano' }, PANEL_ID)
    expect(wire(content)).toBe(
      `{"msgtype":"${PANEL_MSGTYPE}","body":"* amanhã","m.new_content":{"msgtype":"${PANEL_MSGTYPE}","body":"amanhã","${PANEL_BLOCK}":{"title":"Plano"}},` +
        `"m.relates_to":{"rel_type":"m.replace","event_id":"${PANEL_ID}"}}`,
    )
    expect(readPanelBlock(content['m.new_content'])).toEqual({ title: 'Plano', cleared: false })
  })

  it('an edit with rich content and no title', () => {
    const content = buildPanelEditContent({ text: 'hoje', rich: RICH }, PANEL_ID)
    expect(content['m.new_content']).toMatchObject({ format: 'org.matrix.custom.html', formatted_body: '<p><strong>hoje</strong></p>', [PANEL_BLOCK]: {} })
  })

  it('the clear: the mark, an empty body, no title', () => {
    const content = buildPanelEditContent({ cleared: true }, PANEL_ID)
    expect(wire(content)).toBe(
      `{"msgtype":"${PANEL_MSGTYPE}","body":"* ","m.new_content":{"msgtype":"${PANEL_MSGTYPE}","body":"","${PANEL_BLOCK}":{"cleared":true}},` +
        `"m.relates_to":{"rel_type":"m.replace","event_id":"${PANEL_ID}"}}`,
    )
    expect(readPanelBlock(content['m.new_content'])).toEqual({ cleared: true })
  })
})
