import { describe, expect, it } from 'vitest'
import type { Message } from '../src/acl'
import {
  SearchIndex,
  excerptOf,
  matchesAll,
  normalizeForSearch,
  queryTerms,
  searchableText,
} from '../src/acl/internal/search-index'
import {
  createMemorySearchStore,
  memorySearchDbNames,
  searchDbName,
  wipeSearchIndexes,
  type SearchEntry,
} from '../src/acl/internal/search-store'

// ADR-074 dec. 1/2/5/6: normalization, AND matching, the excerpt, idempotent upsert, removal and the
// memory store that stands in for IndexedDB in Node.

let seq = 0
function entry(text: string, over: Partial<SearchEntry> = {}): SearchEntry {
  seq += 1
  const eventId = over.eventId ?? `$e${seq}`
  const snapshot = {
    id: eventId,
    channelId: over.roomId ?? '!r',
    author: '@a',
    body: { kind: 'text', text },
    sentAt: over.ts ?? seq,
    reactions: [],
    mine: false,
    mentionsMe: false,
  } as unknown as Message
  return {
    eventId,
    roomId: '!r',
    sender: '@a',
    ts: seq,
    text,
    norm: normalizeForSearch(text),
    snapshot,
    ...over,
  }
}

const all = (): boolean => true

describe('normalization (dec. 5)', () => {
  it('folds case and accents', () => {
    expect(normalizeForSearch('Ação RÁPIDA Über Çà')).toBe('acao rapida uber ca')
  })

  it('a combining mark in the source folds like the precomposed letter', () => {
    expect(normalizeForSearch('é')).toBe(normalizeForSearch('é'))
  })

  it('terms split on whitespace; under 2 characters the query is empty', () => {
    expect(queryTerms('  Reunião   amanhã ')).toEqual(['reuniao', 'amanha'])
    expect(queryTerms(' a ')).toEqual([])
    expect(queryTerms('')).toEqual([])
  })

  it('every term must match (AND), as a substring anywhere', () => {
    const norm = normalizeForSearch('A reunião foi movida para amanhã cedo')
    expect(matchesAll(norm, queryTerms('reun AMANHA'))).toBe(true)
    expect(matchesAll(norm, queryTerms('reuniao ontem'))).toBe(false)
  })
})

describe('excerpt', () => {
  it('cuts the original text around the earliest match, accents kept', () => {
    const ex = excerptOf('Vamos marcar a reunião na sala grande', queryTerms('REUNIAO'))
    expect(ex).toEqual({ before: 'Vamos marcar a ', match: 'reunião', after: ' na sala grande' })
  })

  it('maps through a combining mark and squashes line breaks in the context', () => {
    const ex = excerptOf('primeira linha\nsegunda café aqui', queryTerms('café'))
    expect(ex.match).toBe('café')
    expect(ex.before).toBe('primeira linha segunda ')
  })

  it('bounds the context on both sides', () => {
    const long = 'x'.repeat(100) + 'alvo' + 'y'.repeat(100)
    const ex = excerptOf(long, ['alvo'])
    expect(ex.before).toBe('x'.repeat(40))
    expect(ex.after).toBe('y'.repeat(40))
  })
})

describe('searchable text (dec. 2)', () => {
  it('text, file name and image name; nothing for unavailable/unsupported', () => {
    expect(searchableText({ kind: 'text', text: 'oi' })).toBe('oi')
    expect(
      searchableText({ kind: 'file', media: 'm' as never, name: 'plano.pdf', size: 1, mimetype: 'application/pdf' }),
    ).toBe('plano.pdf')
    expect(searchableText({ kind: 'image', media: 'm' as never, alt: 'foto.png' })).toBe('foto.png')
    expect(searchableText({ kind: 'unavailable', arrival: 'awaited' })).toBeUndefined()
    expect(searchableText({ kind: 'unsupported', shape: {} as never })).toBeUndefined()
  })
})

describe('SearchIndex', () => {
  it('upsert is idempotent by event id and the newest content wins', async () => {
    const idx = new SearchIndex(createMemorySearchStore('t-upsert'))
    await idx.ready
    idx.upsert([entry('primeiro texto', { eventId: '$x' })])
    idx.upsert([entry('primeiro texto', { eventId: '$x' })])
    expect(idx.size).toBe(1)
    idx.upsert([entry('texto editado', { eventId: '$x' })])
    expect(idx.size).toBe(1)
    expect(idx.search('primeiro', all)).toEqual([])
    expect(idx.search('editado', all).map((h) => h.entry.eventId)).toEqual(['$x'])
  })

  it('remove drops the entry from memory and from the store', async () => {
    const store = createMemorySearchStore('t-remove')
    const idx = new SearchIndex(store)
    await idx.ready
    idx.upsert([entry('apagar isto', { eventId: '$gone' })])
    idx.remove('$gone')
    expect(idx.search('apagar', all)).toEqual([])
    await new Promise((r) => setTimeout(r, 0))
    expect((await store.load()).entries).toEqual([])
  })

  it('results are newest first and narrowed by room', async () => {
    const idx = new SearchIndex(createMemorySearchStore('t-order'))
    await idx.ready
    idx.upsert([
      entry('alfa velho', { eventId: '$1', ts: 10 }),
      entry('alfa novo', { eventId: '$2', ts: 30 }),
      entry('alfa meio', { eventId: '$3', ts: 20, roomId: '!other' }),
    ])
    expect(idx.search('alfa', all).map((h) => h.entry.eventId)).toEqual(['$2', '$3', '$1'])
    expect(idx.search('alfa', (r) => r === '!r').map((h) => h.entry.eventId)).toEqual(['$2', '$1'])
  })

  it('the memory store survives the instance: a second index of the same name loads entries and cursors', async () => {
    const first = new SearchIndex(createMemorySearchStore('t-persist'))
    await first.ready
    first.upsert([entry('persistente', { eventId: '$p' })])
    first.setCursor({ roomId: '!r', token: 't1', done: false })
    await new Promise((r) => setTimeout(r, 0))

    const second = new SearchIndex(createMemorySearchStore('t-persist'))
    await second.ready
    expect(second.search('persist', all).map((h) => h.entry.eventId)).toEqual(['$p'])
    expect(second.cursor('!r')).toEqual({ roomId: '!r', token: 't1', done: false })
  })

  it('a removal before the load finishes is not undone by the load', async () => {
    const name = 't-race'
    const seed = new SearchIndex(createMemorySearchStore(name))
    await seed.ready
    seed.upsert([entry('corrida', { eventId: '$r' })])
    await new Promise((r) => setTimeout(r, 0))

    const idx = new SearchIndex(createMemorySearchStore(name))
    idx.remove('$r') // before `ready`
    await idx.ready
    expect(idx.search('corrida', all)).toEqual([])
  })

  it('wipe deletes every account database', async () => {
    const name = searchDbName('@someone:example.org')
    expect(name).toMatch(/^tayet-search-[0-9a-f]{8}$/)
    expect(name).not.toContain('someone')
    const idx = new SearchIndex(createMemorySearchStore(name))
    await idx.ready
    idx.upsert([entry('algo')])
    await new Promise((r) => setTimeout(r, 0))
    expect(memorySearchDbNames()).toContain(name)
    await wipeSearchIndexes()
    expect(memorySearchDbNames().filter((n) => n.startsWith('tayet-search-'))).toEqual([])
  })
})
