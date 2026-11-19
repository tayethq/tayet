// An agent's forms in the Slack layer: `views.open` with the `trigger_id` of a click or of a `/` command, and the
// person's submission back to the app as Slack's `view_submission`. Only with the core's forms facade; without it
// `views.open` stays `unknown_method`. `views.update`, `views.push` and `views.publish` stay `unknown_method`.
//
// views.open, in this order:
//   1. `trigger_id` (slack/triggers.ts): not of the format → `invalid_trigger_id`; unknown, expired, born too old
//      or refused by the core (the origin no longer matches) → `expired_trigger_id`; already used →
//      `exchanged_trigger_id`; `interactivity_pointer` in its place → `invalid_arguments`;
//   2. the modal → the form (slack/modal.ts): its own codes; a definition over the size limit → `view_too_large`;
//      any other broken rule of a field → `invalid_blocks`;
//   3. the probe of the definition (a finding → `leak-blocked`, then `invalid_arguments` with one
//      `response_metadata.messages` line per finding when all are id shapes, else `internal_error`);
//   4. the core writes the definition; only then is the `trigger_id` spent;
//   5. `{ ok: true, view }`: the blocks rebuilt from the form, `id` and `hash` derived, `private_metadata` as sent.
// A response_url of this sidecar inside `private_metadata` is written with its ticket replaced by a derived value
// of the same length (an HMAC under a secret of this run), kept in memory for as long as the ticket lives, and
// put back in the submission: the ticket never reaches the conversation.
//
// view_submission: the core hands over a valid submission; it passes the native edge, becomes Slack's payload (the
// fields Bolt reads; `state.values` per element type; never the labels the person saw) and passes the Slack edge.
// One attempt, 10 s: an `interactive` envelope to every open socket, the first ack counting; with
// `--slack-actions-url`, one signed POST to that URL, out of the clicks' queue, its answer read. The outcome:
//   - an empty ack or body, or `clear` → accepted;
//   - `errors` → the `block_id` keys become field ids, the others leave, a message is cut at 300 characters, the
//     probe runs before the write; nothing left → refused;
//   - `update`, `push`, an invalid body, a status without 2xx, a refused connection, a socket closed before its
//     ack, no socket open, a finding of an edge → refused, at once (the person reads "not sent");
//   - no answer in 10 s → nothing is written (the person reads that the agent did not answer).
// Lines never carry a trigger_id, a ticket, a response_url, private_metadata, a label, a value or an id.
import { createHmac, randomBytes } from 'node:crypto'
import type { FormField } from '@tayet/shared'
import { FormError, type FormFacade, type FormOutcome, type FormSubmitted } from '../../core/forms'
import { FORM_ERROR_MAX, formDefinitionCheck } from '../../core/form-limits'
import type { ReadFacade } from '../../core/read'
import { WriteError } from '../../core/write'
import { logLeaks, scanEdge, scanFormProbe, scanFormResultProbe } from '../edge'
import { resolverOf } from './chat'
import { scanSlack } from './edge'
import type { AckOutcome, EnvelopeTiming } from './envelopes'
import { refusalOf, SlackError } from './errors'
import type { PostAnswer } from './http-actions'
import { RESPONSE_PATH } from './interactive'
import { blocksOf, compose, formOfModal, idsOf, split, stateValuesOf, viewOf } from './modal'
import type { ResponseTickets } from './response'
import { nested, required, type SlackCtx, type SlackMethod } from './router'
import type { TriggerTable } from './triggers'

type Log = (line: Record<string, unknown>) => void

export const SUBMISSION_TIMEOUT_MS = 10_000
export const SUBMISSION_TIMING: EnvelopeTiming = { ackTimeoutMs: SUBMISSION_TIMEOUT_MS, maxRetries: 0 }

export interface ViewsOptions {
  forms: FormFacade
  read: ReadFacade
  log: Log
  triggers: TriggerTable
  tickets: ResponseTickets
  baseUrl: () => string | null
  now: () => number
  // A method's context with no request (the listener's names and the agent).
  ctx(): SlackCtx
  // One `interactive` envelope to every open socket.
  broadcast(payload: Record<string, unknown>): Array<{ outcome: Promise<AckOutcome> }>
  // With `--slack-actions-url`: one signed POST.
  post?: (payload: Record<string, unknown>) => Promise<PostAnswer>
}

export interface Views {
  open: SlackMethod
  // The core's listener of submissions.
  submitted: (s: FormSubmitted) => void
  clear: () => void
}

type Answer = { kind: 'answer'; body: Record<string, unknown> | undefined } | { kind: 'refused'; reason: string } | { kind: 'timeout' }

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function createViews(opts: ViewsOptions): Views {
  const { forms, read, log } = opts
  const secret = randomBytes(32)
  const masked = new Map<string, { ticket: string; expires: number }>()

  // A response_url of this sidecar inside a text, its ticket swapped (`mask`) or put back (`unmask`).
  const urls = (): RegExp | null => {
    const base = opts.baseUrl()
    return base === null ? null : new RegExp(`${escape(`${base}${RESPONSE_PATH}`)}([0-9a-f]{64})`, 'g')
  }
  const mask = (text: string): string => {
    const re = urls()
    if (re === null) return text
    const now = opts.now()
    for (const [k, v] of masked) if (now >= v.expires) masked.delete(k)
    return text.replace(re, (whole, ticket: string) => {
      const expires = opts.tickets.expiry(ticket)
      if (expires === undefined) return whole
      const derived = createHmac('sha256', secret).update(ticket).digest('hex')
      masked.set(derived, { ticket, expires })
      return whole.slice(0, -ticket.length) + derived
    })
  }
  const unmask = (text: string): string => {
    const re = urls()
    if (re === null) return text
    return text.replace(re, (whole, derived: string) => {
      const kept = masked.get(derived)
      return kept !== undefined && opts.now() < kept.expires ? whole.slice(0, -derived.length) + kept.ticket : whole
    })
  }

  const open: SlackMethod = async (args, ctx) => {
    if (args.interactivity_pointer !== undefined) throw new SlackError('invalid_arguments')
    const attempt = opts.triggers.begin(required(args, 'trigger_id'))
    let opened = false
    try {
      const resolve = resolverOf(ctx)
      const modal = formOfModal(nested(args, 'view'), resolve, (key) => log({ evt: 'view-key-dropped', key }))
      const meta = compose(mask(modal.privateMetadata), modal.callbackId)
      const form = { title: modal.title, submitLabel: modal.submitLabel, fields: modal.fields }
      const check = formDefinitionCheck(form, meta)
      if (check !== 'ok') throw new SlackError(check === 'too_large' ? 'view_too_large' : 'invalid_blocks')
      const o = attempt.origin
      const leaks = scanFormProbe(o.conversation, { ...form, meta })
      if (leaks.length > 0) {
        logLeaks(log, 'slack views.open', leaks)
        throw refusalOf(leaks)
      }
      let id: string
      try {
        ;({ id } = await forms.open({ conversation: o.conversation, origin: o.kind === 'card' ? { kind: 'card', card: o.card, person: o.person } : { kind: 'command', message: o.message }, form, meta }))
      } catch (err) {
        if (err instanceof FormError) throw new SlackError('expired_trigger_id')
        if (err instanceof WriteError && err.code === 'invalid_argument') throw new SlackError('invalid_blocks')
        throw err
      }
      opened = true
      log({ evt: 'view-opened', origin: o.kind })
      const me = await ctx.me()
      return { view: viewOf({ conversation: o.conversation, form: id, title: form.title, submitLabel: form.submitLabel, blocks: blocksOf(form.fields, resolve), privateMetadata: modal.privateMetadata, callbackId: modal.callbackId, team: me.workspace, bot: read.bot() }) }
    } finally {
      attempt.settle(opened)
    }
  }

  const payloadOf = async (s: FormSubmitted): Promise<Record<string, unknown>> => {
    const ctx = opts.ctx()
    const me = await ctx.me()
    const bot = read.bot()
    let name: string
    try {
      name = read.person(s.submission.by).name
    } catch {
      name = ''
    }
    const [privateMetadata, callbackId] = (s.form.meta !== undefined ? split(s.form.meta) : undefined) ?? ['', '']
    const view = viewOf({
      conversation: s.conversation,
      form: s.form.id,
      title: s.form.title,
      submitLabel: s.form.submitLabel,
      blocks: blocksOf(s.form.fields, resolverOf(ctx)),
      privateMetadata: unmask(privateMetadata),
      callbackId,
      team: me.workspace,
      bot,
      values: stateValuesOf(s.form.fields, s.submission.values),
    })
    return {
      type: 'view_submission',
      team: { id: me.workspace, domain: '' },
      user: { id: s.submission.by, username: name, name, team_id: me.workspace },
      api_app_id: bot,
      token: '',
      enterprise: null,
      is_enterprise_install: false,
      view,
      response_urls: [],
    }
  }

  // One envelope per open socket: the first ack counts; with none, a socket that timed out means no answer.
  const viaSockets = (payload: Record<string, unknown>): Promise<Answer> => {
    const sent = opts.broadcast(payload)
    if (sent.length === 0) return Promise.resolve({ kind: 'refused', reason: 'no-socket' })
    return new Promise((resolve) => {
      let left = sent.length
      let timedOut = false
      let done = false
      for (const { outcome } of sent) {
        void outcome.then((o) => {
          if (done) return
          if (o.acked) {
            done = true
            return resolve({ kind: 'answer', body: o.payload })
          }
          if (o.reason === 'timeout') timedOut = true
          if (--left > 0) return
          done = true
          resolve(timedOut ? { kind: 'timeout' } : { kind: 'refused', reason: 'closed' })
        })
      }
    })
  }

  const viaHttp = async (post: NonNullable<ViewsOptions['post']>, payload: Record<string, unknown>): Promise<Answer> => {
    const a = await post(payload)
    if (a.kind !== 'answer') return a.kind === 'timeout' ? a : { kind: 'refused', reason: 'connection' }
    if (a.status < 200 || a.status >= 300) return { kind: 'refused', reason: 'status' }
    if (a.body.trim() === '') return { kind: 'answer', body: undefined }
    try {
      const body: unknown = JSON.parse(a.body)
      return isRecord(body) ? { kind: 'answer', body } : { kind: 'refused', reason: 'body' }
    } catch {
      return { kind: 'refused', reason: 'body' }
    }
  }

  // The app's answer → the result; a string is the reason of a refusal.
  const outcomeOf = (s: FormSubmitted, body: Record<string, unknown> | undefined): FormOutcome | string => {
    if (body === undefined || Object.keys(body).length === 0 || body.response_action === 'clear') return { ok: true }
    if (body.response_action !== 'errors') return body.response_action === 'update' || body.response_action === 'push' ? body.response_action : 'body'
    if (!isRecord(body.errors)) return 'body'
    const byBlock = new Map(s.form.fields.flatMap((f: FormField) => (f.kind === 'context' ? [] : [[idsOf(f.id)[0], f.id] as const])))
    const errors: Record<string, string> = {}
    for (const [block, message] of Object.entries(body.errors)) {
      const id = byBlock.get(block)
      if (id === undefined || typeof message !== 'string' || message === '') continue
      errors[id] = [...message].slice(0, FORM_ERROR_MAX).join('')
    }
    if (Object.keys(errors).length === 0) return 'errors'
    const leaks = scanFormResultProbe(s.conversation, errors)
    if (leaks.length > 0) {
      logLeaks(log, 'slack view_submission errors', leaks)
      return 'leak'
    }
    return { errors }
  }

  const write = async (s: FormSubmitted, outcome: FormOutcome | string): Promise<void> => {
    if (typeof outcome === 'string') log({ evt: 'view-submission-refused', reason: outcome })
    try {
      await forms.result(s.conversation, s.submission.id, typeof outcome === 'string' ? { refused: true } : outcome)
      if (typeof outcome !== 'string') log({ evt: 'view-submission-answered', outcome: 'ok' in outcome ? 'ok' : 'errors' })
    } catch {
      log({ evt: 'form-result-failed' })
    }
  }

  const deliver = async (s: FormSubmitted): Promise<void> => {
    const native = scanEdge(s)
    if (native.length > 0) {
      logLeaks(log, 'slack view_submission', native)
      return write(s, 'leak')
    }
    const payload = await payloadOf(s)
    const leaks = scanSlack(payload)
    if (leaks.length > 0) {
      logLeaks(log, 'slack view_submission', leaks)
      return write(s, 'leak')
    }
    const answer = opts.post !== undefined ? await viaHttp(opts.post, payload) : await viaSockets(payload)
    if (answer.kind === 'timeout') return log({ evt: 'view-submission-unanswered' })
    await write(s, answer.kind === 'refused' ? answer.reason : outcomeOf(s, answer.body))
  }

  return {
    open,
    submitted: (s) => void deliver(s).catch(() => log({ evt: 'form-result-failed' })),
    clear: () => {
      masked.clear()
      opts.triggers.clear()
    },
  }
}
