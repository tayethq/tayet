// chat.postMessage / update / delete (PLANO-AGENTES §0.3.12 items 4, 7, 11; §0.3.17, A3-4).
// - `text` (mrkdwn unless `mrkdwn: false`) → the product's rich text + mentions (slack/mrkdwn.ts); with no
//   `text`, `blocks` are flattened (slack/blocks.ts), their warnings in `response_metadata.warnings`. With a
//   `markdown` block among the `blocks`, the blocks are the content and the `text` is ignored.
//   `markdown_text` is read as a single `markdown` block; with a non-empty `text` or with `blocks` in the same
//   call → `markdown_text_conflict`, nothing sent. Nothing left → `no_text`.
// - An `actions` block (A3-4, with the approval facade): chat.postMessage sends an approval card
//   (slack/actions.ts) — read even when there is `text`, which is then the request; with no `text`, the
//   request is the other blocks flattened. The card's `action_id`/`block_id`/`value` go to the layer's file
//   (slack/cards.ts) before the answer. Preflight before any effect: the card's probe (request + options) and
//   the content scan of every `action_id`, `value` and `block_id`. Without the facade, `actions` is dropped
//   with `blocks_unsupported:actions`, as before.
// - chat.update on one of the agent's own cards, no `actions` block: the request is edited (the core keeps
//   the close as it is), then the card is closed when it is still open (after the automatic seal, it is only
//   the edit). The response_url (slack/router.ts) takes this same path.
// - chat.update with an `actions` block (with the facade), on one of the agent's own cards:
//   - the card is open (no valid answer) and the buttons give the same options (id, label and style, in
//     order): the request is edited and the card stays open; the card's entry in the layer's file takes the
//     new `action_id`/`block_id`/`value`;
//   - otherwise (answered, closed, or other options): the card is closed if still open (the core's close,
//     which never hides an answer) and a NEW card is posted with the call's request and buttons, in the same
//     place (the origin's thread, or the root), by the chat.postMessage path (preflight, content scan, the
//     file's entry before the answer). The old card is not edited.
//   - The first card's `ts` (the chain's origin) then stands for the live card (slack/cards.ts aliases):
//     chat.update and the response_url on the origin or on any card of the chain act on the live card;
//     chat.update answers the `ts` the app passed, with the live card in `message`. chat.delete acts on the
//     literal `ts`.
//   On any other message, an `actions` block → `invalid_blocks`.
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
import { refusalOf } from './errors'
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
  // Whether the call had an `actions` block (read only with the facade).
  actions: boolean
  // The approval card of an `actions` block (with the facade, A3-4).
  card?: CardSpec
}

const hasMarkdownBlock = (blocks: readonly unknown[]): boolean =>
  blocks.some((b) => b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'markdown')

// The content of a post or an update: `text` wins over `blocks`, unless the blocks hold a `markdown` block;
// `markdown_text` stands for one `markdown` block and takes neither `text` nor `blocks` beside it. With the
// approval facade, an `actions` block is read whatever the `text` (A3-4): the card of a post or of an update.
function contentOf(args: SlackArgs, ctx: SlackCtx): Content {
  const text = str(args, 'text')
  const resolve = resolverOf(ctx)
  let raw = nested(args, 'blocks')
  if (raw !== undefined && !Array.isArray(raw)) throw new SlackError('invalid_arguments')
  const markdown = args.markdown_text
  if (markdown !== undefined && markdown !== null && typeof markdown !== 'string') throw new SlackError('invalid_arguments')
  if (typeof markdown === 'string' && markdown !== '') {
    if (text !== undefined || raw !== undefined) throw new SlackError('markdown_text_conflict')
    raw = [{ type: 'markdown', text: markdown }]
  }
  let blocks = raw as unknown[] | undefined
  let actions: ReturnType<typeof readActions> | undefined
  if (ctx.approvals !== undefined && blocks !== undefined) {
    actions = readActions(blocks)
    blocks = actions.rest
  }
  let out: Content
  if (text !== undefined && text.trim() !== '' && !(blocks !== undefined && hasMarkdownBlock(blocks))) {
    out = bool(args, 'mrkdwn', true) ? { ...mrkdwnToRich(text, resolve), warnings: [], actions: false } : { text: unescapeMrkdwn(text), mentions: [], warnings: [], actions: false }
  } else {
    if (blocks === undefined) throw new SlackError('no_text')
    out = { ...flattenBlocks(blocks, resolve), actions: false }
  }
  if (actions !== undefined) out = { ...out, warnings: [...out.warnings, ...actions.warnings], actions: actions.present, ...(actions.card !== undefined && { card: actions.card }) }
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
    throw refusalOf(leaks)
  }
}

const entryOf = (card: CardSpec) => card.buttons.map((b) => ({ option: b.option.id, action_id: b.action_id, ...(b.value !== undefined && { value: b.value }) }))

// A card through the facade, then its entry in the layer's file (before the caller answers).
async function sendCard(ctx: SlackCtx, channel: string, content: Content & { card: CardSpec }, thread: string | undefined): Promise<ApiMessage> {
  const approvals = ctx.approvals
  if (approvals === undefined) throw new SlackError('internal_error')
  const { card } = content
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
  await ctx.cards.add({ conversation: channel, id: sent.id, block_id: card.block_id, actions: entryOf(card), at: ctx.now() })
  return sent
}

// chat.postMessage with a card: the preflight, the facade's request, then the layer's file, then the answer.
async function postCard(ctx: SlackCtx, channel: string, content: Content & { card: CardSpec }, thread: string | undefined, warnings: string[]) {
  preflightCard(ctx, channel, content.text, content.card)
  const sent = await sendCard(ctx, channel, content, thread)
  return { channel, ts: sent.id, message: await shown(ctx, sent, 'chat.postMessage'), ...metadata(warnings) }
}

// The target when it is one of the agent's own cards (a read that fails leaves it to the edit's errors).
async function ownCard(ctx: SlackCtx, channel: string, ts: string): Promise<ApiMessage | undefined> {
  if (ctx.approvals === undefined) return undefined
  try {
    const m = await ctx.read.message(channel, ts)
    return m.approval !== undefined && m.author === (await ctx.me()).id ? m : undefined
  } catch {
    return undefined
  }
}

type Option = CardSpec['buttons'][number]['option']
const sameOptions = (a: readonly Option[], b: readonly Option[]): boolean =>
  a.length === b.length && a.every((o, i) => o.id === b[i]?.id && o.label === b[i]?.label && o.style === b[i]?.style)

// chat.update with buttons on one of the agent's own cards (`live`, the chain's live card; `ts`, what the
// app passed). Preflight before any effect.
async function updateCard(ctx: SlackCtx, channel: string, ts: string, live: ApiMessage, content: Content & { card: CardSpec }) {
  const approvals = ctx.approvals
  if (approvals === undefined) throw new SlackError('internal_error')
  const { card } = content
  preflightCard(ctx, channel, content.text, card)
  const options = card.buttons.map((b) => b.option)
  const status = (await approvals.state(channel, live.id)).approval
  if (status.state === 'open' && sameOptions(status.options, options)) {
    // The same card, still open: edit the request in place; the click gives back the new fields.
    const edited = await ctx.write.edit(channel, live.id, content.text, content.rich)
    const entry = ctx.cards.get(channel, live.id)
    const actions = entryOf(card)
    if (entry === undefined || entry.block_id !== card.block_id || JSON.stringify(entry.actions) !== JSON.stringify(actions)) {
      await ctx.cards.add({ conversation: channel, id: live.id, block_id: card.block_id, actions, at: entry?.at ?? ctx.now() })
    }
    const message = await shown(ctx, edited, 'chat.update')
    return { channel, ts, text: message.text, message, ...metadata(content.warnings) }
  }
  // Another card: close this one if still open (an answer is never hidden), then a new one in its place.
  if (status.state === 'open') {
    const closed = await approvals.close(channel, live.id)
    if (closed.approval?.state === 'closed') await ctx.cards.remove(channel, live.id)
  }
  const origin = ctx.cards.originOf(channel, live.id)
  let thread = live.thread
  if (origin !== live.id) {
    try {
      thread = (await ctx.read.message(channel, origin)).thread
    } catch {
      // The origin is gone (chat.delete acts on the literal ts): every card of a chain shares its thread.
    }
  }
  const sent = await sendCard(ctx, channel, content, thread)
  await ctx.cards.alias({ conversation: channel, origin, live: sent.id, at: ctx.now() })
  const message = await shown(ctx, sent, 'chat.update')
  return { channel, ts, text: message.text, message, ...metadata(content.warnings) }
}

export const CHAT_METHODS: SlackMethods = {
  'chat.postMessage': async (args, ctx) => {
    const channel = required(args, 'channel', 'channel_not_found')
    const content = contentOf(args, ctx)
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
    const content = contentOf(args, ctx)
    ctx.preflight('chat.update', channel, content.text)
    // The origin of a chain, or any card of it, stands for the live card.
    await ctx.cards.load()
    const target = ctx.cards.liveOf(channel, ts)
    const card = await ownCard(ctx, channel, target)
    if (content.actions && card === undefined) throw new SlackError('invalid_blocks')
    if (card !== undefined && content.card !== undefined) return updateCard(ctx, channel, ts, card, content as Content & { card: CardSpec })
    const edited = await ctx.write.edit(channel, target, content.text, content.rich)
    // A card the layer closes leaves its file (no click can come any more); one an answer reached first stays
    // until the click is acked.
    if (card !== undefined && ctx.approvals !== undefined && (await ctx.approvals.state(channel, target)).approval.state === 'open') {
      const closed = await ctx.approvals.close(channel, target)
      if (closed.approval?.state === 'closed') await ctx.cards.remove(channel, target)
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
