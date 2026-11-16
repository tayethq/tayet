// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { applyTitle, titleFor } from '../../src/ui/document-title'
import type { Channel, ChannelId } from '../../src/acl'

// ADR-073 dec. 7: the tab title counts what notifies.

const ch = (kind: Channel['kind'], count: number, mentions: number, archived?: boolean): Channel => ({
  id: `!${kind}${count}${mentions}:tayet.local` as unknown as ChannelId,
  name: kind === 'dm' ? 'alice' : '#all',
  kind,
  memberCount: 2,
  unread: { count, mentions },
  ...(archived ? { archived } : {}),
})

describe('titleFor (ADR-073 dec. 7)', () => {
  it('nothing that notifies → plain app name', () => {
    expect(titleFor([])).toBe('Tayet')
    expect(titleFor([ch('public', 5, 0), ch('private', 3, 0)])).toBe('Tayet')
  })

  it('a DM counts every unread; a channel counts only its mentions', () => {
    expect(titleFor([ch('dm', 2, 0), ch('public', 7, 1), ch('private', 4, 2)])).toBe('(5) Tayet')
  })

  it('archived channels never count', () => {
    expect(titleFor([ch('dm', 2, 0, true), ch('public', 3, 3, true), ch('dm', 1, 0)])).toBe('(1) Tayet')
  })

  it('applyTitle writes document.title', () => {
    applyTitle([ch('dm', 3, 0)])
    expect(document.title).toBe('(3) Tayet')
    applyTitle([])
    expect(document.title).toBe('Tayet')
  })
})
