// reactions.add / reactions.remove (ADR-087 dec. 6; PLANO-AGENTES §0.3.12). `channel`, `timestamp` (the
// message's ts) and `name`: a Slack name of the iamcal table (slack/emoji.ts, `name::skin-tone-N`
// included), or the character itself. An unknown name → `invalid_name`. The core is idempotent; Slack
// is not: a reaction the agent already has → `already_reacted`; removing one it does not have →
// `no_reaction`.
import { emojiOf, isEmojiChar } from './emoji'
import { required, SlackError, type SlackArgs, type SlackMethods } from './router'

function target(args: SlackArgs): { channel: string; ts: string; emoji: string } {
  const channel = required(args, 'channel', 'channel_not_found')
  const ts = required(args, 'timestamp', 'message_not_found')
  const name = required(args, 'name', 'invalid_name')
  const emoji = emojiOf(name) ?? (isEmojiChar(name) ? name : undefined)
  if (emoji === undefined) throw new SlackError('invalid_name')
  return { channel, ts, emoji }
}

export const REACTION_METHODS: SlackMethods = {
  'reactions.add': async (args, ctx) => {
    const { channel, ts, emoji } = target(args)
    if (!(await ctx.write.react(channel, ts, emoji))) throw new SlackError('already_reacted')
    return {}
  },

  'reactions.remove': async (args, ctx) => {
    const { channel, ts, emoji } = target(args)
    if (!(await ctx.write.unreact(channel, ts, emoji))) throw new SlackError('no_reaction')
    return {}
  },
}
