import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createAuthorNames, displayName, personNameOf } from '../../src/core/read'
import { ALICE, BOB, GENERAL, GONE, ME, SECRET, call, idLeaks, refusal, startSlack, type SlackHarness } from '../support/slack-world'

// users.info (PLANO-AGENTES §0.3.12 item 8): the Slack shape over the core's person(), and the core's
// rule for whoever left — the name of the last event seen from them, '' without one.

let h: SlackHarness
beforeEach(async () => {
  h = await startSlack()
})
afterEach(() => h.close())

const info = async (user: string): Promise<Record<string, unknown>> => {
  const res = await call(h.client(), 'users.info', { user })
  expect(idLeaks(res)).toEqual([])
  return res.user as Record<string, unknown>
}

describe('users.info', () => {
  it('someone still in the conversation: the name as it is; never profile.email', async () => {
    const res = await h.client().users.info({ user: ALICE.id })
    expect(res.user).toEqual({
      id: ALICE.id,
      team_id: ME.workspace,
      name: 'Alice Souza',
      real_name: 'Alice Souza',
      deleted: false,
      is_bot: false,
      profile: { display_name: 'Alice Souza', real_name: 'Alice Souza' },
    })
    expect(JSON.stringify(res)).not.toMatch(/email/)
  })

  it('is_bot from the kind (the agent itself)', async () => {
    h.world.read.person = (id) => (id === ME.id ? { id: ME.id, name: ME.name, kind: 'agent' } : ALICE)
    expect(await info(ME.id)).toMatchObject({ id: ME.id, is_bot: true, name: 'Relatórios' })
  })

  it('someone who left, with the name of their last message, and without one (an empty name)', async () => {
    expect(await info(GONE.id)).toMatchObject({ id: GONE.id, name: '', real_name: '', deleted: false, profile: { display_name: '', real_name: '' } })
    h.world.read.person = (id) => (id === GONE.id ? { ...GONE, name: 'Carla Dias' } : ALICE)
    expect(await info(GONE.id)).toMatchObject({ id: GONE.id, name: 'Carla Dias', deleted: false })
  })

  it('an unknown person → user_not_found; no user → user_not_found', async () => {
    expect(await refusal(h.client(), 'users.info', { user: 'UNOBODYAAAA' })).toBe('user_not_found')
    expect(await refusal(h.client(), 'users.info', {})).toBe('user_not_found')
  })
})

// users.list (S-f3; §0.3.12 item 7): the union of the agent's conversations' members, once each, sorted.
describe('users.list', () => {
  const list = async (args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const res = await call(h.client(), 'users.list', args)
    expect(idLeaks(res)).toEqual([])
    return res
  }
  const ids = (res: Record<string, unknown>): string[] => (res.members as Array<{ id: string }>).map((u) => u.id)

  it('every member of every conversation once (dedup across conversations), sorted by name', async () => {
    const res = await list()
    // GENERAL = me, Alice, Bob; SECRET = me, Bob; DM = me, Alice.
    const names = (res.members as Array<{ name: string }>).map((u) => u.name)
    expect(names).toEqual([...names].sort((a, b) => new Intl.Collator().compare(a, b)))
    expect(ids(res).sort()).toEqual([ALICE.id, BOB.id, ME.id].sort())
    expect(new Set(ids(res)).size).toBe(ids(res).length)
    expect(res.members).toContainEqual({
      id: ALICE.id,
      team_id: ME.workspace,
      name: 'Alice Souza',
      real_name: 'Alice Souza',
      deleted: false,
      is_bot: false,
      profile: { display_name: 'Alice Souza', real_name: 'Alice Souza' },
    })
    expect(res).toMatchObject({ ok: true, response_metadata: { next_cursor: '' } })
    expect(typeof res.cache_ts).toBe('number')
    expect(JSON.stringify(res)).not.toMatch(/email/)
  })

  it('the order is the collator’s (accents next to their letter), then the U…', async () => {
    const people: Record<string, { id: string; name: string; kind: 'member' }> = {
      UZEAAAAAAAA: { id: 'UZEAAAAAAAA', name: 'Zé', kind: 'member' },
      UEAAAAAAAAA: { id: 'UEAAAAAAAAA', name: 'Érica', kind: 'member' },
      UEBAAAAAAAA: { id: 'UEBAAAAAAAA', name: 'eduardo', kind: 'member' },
      UFAAAAAAAAA: { id: 'UFAAAAAAAAA', name: 'Fábio', kind: 'member' },
    }
    const members = h.world.read.members.bind(h.world.read)
    const person = h.world.read.person.bind(h.world.read)
    h.world.read.members = (id, q) => (id === GENERAL.id ? { people: Object.values(people) } : members(id, q))
    h.world.read.person = (id) => people[id] ?? person(id)
    const names = ((await list()).members as Array<{ name: string }>).map((u) => u.name)
    expect(names.indexOf('eduardo')).toBeLessThan(names.indexOf('Érica'))
    expect(names.indexOf('Érica')).toBeLessThan(names.indexOf('Fábio'))
    expect(names.indexOf('Fábio')).toBeLessThan(names.indexOf('Zé'))
  })

  it('limit + cursor page through the whole list; a bad cursor → invalid_cursor', async () => {
    const all = ids(await list())
    const first = await list({ limit: 2 })
    expect(ids(first)).toEqual(all.slice(0, 2))
    const next = (first.response_metadata as { next_cursor: string }).next_cursor
    expect(next).not.toBe('')
    const second = await list({ limit: 2, cursor: next })
    expect(ids(second)).toEqual(all.slice(2))
    expect(second).toMatchObject({ response_metadata: { next_cursor: '' } })
    expect(await refusal(h.client(), 'users.list', { cursor: 'bad' })).toBe('invalid_cursor')
    const paged: string[] = []
    for await (const page of h.client().paginate('users.list', { limit: 1 })) paged.push(...((page as unknown as { members: Array<{ id: string }> }).members as Array<{ id: string }>).map((u) => u.id))
    expect(paged).toEqual(all)
  })

  it('whoever left: the same reading as users.info (the name person() gives, \'\' without one)', async () => {
    const members = h.world.read.members.bind(h.world.read)
    h.world.read.members = (id, q) => (id === SECRET.id ? { people: [...members(id, q).people, GONE] } : members(id, q))
    const gone = ((await list()).members as Array<Record<string, unknown>>).find((u) => u.id === GONE.id)
    expect(gone).toMatchObject({ id: GONE.id, name: '', real_name: '', deleted: false })
    h.world.read.person = (id) => (id === GONE.id ? { ...GONE, name: 'Carla Dias' } : id === ME.id ? { ...ME } : id === BOB.id ? BOB : ALICE)
    const named = ((await list()).members as Array<Record<string, unknown>>).find((u) => u.id === GONE.id)
    expect(named).toMatchObject({ id: GONE.id, name: 'Carla Dias' })
  })
})

describe('core: the departed author’s name (core/read.ts)', () => {
  it('kept per person; the newest event by its instant wins, whatever order pages arrive in', () => {
    const names = createAuthorNames()
    names.note('@carla:x', 'Carla Nova', 2_000)
    names.note('@carla:x', 'Carla Antiga', 1_000)
    expect(names.get('@carla:x')).toBe('Carla Nova')
    names.note('@carla:x', 'Carla Final', 3_000)
    expect(names.get('@carla:x')).toBe('Carla Final')
    names.note('@dani:x', undefined, 5_000)
    names.note('@dani:x', '  ', 5_000)
    expect(names.get('@dani:x')).toBeUndefined()
    expect([...names.people()]).toEqual(['@carla:x'])
  })

  it('present → the roster’s name (nothing changes); gone → the last event’s name, else an empty name', () => {
    expect(personNameOf(true, 'Alice', 'Alice Antiga')).toBe('Alice')
    expect(personNameOf(true, undefined, 'Alice Antiga')).toBeUndefined()
    expect(personNameOf(false, undefined, 'Carla Dias')).toBe('Carla Dias')
    expect(displayName(personNameOf(false, undefined, undefined), '@carla:x')).toBe('')
    expect(displayName(personNameOf(false, undefined, 'Carla Dias'), '@carla:x')).toBe('Carla Dias')
  })
})
