# tayet-agent

Runs a Tayet agent on your own machine. An agent is a workspace member that your programs operate:
it reads the conversations it was added to and posts in them, and everyone sees it marked as an
agent. `tayet-agent` connects out to your Tayet workspace and exposes a small HTTP API on this
machine for your programs to use. It only makes outbound connections.

The agent belongs to its operator, the person who created it: it joins a conversation only when
its operator adds it. An invitation from anyone else is declined (the agent leaves the room at once,
and its log shows `invite-refused`).

You need Node.js 22 or newer.

## Run it

A workspace admin creates the agent in Tayet, under People, and Tayet shows the command once:

```
npx tayet-agent --server <your Tayet address> --token <credential>
```

`--server` is the address of your Tayet workspace, the one you open in the browser (for example
`https://chat.example.com`). The credential is shown once; if it is lost, reissue it in Tayet and
restart the agent with the new one.

To keep the credential out of the command line and shell history (Docker, systemd), set
`TAYET_AGENT_TOKEN` instead of passing `--token`. When both are present, `--token` wins.

If the agent's local store is lost or damaged, the agent reissues its own credential and keeps
running; the `--token` of your configuration then stays only as the seed (see
[Store loss and automatic reissue](#store-loss-and-automatic-reissue)).

| Option | |
|---|---|
| `--server <address>` | Your Tayet address. |
| `--token <credential>` | The agent credential (or `TAYET_AGENT_TOKEN`). |
| `--store <dir>` | The agent's local directory (default: a per-user data directory). One store per agent. |
| `--listen <host:port>` | Address of the local API (default `127.0.0.1:7878`). Give each agent on one machine its own port. |
| `--slack-manifest <file>` | A Slack app manifest in JSON: its slash commands become the agent's commands, declared at every start ([Slash commands](#slash-commands)). |
| `--slack-actions-url <url>` | Deliver the approval card's clicks as signed HTTP POSTs to this URL on this machine, instead of Socket Mode ([Clicks over HTTP](#clicks-over-http)). |
| `--rotate-local-token` | Replace the local token and exit (run it with the agent stopped). The local token is also the signing secret of `--slack-actions-url`. |
| `--debug` | Add diagnostics: identifiers in the log lines, library output on stderr. |
| `--help` | Show the usage. |

The agent logs one JSON line per event on stdout. The credential and the local token never appear in
the logs. By default the lines carry no internal identifier either: conversations appear as their `C…`
or `D…` id, and the default store directory is named after the agent's `U…` id. `--debug` adds the
device identifier and its key to the `whoami`, `identity`, `identity-reset` and `revoked` lines, and
sends library diagnostics to stderr. Error lines carry the error's own text in `message`, which may
name internal identifiers: it is diagnostics, kept for troubleshooting.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Stopped by a signal (SIGTERM/SIGINT). |
| 1 | Unexpected error. |
| 64 | Usage error (a missing or invalid option). |
| 65 | The store belongs to another agent or workspace. Nothing is deleted. |
| 69 | Tayet is unreachable, or the address is not a Tayet address. Also when no account service is found (a development address without a discovery document): the agent needs it to learn its operator. |
| 70 | The agent needs a new credential and automatic recovery was not possible: reissue it in Tayet. |
| 73 | The local API address is in use (another agent on this machine?): use `--listen`. |
| 75 | Another process is using this store. |
| 77 | The credential is not an agent credential. |
| 78 | The credential was refused or revoked. At runtime the store is wiped. Do not restart in a loop. Also `operator-unknown`: the agent has no operator recorded, and only a workspace admin can fix it, by creating the agent again. Also `self-reissue-failed` with `step` `mint` or `sweep`: the automatic reissue ended the old credential without issuing a new one; reissue it in Tayet. |

A restart policy should stop on the terminal codes 64, 65, 77 and 78 instead of looping.

## Store loss and automatic reissue

When the agent's local store is lost or damaged (the encrypted store deleted or unreadable, or the
whole directory gone while the credential still works), the agent asks Tayet for a new credential
with its current one, writes it to `<store>/credential`, clears the old device and restarts itself
once, in the same process. It logs `credential-rotated`. From then on the `--token` (or
`TAYET_AGENT_TOKEN`) of your configuration is no longer valid: it is only the seed by which the agent
finds the stored credential. Nothing in your configuration needs to change.

- `credential` is a secret of the same class as `storage.key` (mode 0600). Back it up, or not, the same
  way. With `--store` it lives in that directory; in the Docker image, in `/data`.
- The agent reissues at most once per run, and not again within 10 minutes of the last reissue; in
  those cases, and when Tayet refuses or fails, it exits 70 or 78 (above).
- A revoked credential is never reissued: revocation ends with 78.
- If an admin reissues the credential in Tayet, restart the agent with the new one: the stored
  credential is then removed.
- Losing the whole directory after a reissue loses `credential` as well: the agent exits 78. Reissue
  the credential in Tayet and restart with the new one.
- One credential runs one store. Starting the same credential in a second store (another directory or
  another machine) moves the agent there: the second one reissues, and the first one stops with 78.
  Restarting the first one does not take the agent back; it exits 78 again.

## Docker

```
docker run -d --name my-agent \
  -e TAYET_AGENT_TOKEN=<credential> \
  -v my-agent-data:/data \
  ghcr.io/tayethq/tayet-agent --server <your Tayet address>
```

The image keeps its store in `/data` and listens on `0.0.0.0:7878` inside the container (it logs a
warning, since the local token is then the only guard). No port is published by default: publish one
(`-p 127.0.0.1:7878:7878`) or reach it from another container on the same network.

## Local API

Once ready, the agent serves HTTP on the `--listen` address. Every request needs
`Authorization: Bearer <local token>`. The local token is in `<store>/local.token` and is never printed;
`<store>/api.json` has the URL. Requests with an `Origin` header are refused. Ids are opaque: `C…` and
`D…` conversations, `U…` people, `T…` the workspace, `F…` files; a message is its `ts` inside its
conversation.

| Route | |
|---|---|
| `GET /v1/healthz` | Liveness (no token). |
| `GET /v1/me` | The agent. |
| `GET /v1/conversations` · `GET /v1/conversations/:id` | Conversations the agent is in. |
| `GET /v1/conversations/:id/members` | Members of a conversation. |
| `GET /v1/conversations/:id/messages` | Messages, newest first (`limit`, `cursor`, `oldest`, `latest`, `inclusive`, `thread`). |
| `POST /v1/conversations/:id/messages` | Post `{ text, thread?, replyTo?, mentions?, markdown? }`; waits for acceptance (up to 30 s). |
| `PATCH /v1/conversations/:id/messages/:ts` · `DELETE …/:ts` | Edit (`{ text, markdown? }`) or remove one of the agent's own messages. On an approval card, PATCH changes only the request. |
| `POST /v1/conversations/:id/approvals` | Ask for a decision: `{ text, options, markdown?, thread?, mentions? }` (see below). Answers like a message POST, with `approval`. |
| `POST /v1/conversations/:id/approvals/:ts/close` | Close one of the agent's cards (`{ text?, markdown? }`; without `text` the request stays). Closing a closed card changes nothing. May answer `answered` (see below). |
| `GET /v1/conversations/:id/approvals/:ts` | The state of one of the agent's cards: `{ conversation, id, approval }`. |
| `PUT /v1/conversations/:id/panel` · `DELETE …` · `GET …` | Write, clear or read the agent's pinned panel (see below). PUT and DELETE answer 202 when queued. |
| `PUT /v1/commands` · `DELETE …` · `GET …` | Declare, clear or read the agent's `/` commands, for every conversation it is in (see below). PUT and DELETE answer 202 when kept. |
| `PUT /v1/conversations/:id/messages/:ts/reactions/:emoji` · `DELETE …` | Add or remove a reaction. |
| `POST /v1/conversations/:id/files?name=&thread=` | Upload a file (the body is the bytes). |
| `GET /v1/files/:id` | Download a file. |
| `GET /v1/people/:id` | A person. |
| `GET /v1/events` | Server-Sent Events (`message.received`, `mention`, `message.edited`, `message.removed`, `reaction.changed`, `conversation.added`/`removed`, `member.changed`, `approval.answered`, `agent.revoked`, `resync`); reconnect with `Last-Event-ID`. |

`markdown: true` renders `text` as Markdown: bold, italic, strike, code, links, code blocks, quotes and
lists. A heading becomes a bold line and a table becomes a code block. The formatted version is sent only
when there is formatting, and `text` stays the plain fallback. Without `markdown` (or with `false`) the text
goes as is. Any other value is a 400 `invalid_argument`.

### Approval cards

An approval card asks the people of a conversation to choose one of 1 to 25 options. Each option is
`{ id, label, style? }`: `id` matches `[a-z0-9_-]{1,32}` and is unique on the card, `label` has 1 to 75
characters, `style` is `primary` or `danger`, and at most one option is `primary` (two are a 400, never
demoted). `text` is the request; other clients show it as plain text.

A client older than 0.1.1 reads a card with more than 3 options as malformed and shows its content as not
displayable: more than 3 options needs a Tayet server at 0.1.1 or later.

Any person in the conversation may answer, in the product; agents never answer, and the agent has no route
to answer a card. The first valid answer in the server's order decides. Then the agent gets

```json
{ "type": "approval.answered", "conversation": "C…", "id": "<the card's ts>", "option": "approve", "by": "U…", "at": 1731250000000 }
```

and the card is sealed: the agent closes it on its own, keeping the request. An answer that cannot be read
yet (its key has not arrived) is waited for; an invalid answer (another agent's, an option that is not on
the card) only writes the log line `approval-answer-ignored` with the reason.

Messages carry the card as `approval: { options, state?, answer? }`. `state` (`open`, `answered`,
`closed`) and `answer` (`{ option, by, at }`; `option` is absent while the answer cannot be read) come only
on the agent's own cards; another agent's card carries its options alone.

Closing a card never hides an answer. The close reads the answers before it writes and once more after: if
a person had already answered (or answers up to the instant of the close), the close answers with
`approval.state: "answered"` and the answer, and **the `approval.answered` event has already gone out** —
the card is closed either way. An answer that cannot be read yet keeps being watched after the close and is
reported when it can be read. An answer after the close does not count (`closed`).

The agent's open cards are kept in `<store>/approvals.json` (conversation ids, `ts` and options only), so a
card answered while the agent was stopped is reported when it starts again. **Delivery is at least once**: a
stop between the event and the seal sends the event again on the next start. Treat `approval.answered` as
idempotent by `id`.

An `approval.answered` that goes out while no event stream is connected (typically: decided at start-up,
before you connect) is kept in memory — at most 200, the oldest dropped first — and delivered to the first
stream that connects **without a cursor of this run** (no `Last-Event-ID`, or one that gets `resync`): right
after the `resync`, or first when there is none. Those frames carry no `id:` line, so your cursor does not
move back. A stream that reconnects with a cursor of this run gets the normal replay instead. `GET
…/approvals/:ts` reads a card's state at any time. With `--slack-actions-url` the Slack layer hears every
`approval.answered` from the start (it sends them over HTTP), so none is kept for a stream that connects later
([Clicks over HTTP](#clicks-over-http)); a stream already connected gets them as always.

### Pinned panel

The pinned panel is a board the agent keeps up to date in a conversation, shown above the timeline. It
adds no row to the conversation, notifies no one and is not searched. One panel per agent and conversation.

- `PUT /v1/conversations/:id/panel` with `{ text, markdown?, title? }` → **202** `{ conversation, pending:
  true }`. `text` up to 8 KiB (more is 413 `payload_too_large`), `markdown` as in the message POST; `title`
  is plain text, one line, at most 75 characters (otherwise 400). `thread` and `mentions` are refused (400).
  Each PUT replaces the content.
- `DELETE /v1/conversations/:id/panel` clears it → **202** `{ conversation, pending: true }`, or **204** when
  there is no panel (or it is already cleared) and nothing is pending. A PUT after a clear shows it again.
- `GET /v1/conversations/:id/panel` → `{ conversation, panel, pending }`: `panel` is `{ title?, text,
  updatedAt }`, or `null` with no panel or a cleared one; `unreadable: true` when the panel exists but cannot
  be read any more (the store was lost). `pending` is true while a write or a clear waits for its turn.

The write goes out **within 10 s**: the agent writes its panels at most once every 10 s, all conversations
together, in turn. A newer PUT or DELETE replaces the one still waiting in that conversation, so only the
latest version is written. **Messages come first**: a panel write waits while messages are being sent. When
the server limits the agent, the version stays pending and is written after the server's wait; a panel write
never fails with 429.

When a person joins the conversation, the agent writes the panel again with the same content, after a random
delay of up to 10 s (people who join in the same window share one rewrite; a new PUT or DELETE replaces it):
someone who joins cannot read what was written before they joined. A panel the agent can no longer read
(after a lost store) is not rewritten until its next PUT.

Nothing about the panel is kept on disk: the agent finds its own panel on the server. A restart loses what was
still pending, and the agent losing its membership drops it (log line `panel-dropped`).

### Commands

The agent declares the `/` commands it takes, once: people see them in the composer of every conversation the
agent is a member of, and of those it joins later. A person who picks one sends an ordinary message that
starts with `/name` and mentions the agent.

- `PUT /v1/commands` with `{ commands: [{ name, description, hint? }] }` → **202** `{ pending }`: the whole set,
  replacing the previous one. `name` is written without the slash: lowercase letters, digits, `-` and `_`, at
  most 32, starting with a letter or a digit. `description` is one line of 1 to 100 characters; `hint` (the
  arguments, shown as a placeholder) one line of up to 60. At most 25 commands, each name once, and the whole
  set at most 8 KiB (413 `payload_too_large`). Any other field, a repeated name or a rule broken is a 400
  `invalid_argument`. An empty list clears, as DELETE does.
- `DELETE /v1/commands` clears them in every conversation → **202** `{ pending }`, or **204** when nothing was
  written and no set was declared.
- `GET /v1/commands` → `{ commands, pending }`.

A Slack app can declare them from its app manifest instead: start the agent with `--slack-manifest <file>`
([Slash commands](#slash-commands)).

`pending` is the number of conversations still to update. The commands share the panel's budget: one write
every 10 s per agent, panels and commands together and in turn, messages first. Declaring the same set again
writes nothing; a restart writes only the conversations whose version differs. When a person joins a
conversation, the agent writes its commands there again (after the panel, in the same random window), so
whoever joins can read them.

The set and, per conversation, a hash of the version written there are kept in `<store>/commands.json`
(opaque ids only, mode 0600). The agent losing its membership forgets that conversation (log line
`commands-dropped` when a write was pending).

**Receiving a command.** A message that invokes one of the agent's commands carries `command: { name, args }`
(`name` without the slash), in `message.received`, `mention` (a command always mentions the agent), the
readable version of a message that could not be decrypted at first (`message.edited` and `mention`), the
history (`GET …/messages`) and MCP (`wait_for_mention`, `read_messages`). It comes only when a person (member or
guest) sent the command to this agent, the agent is among the mentions, and `name` is in the set declared now.
`args` is the plain text after `/name`, without the leading whitespace (`""` with no argument); the formatted
message stays whole in `rich`. There is no `command`:
- on an edited message, live or in the history: the agent already received the original, and an edit does not
  invoke again;
- on another agent's message, on a command for another agent, or when this agent is not mentioned: an ordinary
  message (a mention when it mentions the agent);
- for a name outside the declared set: an ordinary mention, and a log line `command-unknown` (without the
  name).

The edit of a panel or of a commands list (this agent's or another's) never reaches the agent as
`message.edited`.

Errors are `{ "error": { "code": "…", "message": "…" } }`; `rate_limited` (429) comes with
`Retry-After`. After a revocation every route answers 503 `revoked` and the process exits with 78.

A write whose content looks like an internal id is refused before anything is sent or queued: 422
`content_refused`, with `refused`, one entry per finding. `field` is where (`text`, `title`, `files[0].name`,
`approval.options[0].label`, `commands[0].description`, …) and `pattern` the kind of id, by product name:
`user_id`, `conversation_id`, `message_id` or `media_address`. The text that matched never comes back. Rephrase
and send again. This applies to the message POST and PATCH, the card POST and close, the panel PUT, the commands
PUT and the file POST (a name).

```json
{ "error": { "code": "content_refused", "message": "…", "refused": [{ "field": "text", "pattern": "user_id" }] } }
```

In a read of messages (`GET …/messages`, with or without `thread`), a message whose content (its text, rich text,
file names, card, command or the emoji of a reaction) looks like an internal id comes back withheld: `id`,
`conversation`, `author`, `mentionsMe` and `thread` (on a reply) stay, `text` is empty, `reactions` is empty and
`unavailable` is `true`; nothing else (no `rich`, `files`, thread summary, card or command). The rest of the page
comes back as usual. The message of an event goes out the same way.

The names people write — a conversation's `name` and `topic`, a person's `name`, the agent's own `name` — come back
as written: an ordinary word in them does not withhold the answer (a channel named `Verificação de contas` is
listed as such).

A 500 `internal` is the agent's own failure: an answer it withholds (a read that still carries an internal id once
those messages are withheld, such as one in a name, or the answer of a write that already happened), or a refusal
before the write for anything other than an id shape in the content.

## Slack layer (Web API)

The same listener speaks part of Slack's Web API, so a program written against a Slack SDK can run as a
Tayet agent by changing two things: the API base URL becomes `<api.json url>/slack/api/`, and the bot
token becomes the local token.

```js
import { WebClient } from '@slack/web-api'
const slack = new WebClient(localToken, { slackApiUrl: 'http://127.0.0.1:7878/slack/api/' })
```

The methods (Slack's cut for v1). Ids are the same opaque ids as the native API, plus a `B…` bot id in
`auth.test`.

| Method | |
|---|---|
| `auth.test` | The agent: `user_id`, `bot_id`, `team_id`. |
| `conversations.list` | **Only the conversations the agent is in** (a documented difference). `types`: `public_channel`, `private_channel`, `im`, `mpim` (a group conversation of up to 9 participants; the agent is in one when its operator includes it at creation). |
| `conversations.info` · `conversations.members` | A conversation of the agent; its members. |
| `conversations.history` · `conversations.replies` | Messages, newest first; a thread, its root first. |
| `conversations.open` | The DM the agent already has with that person (`users`: one `U…`). The agent never opens a DM: the person who operates it does. No DM yet → `restricted_action` with `response_metadata.warnings: ['dm_opened_by_operator']`; an unknown `U…` → `user_not_found`; two or more `users` → `invalid_arguments`. `channel` returns that conversation; `return_im` the whole object. |
| `chat.postMessage` · `chat.update` · `chat.delete` | Post; edit or remove the agent's own messages. An `actions` block of buttons posts an approval card (below). |
| `reactions.add` · `reactions.remove` | By Slack emoji name or the emoji itself. |
| `files.getUploadURLExternal` · `files.completeUploadExternal` | Upload v2 (`filesUploadV2`). |
| `files.info` | A file the agent has seen (`F…`): name, type, size, `url_private`, `url_private_download`. |
| `users.info` | A person. |
| `users.list` | **The people of the agent's conversations**, once each, sorted by name (a documented difference: no directory of the whole workspace). `limit`, `cursor`. |
| `views.open` | A form for the person who clicked a card or sent a command, with that `trigger_id` ([Forms](#forms)). |

- **Messages.** Text is mrkdwn both ways: mentions are `<@U…>`. Without `text`, `blocks` are turned into
  text; inputs are dropped and named in `response_metadata.warnings`, and a read never returns `blocks`.
  A `markdown` block, and the `markdown_text` argument of `chat.postMessage` and `chat.update`, render
  standard Markdown as `markdown: true` does on the local API: headings and tables come out degraded in the
  same way (a bold line, a code block). `<@U…>` and `<#C…>` inside it are resolved as in mrkdwn, except in
  code. When the `blocks` hold a `markdown` block, the blocks are the content and `text` is ignored; with no
  `markdown` block, `text` wins over `blocks`. `markdown_text` with a non-empty `text` or with `blocks` in
  the same call → `markdown_text_conflict` (nothing sent). `username`, `icon_url`, `icon_emoji`, `as_user` and `reply_broadcast` are ignored
  with a warning: the agent always speaks as itself.
- **Buttons are an approval card.** An `actions` block in `chat.postMessage` becomes the product's approval
  card: people see the request with the buttons and answer it in the app; the answer reaches your app as a
  `block_actions` (Socket Mode below, or an HTTP POST with `--slack-actions-url`). The block is read even when the call has `text`, which is then the
  request; without `text`, or when the other blocks hold a `markdown` block, the request is the other blocks
  turned into text. The rules:
  - one `actions` block per message, 1 to 25 `button`s; a label of 1 to 75 characters; `action_id` and
    `block_id` up to 255 characters, `value` up to 2,000, no repeated `action_id`. Breaking one →
    `invalid_blocks`, nothing sent;
  - a button with a `url`, any other element (selects, date pickers, overflow…) and a button's `confirm` are
    dropped or ignored with a warning (`blocks_unsupported:button_url`, `blocks_unsupported:<type>`,
    `blocks_unsupported:confirm`); with no button left the message is sent as an ordinary one;
  - more than one `primary` button: the first keeps the style, the others lose it
    (`approval_primary_demoted`);
  - your `action_id`, `block_id` and `value` come back unchanged in the click. They are kept per card in
    `<store>/slack-cards.json` (at most 500; the oldest goes first) until your app acks the click;
  - the card is answered once, by a person, in the app. The first answer closes it for everyone (the
    sidecar seals it); there is no second click.

  `chat.update` on one of your cards changes the request and closes the card if it is still open (usually
  the seal has closed it already, and it is only the edit). With an `actions` block, on one of your cards:
  - the card is still open (nobody answered) and the buttons give the same options (id, label and style, in
    order): the request is edited and the card stays open; new `action_id`, `block_id` or `value` replace the
    ones kept for the click;
  - otherwise (answered, closed, or other options): the card is closed if still open (an answer is never
    hidden) and a **new card** is posted with the request and buttons of the call, in the same place (the same
    thread, or the conversation's root). The old card is not edited. This is how a second person approves:
    update the card after the first answer, with the same buttons.

  The first card's `ts` then stands for the newest card of the chain: a click on any card of it comes with
  `container.message_ts` = that first `ts`, and `chat.update` or the `response_url` on that `ts` (or on any
  card of the chain) act on the newest card. `chat.update` answers the `ts` you passed, with the newest card
  in `message`. `chat.delete` acts on the literal `ts`. On any other message an `actions` block is
  `invalid_blocks`. A card posted through the native API or the MCP also sends its click here, with
  `action_id` = the option's id, `block_id: 'approval'` and no `value`.
- **Reactions.** `name` is a Slack emoji name (the iamcal set Slack uses, `thumbsup`/`+1`,
  `wave::skin-tone-3`) or the emoji itself. An unknown name is `invalid_name`; adding a reaction the agent
  already has is `already_reacted`; removing one it does not have is `no_reaction`. A read shows a
  reaction by its Slack name (👍 reads `+1`), or by the emoji when it has no name.
- **Files.** Upload v2, as `filesUploadV2` of the Slack SDKs does it: `files.getUploadURLExternal` returns
  an `upload_url` on this same listener (single use, valid for 10 minutes), the SDK posts the bytes there
  with the local token, and `files.completeUploadExternal` sends them: `initial_comment` first, as a
  message, then each file, in the thread when `thread_ts` is given. The answer carries each file's final
  `F…`. A completion uses up its uploads whether it succeeds or not; if one send fails, the ones before it
  stay sent and the answer is the error. `channel_id` is required (a file is always sent to a
  conversation); a title is not kept by the product and only comes back in the answer. The old
  `files.upload` answers `method_deprecated`. Uploads wait in `<store>/uploads/`, emptied at start and on
  a clean stop.
- **Downloads.** Every file in a read (`conversations.history`, `conversations.replies`, the `message`
  event) and in `files.info` carries `url_private` and `url_private_download`: the same URL,
  `<api.json url>/slack/files/F…`, on this listener. The Slack SDKs do not download files; fetch the URL
  with the local token as Bearer. The bytes are the file as the person sent it, already decrypted; the
  headers are those of `GET /v1/files/:id`. Without the token the URL answers 401 `not_authed`; an unknown
  file 404 `file_not_found`.

  ```js
  const { file } = await slack.files.info({ file: 'F0123456789' })
  const res = await fetch(file.url_private, { headers: { Authorization: `Bearer ${localToken}` } })
  const bytes = new Uint8Array(await res.arrayBuffer())
  ```
- **People.** `users.info` and `users.list` return the person's name as the conversation shows it; for
  someone who left, the name on the last message the agent saw from them (empty without one). `is_bot` is
  true for agents. `deleted` is always false, and there is never an `email`.
- **Answers.** HTTP 200 `{ ok }`, except the limit: HTTP 429 with `Retry-After`, which the Slack SDKs wait
  out. The upload and download URLs answer with HTTP status codes, as a file host does.
- **Content that looks like an internal id.** `chat.postMessage` (text or card), `chat.update`,
  `files.completeUploadExternal` and `views.open` refuse it before anything is sent: `invalid_arguments`, with
  one line per finding in `response_metadata.messages`, such as
  `[ERROR] content looks like an internal id: user_id` (`user_id`, `conversation_id`, `message_id` or
  `media_address`; never the text that matched). The Slack SDKs put the lines in the error's `data` and log
  them. `internal_error` stays the agent's own failure.
- **Messages withheld in a read.** In `conversations.history` and `conversations.replies`, a message whose content
  (the emoji of a reaction included) looks like an internal id comes back with an empty `text` and no files or
  reactions; a reply keeps its `thread_ts`. The rest of the page comes back. A thread's root keeps `thread_ts`, `reply_count` and `latest_reply` in `conversations.replies`,
  counted from the replies read.
- **Fixed Slack domains.** An app that checks Slack's domains in its code must also accept the sidecar's
  addresses: the `response_url` is on this listener (`<api.json url>/slack/response/…`, not
  `https://hooks.slack.com`), and so is the `upload_url` of upload v2 (not `files.slack.com`). A button whose
  click opens a form (`views.open`) works as in Slack, within the limits of [Forms](#forms).

Node verified: `@slack/web-api` 8.3.0.

## Socket Mode

Events and slash commands reach a Slack app through Socket Mode, their only transport: your app opens the
connection, so it needs no open port. So do the clicks on approval cards, unless the agent runs with
`--slack-actions-url` ([Clicks over HTTP](#clicks-over-http)). Point the SDK at the sidecar and put the local
token in both token fields:

```js
import { App } from '@slack/bolt'
const app = new App({
  token: localToken,
  appToken: localToken,
  socketMode: true,
  clientOptions: { slackApiUrl: 'http://127.0.0.1:7878/slack/api/' },
})
app.event('app_mention', async ({ event, say }) => {
  await say({ text: 'on it', thread_ts: event.ts })
})
await app.start()
```

`apps.connections.open` returns a `ws://…/slack/socket?ticket=…` URL on the same listener; the ticket is
single use and valid for 60 seconds, and the SDK asks for a new one on every reconnect. Several connections
at once are fine: every event goes to each of them.

- **Events.** `message` (a new message, `message_changed` with the new `message` and `previous_message.ts`,
  `message_deleted` with `deleted_ts`) and `app_mention`, which comes right after the `message` it belongs
  to. `channel_type` is `channel`, `group` (private), `im` or `mpim` (a group conversation). The agent's
  own messages carry its own user id, so Bolt's `ignoreSelf` drops them. `event_id` is opaque.
- **Clicks (`block_actions`).** Without `--slack-actions-url`, a person's answer to one of your approval cards
  comes as an `interactive` envelope with a `block_actions` payload: `actions[0]` carries your `action_id`, `block_id` and `value`
  (Bolt's `app.action(...)` matches on them), `user.id` is the person, `channel.id` and
  `container.message_ts` the card. Ack it (`await ack()`); a response payload in the ack is ignored. An answer
  decided while no socket was open (the sidecar was starting, your app was down) is kept and sent to the
  first connection that opens — or to the first `GET /v1/events` stream, whichever comes first. Delivered at
  least once: treat a click as idempotent by `container.message_ts`.

  ```js
  app.action('approve', async ({ ack, action, body, respond }) => {
    await ack()
    await respond({ replace_original: true, text: `Approved by <@${body.user.id}>` })
  })
  ```
- **`respond()` and `response_url`.** The `response_url` is on this listener
  (`<api.json url>/slack/response/…`), valid for 30 minutes and 5 calls, with no token: the URL is the
  credential, so keep it out of your logs. Only `replace_original: true` with `text` and/or `blocks` is
  supported: it takes the `chat.update` path above (changes the request; closes the card if still open; with
  an `actions` block, edits the open card or posts a new one in its place). Without `replace_original`, or
  with `delete_original` → HTTP 400 `invalid_arguments`; an unknown, expired or used-up URL → 404
  `expired_url`. Content that looks like an internal id → HTTP 400 `invalid_arguments`, nothing changed (no
  `response_metadata` here).
- **Slash commands.** A person's `/` command to your app comes as a `slash_commands` envelope (below).
- **Forms.** The `trigger_id` of a click or of a command opens one form with `views.open`, and the person's
  submission comes as a `view_submission` in an `interactive` envelope ([Forms](#forms)).
- **Not supported:** `views.update`, `views.push` and `views.publish` (App Home), ephemeral messages
  (`response_type: 'ephemeral'`, `chat.postEphemeral`), selects and other inputs in messages.
- **Acks and redelivery.** Ack every envelope (Bolt does it for you for events; for a click, call `ack()`). Without an ack within 3 seconds the
  envelope is sent again, up to three times (`retry_attempt` 1, 2, 3, `retry_reason: 'timeout'`), then it is
  dropped and a line is logged. A form's submission is the exception: one envelope, never sent again, with 10
  seconds for the ack.
- **Keepalive.** The sidecar pings every 10 seconds and answers the client's pings; a connection that does
  not answer for 30 seconds is closed.
- **Disconnect.** On a clean stop every connection gets `{ type: 'disconnect', reason: 'refresh_requested' }`
  and the SDK reconnects when the sidecar is back. On a revocation it gets `reason: 'link_disabled'`; after
  that `apps.connections.open` answers `token_revoked` and the process exits with 78.
- **Requests.** As on every route, a request with an `Origin` header is refused (403). A `Host` without a
  port is accepted on this route only, and only for the loopback name the sidecar listens on.

### Slash commands

Point the agent at your Slack app manifest, in JSON, and its slash commands become the agent's commands: people
see them in the composer of every conversation the agent is in, and picking one sends a message that starts with
`/name` and mentions the agent.

```
npx tayet-agent --server <your Tayet address> --token <credential> --slack-manifest manifest.json
```

- **The manifest.** Only `features.slash_commands[]` is read: `command` becomes the name (without the slash,
  lowercase), `description` the description, `usage_hint` the hint shown as a placeholder. `url` and
  `should_escape` are ignored. YAML is not accepted: export the manifest as JSON. A manifest with no slash commands
  declares none (and clears what an earlier start wrote).
- **The rules.** As for `PUT /v1/commands`: a name of 1 to 32 lowercase letters, digits, `-` and `_`, each once; a
  description of one line; at most 25 commands. A manifest that cannot be read, is not JSON or breaks a rule stops
  the start (exit code 64) with a usage line naming the entry's position and the rule, never its content. A
  description over 100 characters or a hint over 60 is cut at the limit with `…`, and a `slack-manifest-cut` line
  counts the cuts.
- **Who sets the set.** The manifest is declared at every start, once the agent is online (`slack-manifest-declared`
  line); a conversation that already has it is not written again. A `PUT`/`DELETE /v1/commands`, `set_commands` or
  `clear_commands` after that holds until the next start. Without the flag nothing changes.
- **The envelope.** A person who invokes one of the agent's commands sends your app a `slash_commands` envelope in
  place of the `message` and the `app_mention` of that message (also when the message could only be decrypted
  later). Bolt's `app.command('/name', …)` matches on `command`. The payload: `command` (`/name`), `text` (the
  arguments), `channel_id`, `channel_name` (`directmessage` in a DM), `user_id`, `user_name`, `team_id`,
  `api_app_id`, `trigger_id` (opens one form, [Forms](#forms)) and `response_url`, plus two fields Slack does not have:
  `message_ts` (the command's message) and `thread_ts` (only when the command was sent in a thread). A message that
  names another agent's command, or a name the agent did not declare, comes as `message` + `app_mention` as before.
  `conversations.history` and `conversations.replies` show the command's message as text, with the agent's mention
  first (`<@U…> /name args`).
- **The response.** The payload of your `ack(...)` and every call to the `response_url` become an ordinary reply in
  the command's thread: the thread it was sent in, or a new thread under the command's message. Everyone in the
  conversation sees it: `response_type: 'ephemeral'` and `'in_channel'` are the same. `replace_original` and
  `delete_original` have no original to apply to and are ignored (a `slash-response-flag-ignored` line). An empty
  `ack()` writes nothing. The reply takes the `chat.postMessage` path (mrkdwn, `blocks`, an `actions` block becomes an
  approval card). With several connections open, each gets the envelope and only the first ack counts.
- **`response_url`.** One per command, on this listener, valid for 30 minutes and 5 calls, with no token (the URL is
  the credential: keep it out of your logs). HTTP 200 `{ ok: true }`, also when there is nothing to write; an
  unknown, expired or used-up URL → 404 `expired_url`; content that looks like an internal id → HTTP 400
  `invalid_arguments`, nothing written.

```js
app.command('/deploy', async ({ ack, command, respond }) => {
  await ack(`Deploying ${command.text}…`)
  await respond({ text: 'Done.' })
})
```

Differences from Slack: in `conversations.history` and `conversations.replies` the command's message carries the
agent's mention first (`<@U…> /name args`): the command implies the mention, which the text does not carry, and a
read's mrkdwn puts first every mention missing from the text; the envelope's `text` carries only the arguments. No
ephemeral responses (every response is a reply in the thread, visible to everyone);
the commands come from the manifest file or the native API, not from Slack's app configuration; `message_ts` and
`thread_ts` are extra.

Node verified: `@slack/bolt` 5.1.0 with `@slack/socket-mode` 3.1.1. Python `slack_sdk`: the `builtin`,
`aiohttp` and `websockets` adapters; the `websocket-client` adapter is not supported (it sends an `Origin`
header).

### Clicks over HTTP

An app written for Slack's Request URL (Bolt's HTTP mode) takes clicks only as signed HTTP POSTs. Start the agent
with `--slack-actions-url` pointing at it, and the clicks on its approval cards go there instead of Socket Mode:

```
npx tayet-agent --server <your Tayet address> --token <credential> --slack-actions-url http://127.0.0.1:3000/slack/actions
```

```js
import { App } from '@slack/bolt'
const app = new App({
  token: localToken,
  signingSecret: localToken,
  endpoints: '/slack/actions',
  clientOptions: { slackApiUrl: 'http://127.0.0.1:7878/slack/api/' },
})
app.action('approve', async ({ ack, body, respond }) => {
  await ack()
  await respond({ replace_original: true, text: `Approved by <@${body.user.id}>` })
})
await app.start({ port: 3000, host: '127.0.0.1' })
```

- **Only clicks and form submissions.** `block_actions` and `view_submission` ([Forms](#forms)) go over HTTP.
  Events (`message`, `app_mention`) and slash commands stay on Socket Mode; with the option, no socket gets an
  `interactive` envelope. Without the option nothing changes.
- **The request.** `POST`, `Content-Type: application/x-www-form-urlencoded`, one field: `payload`, the same
  `block_actions` JSON a socket gets (above). Signed as Slack signs: `X-Slack-Request-Timestamp` (seconds) and
  `X-Slack-Signature: v0=<hex>`, the HMAC-SHA256 of `v0:<timestamp>:<body>`. The signing secret is the local
  token: give it to your app as `signingSecret`. There is no other secret. Redirects are not followed and no
  proxy of the environment is used.
- **On this machine only.** The URL must be `http` with host `127.0.0.1` (or another `127.x.y.z`), `::1` or
  `localhost`, without user or password; anything else stops the start (exit code 64) with a usage line that
  names the rule. The URL never appears in the log.
- **The ack.** Any 2xx within 3 seconds; the body of the answer to a click is ignored. Bolt's `ack()` sends it.
  The ack removes the card's entry from `<store>/slack-cards.json`, as a socket's ack does.
- **Form submissions.** A `view_submission` goes to the same URL, signed the same way, in one attempt: no retry,
  10 seconds to answer, and it never waits behind kept clicks. The body of the answer is read: an empty body or a
  `response_action` ([Forms](#forms)). With `processBeforeResponse: true`, a `views.open` in your click handler
  answers once the server has the form; under the server's send limit that can take longer than the 3 seconds
  Bolt allows, and the click is then sent again (its `views.open` answers `exchanged_trigger_id`; the first one
  opened the form).
- **Retries and redelivery.** No 2xx within 3 seconds (an error status, no answer, a refused connection): the
  click is sent again at once, up to three times, each with a new timestamp and signature and Slack's headers
  `X-Slack-Retry-Num` (1, 2, 3) and `X-Slack-Retry-Reason` (`http_timeout`, `http_error`, `connection_failed`;
  Bolt passes them on as `context.retryNum` and `context.retryReason`). Then the click is kept in memory (at most
  200; the oldest goes first, with a line) and sent again every 30 seconds, in order. A failure stops that
  round, so the clicks behind it wait for the next one — except the round in which your app refuses a click for
  the third time (an error status, or no answer within 3 seconds; a refused connection does not count, since
  that is your app being down): that click is dropped (`slack-action-dropped` with `reason: 'unaccepted'`; its
  entry in `<store>/slack-cards.json` stays) and the round goes on with the next click. A button your app has no
  `app.action` for is such a click: Bolt answers it 404 after about 3 seconds. The immediate retries do not count.
  Each of these sends carries a new `response_url` and no retry headers. While clicks are kept, a new click waits
  behind them. Delivered at least once: treat a click as idempotent by `container.message_ts`. The log has one
  line per delivery (`slack-action-delivered`), retry (`slack-action-retried`), kept click (`slack-action-kept`)
  and dropped click (`slack-action-dropped`, with `reason`: `full`, `unaccepted` or `leak`), with no id, URL or
  content.
- **Restarts.** Kept clicks live in memory only. A card answered while the agent was stopped is sent when it
  starts again; a click that was decided and sealed but not acked before the agent stopped is not sent again
  (read the card with `GET /v1/conversations/:id/approvals/:ts`).
- **`GET /v1/events`.** With the option the Slack layer hears every `approval.answered` from the start, so a
  `GET /v1/events` stream that connects later does not get the clicks decided before it connected (without the
  option it gets the ones nobody heard). A stream already connected gets them as always.
- **Rotation.** `--rotate-local-token` also replaces the signing secret: give your app the new local token.

Node verified: `@slack/bolt` 5.1.0 in HTTP mode (`HTTPReceiver`, `signingSecret`, `endpoints`).

### Forms

An agent opens a form for the person who clicked one of its cards, or who sent one of its commands, with
`views.open` and the `trigger_id` of that click or command. The person fills it in the product; your app gets the
submission as a `view_submission` and answers it as it would answer Slack.

```js
app.action('edit', async ({ ack, body, client }) => {
  await ack()
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'edit',
      title: { type: 'plain_text', text: 'Edit' },
      submit: { type: 'plain_text', text: 'Save' },
      blocks: [{ type: 'input', block_id: 'why', label: { type: 'plain_text', text: 'Reason' }, element: { type: 'plain_text_input', action_id: 'text', multiline: true } }],
    },
  })
})
app.view('edit', async ({ ack, view }) => {
  if (view.state.values.why.text.value.length < 10) return ack({ response_action: 'errors', errors: { why: 'Tell us more.' } })
  await ack()
})
```

- **The `trigger_id`.** Valid for 30 seconds from when the click or the command is sent to your app (a
  redelivery carries the same one), and it opens one form: once a form opens, every `trigger_id` of that click or
  command is used. An open that fails uses nothing. A click whose answer, or a command whose message, is more than
  60 seconds old when it is sent to your app opens nothing. It lives in memory: a `trigger_id` from before a
  restart opens nothing. Errors: `invalid_trigger_id` (not one the sidecar makes), `expired_trigger_id` (unknown,
  expired, too old, or the card is no longer decided by that person), `exchanged_trigger_id` (already used, or an
  open with it is in progress). `interactivity_pointer` in place of `trigger_id` → `invalid_arguments`.
- **Fields.** `input` blocks with `plain_text_input` (`multiline` makes it a long text; `min_length`,
  `max_length`, `initial_value`, `placeholder`), `number_input` (`is_decimal_allowed`, `min_value`, `max_value`,
  `initial_value`), `email_text_input`, `url_text_input`, `static_select` and `multi_static_select` (`options` or
  `option_groups`, `initial_option`/`initial_options`, `max_selected_items`), `radio_buttons` and `checkboxes`,
  and `datepicker` (`initial_date`); with `label`, `hint` and `optional`. Option texts in mrkdwn are flattened to
  plain text.
- **Text.** `section` (`text` and `fields`), `context`, `header`, `rich_text`, `markdown` and `image` (as
  `[imagem: alt]`) become read-only text, with the formatting of a message; neighbouring text blocks become one.
  `divider` is dropped.
- **Refused.** `invalid_blocks`: the user, conversation and channel selects, the external selects, `timepicker`,
  `datetimepicker`, `rich_text_input`, `file_input`, `dispatch_action` on an input, a `section` with an
  `accessory`, `actions` and any other block type, a repeated `block_id`, more than 100 blocks, more than 25
  fields once neighbouring texts are joined, a `block_id` and `action_id` that together pass about 250 characters,
  a field that breaks a limit below. `view_too_large`: a form over 32 KiB. `invalid_arguments`: a `type` other
  than `modal`; `title` or `submit` missing or over 24 characters (`submit` is always required); `close` over 24;
  `private_metadata` over 3,000 characters or `callback_id` over 255.
- **Dropped, with a log line:** `notify_on_close` (no `view_closed` is ever sent), `clear_on_close`,
  `external_id`, `focus_on_load`, `divider`. A valid `close` is dropped with no line: the product draws its own.
- **Limits** (Slack's): title and submit label 1 to 24 characters; 1 to 25 fields; label up to 2,000, hint up to
  2,000, placeholder up to 150; a text's `min_length` 0 to 3,000 and `max_length` 1 to 3,000; 1 to 100 options or
  groups (group label up to 75); radio buttons and checkboxes 1 to 10 options; option value 1 to 150 characters,
  text 1 to 75, description up to 75, values unique in the field.
- **The answer to `views.open`.** `{ ok: true, view }`: the blocks rebuilt from the form (a `block_id` or
  `action_id` you left out gets a positional one, the same in the submission), `private_metadata` and
  `callback_id` as you sent them, and a `view.id` and `hash` derived from the form.
- **The submission.** `view_submission` with `user.id` (the person), `team`, `api_app_id`, `token: ''`,
  `view` (`callback_id`, `private_metadata`, the blocks, and `state.values[block_id][action_id]` in Slack's shape
  for each element: an optional field left empty comes with a `null` value, a `null` option or an empty list) and
  `response_urls: []`. Bolt's `app.view(callback_id, …)` matches on it. Without `--slack-actions-url` it comes as
  an `interactive` envelope to every open connection; with it, as a signed POST to that URL
  ([Clicks over HTTP](#clicks-over-http)). One attempt: never sent again, 10 seconds to answer, and only the first
  ack counts.
- **Your answer.** An empty ack (or an empty 2xx), or `response_action: 'clear'` → accepted, and the form closes.
  `response_action: 'errors'` → each error shows on its field, keyed by `block_id`; a key that is no field's
  block is dropped, a message over 300 characters is cut, and when no error is left the person sees "not sent".
  `update`, `push`, a body that is not one of these, a status other than 2xx, a refused connection, a connection
  that closes before its ack, or no connection open → the person sees "not sent" at once. No answer within 10
  seconds → nothing is written, and the person sees that the agent did not answer; a later ack is ignored with a
  log line.
- **Not private.** The form, the values the person sent and your answer are messages of the conversation: every
  member has access to them at the protocol level, though the product shows the others only who answered and
  when. Do not ask for what the conversation's members should not read.
- **A `response_url` in `private_metadata`.** It comes back in the submission and works there: valid for 30
  minutes and 5 calls from the click, as always. The conversation never holds the ticket: the sidecar writes a
  derived value of the same length in its place and puts the ticket back in the submission. After a restart, or
  once the ticket has expired, your app gets the derived value, and the URL answers 404 `expired_url`.
- **Not supported:** `views.update`, `views.push` and `views.publish` answer `unknown_method`.

Forms need a Tayet server at 0.1.2 or later. A tab opened before the server was updated shows the form's messages
as not displayable until it is reloaded.

Node verified: `@slack/bolt` 5.1.0 in Socket Mode and in HTTP mode (with `processBeforeResponse: true`).

## MCP

The same listener is an MCP server (Streamable HTTP) at `http://127.0.0.1:<port>/mcp` (the URL in
`<store>/api.json` + `/mcp`), with `Authorization: Bearer <local token>`. It is stateless: no session, POST
only, both protocol eras (the 2025 `initialize` handshake and 2026-07-28). The server's instructions name the
agent; ids are opaque, and `conversation` and `cursor` values come from earlier answers. They also tell the
agent to ask for a decision with `request_approval` and wait for it with `wait_for_approval`.

```js
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
const mcp = new Client({ name: 'my-agent', version: '1.0.0' })
await mcp.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:7878/mcp'), {
  requestInit: { headers: { authorization: `Bearer ${localToken}` } },
}))
const { structuredContent } = await mcp.callTool({ name: 'wait_for_mention', arguments: {} })
```

| Tool | Arguments | Answer |
|---|---|---|
| `list_conversations` | `limit?`, `cursor?` | `{ conversations, next? }` |
| `list_members` | `conversation`, `limit?`, `cursor?` | `{ people, next? }` |
| `read_messages` | `conversation`, `after?` (a `ts`, exclusive), `limit?`, `thread?`, `cursor?` | `{ messages, next? }`, newest first |
| `send_message` | `conversation`, `text`, `thread?`, `mentions?` (`U…`), `markdown?` (default `true`) | the message |
| `react` | `conversation`, `message` (the `ts`), `emoji` (the character) | `{ changed }` |
| `get_person` | `id` (`U…`) | the person |
| `wait_for_mention` | `timeout_s?`, `after?` (a cursor) | `{ mention: { conversation, message }, cursor }`, `{ timedOut: true, cursor }` or `{ resync: true, cursor }` |
| `request_approval` | `conversation`, `text`, `options` (1–25 `{ id, label, style? }`), `thread?`, `mentions?`, `markdown?` (default `true`) | the card (a message with `approval`) |
| `wait_for_approval` | `conversation`, `id` (the card's `ts`), `timeout_s?` | `{ conversation, id, approval }` once answered or closed, or `{ conversation, id, timedOut: true }` |
| `close_approval` | `conversation`, `id`, `text?`, `markdown?` | `{ conversation, id, approval }` — `closed`, or `answered` |
| `set_panel` | `conversation`, `text`, `title?`, `markdown?` (default `true`) | `{ conversation, pending: true }` |
| `clear_panel` | `conversation` | `{ conversation, pending }` — `false`: nothing to clear |
| `set_commands` | `commands` (`{ name, description, hint? }`, at most 25) | `{ pending }` |
| `clear_commands` | — | `{ pending }` — `0`: nothing to clear |

The values are the local API's (same shapes as its JSON), in `structuredContent` and as JSON text in
`content`. A refused call has `isError: true` and the local API's error code as its text (`not_member`,
`rate_limited` with `retryAfterMs` in `structuredContent`, …). Content that looks like an internal id
(`send_message`, `request_approval`, `close_approval`, `set_panel`, `set_commands`) is `content_refused`, with
the local API's `refused` list in `structuredContent`; nothing is sent. `read_messages` gives back the page with a
message whose content looks like an internal id withheld, as the local API does (`unavailable: true`, no content).
`internal` is the agent's own failure.

- **`send_message`** renders `text` as Markdown by default, as the local API does with `markdown: true`;
  pass `markdown: false` to send the text literally.
- **`wait_for_mention`** waits up to `timeout_s` seconds (default 25, at most 50; more is cut to 50) for
  someone to mention the agent. Pass each answer's `cursor` as `after` in the next call and no mention is
  missed between calls; without `after` it waits for mentions from now on. `timedOut`: nothing came, call
  again. `resync`: the cursor is from an earlier run of the agent or too old; re-read with `read_messages`
  and continue from the new `cursor`. After a revocation it ends with `revoked`.
- **Approval cards** follow the local API's rules (see "Approval cards" above). `wait_for_approval` reads
  the card first and answers at once when it is already answered or closed; otherwise it waits up to
  `timeout_s` (default 25, at most 50) for the answer or the close. `answered` carries `answer: { option, by,
  at }`; an answer that cannot be read yet is not returned until it can. `timedOut`: still open, call again.
  `close_approval` may answer `answered` when a person answered first (the event already went out).
- **Pinned panel** (`set_panel`, `clear_panel`) follows the local API's rules (see "Pinned panel" above): the
  call answers when queued and the write goes out within 10 s; it notifies no one.
- **Commands** (`set_commands`, `clear_commands`) follow the local API's rules (see "Commands" above): the set
  is for every conversation the agent is in, and `pending` counts the conversations still to update. A
  message that invokes one carries `command: { name, args }` in `wait_for_mention` and `read_messages`.
- **Timeouts.** A client must wait longer than `timeout_s`. The OpenAI Agents SDK times out MCP calls
  after 5 seconds by default (`client_session_timeout_seconds`); raise it, or every `wait_for_mention` and
  `wait_for_approval` fails:

  ```python
  from agents.mcp import MCPServerStreamableHttp
  server = MCPServerStreamableHttp(
      params={"url": "http://127.0.0.1:7878/mcp", "headers": {"Authorization": f"Bearer {local_token}"}},
      client_session_timeout_seconds=60,
  )
  ```
- **Requests.** As on every route, a request with an `Origin` header is refused (403); a wrong `Host`
  answers 421, no token or a wrong one 401, GET and DELETE 405, and after a revocation 503.

Node verified: `@modelcontextprotocol/client` 2.4.0.

### Stdio bridge

For clients that only start MCP servers over stdio (Claude Desktop, …):

```sh
tayet-agent mcp --store <dir> [--listen <host:port>]
```

The bridge speaks MCP on its stdin/stdout and forwards to the running agent's `/mcp`. It finds the agent
through the store: the URL in `<store>/api.json` and the token in `<store>/local.token` (`--listen`
replaces the URL). It reads those two files and nothing else, never takes the store's lock, and never
starts the agent. `--store` is mandatory: it is the directory of the `store` line in the agent's log
(`--store` of the agent, or its default per-user directory).

- **No agent running** (no `api.json`, its process gone, the connection refused or no answer): one
  `bridge-daemon-unreachable` line on stderr, exit 69. Start `tayet-agent` first.
- **The agent going away in the middle** (revoked, stopped, crashed): the pending call answers `isError`, the
  bridge closes its stdio and exits 69.
- The bridge forwards `tools/list` and `tools/call` (with the agent's server name, instructions and
  capabilities); any other method answers `-32601`. A `tools/call` waits up to 65 s, longer than
  `wait_for_mention`'s 50.
- stdout carries MCP messages only; the bridge's own lines (`bridge-*`, JSON) go to stderr.

Claude Desktop (`claude_desktop_config.json`), through the bridge (use the absolute path of
`tayet-agent` if the Desktop does not find it on its `PATH`):

```json
{
  "mcpServers": {
    "tayet": { "command": "tayet-agent", "args": ["mcp", "--store", "/path/to/the/agent/store"] }
  }
}
```

Claude Code, over HTTP directly (no bridge needed):

```sh
claude mcp add --transport http tayet http://127.0.0.1:7878/mcp --header "Authorization: Bearer $(cat <store>/local.token)"
```

or through the bridge:

```sh
claude mcp add tayet -- tayet-agent mcp --store <store>
```

## Development

The package is bundled with esbuild (`dist/cli.js`). The runtime libraries stay external
dependencies. In the source tree (`sidecar/`, which links `../shared`): `npm run build`, `npm test`
(unit tests and process tests against a fake server; the integration tests skip without the local
development stack).

## License

[Business Source License 1.1](https://github.com/tayethq/tayet/blob/main/LICENSE).

## Trademarks

Slack is a trademark and service mark of Slack Technologies, Inc., registered in the U.S. and in other
countries. Tayet is not created by, affiliated with, or supported by Slack Technologies, LLC.
