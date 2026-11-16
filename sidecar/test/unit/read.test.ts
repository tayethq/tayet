import { describe, it, expect } from 'vitest'
import { createTsIndex, displayName, dmPeerByRoom, isAgent, projectBody, ReadError, sidecarCtx } from '../../src/core/read'
import { eventSuffix, messageTs } from '../../src/api/ids'

// Read path (core/read.ts): projection without shape/status/blurhash/arrival, the minimal context,
// and the ts → event reverse (LRU → timestamp_to_event → same-millisecond neighbours + suffix).

const msg = (body: unknown) => ({ body }) as never

describe('projection (adj. 12)', () => {
  it('unsupported carries no shape; unavailable no arrival', () => {
    const u = projectBody(msg({ kind: 'unsupported', shape: { msgtype: 'm.location', eventType: 'm.room.message' } }), {})
    expect(u).toEqual({ text: '', unsupported: true })
    expect(JSON.stringify(u)).not.toContain('m.room')
    expect(projectBody(msg({ kind: 'unavailable', arrival: 'stalled' }), {})).toEqual({ text: '', unavailable: true })
  })

  it('text keeps rich; image becomes a file without blurhash, with mimetype/size from the content', () => {
    expect(projectBody(msg({ kind: 'text', text: 'oi' }), {})).toEqual({ text: 'oi' })
    const rich = { t: 'doc', children: [] }
    expect(projectBody(msg({ kind: 'text', text: 'oi', rich }), {})).toEqual({ text: 'oi', rich })
    const img = projectBody(msg({ kind: 'image', media: 'FAAAAAAAAAA', alt: 'grid.png', width: 10, height: 20, blurhash: 'LKO2' }), {
      body: 'grid.png',
      info: { mimetype: 'image/png', size: 200 },
    })
    expect(img).toEqual({ text: '', files: [{ id: 'FAAAAAAAAAA', name: 'grid.png', mimetype: 'image/png', size: 200, width: 10, height: 20 }] })
    expect(projectBody(msg({ kind: 'file', media: 'FB', name: 'a.pdf', size: 3, mimetype: 'application/pdf' }), {})).toEqual({
      text: '',
      files: [{ id: 'FB', name: 'a.pdf', mimetype: 'application/pdf', size: 3 }],
    })
  })

  it('an approval card leaves as its plain fallback text — no options, no state, no request doc (A3-1)', () => {
    const card = msg({
      kind: 'approval',
      text: 'Publicar a versão 2.4?',
      request: [{ t: 'p', children: [{ t: 'text', text: 'Publicar' }] }],
      options: [{ id: 'approve', label: 'Aprovar', style: 'primary' }],
      state: { kind: 'answered', by: '@bob:tayet.local', at: 2000, option: 'approve' },
    })
    const out = projectBody(card, {})
    expect(out).toEqual({ text: 'Publicar a versão 2.4?' })
    expect(JSON.stringify(out)).not.toContain('@bob')
  })
})

describe('minimal context', () => {
  const client = {
    getUserId: () => '@a-abcdefghijkl:tayet.local',
    getAccountData: () => ({ getContent: () => ({ '@alice:tayet.local': ['!dm:tayet.local'], bad: 'x' }) }),
  }

  it('DMs from the agent own m.direct; kind by the reserved prefix; infra accounts derived', () => {
    expect([...dmPeerByRoom(client as never)]).toEqual([['!dm:tayet.local', '@alice:tayet.local']])
    const ctx = sidecarCtx(client as never, undefined, new Map(), () => {})
    expect(ctx.isDm('!dm:tayet.local')).toBe(true)
    expect(ctx.dmPeerOf?.('!dm:tayet.local')).toBe('@alice:tayet.local')
    expect(ctx.kindOf?.('@a-zq2whhwsc6nh:tayet.local')).toBe('agent')
    expect(ctx.kindOf?.('@u-zq2whhwsc6nh:tayet.local')).toBe('member')
    expect(ctx.custodian).toBe('@cofre:tayet.local')
    expect(ctx.systemAccount).toBe('@system:tayet.local')
    expect(ctx.agentOf).toBeUndefined()
    expect(isAgent('@a-abcdefghijkl:x')).toBe(true)
  })

  it('media becomes an F… token, the descriptor stays inside', () => {
    const files = new Map<string, unknown>()
    const ctx = sidecarCtx(client as never, undefined, files as never, () => {})
    const ref = ctx.mediaRefFor?.('mxc://tayet.local/abc', undefined, 'image/png') as unknown as string
    expect(ref).toMatch(/^F[A-Z2-7]{10}$/)
    expect(files.get(ref)).toEqual({ uri: 'mxc://tayet.local/abc', encrypted: undefined, mimetype: 'image/png' })
  })
})

// Two event ids with the same suffix, for a same-millisecond collision.
function sameSuffixPair(): [string, string, string] {
  const seen = new Map<string, string>()
  for (let i = 0; ; i++) {
    const id = `$e${i}`
    const s = eventSuffix(id)
    const prev = seen.get(s)
    if (prev !== undefined) return [prev, id, s]
    seen.set(s, id)
  }
}

describe('ts index (adj. 3)', () => {
  const ROOM = '!r:x'
  const MS = 1730900668362

  function fake(opts: { candidate?: string; at?: number; before?: string[]; after?: string[]; fail?: boolean } = {}) {
    const calls: string[] = []
    const client = {
      timestampToEvent: (_room: string, ms: number) => {
        calls.push(`t2e ${ms}`)
        if (opts.fail) return Promise.reject(Object.assign(new Error('not found'), { httpStatus: 404 }))
        return Promise.resolve({ event_id: opts.candidate ?? '$none', origin_server_ts: opts.at ?? ms })
      },
      http: {
        authedRequest: (_m: string, path: string) => {
          calls.push(`context ${path}`)
          return Promise.resolve({
            events_before: (opts.before ?? []).map((event_id) => ({ event_id, origin_server_ts: MS })),
            events_after: (opts.after ?? []).map((event_id) => ({ event_id, origin_server_ts: MS })),
          })
        },
      },
      fetchRoomEvent: (_room: string, id: string) => {
        calls.push(`fetch ${id}`)
        return Promise.resolve({ origin_server_ts: MS })
      },
    }
    return { client, calls }
  }

  it('emitted messages are resolved from the LRU, no request', async () => {
    const f = fake()
    const idx = createTsIndex(f.client as never, () => {})
    const ts = idx.tsOf(ROOM, '$abc', MS) as string
    expect(await idx.eventOf(ROOM, ts)).toBe('$abc')
    expect(f.calls).toEqual([])
    expect(idx.tsOf(ROOM, 'm1730.local', MS)).toBeNull()
  })

  it('miss → timestamp_to_event; suffix matches → that event', async () => {
    const f = fake({ candidate: '$abc' })
    const idx = createTsIndex(f.client as never, () => {})
    expect(await idx.eventOf(ROOM, messageTs(MS, '$abc'))).toBe('$abc')
    expect(f.calls).toEqual([`t2e ${MS}`])
  })

  it('suffix differs → the same-millisecond neighbour with the right suffix', async () => {
    const f = fake({ candidate: '$other', before: ['$zzz', '$want'], after: ['$later'] })
    const idx = createTsIndex(f.client as never, () => {})
    expect(await idx.eventOf(ROOM, messageTs(MS, '$want'))).toBe('$want')
    expect(f.calls[1]).toMatch(/^context \/rooms\/!r%3Ax\/context\/%24other$/)
  })

  it('two neighbours with the same ts → the first in timeline order, and a collision signal', async () => {
    const [a, b] = sameSuffixPair()
    const collisions: string[] = []
    const f = fake({ candidate: '$other', before: [b, a] })
    const idx = createTsIndex(f.client as never, (r) => collisions.push(r))
    // events_before comes newest first: [b, a] → timeline order a, b.
    expect(await idx.eventOf(ROOM, messageTs(MS, a))).toBe(a)
    expect(collisions).toEqual([ROOM])
  })

  it('a second event under a known ts keeps the first and signals', () => {
    const [a, b] = sameSuffixPair()
    const collisions: string[] = []
    const idx = createTsIndex({} as never, (r) => collisions.push(r))
    expect(idx.tsOf(ROOM, a, MS)).toBe(idx.tsOf(ROOM, b, MS))
    expect(collisions).toEqual([ROOM])
  })

  it('not found: another instant, server 404, malformed ts', async () => {
    await expect(createTsIndex(fake({ at: MS + 1 }).client as never, () => {}).eventOf(ROOM, messageTs(MS, '$a'))).rejects.toBeInstanceOf(ReadError)
    await expect(createTsIndex(fake({ fail: true }).client as never, () => {}).eventOf(ROOM, messageTs(MS, '$a'))).rejects.toThrow('message_not_found')
    await expect(createTsIndex(fake().client as never, () => {}).eventOf(ROOM, 'nope')).rejects.toThrow('message_not_found')
  })

  it('related events: local first, then fetched once and cached', async () => {
    const f = fake()
    const idx = createTsIndex(f.client as never, () => {})
    expect(await idx.tsOfRelated(ROOM, '$root', () => undefined)).toBe(messageTs(MS, '$root'))
    expect(await idx.tsOfRelated(ROOM, '$root', () => undefined)).toBe(messageTs(MS, '$root'))
    expect(f.calls).toEqual(['fetch $root'])
    expect(await idx.tsOfRelated(ROOM, '$loc', () => ({ getTs: () => 5000 }) as never)).toBe(messageTs(5000, '$loc'))
  })
})

describe('display name at the edge', () => {
  it('no name (or an mxid as name) → empty, never the localpart', () => {
    expect(displayName(undefined, '@a-abcdefghijkl:x')).toBe('')
    expect(displayName('', '@u-abcdefghijkl:x')).toBe('')
    expect(displayName('@a-abcdefghijkl:x', '@a-abcdefghijkl:x')).toBe('')
    expect(displayName('Alice (@alice:x)', '@alice:x')).toBe('Alice')
    expect(displayName(' Relatórios ', '@a-abcdefghijkl:x')).toBe('Relatórios')
  })
})
