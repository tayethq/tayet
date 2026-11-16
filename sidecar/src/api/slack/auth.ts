// auth.test (PLANO-AGENTES §0.3.12 items 1, 7). `url` is the product URL the agent was started with;
// `team` is the workspace's `T…` (the native `me` carries no workspace name); `user` the agent's name
// (its `U…` when it has none); `bot_id` its `B…`, which Bolt reads with `user_id` to drop its own messages.
import type { SlackAuthTest } from './contract'
import type { SlackMethods } from './router'

const withSlash = (url: string): string => (url.endsWith('/') ? url : `${url}/`)

export const AUTH_METHODS: SlackMethods = {
  'auth.test': async (_args, ctx) => {
    const me = ctx.native(await ctx.me(), 'auth.test')
    const out: Omit<SlackAuthTest, 'ok'> = {
      url: withSlash(ctx.productUrl),
      team: me.workspace,
      team_id: me.workspace,
      user: me.name !== '' ? me.name : me.id,
      user_id: me.id,
      bot_id: ctx.read.bot(),
    }
    return out
  },
}
