// A Bolt 5.1.0 agent with no patch, as an operator writes it (the README's Socket Mode snippet): the
// sidecar's local token in both fields, its base URL in clientOptions. Run as a child process by the
// stack tests (test/integration/sidecar-socket.test.ts, sidecar-slack-approval.test.ts, sidecar-slack-commands.test.ts). It answers every
// mention in the mention's thread with `recebido <last word>` — except a mention with `cartão`, which it
// answers with an approval card (`text` + an `actions` block of two buttons whose action_ids are off the
// option rule, with values; A3-4). A click (`app.action`) is printed and answered with
// respond({ replace_original: true, text: `respondido <value>` }). A `/` command (`app.command`, A4-3) is printed,
// acked with `ack <args>` and answered with respond({ text: `respondido <args>` }). One JSON line per event (never
// the token).
//   SIDECAR_URL=http://127.0.0.1:<port> SIDECAR_TOKEN=<local token> node test/support/bolt-agent.mjs
import { App, LogLevel } from '@slack/bolt'

const url = process.env.SIDECAR_URL
const token = process.env.SIDECAR_TOKEN
const out = (line) => process.stdout.write(`${JSON.stringify(line)}\n`)

const app = new App({ token, appToken: token, socketMode: true, clientOptions: { slackApiUrl: `${url}/slack/api/` }, logLevel: LogLevel.ERROR })

app.event('message', async ({ event }) => {
  out({ evt: 'message', event })
})

app.event('app_mention', async ({ event, say }) => {
  out({ evt: 'app_mention', event })
  const word = event.text.trim().split(/\s+/).pop()
  if (/cartão/.test(event.text)) {
    const res = await say({
      text: `Publicar a versão ${word}?`,
      blocks: [
        {
          type: 'actions',
          block_id: 'release',
          elements: [
            { type: 'button', action_id: 'Approve.Release', value: `release-${word}`, style: 'primary', text: { type: 'plain_text', text: 'Aprovar' } },
            { type: 'button', action_id: 'Reject.Release', value: `reject-${word}`, style: 'danger', text: { type: 'plain_text', text: 'Rejeitar' } },
          ],
        },
      ],
    })
    out({ evt: 'card', ts: res.ts, warnings: res.response_metadata?.warnings ?? [] })
    return
  }
  const res = await say({ text: `recebido ${word}`, thread_ts: event.ts })
  out({ evt: 'said', ts: res.ts, thread_ts: event.ts })
})

app.action(/.+/, async ({ ack, body, action, respond }) => {
  await ack()
  out({ evt: 'action', action, user: body.user.id, channel: body.channel.id, message_ts: body.container.message_ts })
  const text = `respondido ${action.value ?? action.action_id}`
  await respond({ replace_original: true, text })
  out({ evt: 'responded', text })
})

app.command(/.+/, async ({ ack, command, respond }) => {
  await ack(`ack ${command.text}`)
  out({ evt: 'command', command })
  await respond({ text: `respondido ${command.text}` })
  out({ evt: 'command-responded' })
})

process.on('SIGTERM', () => {
  app.stop().finally(() => process.exit(0))
})

await app.start()
out({ evt: 'started' })
