// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorToComposeResult } from '../../src/ui/composer/doc-to-rich'
import { parseCompose } from '@tayet/shared'
import { richExtensions } from '../../src/ui/composer/rich-schema'

// editorToComposeResult (ADR-051 PR-5): Editor → ComposeResult, the outbound contract the ACL
// consumes. `text` is the PLAIN fallback (getText); `rich` rides ONLY when the doc carries
// formatting — exact parity with parseCompose (no `rich` for an all-plain parse). A headless Editor
// on the real schema (richExtensions) drives it; mentions are proved through RichComposer (the node
// is island-local).
let editor: Editor
const build = (content: string): Editor => {
  editor = new Editor({ extensions: richExtensions, content })
  return editor
}

afterEach(() => editor?.destroy())

describe('editorToComposeResult', () => {
  it('plain paragraph → { text } with NO rich (parity with parseCompose)', () => {
    const result = editorToComposeResult(build('<p>hello there</p>'))
    expect(result).toEqual({ text: 'hello there' })
    expect(result.rich).toBeUndefined()
    // parseCompose of the same plain text also carries no rich.
    expect(parseCompose('hello there').rich).toBeUndefined()
  })

  it('empty editor → { text: "" } with NO rich', () => {
    const result = editorToComposeResult(build('<p></p>'))
    expect(result).toEqual({ text: '' })
  })

  it('formatted → { text, rich }; text is the plain fallback, rich matches parseCompose', () => {
    const result = editorToComposeResult(build('<p>say <strong>hi</strong></p>'))
    expect(result.text).toBe('say hi') // getText, no markdown markers
    expect(result.rich).toEqual(parseCompose('say **hi**').rich)
  })

  it('formatted multi-block carries rich; text is the plain block-joined fallback', () => {
    const result = editorToComposeResult(build('<ul><li><p>a</p></li><li><p>b</p></li></ul>'))
    // The list's plain fallback is lossy (blocks joined by getText); rich is the fidelity path.
    expect(result.text).toContain('a')
    expect(result.text).toContain('b')
    expect(result.rich).toEqual(parseCompose('- a\n- b').rich)
  })
})
