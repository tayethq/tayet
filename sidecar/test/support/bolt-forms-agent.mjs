// A Bolt 5.1.0 agent with no patch that opens a form, as an app written for Slack does: in Socket Mode
// (MODE=socket) or with the HTTP receiver and processBeforeResponse (MODE=http, listening on ACTIONS_PORT at
// `/slack/actions`). The sidecar's local token is its bot token, its app token and its signing secret. Run as a
// child process by test/integration/sidecar-slack-forms.test.ts.
// - Once started, it posts a card of one button (`Edit`) in CONVERSATION.
// - The click (`app.action('Edit')`) and the command `/editar` (`app.command`, Socket Mode only) open the same
//   modal with views.open, the click before its ack.
// - The submission (`app.view('edit')`): a reason shorter than 5 characters, or one that starts with `round`, is
//   answered with `errors` on the reason's block; any other with an empty ack.
// One JSON line per event (never the token).
//   SIDECAR_URL=… SIDECAR_TOKEN=… MODE=socket|http [ACTIONS_PORT=…] CONVERSATION=<C…> MARKER=<word>
//   node test/support/bolt-forms-agent.mjs
import { App, LogLevel } from '@slack/bolt'

const url = process.env.SIDECAR_URL
const token = process.env.SIDECAR_TOKEN
const http = process.env.MODE === 'http'
const conversation = process.env.CONVERSATION
const marker = process.env.MARKER
const out = (line) => process.stdout.write(`${JSON.stringify(line)}\n`)
const clientOptions = { slackApiUrl: `${url}/slack/api/` }

const app = http
  ? new App({ token, signingSecret: token, endpoints: '/slack/actions', processBeforeResponse: true, clientOptions, logLevel: LogLevel.ERROR })
  : new App({ token, appToken: token, socketMode: true, clientOptions, logLevel: LogLevel.ERROR })

const text = (t) => ({ type: 'plain_text', text: t })
const modal = (origin) => ({
  type: 'modal',
  callback_id: 'edit',
  private_metadata: JSON.stringify({ origin, marker }),
  title: text('Editar decisão'),
  submit: text('Salvar'),
  close: text('Cancelar'),
  blocks: [
    { type: 'section', text: { type: 'mrkdwn', text: 'Diga *por que* a decisão muda.' } },
    { type: 'input', block_id: 'why', label: text('Motivo'), element: { type: 'plain_text_input', action_id: 'why_input', multiline: true, max_length: 500 } },
    { type: 'input', block_id: 'level', optional: true, label: text('Nível'), element: { type: 'radio_buttons', action_id: 'pick', options: [{ text: text('Baixo'), value: 'low' }, { text: text('Alto'), value: 'high' }] } },
  ],
})

const open = async (client, trigger, origin) => {
  const started = Date.now()
  try {
    const res = await client.views.open({ trigger_id: trigger, view: modal(origin) })
    out({ evt: 'opened', origin, view_id: res.view.id, private_metadata: res.view.private_metadata, ms: Date.now() - started })
  } catch (err) {
    out({ evt: 'open-failed', origin, error: err?.data?.error ?? String(err), ms: Date.now() - started })
  }
}

app.action('Edit', async ({ ack, body, client }) => {
  await open(client, body.trigger_id, 'card')
  await ack()
})

app.command('/editar', async ({ ack, command, client }) => {
  await ack()
  await open(client, command.trigger_id, 'command')
})

app.view('edit', async ({ ack, view, body }) => {
  const why = view.state.values.why?.why_input?.value ?? ''
  out({ evt: 'submission', values: view.state.values, meta: view.private_metadata, user: body.user.id, view_id: view.id })
  if (why.length < 5 || why.startsWith('round')) await ack({ response_action: 'errors', errors: { why: 'Escreva mais.' } })
  else await ack()
})

process.on('SIGTERM', () => {
  app.stop().finally(() => process.exit(0))
})

await (http ? app.start({ port: Number(process.env.ACTIONS_PORT), host: '127.0.0.1' }) : app.start())
out({ evt: 'started' })

const res = await app.client.chat.postMessage({
  channel: conversation,
  text: `Mudar a decisão ${marker}?`,
  blocks: [{ type: 'actions', block_id: 'edit', elements: [{ type: 'button', action_id: 'Edit', value: 'edit', text: text('Editar') }] }],
})
out({ evt: 'card', ts: res.ts })
