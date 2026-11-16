// A Bolt 5.1.0 agent with no patch in HTTP mode (no Socket Mode), as an app written for Slack's Request URL
// runs: the sidecar's local token as its bot token and as its signing secret, the sidecar's base URL in
// clientOptions, its own listener on a loopback port at `/slack/actions`. Run as a child process by the stack
// test of the clicks over HTTP (test/integration/sidecar-slack-actions-http.test.ts). Once listening, it posts
// an approval card (`text` + an `actions` block of two buttons whose action_ids are off the option rule, with
// values) in the conversation it was given. A click (`app.action`, the signature checked by Bolt itself) is
// printed and answered with respond({ replace_original: true, text: `respondido <value>` }). One JSON line per
// event (never the token).
//   SIDECAR_URL=http://127.0.0.1:<port> SIDECAR_TOKEN=<local token> ACTIONS_PORT=<port> CONVERSATION=<C…>
//   MARKER=<word> node test/support/bolt-http-agent.mjs
import { App, LogLevel } from '@slack/bolt'

const url = process.env.SIDECAR_URL
const token = process.env.SIDECAR_TOKEN
const port = Number(process.env.ACTIONS_PORT)
const conversation = process.env.CONVERSATION
const marker = process.env.MARKER
const out = (line) => process.stdout.write(`${JSON.stringify(line)}\n`)

const app = new App({ token, signingSecret: token, endpoints: '/slack/actions', clientOptions: { slackApiUrl: `${url}/slack/api/` }, logLevel: LogLevel.ERROR })

app.action(/.+/, async ({ ack, body, action, respond, context }) => {
  await ack()
  out({ evt: 'action', action, user: body.user.id, channel: body.channel.id, message_ts: body.container.message_ts, card_ts: body.message?.ts, retry_num: context.retryNum ?? null })
  const text = `respondido ${action.value ?? action.action_id}`
  await respond({ replace_original: true, text })
  out({ evt: 'responded', text })
})

process.on('SIGTERM', () => {
  app.stop().finally(() => process.exit(0))
})

await app.start({ port, host: '127.0.0.1' })
out({ evt: 'started' })

const res = await app.client.chat.postMessage({
  channel: conversation,
  text: `Publicar a versão ${marker}?`,
  blocks: [
    {
      type: 'actions',
      block_id: 'release',
      elements: [
        { type: 'button', action_id: 'Approve.Release', value: `release-${marker}`, style: 'primary', text: { type: 'plain_text', text: 'Aprovar' } },
        { type: 'button', action_id: 'Reject.Release', value: `reject-${marker}`, style: 'danger', text: { type: 'plain_text', text: 'Rejeitar' } },
      ],
    },
  ],
})
out({ evt: 'card', ts: res.ts, warnings: res.response_metadata?.warnings ?? [] })
