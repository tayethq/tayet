// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentFormDialog } from '../../src/ui/components/AgentFormDialog'
import type { AgentForm, FormField } from '../../src/acl'

// R5 (workspace.md §25.7; PLANO-MOBILE §8.21): the long text keeps its 64 and its padding over the field's own
// rule, which comes later in the sheet. No layout: the cascade is worked out here from the rules that set the
// property outside a media query — the most classes wins, then the last one.

afterEach(cleanup)

function winner(el: Element, property: string): string | undefined {
  let css = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  css = css.replace(/@(media|keyframes)[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '')
  let best: { weight: number; value: string } | undefined
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const value = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]+)`).exec(body!)?.[1]?.trim()
    if (value === undefined) continue
    for (const selector of selectors!.split(';').pop()!.split(',').map((s) => s.trim())) {
      // Only selectors made of classes can reach the textarea with these properties.
      if (!/^[.\w][\w.\- >]*$/.test(selector) || !el.matches(selector)) continue
      const weight = selector.split('.').length - 1
      if (!best || weight >= best.weight) best = { weight, value }
    }
  }
  return best?.value
}

describe('the long text of the agent form, wide window', () => {
  it.each([
    ['min-height', '64px'],
    ['padding', 'var(--space-8)'],
  ])('%s is %s', (property, value) => {
    const fields: FormField[] = [{ kind: 'longText', id: 'note', label: 'Observação', optional: true, minLength: 0, maxLength: 100 }]
    const form = { id: 'f', channelId: 'c', agent: 'a', anchor: 'm', title: 'Ajustar', submitLabel: 'Salvar', fields, state: { kind: 'open' } } as unknown as AgentForm
    const r = render(<AgentFormDialog form={form} agent={undefined} onSubmit={async () => ({ ok: true })} onClose={() => {}} />)
    expect(winner(r.container.querySelector('textarea')!, property)).toBe(value)
  })
})
