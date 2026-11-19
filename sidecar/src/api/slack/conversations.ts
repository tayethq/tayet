// conversations.list / info / members (PLANO-AGENTES §0.3.12 item 7). The agent's conversations only:
// `types` filters public_channel / private_channel / im / mpim (`mpim` = the product's group conversations,
// ADR-094 dec. 12);
// `exclude_archived` is accepted (nothing is archived); `limit` (Slack's default 100, at most 1000; the
// native page is at most 200) and `cursor` → `response_metadata.next_cursor` ('' at the end).
//
// conversations.open (S-f3; §0.3.12 item 7, ADR-090): the agent never creates a DM — the person who
// operates it opens it. `users` (one `U…`; two or more → `invalid_arguments`: an agent never opens a group
// conversation — only its operator includes it in one, at creation, ADR-094 dec. 7; the agent itself →
// `invalid_arguments`) → the existing DM with that person, else `user_not_found` (an
// unknown `U…`) or `restricted_action` + `response_metadata.warnings: ['dm_opened_by_operator']`.
// `channel` (a conversation of the agent) → itself. `return_im` → the whole object, as Slack. No write.
//
// conversations.history / replies: the native listing (newest first, no thread replies) and the thread's
// root by its ts (`ReadFacade.message`, §0.3.12 item 3) + its replies, oldest first as Slack orders them.
// A message whose content alone is at fault comes back withheld (no text, no files, no reactions), the rest of the
// page with it (`ctx.listing`); any other finding is `internal_error`, as for every native value.
import type { ApiConversation, ApiMessage } from '../contract'
import { PAGE_MAX, ReadError } from '../../core/read'
import { parseTs } from '../ids'
import { cursorOf, offsetOf, slackConversation, slackMessage, type MessageView } from './translate'
import { nameOf } from './emoji'
import { richToMrkdwn } from './mrkdwn'
import { bool, int, required, SlackError, str, type SlackCtx, type SlackMethods } from './router'

const TYPES = ['public_channel', 'private_channel', 'im', 'mpim'] as const
type SlackType = (typeof TYPES)[number]
const KIND_OF: Record<ApiConversation['kind'], SlackType> = { public: 'public_channel', private: 'private_channel', dm: 'im', group: 'mpim' }

function typesOf(raw: string | undefined): Set<SlackType> {
  if (raw === undefined) return new Set(['public_channel'])
  const out = new Set<SlackType>()
  for (const t of raw.split(',').map((x) => x.trim())) {
    if (!(TYPES as readonly string[]).includes(t)) throw new SlackError('invalid_arguments')
    out.add(t as SlackType)
  }
  return out
}

export function limitOf(raw: number | undefined): number {
  if (raw === undefined || raw === 0) return 100
  return Math.min(raw, 1000)
}

// Every conversation of the agent (the native pages walked whole: the list is the agent's own).
export function allConversations(ctx: SlackCtx): ApiConversation[] {
  const out: ApiConversation[] = []
  let cursor: string | undefined
  do {
    const page = ctx.native(ctx.read.conversations({ limit: PAGE_MAX, cursor }), 'conversations.list')
    out.push(...page.conversations)
    cursor = page.next
  } while (cursor !== undefined)
  return out
}

// A person's current name for the mrkdwn of a read ('' when unknown: the mention is then prefixed).
export const personName = (ctx: SlackCtx) => (id: string): string | undefined => {
  try {
    return ctx.read.person(id).name
  } catch {
    return undefined
  }
}

// How a message reads in Slack: the text in mrkdwn with its mentions, and the reaction names.
export async function viewOf(ctx: SlackCtx): Promise<MessageView> {
  const me = (await ctx.me()).id
  const person = personName(ctx)
  return { me, text: (m) => richToMrkdwn(m.text, m.rich, m.mentions ?? [], { person }), reaction: nameOf, base: ctx.baseUrl() }
}

const boundsOf = (args: Record<string, unknown>) => {
  const oldest = str(args, 'oldest')
  const latest = str(args, 'latest')
  return {
    ...(oldest !== undefined && oldest !== '0' && { oldest }),
    ...(latest !== undefined && { latest }),
    inclusive: bool(args, 'inclusive', false),
  }
}

// Every reply of a thread (the native pages walked whole), oldest first.
async function allReplies(ctx: SlackCtx, id: string, root: string, bounds: ReturnType<typeof boundsOf>): Promise<ApiMessage[]> {
  const out: ApiMessage[] = []
  let cursor: string | undefined
  do {
    const page = ctx.listing(await ctx.read.messages(id, { thread: root, limit: PAGE_MAX, cursor, ...(cursor === undefined && bounds) }), 'conversations.replies')
    out.push(...page.messages)
    cursor = page.next
  } while (cursor !== undefined)
  return out.reverse()
}

// The refusal of a DM the agent would have to create (ADR-090: the person who operates it opens it).
export const DM_OPENED_BY_OPERATOR = 'dm_opened_by_operator'

function openTarget(args: Record<string, unknown>, ctx: SlackCtx, me: string): ApiConversation {
  const channel = str(args, 'channel')
  const users = str(args, 'users')
  if (channel !== undefined) {
    if (users !== undefined) throw new SlackError('invalid_arguments')
    return ctx.native(ctx.read.conversation(channel), 'conversations.open')
  }
  if (users === undefined) throw new SlackError('invalid_arguments')
  const list = users.split(',').map((u) => u.trim()).filter((u) => u !== '')
  if (list.length !== 1) throw new SlackError('invalid_arguments')
  const user = list[0] as string
  if (user === me) throw new SlackError('invalid_arguments')
  const dm = allConversations(ctx).find((c) => c.kind === 'dm' && c.peer === user)
  if (dm !== undefined) return dm
  ctx.native(ctx.read.person(user), 'conversations.open')
  throw new SlackError('restricted_action', undefined, [DM_OPENED_BY_OPERATOR])
}

export const CONVERSATION_METHODS: SlackMethods = {
  'conversations.open': async (args, ctx) => {
    const returnIm = bool(args, 'return_im', false)
    bool(args, 'prevent_creation', false)
    const c = openTarget(args, ctx, (await ctx.me()).id)
    return { no_op: true, already_open: true, channel: returnIm ? slackConversation(c) : { id: c.id } }
  },


  'conversations.list': (args, ctx) => {
    const types = typesOf(str(args, 'types'))
    bool(args, 'exclude_archived', false)
    const limit = limitOf(int(args, 'limit'))
    const offset = offsetOf(str(args, 'cursor'))
    if (offset === null) throw new SlackError('invalid_cursor')
    const all = allConversations(ctx).filter((c) => types.has(KIND_OF[c.kind]))
    const page = all.slice(offset, offset + limit)
    const next = offset + limit < all.length ? cursorOf(offset + limit) : ''
    return Promise.resolve({ channels: page.map(slackConversation), response_metadata: { next_cursor: next } })
  },

  'conversations.info': (args, ctx) => {
    const id = required(args, 'channel', 'channel_not_found')
    bool(args, 'include_num_members', false)
    return Promise.resolve({ channel: slackConversation(ctx.native(ctx.read.conversation(id), 'conversations.info')) })
  },

  'conversations.members': (args, ctx) => {
    const id = required(args, 'channel', 'channel_not_found')
    const limit = Math.min(limitOf(int(args, 'limit')), PAGE_MAX)
    const page = ctx.native(ctx.read.members(id, { limit, cursor: str(args, 'cursor') }), 'conversations.members')
    return Promise.resolve({ members: page.people.map((p) => p.id), response_metadata: { next_cursor: page.next ?? '' } })
  },

  'conversations.history': async (args, ctx) => {
    const id = required(args, 'channel', 'channel_not_found')
    const limit = Math.min(limitOf(int(args, 'limit')), PAGE_MAX)
    const cursor = str(args, 'cursor')
    const page = ctx.listing(await ctx.read.messages(id, { limit, ...(cursor !== undefined ? { cursor } : boundsOf(args)) }), 'conversations.history')
    const view = await viewOf(ctx)
    return {
      messages: page.messages.map((m) => slackMessage(m, view)),
      has_more: page.next !== undefined,
      pin_count: 0,
      response_metadata: { next_cursor: page.next ?? '' },
    }
  },

  // The root first (on the first page), then the replies oldest first; a reply's ts names its thread.
  'conversations.replies': async (args, ctx) => {
    const id = required(args, 'channel', 'channel_not_found')
    const ts = required(args, 'ts', 'thread_not_found')
    const limit = limitOf(int(args, 'limit'))
    const offset = offsetOf(str(args, 'cursor'))
    if (offset === null) throw new SlackError('invalid_cursor')
    let root: ApiMessage
    try {
      // The thread is taken from what was read, once the edge passed it (a structural finding fails there, so the
      // thread was scanned clean); a withheld message keeps it too.
      const read = await ctx.read.message(id, ts)
      root = ctx.listing(read, 'conversations.replies')
      if (read.thread !== undefined) root = ctx.listing(await ctx.read.message(id, read.thread), 'conversations.replies')
    } catch (err) {
      if (err instanceof ReadError && err.code === 'message_not_found') throw new SlackError('thread_not_found')
      throw err
    }
    const replies = await allReplies(ctx, id, root.id, boundsOf(args))
    // A root read by its ts may come without its thread summary (the core has no thread for an event
    // outside the loaded timeline): the replies just read say it.
    const last = replies.length > 0 ? parseTs((replies[replies.length - 1] as ApiMessage).id) : null
    if (root.threadSummary === undefined && last !== null) root = { ...root, threadSummary: { replyCount: replies.length, latestReplyAt: last.ms } }
    const all = [root, ...replies]
    const view = await viewOf(ctx)
    const page = all.slice(offset, offset + limit)
    const next = offset + limit < all.length ? cursorOf(offset + limit) : ''
    return { messages: page.map((m) => slackMessage(m, view)), has_more: next !== '', response_metadata: { next_cursor: next } }
  },
}
