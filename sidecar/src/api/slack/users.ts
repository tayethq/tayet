// users.info (ADR-087 dec. 6; PLANO-AGENTES §0.3.12 item 8). `user` → the person as the core reads them
// (core/read.ts `person()`): whoever is still in a conversation the agent shares keeps the roster's
// name; whoever left gets the name of the last event the agent saw from them ('' without one).
// `is_bot` comes from the person's kind. `deleted` stays false: the tombstone of a removed account
// lives in #all, where the agent is not (declared, §8.19). Never `profile.email`.
//
// users.list (S-f3; §0.3.12 item 7): the people of the agent's conversations — the `members` of each,
// deduplicated by `U…`, each through the same `person()` as users.info — sorted by name with the
// process locale's collator (then by `U…`). The reach is the agent's (§0.1 item 21): no #all, no
// directory (a documented difference, as conversations.list). `limit` (default 100, at most 1000) and
// `cursor` page over the whole list as conversations.list does.
import type { ApiPerson } from '../contract'
import { PAGE_MAX } from '../../core/read'
import { allConversations, limitOf } from './conversations'
import { cursorOf, offsetOf, slackUser } from './translate'
import { bool, int, required, SlackError, str, type SlackCtx, type SlackMethods } from './router'

// Every person of every conversation of the agent (the native pages walked whole), once each.
function allPeople(ctx: SlackCtx): ApiPerson[] {
  const seen = new Map<string, ApiPerson>()
  for (const c of allConversations(ctx)) {
    let cursor: string | undefined
    do {
      const page = ctx.native(ctx.read.members(c.id, { limit: PAGE_MAX, cursor }), 'users.list')
      for (const p of page.people) if (!seen.has(p.id)) seen.set(p.id, p)
      cursor = page.next
    } while (cursor !== undefined)
  }
  // The same reading as users.info (whoever left one conversation keeps the name person() gives).
  const out = [...seen.values()].map((p) => {
    try {
      return ctx.native(ctx.read.person(p.id), 'users.list')
    } catch {
      return p
    }
  })
  const collator = new Intl.Collator()
  return out.sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export const USER_METHODS: SlackMethods = {
  'users.info': async (args, ctx) => {
    const id = required(args, 'user', 'user_not_found')
    bool(args, 'include_locale', false)
    const team = (await ctx.me()).workspace
    return { user: slackUser(ctx.native(ctx.read.person(id), 'users.info'), team) }
  },

  'users.list': async (args, ctx) => {
    bool(args, 'include_locale', false)
    const limit = limitOf(int(args, 'limit'))
    const offset = offsetOf(str(args, 'cursor'))
    if (offset === null) throw new SlackError('invalid_cursor')
    const team = (await ctx.me()).workspace
    const all = allPeople(ctx)
    const page = all.slice(offset, offset + limit)
    const next = offset + limit < all.length ? cursorOf(offset + limit) : ''
    return {
      members: page.map((p) => slackUser(p, team)),
      cache_ts: Math.floor(ctx.now() / 1000),
      response_metadata: { next_cursor: next },
    }
  },
}
