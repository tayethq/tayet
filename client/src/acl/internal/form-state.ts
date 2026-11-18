import type { MatrixEvent } from 'matrix-js-sdk'
import type { AgentForm, ChannelId, FormId, FormIssue, FormState, FormValues, MessageId, UserId } from '@tayet/shared'
import {
  FORM_MSGTYPE,
  FORM_REL_TYPE,
  FORM_RESULT_MSGTYPE,
  FORM_SUBMISSION_MSGTYPE,
  readFormDefinition,
  readFormResult,
  readFormSubmission,
  resolveFormReply,
  submissionLabels,
  submittableValues,
  validateFormValues,
  type FormAnchorFacts,
  type FormDefinition,
  type FormRelated,
  type FormResult,
  type FormSubmissionLabel,
} from '@tayet/shared/internal'
import { relationPage, type RelationsClient } from './approval-state'

// An agent's form, on the client. Two pieces:
// - FormSession: the forms this session may open and the one it has open. A definition opens only when
//   its trigger is an answer to a card or a command message that THIS instance sent, and only when it
//   arrives live (the gateway calls it from the live stream only). The set lives in memory: a reload
//   loses it, by design. One form at a time; a second definition for the same trigger, or one that
//   arrives while another form is open, is ignored.
// - FormReplies: who answered a form opened from a message (a card, or a command message), read from
//   the anchor's form relations, forward, like the card's answers — the first accepted submission. It
//   is the same for every member of the conversation.

// How long the session waits for the agent's result after the server accepted the submission.
export const FORM_ANSWER_TIMEOUT_MS = 15_000

export interface FormClock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const realClock: FormClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

// A trigger this instance sent: where it lives, the message forms open from and the agent that may open
// one from it (the card's author, or the agent the command names).
export interface OwnTrigger {
  roomId: string
  anchorId: string
  agent: string
}

// A definition as the gateway hands it: decrypted, related to `anchorId`, from `sender`.
export interface DefinitionFact {
  id: string
  roomId: string
  sender: string
  anchorId: string
  // The anchor's stable message id (an own message keeps its send id).
  anchorMessage: string
  definition: FormDefinition
}

export interface ResultFact {
  roomId: string
  sender: string
  result: FormResult
}

export interface FormSessionPorts {
  // Send the submission; resolves with its server id.
  send(roomId: string, anchorId: string, formId: string, title: string, values: FormValues, labels: FormSubmissionLabel[]): Promise<string>
  emit(event: { t: 'form.opened' | 'form.changed'; channelId: ChannelId; form: AgentForm }): void
  clock: FormClock
}

interface OpenForm {
  fact: DefinitionFact
  form: AgentForm
  // Every submission of this form the server accepted (a late result for any of them counts).
  submissions: Set<string>
  // Results that arrived before the server confirmed the submission they name.
  early: Map<string, FormResult>
  timer: unknown
  // The submission under way (a newer attempt wins over a late outcome).
  attempt: number
}

export type SubmitOutcome = { ok: true } | { issues: Record<string, FormIssue> }

export class FormSession {
  private readonly triggers = new Map<string, OwnTrigger>()
  private readonly used = new Set<string>()
  private inflight = 0
  private held: DefinitionFact[] = []
  private open: OpenForm | undefined

  constructor(private readonly ports: FormSessionPorts) {}

  // An own send that may become a trigger started; `settle` ends it with its server id and trigger
  // facts, or with nothing when it failed.
  beginOwnSend(): (trigger?: { id: string } & OwnTrigger) => void {
    this.inflight += 1
    let settled = false
    return (trigger) => {
      if (settled) return
      settled = true
      this.inflight -= 1
      if (trigger) this.triggers.set(trigger.id, { roomId: trigger.roomId, anchorId: trigger.anchorId, agent: trigger.agent })
      const held = this.held
      this.held = []
      for (const fact of held) this.noteDefinition(fact)
    }
  }

  // A live definition. Opens when its trigger is this instance's and the rest of the rule holds; waits
  // while an own send is unconfirmed; else it is ignored.
  noteDefinition(fact: DefinitionFact): void {
    const trigger = this.triggers.get(fact.definition.trigger)
    if (!trigger) {
      if (this.inflight > 0) this.held.push(fact)
      return
    }
    if (fact.roomId !== trigger.roomId || fact.anchorId !== trigger.anchorId || fact.sender !== trigger.agent) return
    if (this.used.has(fact.definition.trigger)) return
    this.used.add(fact.definition.trigger)
    if (this.open) return
    const { definition } = fact
    const form: AgentForm = {
      id: fact.id as FormId,
      channelId: fact.roomId as ChannelId,
      agent: fact.sender as UserId,
      anchor: fact.anchorMessage as MessageId,
      title: definition.title,
      submitLabel: definition.submitLabel,
      fields: definition.fields,
      state: { kind: 'open' },
    }
    this.open = { fact, form, submissions: new Set(), early: new Map(), timer: undefined, attempt: 0 }
    this.ports.emit({ t: 'form.opened', channelId: form.channelId, form })
  }

  // A live result: only from the definition's author, for a submission of the open form.
  noteResult(fact: ResultFact): void {
    const open = this.open
    if (!open || fact.roomId !== open.fact.roomId || fact.sender !== open.fact.sender) return
    if (open.submissions.has(fact.result.submission)) this.apply(open, fact.result)
    else if (open.form.state.kind === 'sending') open.early.set(fact.result.submission, fact.result)
  }

  async submit(formId: FormId, values: FormValues): Promise<SubmitOutcome> {
    const open = this.open
    if (!open || open.form.id !== formId) throw new Error('form not found')
    const state = open.form.state.kind
    if (state === 'sending') throw new Error('form is sending')
    if (state === 'done') throw new Error('form is done')
    const issues = validateFormValues(open.form.fields, values)
    if (Object.keys(issues).length > 0) return { issues }
    this.stopTimer(open)
    const attempt = ++open.attempt
    open.early.clear()
    this.setState(open, { kind: 'sending' })
    const sent = submittableValues(open.form.fields, values)
    let submissionId: string
    try {
      submissionId = await this.ports.send(open.fact.roomId, open.fact.anchorId, open.fact.id, open.form.title, sent, submissionLabels(open.form.fields, sent))
    } catch (err) {
      if (this.open === open && open.attempt === attempt) this.setState(open, { kind: 'failed' })
      throw err
    }
    if (this.open !== open || open.attempt !== attempt) return { ok: true }
    open.submissions.add(submissionId)
    const early = open.early.get(submissionId)
    open.early.clear()
    if (early) {
      this.apply(open, early)
      return { ok: true }
    }
    open.timer = this.ports.clock.setTimeout(() => {
      open.timer = undefined
      if (this.open === open && open.attempt === attempt && open.form.state.kind === 'sending') this.setState(open, { kind: 'noAnswer' })
    }, FORM_ANSWER_TIMEOUT_MS)
    return { ok: true }
  }

  // Discard without confirming: the form is forgotten and a later result for it is ignored.
  close(formId: FormId): void {
    const open = this.open
    if (!open || open.form.id !== formId) return
    this.stopTimer(open)
    this.open = undefined
  }

  clear(): void {
    if (this.open) this.stopTimer(this.open)
    this.open = undefined
    this.triggers.clear()
    this.used.clear()
    this.held = []
    this.inflight = 0
  }

  // An accepted result ends the form: 'done' is emitted and the form is forgotten, so the session is free
  // for the next one (a later close is a no-op, a later result is ignored).
  private apply(open: OpenForm, result: FormResult): void {
    if (open.form.state.kind === 'done') return
    this.stopTimer(open)
    if ('ok' in result) {
      this.setState(open, { kind: 'done' })
      if (this.open === open) this.open = undefined
      return
    }
    this.setState(open, { kind: 'errors', errors: result.errors })
  }

  private setState(open: OpenForm, state: FormState): void {
    open.form = { ...open.form, state }
    this.ports.emit({ t: 'form.changed', channelId: open.form.channelId, form: open.form })
  }

  private stopTimer(open: OpenForm): void {
    if (open.timer !== undefined) this.ports.clock.clearTimeout(open.timer)
    open.timer = undefined
  }
}

// A form message as the reply rule reads it, or undefined when it does not decrypt or is malformed.
// `malformed` tells the caller to signal it (a readable message of a form type that breaks the rule).
export function formRelatedOf(event: MatrixEvent): { related?: FormRelated; anchorId?: string; malformed: boolean } {
  const wire = (event.getWireContent?.() ?? {}) as Record<string, unknown>
  const content = event.getContent() as Record<string, unknown>
  let anchorId: string | undefined
  for (const c of [wire, content]) {
    const rel = c['m.relates_to'] as { rel_type?: unknown; event_id?: unknown } | undefined
    if (rel?.rel_type === FORM_REL_TYPE && typeof rel.event_id === 'string') anchorId = rel.event_id
  }
  const id = event.getId()
  const sender = event.getSender()
  const readable = !event.isDecryptionFailure() && !(event.isEncrypted() && event.getClearContent() === null) && !event.isRedacted()
  if (!id || !sender || !readable) return { malformed: false, ...(anchorId !== undefined && { anchorId }) }
  const base = { id, sender, ts: event.getTs() }
  const msgtype = content.msgtype
  let related: FormRelated | undefined
  if (msgtype === FORM_MSGTYPE) {
    const definition = readFormDefinition(content)
    if (definition) related = { ...base, kind: 'definition', definition }
  } else if (msgtype === FORM_SUBMISSION_MSGTYPE) {
    const submission = readFormSubmission(content)
    if (submission) related = { ...base, kind: 'submission', submission }
  } else if (msgtype === FORM_RESULT_MSGTYPE) {
    const result = readFormResult(content)
    if (result) related = { ...base, kind: 'result', result }
  }
  const malformed = related === undefined || anchorId === undefined
  return { ...(related && anchorId !== undefined && { related }), ...(anchorId !== undefined && { anchorId }), malformed }
}

export interface FormRepliesPorts {
  fetchPage(roomId: string, anchorId: string, from: string | undefined): Promise<{ related: FormRelated[]; next?: string }>
  // The author of a trigger (an answer to a card), or undefined when it cannot be found.
  senderOf(roomId: string, eventId: string): Promise<string | undefined>
  changed(roomId: string, anchorId: string): void
  detach(work: Promise<unknown>): void
}

interface ReplyEntry {
  roomId: string
  anchor: FormAnchorFacts & { id: string }
  related: FormRelated[]
  loaded: boolean
  senders: Map<string, string | undefined>
  reply: { by: string; at: number } | undefined
}

export const FORM_REPLY_CACHE_CAP = 500
const keyOf = (roomId: string, anchorId: string): string => `${roomId}\u0000${anchorId}`

export class FormReplies {
  private readonly entries = new Map<string, ReplyEntry>()
  private generation = 0

  constructor(private readonly ports: FormRepliesPorts) {}

  // Synchronous, from the translator: the cached reply, else nothing while the read runs.
  replyFor(roomId: string, anchorId: string, anchor: FormAnchorFacts): { by: string; at: number } | undefined {
    const key = keyOf(roomId, anchorId)
    const entry = this.entries.get(key)
    if (entry) {
      this.entries.delete(key)
      this.entries.set(key, entry)
      entry.anchor = { ...anchor, id: anchorId }
      return entry.reply
    }
    const fresh: ReplyEntry = { roomId, anchor: { ...anchor, id: anchorId }, related: [], loaded: false, senders: new Map(), reply: undefined }
    this.entries.set(key, fresh)
    if (this.entries.size > FORM_REPLY_CACHE_CAP) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    this.ports.detach(this.read(fresh, this.generation))
    return undefined
  }

  // Watch an anchor before any translation asked for it: this session's own command message, whose
  // translation carries a send id until the server's echo, so the translator never asks.
  watch(roomId: string, anchorId: string, anchor: FormAnchorFacts): void {
    this.replyFor(roomId, anchorId, anchor)
  }

  // A live form message of an anchor the cache holds (one it does not hold is read when translated).
  noteLive(roomId: string, anchorId: string, related: FormRelated): void {
    const entry = this.entries.get(keyOf(roomId, anchorId))
    if (!entry) return
    if (!entry.related.some((r) => r.id === related.id)) entry.related.push(related)
    if (entry.loaded) this.ports.detach(this.settle(entry, this.generation))
  }

  clear(): void {
    this.entries.clear()
    this.generation += 1
  }

  private async read(entry: ReplyEntry, generation: number): Promise<void> {
    const paged: FormRelated[] = []
    let from: string | undefined
    try {
      do {
        const page = await this.ports.fetchPage(entry.roomId, entry.anchor.id, from)
        if (generation !== this.generation) return
        paged.push(...page.related)
        from = page.next
      } while (from !== undefined)
    } catch {
      // The reply stays absent; the next translation reads again.
      this.entries.delete(keyOf(entry.roomId, entry.anchor.id))
      return
    }
    // The pages are the server's order; live messages no page brought go after them.
    const ids = new Set(paged.map((r) => r.id))
    entry.related = [...paged, ...entry.related.filter((r) => !ids.has(r.id))]
    entry.loaded = true
    await this.settle(entry, generation)
  }

  private async settle(entry: ReplyEntry, generation: number): Promise<void> {
    if (entry.anchor.kind === 'card') {
      for (const r of entry.related) {
        if (r.kind !== 'definition' || entry.senders.has(r.definition.trigger)) continue
        const trigger = r.definition.trigger
        entry.senders.set(trigger, await this.ports.senderOf(entry.roomId, trigger).catch(() => undefined))
        if (generation !== this.generation) return
      }
    }
    const reply = resolveFormReply(entry.anchor, entry.related, (t) => entry.senders.get(t))
    if (reply?.by === entry.reply?.by && reply?.at === entry.reply?.at) return
    entry.reply = reply
    this.ports.changed(entry.roomId, entry.anchor.id)
  }
}

// One page of an anchor's form messages, forward, decrypted before they are read.
export async function fetchFormPage(client: RelationsClient, roomId: string, anchorId: string, from: string | undefined): Promise<{ related: FormRelated[]; next?: string }> {
  const { events, next } = await relationPage(client, roomId, anchorId, FORM_REL_TYPE, from)
  const related = events.map((ev) => formRelatedOf(ev).related).filter((r): r is FormRelated => r !== undefined)
  return { related, ...(next !== undefined && { next }) }
}
