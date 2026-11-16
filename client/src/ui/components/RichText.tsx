import { Fragment, type ReactNode } from 'react'
import type { RichDoc, RichBlock, RichInline } from '@tayet/client'

// Structural renderer for the domain's RichDoc (ADR-012, Opção C). It maps the BOUNDED node set to
// React elements via JSX only — it NEVER injects a raw HTML string (the render-scan gate greps this
// source to prove that). An unknown/dangerous node cannot be rendered: it does not exist in the
// union. This is the construction that makes XSS impossible on screen; the DOM tag-set scan backstops it.

// Defense-in-depth: only http(s)/mailto hrefs become a real link. The ACL already sanitizes inbound
// and outbound hrefs, but the renderer is the last line — a link node from any source is re-checked.
const SAFE_HREF = /^(https?:|mailto:)/i

function renderInline(nodes: RichInline[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        // A modelled newline becomes a <br/>; text is rendered as a React string (auto-escaped).
        return (
          <Fragment key={i}>
            {n.text.split('\n').map((line, j, arr) => (
              <Fragment key={j}>
                {line}
                {j < arr.length - 1 && <br />}
              </Fragment>
            ))}
          </Fragment>
        )
      case 'strong':
        return <strong key={i}>{renderInline(n.children)}</strong>
      case 'em':
        return <em key={i}>{renderInline(n.children)}</em>
      case 'strike':
        return <del key={i}>{renderInline(n.children)}</del>
      case 'code':
        return (
          <code key={i} className="rich__code">
            {n.text}
          </code>
        )
      case 'link': {
        const inner = renderInline(n.children)
        if (!SAFE_HREF.test(n.href.trim())) return <Fragment key={i}>{inner}</Fragment>
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow">
            {inner}
          </a>
        )
      }
    }
  })
}

function renderBlock(block: RichBlock, key: number): ReactNode {
  switch (block.t) {
    case 'p':
      return (
        <p key={key} className="rich__p">
          {renderInline(block.children)}
        </p>
      )
    case 'ul':
      return (
        <ul key={key} className="rich__ul">
          {block.items.map((item, i) => (
            <li key={i}>{item.map((b, j) => renderBlock(b, j))}</li>
          ))}
        </ul>
      )
    case 'ol':
      return (
        <ol key={key} className="rich__ol">
          {block.items.map((item, i) => (
            <li key={i}>{item.map((b, j) => renderBlock(b, j))}</li>
          ))}
        </ol>
      )
    case 'quote':
      return (
        <blockquote key={key} className="rich__quote">
          {block.children.map((b, i) => renderBlock(b, i))}
        </blockquote>
      )
    case 'codeblock':
      return (
        <pre key={key} className="rich__pre">
          <code>{block.text}</code>
        </pre>
      )
  }
}

// Render a full RichDoc. Used for received rich messages and the live rich preview.
// `lead` (ADR-093, Proposto): an element drawn at the start of the first paragraph — a command message's
// chip, whose "/nome" the caller already took out of the doc. Ignored when the doc does not open with a
// paragraph.
export function RichText({ doc, lead }: { doc: RichDoc; lead?: ReactNode }) {
  const [first] = doc
  if (lead && first?.t === 'p') {
    return (
      <div className="rich">
        <p className="rich__p">
          {lead}
          {renderInline(first.children)}
        </p>
        {doc.slice(1).map((b, i) => renderBlock(b, i + 1))}
      </div>
    )
  }
  return <div className="rich">{doc.map((b, i) => renderBlock(b, i))}</div>
}
