import type { Message } from '@tayet/client'
import { richDocToMarkdown } from './rich-to-markdown'

// "Copiar texto" (manifest workspace.md §25.1 items 4 and 5; PLANO-MOBILE §0.12.2 R5, N4 a): what a
// message copies, and whether the action exists at all. The one rule for every place that offers the
// action — the wide action bar today, the narrow sheet (M3b) next — so none of them decides on its own.
//
// - Text: the rich through the converter, else the body's text as it is. A command copies its whole
//   body ("/nome args"): the "/nome" the screen draws as a chip is part of the text.
// - Approval card: the text of the request, by the screen's own rule — the request through the
//   converter, else the text. Options and answers stay out.
// - No action: image, file, a pending message, a message that did not decrypt (unavailable) and an
//   unsupported one (its body is the product's placeholder, not the message's). A message not sent
//   (failed) keeps the action: its text is the sender's own.
// Only clean domain text leaves: no id ever reaches the clipboard.
export function copyTextOf(m: Message): string | undefined {
  if (m.status === 'pending') return undefined
  const body = m.body
  switch (body.kind) {
    case 'text':
      return body.rich ? richDocToMarkdown(body.rich) : body.text
    case 'approval':
      return body.request ? richDocToMarkdown(body.request) : body.text
    case 'image':
    case 'file':
    case 'unavailable':
    case 'unsupported':
      return undefined
  }
}

export function canCopyText(m: Message): boolean {
  return copyTextOf(m) !== undefined
}
