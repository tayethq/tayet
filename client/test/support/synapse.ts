import { execSync } from 'node:child_process'
import { CLIENT_ID, CLIENT_SECRET } from './escrow-harness'
import { HS_URL, MAS_CONFIG, MAS_CONTAINER, MAS_URL, REQUIRE_STACK } from './stack-env'

// Integration harness for the live Fase 0 Synapse + MAS stack (docker compose, `tayet.local`).
// These tests are a LOCAL gate: they auto-skip when the homeserver is unreachable, so `npm
// test` stays green in CI (which has no Synapse) while running for real on a dev box with the
// stack up. Standing the stack up in CI is a separate infra decision (flagged in the PR).

// Endpoints and container names come from the stack namespace (stack-env.ts, §8.R2 fase 2b).
export const HOMESERVER = HS_URL

// Whether the integration harness MUST find a live homeserver. Default OFF → the integration
// tests auto-skip when Synapse is unreachable (the local gate; keeps `npm test` green on a box
// without the stack). Set TAYET_REQUIRE_STACK=1 (CI only — issue #7, fatia 4) to make a missing
// stack FATAL instead of a silent skip: synapseReachable() then THROWS at collection time, which
// surfaces as a failed test file (red), instead of returning false and letting describe.skipIf
// quietly pass the suite behind the always-present availability marker. The flip binds the
// HARNESS's OWN reachability verdict — distinct from dev-stack.sh's cmd_test shell probe, which
// only guards the `dev-stack.sh test` route. The real silent-skip vector this closes is: the
// shell probe passes but synapseReachable() independently returns false (partial bring-up / probe
// divergence). It intervenes on the reachability axis only, so orthogonal skips (e.g. ADMIN_SCOPE
// in acl-reset) are untouched — which keeps it correct when the serial surface lands (fatia 5).
// REQUIRE_STACK is read in stack-env.ts.

// Synchronous reachability probe (evaluated at collection time for describe.skipIf).
export function synapseReachable(): boolean {
  try {
    execSync(`curl -sf -m 3 ${HOMESERVER}/_matrix/client/versions`, { stdio: 'ignore' })
    return true
  } catch {
    if (REQUIRE_STACK) {
      throw new Error(
        `TAYET_REQUIRE_STACK=1 but Synapse is unreachable at ${HOMESERVER} ` +
          `(/_matrix/client/versions failed). The integration gate is REQUIRED here and must not ` +
          `silently skip — bring the stack up (dev-stack.sh up) or unset TAYET_REQUIRE_STACK.`,
      )
    }
    return false
  }
}

// Direct MAS introspection — the M2 discriminator (PLANO-GATES §8.10). The device race in
// `mas-cli manage issue-compatibility-token` (upsert_device BEFORE the compat session commits,
// outside the SyncDevicesJob lock) leaves a token MAS still reports active while Synapse's
// MAS-delegated auth rejects it (device gone → "Token is not active"). Never throws: a failure of
// the diagnostic itself is reported as `diag failed: <reason>`.
export type Introspection = { status: number; active: boolean } | { failed: string }

export async function introspectToken(token: string): Promise<Introspection> {
  try {
    const res = await fetch(`${MAS_URL}/oauth2/introspect`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token, token_type_hint: 'access_token' }).toString(),
      signal: AbortSignal.timeout(5_000),
    })
    const body = (await res.json().catch(() => ({}))) as { active?: unknown }
    return { status: res.status, active: body.active === true }
  } catch (err) {
    return { failed: scrub(String(err), token) }
  }
}

// Only `mct_` + the last 6 chars of a token ever reach a message or log line.
export function redactToken(token: string): string {
  return `mct_…${token.slice(-6)}`
}

function scrub(text: string, token: string): string {
  return text.split(token).join(redactToken(token)).split(CLIENT_SECRET).join('<secret>')
}

export function introspectionNote(token: string, d: Introspection): string {
  const verdict = 'failed' in d ? `diag failed: ${d.failed}` : `MAS introspection HTTP ${d.status} active=${d.active}`
  return scrub(`${verdict} (token ${redactToken(token)})`, token)
}

// The probe's signature: whoami 401 while MAS says active. By MAS/Synapse source the deleted
// device only comes back with another SyncDevicesJob for the account, which nothing in the mint
// path schedules, so waiting cannot help — mintToken re-mints once instead.
export class TokenDeviceRaceError extends Error {
  override name = 'TokenDeviceRaceError'
}

// Effects of the probe/mint decision, injectable so the decision is unit-testable with fakes.
export interface TokenFx {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  introspect: (token: string) => Promise<Introspection>
  exec: (command: string) => string
  now: () => number
  sleep: (ms: number) => Promise<void>
  warn: (line: string) => void
}

const liveFx: TokenFx = {
  fetch: (url, init) => fetch(url, init),
  introspect: introspectToken,
  exec: (command) => execSync(command, { encoding: 'utf8' }),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  warn: (line) => console.warn(line),
}

// Activation probe (issue #7 M2): a freshly-minted mct_ can be rejected M_UNKNOWN_TOKEN on its
// FIRST use (6× connect flakes + 2× CI boot fails in the Jul/2026 soak — PLANO-GATES §8.1). Poll
// whoami until the homeserver accepts the token. Raw fetch on purpose: rest() stays
// 401-intolerant so this failure class remains visible everywhere else. On the FIRST whoami 401
// the token is introspected directly at MAS: active → TokenDeviceRaceError at once (§8.10);
// anything else keeps polling, and the budget overflow carries a second introspection. Strictly
// 401: a 429/5xx while MAS says active is not the device race and must not feed its counter.
export async function probeTokenActive(token: string, fx: TokenFx = liveFx): Promise<void> {
  const budgetMs = 30_000
  const start = fx.now()
  let attempts = 0
  let last: string | undefined
  let first: Introspection | undefined
  for (;;) {
    attempts++
    let unauthorized = false
    try {
      const res = await fx.fetch(`${HOMESERVER}/_matrix/client/v3/account/whoami`, {
        headers: { Authorization: `Bearer ${token}` },
        // Per-attempt 5s abort — parity with the shell twins' `curl -m 5` (B1 carry-forward).
        signal: AbortSignal.timeout(5_000),
      })
      if (res.status === 200) return
      const body = (await res.json().catch(() => ({}))) as { errcode?: string }
      last = `${res.status}${body.errcode ? ` ${body.errcode}` : ''}`
      unauthorized = res.status === 401
    } catch (err) {
      last = `fetch failed: ${String(err)}`
    }
    if (unauthorized && first === undefined) {
      first = await fx.introspect(token)
      if (!('failed' in first) && first.active) {
        throw new TokenDeviceRaceError(
          `token-activation probe: MAS device race — whoami ${last} on attempt ${attempts} ` +
            `(${fx.now() - start}ms) while ${introspectionNote(token, first)}`,
        )
      }
    }
    const elapsed = fx.now() - start
    if (elapsed > budgetMs) {
      const atBudget = await fx.introspect(token)
      throw new Error(
        `token-activation probe: token not active after ${elapsed}ms ` +
          `(${attempts} attempts, last=${last ?? 'no response'}) ` +
          `[first 401: ${first ? introspectionNote(token, first) : 'not introspected'}; ` +
          `at budget: ${introspectionNote(token, atBudget)}]`,
      )
    }
    await fx.sleep(250)
  }
}

// One mas-cli mint. The docker-exec mint itself failed transiently 2× in the soak (issue #7
// M4-token; runs 28614986622/28960752965), so the exec gets a bounded retry — exec failure ONLY;
// a clean exec whose output has no mct_ is a real error, not a retry.
async function issueCompatToken(username: string, fx: TokenFx): Promise<string> {
  const out = await (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return fx.exec(
          `docker exec ${MAS_CONTAINER} mas-cli manage issue-compatibility-token -c ${MAS_CONFIG} ${username} 2>&1`,
        )
      } catch (err) {
        if (attempt >= 2) {
          const e = err as { stdout?: unknown; stderr?: unknown }
          throw new Error(
            `mint exec failed after ${attempt + 1} attempts for ${username}: ` +
              `stdout=${String(e.stdout ?? '')} stderr=${String(e.stderr ?? '')}`,
            { cause: err },
          )
        }
        await fx.sleep(attempt === 0 ? 500 : 1000)
      }
    }
  })()
  const m = /mct_[A-Za-z0-9_]+/.exec(out)
  if (!m) throw new Error(`could not mint token for ${username}: ${out}`)
  return m[0]
}

// Mint a fresh MAS compatibility token (mct_…) for a username — the Fase 0 flow. The activation
// probe runs before returning, so every consumer (freshUsers included) inherits it. On the M2
// device-race signature the token is re-minted ONCE (a mint after the racing SyncDevicesJob keeps
// its device); the `[m2-device-race]` line is the class counter — one per re-mint, never silenced.
// A repeated signature propagates with both occurrences; there is never a third mint.
export async function mintToken(username: string, fx: TokenFx = liveFx): Promise<string> {
  const token = await issueCompatToken(username, fx)
  try {
    await probeTokenActive(token, fx)
    return token
  } catch (err) {
    if (!(err instanceof TokenDeviceRaceError)) throw err
    fx.warn(`[m2-device-race] re-mint for ${username} (token ${redactToken(token)})`)
    const again = await issueCompatToken(username, fx)
    try {
      await probeTokenActive(again, fx)
      return again
    } catch (err2) {
      if (!(err2 instanceof TokenDeviceRaceError)) throw err2
      throw new TokenDeviceRaceError(
        `device-race signature repeated after re-mint for ${username}: (1) ${err.message} (2) ${err2.message}`,
        { cause: err2 },
      )
    }
  }
}

async function rest<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  // Synapse rate-limits message sends (M_LIMIT_EXCEEDED / 429) — honour retry_after_ms so the
  // integration suite stays robust under combined load instead of flaking.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${HOMESERVER}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (res.status === 429 && attempt < 25) {
      const retry = (await res.clone().json().catch(() => ({}))) as { retry_after_ms?: number }
      await new Promise((r) => setTimeout(r, (retry.retry_after_ms ?? 500) + 100))
      continue
    }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`)
    return (await res.json()) as T
  }
}

// Create a fixture room (named + topic) so the translators have deterministic input. The
// caller (creator) lands at PL 100 — useful to assert PL≥50→admin.
export async function createRoom(
  token: string,
  opts: { name: string; topic?: string; initialState?: { type: string; state_key: string; content: object }[] },
): Promise<string> {
  const r = await rest<{ room_id: string }>(token, 'POST', '/_matrix/client/v3/createRoom', {
    name: opts.name,
    topic: opts.topic,
    preset: 'private_chat',
    initial_state: opts.initialState,
  })
  return r.room_id
}

// ADR-094 (PLANO-CONVERSAS §8.1): a room created OUTSIDE the product — no name, private preset, the
// caller's initial state and invites — and a state write, so a gate can drive a room the product's verbs
// would never shape that way (a group born elsewhere, its marker changed elsewhere).
export async function createUnnamedRoom(
  token: string,
  opts: {
    invite: string[]
    initialState?: { type: string; state_key: string; content: object }[]
    powerLevelOverride?: object
  },
): Promise<string> {
  const r = await rest<{ room_id: string }>(token, 'POST', '/_matrix/client/v3/createRoom', {
    preset: 'private_chat',
    invite: opts.invite,
    initial_state: opts.initialState,
    ...(opts.powerLevelOverride && { power_level_content_override: opts.powerLevelOverride }),
  })
  return r.room_id
}

// Read one state event's content (GET /state/{type}/{key}).
export async function getState<T = Record<string, unknown>>(token: string, roomId: string, type: string, stateKey = ''): Promise<T> {
  return rest<T>(
    token,
    'GET',
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`,
  )
}

export async function putState(token: string, roomId: string, type: string, content: object, stateKey = ''): Promise<void> {
  await rest(
    token,
    'PUT',
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`,
    content,
  )
}

export async function setDisplayName(token: string, userId: string, name: string): Promise<void> {
  await rest(token, 'PUT', `/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`, { displayname: name })
}

let txn = 0
function nextTxn(): string {
  txn += 1
  return `int${txn}_${process.pid}`
}

export async function sendText(token: string, roomId: string, text: string): Promise<string> {
  const r = await rest<{ event_id: string }>(
    token,
    'PUT',
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${nextTxn()}`,
    { msgtype: 'm.text', body: text },
  )
  return r.event_id
}

// Send a message that intentionally mentions a user (m.mentions, MSC3952 / spec intentional
// mentions). M2 outbound (the @-picker that builds m.mentions) does not exist yet; the harness
// operates BELOW the barrel, so we craft the wire content here. Room is non-encrypted (createRoom
// private_chat), so m.mentions travels cleartext and the recipient's is_user_mention push-rule
// fires the `highlight` tweak — the exact inbound signal ADR-037 M1 reads.
export async function sendMention(
  token: string,
  roomId: string,
  mxid: string,
  text: string,
): Promise<string> {
  const r = await rest<{ event_id: string }>(
    token,
    'PUT',
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${nextTxn()}`,
    { msgtype: 'm.text', body: text, 'm.mentions': { user_ids: [mxid] } },
  )
  return r.event_id
}

// Send an m.replace edit of a prior message.
export async function editText(
  token: string,
  roomId: string,
  targetEventId: string,
  newText: string,
): Promise<string> {
  const r = await rest<{ event_id: string }>(
    token,
    'PUT',
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${nextTxn()}`,
    {
      msgtype: 'm.text',
      body: `* ${newText}`,
      'm.new_content': { msgtype: 'm.text', body: newText },
      'm.relates_to': { rel_type: 'm.replace', event_id: targetEventId },
    },
  )
  return r.event_id
}

// Upload raw bytes to the media repo. DRIFT NOTE (ADR-009): upload stays on the v3 endpoint —
// only download/thumbnail moved to the authenticated v1 namespace. Returns the mxc URI.
export async function uploadMedia(
  token: string,
  bytes: Uint8Array,
  mimetype: string,
  filename: string,
): Promise<string> {
  const res = await fetch(
    `${HOMESERVER}/_matrix/media/v3/upload?filename=${encodeURIComponent(filename)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimetype },
      body: new Blob([bytes as BlobPart]),
    },
  )
  if (!res.ok) throw new Error(`upload -> ${res.status} ${await res.text()}`)
  return ((await res.json()) as { content_uri: string }).content_uri
}

export async function sendImage(
  token: string,
  roomId: string,
  mxc: string,
  opts: { name: string; mimetype: string; size: number },
): Promise<string> {
  const r = await rest<{ event_id: string }>(
    token,
    'PUT',
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${nextTxn()}`,
    { msgtype: 'm.image', body: opts.name, url: mxc, info: { mimetype: opts.mimetype, size: opts.size } },
  )
  return r.event_id
}

// Send a threaded reply (m.thread relation) to a root event — drives the per-thread split.
export async function sendThreadReply(
  token: string,
  roomId: string,
  rootEventId: string,
  text: string,
): Promise<string> {
  const r = await rest<{ event_id: string }>(
    token,
    'PUT',
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${nextTxn()}`,
    {
      msgtype: 'm.text',
      body: text,
      'm.relates_to': { rel_type: 'm.thread', event_id: rootEventId },
    },
  )
  return r.event_id
}

export async function whoami(token: string): Promise<string> {
  const r = await rest<{ user_id: string }>(token, 'GET', '/_matrix/client/v3/account/whoami')
  return r.user_id
}

// The device id the token is bound to (each MAS compatibility token = one device). Used by the
// new-access gate (D2) to identify which device a given session login is, for self-exclusion.
export async function whoamiDevice(token: string): Promise<string> {
  const r = await rest<{ device_id?: string }>(token, 'GET', '/_matrix/client/v3/account/whoami')
  if (!r.device_id) throw new Error('whoami returned no device_id')
  return r.device_id
}

// Raw event as the SERVER stored it (authenticated v3 event endpoint). Lets a test inspect the
// exact wire content that was sent — e.g. to assert a clean m.thread relation with no fallback.
export interface RawEvent {
  event_id: string
  type: string
  content: Record<string, unknown>
  origin_server_ts?: number
  unsigned?: { transaction_id?: string }
}
export async function getEvent(token: string, roomId: string, eventId: string): Promise<RawEvent> {
  return rest<RawEvent>(
    token,
    'GET',
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
  )
}

// One of OUR OWN sent events, as the SERVER stored it, located by the DOMAIN MessageId's raw
// value. ADR-010: an own message's stable MessageId IS the transaction id — it deliberately does
// NOT round-trip as a protocol event id (GET /event/{txn} 404s; that 404 is the boundary working,
// not a bug). The server echoes the txn back to the sending device as unsigned.transaction_id on
// /messages, so we locate by THAT — deterministic even when message bodies repeat (retries, reused
// fixtures). The txn↔event knowledge stays confined to this helper; tests never treat a domain id
// as an event id.
export async function findOwnEvent(
  token: string,
  roomId: string,
  domainMessageId: string,
  limit = 50,
): Promise<RawEvent> {
  const r = await rest<{ chunk: RawEvent[] }>(
    token,
    'GET',
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${limit}`,
  )
  const ev = r.chunk.find((e) => e.unsigned?.transaction_id === domainMessageId)
  if (!ev) throw new Error('own event not found by transaction id (was it sent by this device/token?)')
  return ev
}

// Children of a root via the authenticated v1 relations endpoint, filtered to a rel_type. Returns
// the raw events (full content), so a test can assert the relation each child actually carries.
export async function getRelations(
  token: string,
  roomId: string,
  rootEventId: string,
  relType = 'm.thread',
): Promise<RawEvent[]> {
  const r = await rest<{ chunk: RawEvent[] }>(
    token,
    'GET',
    `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(rootEventId)}/${encodeURIComponent(relType)}`,
  )
  return r.chunk
}

// A page of room messages (newest first) as the SERVER stored them. Lets a test find the wire
// event of a send made through the barrel: m.in_reply_to is NOT a rel_type, so /relations cannot
// list replies — we scan the room instead.
export async function getMessages(token: string, roomId: string, limit = 50): Promise<RawEvent[]> {
  const r = await rest<{ chunk: RawEvent[] }>(
    token,
    'GET',
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${limit}`,
  )
  return r.chunk
}

// Send a reply the way a LEGACY client (Element & co.) does: m.in_reply_to PLUS the deprecated
// fallback in BOTH representations (<mx-reply> prefix in formatted_body, '> ' lines in body).
// Drives the inbound strip gate (PLANO-FASE-1-REPLY §2.3/§5.2, integration case (b)).
export async function sendLegacyReply(
  token: string,
  roomId: string,
  targetEventId: string,
  opts: { quotedText: string; quotedSender: string; text: string },
): Promise<string> {
  const fallbackBody = opts.quotedText
    .split('\n')
    .map((l, i) => (i === 0 ? `> <${opts.quotedSender}> ${l}` : `> ${l}`))
    .join('\n')
  const r = await rest<{ event_id: string }>(
    token,
    'PUT',
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${nextTxn()}`,
    {
      msgtype: 'm.text',
      body: `${fallbackBody}\n\n${opts.text}`,
      format: 'org.matrix.custom.html',
      formatted_body:
        `<mx-reply><blockquote><a href="https://matrix.to/#/${roomId}/${targetEventId}">In reply to</a> ` +
        `<a href="https://matrix.to/#/${opts.quotedSender}">${opts.quotedSender}</a><br/>` +
        `${opts.quotedText}</blockquote></mx-reply>${opts.text}`,
      'm.relates_to': { 'm.in_reply_to': { event_id: targetEventId } },
    },
  )
  return r.event_id
}

export async function invite(token: string, roomId: string, userId: string): Promise<void> {
  await rest(token, 'POST', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
    user_id: userId,
  })
}

// ADR-056: announce presence out-of-band via a one-shot sync — the sync knob is THE write
// mechanism (norm 4.iii: PUT /presence is transient, the next sync stamps over it; spike-
// measured). A one-shot `online` announces; a one-shot `unavailable` outside a sync loop is a
// no-op (also spike-measured), so the harness only offers the two values that actually work.
export async function announcePresence(token: string, presence: 'online' | 'offline'): Promise<void> {
  await rest(token, 'GET', `/_matrix/client/v3/sync?set_presence=${presence}&timeout=0`)
}

export async function join(token: string, roomId: string): Promise<void> {
  await rest(token, 'POST', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {})
}

export async function leave(token: string, roomId: string): Promise<void> {
  await rest(token, 'POST', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {})
}

export async function reactTo(
  token: string,
  roomId: string,
  targetEventId: string,
  key: string,
): Promise<string> {
  const r = await rest<{ event_id: string }>(
    token,
    'PUT',
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.reaction/${nextTxn()}`,
    { 'm.relates_to': { rel_type: 'm.annotation', event_id: targetEventId, key } },
  )
  return r.event_id
}

export async function redact(token: string, roomId: string, eventId: string): Promise<string> {
  const r = await rest<{ event_id: string }>(
    token,
    'PUT',
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${nextTxn()}`,
    {},
  )
  return r.event_id
}
