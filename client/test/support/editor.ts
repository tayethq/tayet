import { fireEvent } from '@testing-library/react'

// Drive the WYSIWYG composer's contenteditable in jsdom. The editor is a TipTap/ProseMirror
// instance, so fireEvent.change() throws ("no value setter") and typing does nothing headlessly.
// A paste with a stubbed clipboardData is the reliable path: ProseMirror's paste handler reads
// text/plain and inserts it at the caret. Use this in App-level tests that have no onEditor handle;
// component-level tests should prefer the RichComposer `onEditor` seam + editor.commands.
//
// `send: true` (default) then fires the Enter keydown (the sendOnEnter keymap) to submit.
export function typeAndSend(editable: Element, text: string, opts: { send?: boolean } = {}): void {
  ;(editable as HTMLElement).focus()
  const paste = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(paste, 'clipboardData', {
    value: {
      getData: (t: string) => (t === 'text/plain' ? text : ''),
      types: ['text/plain'],
      files: [],
      items: [],
    },
  })
  editable.dispatchEvent(paste)
  if (opts.send !== false) fireEvent.keyDown(editable, { key: 'Enter' })
}

// The composer's live contenteditable within a container/panel.
export function editableIn(root: ParentNode): Element {
  const el = root.querySelector('[contenteditable="true"]')
  if (!el) throw new Error('no contenteditable composer found')
  return el
}
