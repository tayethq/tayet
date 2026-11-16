// chat.postMessage / update / delete (PLANO-AGENTES §0.3.12 items 4, 7, 11; §0.3.17, A3-4).
// - `text` (mrkdwn unless `mrkdwn: false`) → the product's rich text + mentions (slack/mrkdwn.ts); with no
//   `text`, `blocks` are flattened (slack/blocks.ts), their warnings in `response_metadata.warnings`.
//   Neither → `no_text`.
// - An `actions` block (A3-4, with the approval facade): chat.postMessage sends an approval card
//   (slack/actions.ts) — read even when there is `text`, which is then the request; with no `text`, the
//   request is the other blocks flattened. The card's `action_id`/`block_id`/`value` go to the layer's file
//   (slack/cards.ts) before the answer. Preflight before any effect: the card's probe (request + options) and
//   the content scan of every `action_id`, `value` and `block_id`. Without the facade, `actions` is dropped
//   with `blocks_unsupported:actions`, as before.
// - chat.update with an `actions` block → `invalid_blocks` (with the facade). On one of the agent's own
//   cards: the request is edited (the core keeps the close as it is), then the card is closed when it is
//   still open (after the automatic seal, it is only the edit). The response_url (slack/router.ts) takes
//   this same path.
// - `thread_ts` → the native `thread` (a reply's ts names its thread, as the native write does).
// - `reply_broadcast`, `username`, `icon_url`, `icon_emoji` and `as_user` are ignored with a warning: the
//   agent always speaks as itself, marked as an agent (P6, ADR-086 dec. 6).
// - update / delete: only the agent's own messages (`cant_update_message` / `cant_delete_message`).
// The answer's `message` is the sent message as a read shows it (mrkdwn, `<@U…>`).
import { ReadError } from '../../core/read'
import { WriteError } from '../../core/write'
import type { ApiMessage } from '../contract'
import { logLeaks, scanApprovalProbe, scanContent } from '../edge'
import { readActions, type CardSpec } from './actions'
import { flattenBlocks, type BlockResolve } from './blocks'
import { emojiOf } from './emoji'
import { personName, viewOf } from './conversations'
import { mrkdwnToRich, unescapeMrkdwn, type Parsed } from './mrkdwn'
import { bool, nested, required, SLACK_TEXT_MAX, SlackError, str, type SlackArgs, type SlackCtx, type SlackMethods, type SlackResult } from './router'
import { slackMessage } from './translate'

const IGNORED = ['reply_broadcast', 'username', 'icon_url', 'icon_emoji', 'as_user'] as const

export function resolverOf(ctx: SlackCtx): BlockResolve {
  return {
    person: personName(ctx),
    conversation: (id) => {
      try {
        return ctx.read.conversation(id).name
      } catch {
        return undefined
      }
    },
    // The iamcal table (slack/emoji.ts); an unknown name stays `:name:`.
    emoji: emojiOf,
  }
}

interface Content extends Parsed {
  warnings: string[]
  // The approval card of an `actions` block (chat.postMessage with the facade, A3-4).
  card?: CardSpec
}

const isActions = (b: unknown): boolean => b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'actions'

// The content of a post or an update: `text` wins; `blocks` only without it. With the approval facade, an
// `actions` block is read whatever the `text` (A3-4): a post's card; an update's → `invalid_blocks`.
function contentOf(args: SlackArgs, ctx: SlackCtx, kind: 'post' | 'update'): Content {
  const text = str(args, 'text')
  const resolve = resolverOf(ctx)
  const raw = nested(args, 'blocks')
  if (raw !== undefined && !Array.isArray(raw)) throw new SlackError('invalid_arguments')
  let blocks = raw as unknown[] | undefined
  let actions: ReturnType<typeof readActions> | undefined
  if (ctx.approvals !== undefined && blocks !== undefined) {
    if (kind === 'update' && blocks.some(isActions)) throw new SlackError('invalid_blocks')
    actions = readActions(blocks)
    blocks = actions.rest
  }
  let out: Content
  if (text !== undefined && text.trim() !== '') {
    out = bool(args, 'mrkdwn', true) ? { ...mrkdwnToRich(text, resolve), warnings: [] } : { text: unescapeMrkdwn(text), mentions: [], warnings: [] }
  } else {
    if (blocks === undefined) throw new SlackError('no_text')
    out = flattenBlocks(blocks, resolve)
  }
  if (actions !== undefined) out = { ...out, warnings: [...out.warnings, ...actions.warnings], ...(actions.card !== undefined && { card: actions.card }) }
  if (out.text.trim() === '') throw new SlackError('no_text')
  if (Buffer.byteLength(out.text, 'utf8') > SLACK_TEXT_MAX) throw new SlackError('msg_too_long')
  return out
}

const metadata = (warnings: string[]): Pick<SlackResult, 'response_metadata'> => (warnings.length > 0 ? { response_metadata: { warnings } } : {})

async function shown(ctx: SlackCtx, m: ApiMessage, where: string) {
  return slackMessage(ctx.native(m, where), await viewOf(ctx))
}

// The card's preflight (A3-4): what the edge would withhold is refused before any effect — the request and
// the options as the card's answer carries them, and the agent's own button fields as content.
function preflightCard(ctx: SlackCtx, channel: string, text: string, card: CardSpec): void {
  const leaks = [
    ...scanApprovalProbe(
      channel,
      text,
      card.buttons.map((b) => b.option),
    ),
    ...scanContent({ block_id: card.block_id, actions: card.buttons.map((b) => ({ action_id: b.action_id, ...(b.value !== undefined && { value: b.value }) })) }),
  ]
  if (leaks.length > 0) {
    logLeaks(ctx.log, 'slack chat.postMessage', leaks)
    throw new SlackError('internal_error')
  }
}

// chat.postMessage with a card: the facade's request, then the layer's file, then the answer.
async function postCard(ctx: SlackCtx, channel: string, content: Content & { card: CardSpec }, thread: string | undefined, warnings: string[]) {
  const approvals = ctx.approvals
  if (approvals === undefined) throw new SlackError('internal_error')
  const { card } = content
  preflightCard(ctx, channel, content.text, card)
  let sent: ApiMessage
  try {
    sent = await approvals.request(channel, {
      text: content.text,
      ...(content.rich !== undefined && { rich: content.rich }),
      options: card.buttons.map((b) => b.option),
      ...(content.mentions.length > 0 && { mentions: content.mentions }),
      ...(thread !== undefined && { thread }),
    })
  } catch (err) {
    if (thread !== undefined && err instanceof ReadError && err.code === 'message_not_found') throw new SlackError('thread_not_found')
    throw err
  }
  await ctx.cards.add({
    conversation: channel,
    id: sent.id,
    block_id: card.block_id,
    actions: card.buttons.map((b) => ({ option: b.option.id, action_id: b.action_id, ...(b.value !== undefined && { value: b.value }) })),
    at: ctx.now(),
  })
  return { channel, ts: sent.id, message: await shown(ctx, sent, 'chat.postMessage'), ...metadata(warnings) }
}

// Whether the target is one of the agent's own cards (a read that fails leaves it to the edit's errors).
async function ownCard(ctx: SlackCtx, channel: string, ts: string): Promise<boolean> {
  if (ctx.approvals === undefined) return false
  try {
    const m = await ctx.read.message(channel, ts)
    return m.approval !== undefined && m.author === (await ctx.me()).id
  } catch {
    return false
  }
}

export const CHAT_METHODS: SlackMethods = {
  'chat.postMessage': async (args, ctx) => {
    const channel = required(args, 'channel', 'channel_not_found')
    const content = contentOf(args, ctx, 'post')
    const warnings = [...content.warnings, ...IGNORED.filter((k) => args[k] !== undefined && args[k] !== '').map((k) => `ignored_argument:${k}`)]
    const thread = str(args, 'thread_ts')
    if (content.card !== undefined) return postCard(ctx, channel, content as Content & { card: CardSpec }, thread, warnings)
    ctx.preflight('chat.postMessage', channel, content.text)
    let sent: ApiMessage
    try {
      sent = await ctx.write.post(channel, {
        text: content.text,
        ...(content.rich !== undefined && { rich: content.rich }),
        ...(content.mentions.length > 0 && { mentions: content.mentions }),
        ...(thread !== undefined && { thread }),
      })
    } catch (err) {
      if (thread !== undefined && err instanceof ReadError && err.code === 'message_not_found') throw new SlackError('thread_not_found')
      throw err
    }
    return { channel, ts: sent.id, message: await shown(ctx, sent, 'chat.postMessage'), ...metadata(warnings) }
  },

  'chat.update': async (args, ctx) => {
    const channel = required(args, 'channel', 'channel_not_found')
    const ts = required(args, 'ts', 'message_not_found')
    const content = contentOf(args, ctx, 'update')
    ctx.preflight('chat.update', channel, content.text)
    const card = await ownCard(ctx, channel, ts)
    const edited = await ctx.write.edit(channel, ts, content.text, content.rich)
    // A card the layer closes leaves its file (no click can come any more); one an answer reached first stays
    // until the click is acked.
    if (card && ctx.approvals !== undefined && (await ctx.approvals.state(channel, ts)).approval.state === 'open') {
      const closed = await ctx.approvals.close(channel, ts)
      if (closed.approval?.state === 'closed') await ctx.cards.remove(channel, ts)
    }
    const message = await shown(ctx, edited, 'chat.update')
    return { channel, ts, text: message.text, message, ...metadata(content.warnings) }
  },

  'chat.delete': async (args, ctx) => {
    const channel = required(args, 'channel', 'channel_not_found')
    const ts = required(args, 'ts', 'message_not_found')
    try {
      await ctx.write.remove(channel, ts)
    } catch (err) {
      if (err instanceof WriteError && err.code === 'not_own_message') throw new SlackError('cant_delete_message')
      throw err
    }
    return { channel, ts }
  },
}
