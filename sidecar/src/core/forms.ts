// An agent's forms in the sidecar core: writing the definition (opened from a click on the agent's own card,
// or from a person's command for this agent), writing the result of a submission, and the watch that hands
// a valid live submission to one in-memory listener — outside the event bus, the event stream and the MCP.
//
// - Opening from a click: the card is read again (fresh) and the answer that decided it is the trigger; it
//   must be the clicking person's. On a card that asks for several answers (ADR-104), the trigger is that
//   person's answer that counts, once read. Opening from a command: the message must be a command for this agent; it
//   is both the trigger and the anchor. The definition is checked by the shared reader before any effect
//   and written through the write queue, as a card is.
// - The watch takes a live submission when: it reads as one; it names a valid definition this agent wrote
//   for the same anchor; its sender owns that definition's trigger (the author of the deciding answer, or of
//   the command message); its values pass the definition's fields; it is at most a minute old when read
//   (the server's instant against this clock). A submission that cannot be read yet waits for its key, up to that minute. Each
//   one is handed over once per run. With no listener, nothing is read.
// - A result is written only for a submission this run handed over: ok, errors by field id, or refused
//   (an error under a key that is no field id, which the person's client shows as not sent).
// - Nothing of the protocol and no content reaches a log line: reasons only.
import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk'
import { MatrixEventEvent } from 'matrix-js-sdk'
import {
  APPROVAL_MSGTYPE,
  FORM_ERROR_MAX,
  FORM_MSGTYPE,
  FORM_REL_TYPE,
  FORM_SUBMISSION_MSGTYPE,
  RESPONSE_REL_TYPE,
  buildFormDefinitionContent,
  buildFormResultContent,
  readApprovalNeeded,
  readApprovalOptions,
  readFormDefinition,
  readFormMeta,
  readFormResult,
  readFormSubmission,
  validateFormValues,
  type FormDefinition,
} from '@tayet/shared/internal'
import type { FormField, FormValues } from '@tayet/shared'
import { FORM_SUBMISSION_MAX_AGE_MS } from './form-limits'
import { ReadError } from './read'
import type { CardReader } from './approvals'
import { WriteError, writeHelpers, type WriteDeps } from './write'

// The origin of a form: a click on one of the agent's cards (the card's ts and the person who clicked), or
// a person's command message for this agent (its ts).
export type FormOrigin = { kind: 'card'; card: string; person: string } | { kind: 'command'; message: string }

export interface FormOpenRequest {
  conversation: string
  origin: FormOrigin
  // The form in the product's schema: title, submit label, fields (checked here).
  form: { title: unknown; submitLabel: unknown; fields: unknown }
  // The agent's state, read back from the definition with each submission.
  meta?: unknown
}

// What the agent answers to a submission.
export type FormOutcome = { ok: true } | { errors: Record<string, string> } | { refused: true }

// A submission handed to the listener, in tokens of the local API.
export interface FormSubmitted {
  conversation: string
  form: { id: string; title: string; submitLabel: string; fields: FormField[]; meta?: string }
  submission: { id: string; by: string; at: number; values: FormValues }
  origin: { kind: 'card' | 'command'; anchor: string }
}

export type FormListener = (submitted: FormSubmitted) => void

export interface FormFacade {
  // Writes the definition; answers the definition's ts.
  open(req: FormOpenRequest): Promise<{ id: string }>
  // Writes the result of a submission this run handed over.
  result(conversation: string, submission: string, outcome: FormOutcome): Promise<void>
  // The one listener of the submissions (undefined unbinds it).
  listen(listener: FormListener | undefined): void
}

// The origin does not allow a form: a card with no deciding answer, or decided by someone else than the
// person who clicked; a message that is no command for this agent.
export class FormError extends Error {
  constructor(readonly code: 'origin_mismatch') {
    super(code)
    this.name = 'FormError'
  }
}

export interface FormDeps extends WriteDeps {
  reader: CardReader
  // Whether a message carries a command for this agent (core/read.ts).
  commandAt: (room: Room, ev: MatrixEvent) => boolean
  client: WriteDeps['client'] & Pick<MatrixClient, 'decryptEventIfNeeded'>
  now?: () => number
}

export interface FormCore {
  facade: FormFacade
  // A live event of a conversation (the boot's live timeline listener).
  noteEvent(ev: MatrixEvent, room: Room): void
}

export const SEEN_MAX = 2_000
export const ACCEPTED_MAX = 500

export type FormIgnoredReason = 'malformed' | 'unreadable' | 'too-old' | 'unknown-form' | 'unknown-trigger' | 'not-owner' | 'invalid-values' | 'no-position'

interface Accepted {
  roomId: string
  anchorId: string
  submissionId: string
  fieldIds: Set<string>
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const relationOf = (ev: MatrixEvent): { rel_type?: unknown; event_id?: unknown } => {
  const rel: unknown = ev.getWireContent()['m.relates_to']
  return isRecord(rel) ? rel : {}
}
const unreadable = (ev: MatrixEvent): boolean => ev.isDecryptionFailure() || (ev.isEncrypted() && ev.getClearContent() === null)
const inputIds = (fields: readonly FormField[]): Set<string> => new Set(fields.flatMap((f) => (f.kind === 'context' ? [] : [f.id])))

// A bounded set: the oldest entry leaves first.
function remember<K>(set: Set<K> | Map<K, unknown>, max: number): void {
  while (set.size > max) set.delete(set.keys().next().value as K)
}

export function createFormCore(deps: FormDeps): FormCore {
  const { client, resolver, reader, log } = deps
  const h = writeHelpers(deps)
  const now = deps.now ?? Date.now
  const seen = new Set<string>()
  const accepted = new Map<string, Accepted>()
  let listener: FormListener | undefined

  // The trigger of a click: the answer that decided the agent's own card, which must be the person's.
  const clickTrigger = async (room: Room, card: string, person: string): Promise<{ anchorId: string; trigger: string }> => {
    const by = resolver.userOf(person)
    const { eventId, ev } = await h.messageAt(room, card)
    h.owned(ev)
    const original = ev.getOriginalContent()
    const options = !ev.isDecryptionFailure() && original.msgtype === APPROVAL_MSGTYPE ? readApprovalOptions(original) : undefined
    if (options === undefined) throw new WriteError('not_approval')
    const needed = readApprovalNeeded(original)
    if (needed === null) throw new WriteError('not_approval')
    if (needed !== undefined) {
      const reading = await reader.read(room.roomId, eventId, options, { fresh: true, needed })
      const mine = reading.counted?.find((a) => a.by === by && a.option !== undefined)
      if (mine === undefined) throw new FormError('origin_mismatch')
      return { anchorId: eventId, trigger: mine.eventId }
    }
    const reading = await reader.read(room.roomId, eventId, options, { fresh: true })
    if (reading.state.kind !== 'answered' || reading.decidedId === undefined || (reading.state.by as unknown as string) !== by) throw new FormError('origin_mismatch')
    return { anchorId: eventId, trigger: reading.decidedId }
  }

  const commandTrigger = async (room: Room, message: string): Promise<{ anchorId: string; trigger: string }> => {
    const { eventId, ev } = await h.messageAt(room, message)
    if (!deps.commandAt(room, ev)) throw new FormError('origin_mismatch')
    return { anchorId: eventId, trigger: eventId }
  }

  // The definition's content, from what the agent gave, re-built from what the shared reader kept (a key it
  // does not know never reaches the conversation); undefined when it breaks a rule.
  const definitionOf = (anchorId: string, trigger: string, form: FormOpenRequest['form'], meta: unknown) => {
    if (!isRecord(form) || !Array.isArray(form.fields) || typeof form.title !== 'string' || typeof form.submitLabel !== 'string') return undefined
    if (meta !== undefined && typeof meta !== 'string') return undefined
    let read: FormDefinition | undefined
    try {
      read = readFormDefinition(buildFormDefinitionContent(anchorId, trigger, form.title, form.submitLabel, form.fields as FormField[], meta))
    } catch {
      return undefined
    }
    if (read === undefined) return undefined
    const content = buildFormDefinitionContent(anchorId, trigger, read.title, read.submitLabel, read.fields, meta)
    return readFormDefinition(content) !== undefined ? content : undefined
  }

  const resultOf = (entry: Accepted, raw: FormOutcome): { ok: true } | { errors: Record<string, string> } => {
    const bad = (): never => {
      throw new WriteError('invalid_argument')
    }
    const outcome: unknown = raw
    if (!isRecord(outcome)) return bad()
    const keys = Object.keys(outcome)
    if (keys.length !== 1) return bad()
    if (outcome.ok === true) return { ok: true }
    if (outcome.refused === true) {
      let key = '_'
      while (entry.fieldIds.has(key)) key += '_'
      return { errors: { [key]: 'refused' } }
    }
    const errors = outcome.errors
    if (!isRecord(errors)) return bad()
    const entries = Object.entries(errors)
    if (entries.length < 1) return bad()
    for (const [id, message] of entries) {
      if (!entry.fieldIds.has(id) || typeof message !== 'string') return bad()
      const n = [...message].length
      if (n < 1 || n > FORM_ERROR_MAX) return bad()
    }
    return { errors: { ...(errors as Record<string, string>) } }
  }

  const ignore = (reason: FormIgnoredReason): void => log({ evt: 'form-submission-ignored', reason })

  // A readable live event related by the form relation to `anchorId`: a submission is checked and handed over.
  const take = async (ev: MatrixEvent, room: Room, anchorId: string): Promise<void> => {
    if (unreadable(ev)) return ignore('unreadable')
    const content = ev.getContent()
    if (content.msgtype !== FORM_SUBMISSION_MSGTYPE) return
    const submission = readFormSubmission(content)
    if (submission === undefined) return ignore('malformed')
    if (now() - ev.getTs() > FORM_SUBMISSION_MAX_AGE_MS) return ignore('too-old')
    const defEv = await h.loadEvent(room, submission.form)
    const defContent = defEv?.getContent() ?? {}
    const definition = defEv !== null && !defEv.isRedacted() && defEv.getSender() === h.me() && defContent.msgtype === FORM_MSGTYPE ? readFormDefinition(defContent) : undefined
    if (defEv === null || definition === undefined || relationOf(defEv).event_id !== anchorId) return ignore('unknown-form')
    const command = definition.trigger === anchorId
    const ownerEv = await h.loadEvent(room, command ? anchorId : definition.trigger)
    if (ownerEv === null || (!command && (relationOf(ownerEv).rel_type !== RESPONSE_REL_TYPE || relationOf(ownerEv).event_id !== anchorId))) return ignore('unknown-trigger')
    const by = ev.getSender()
    if (by === undefined || by !== ownerEv.getSender()) return ignore('not-owner')
    const fieldIds = inputIds(definition.fields)
    if (Object.keys(submission.values).some((id) => !fieldIds.has(id)) || Object.keys(validateFormValues(definition.fields, submission.values)).length > 0) {
      return ignore('invalid-values')
    }
    const submissionId = ev.getId() as string
    const subTs = resolver.tsOf(room.roomId, submissionId, ev.getTs())
    const formTs = resolver.tsOf(room.roomId, submission.form, defEv.getTs())
    const anchorTs = await resolver.tsOfRelated(room, anchorId)
    if (subTs === null || formTs === null || anchorTs === undefined) return ignore('no-position')
    const current = listener
    if (current === undefined) return
    const conversation = resolver.tokenOfRoom(room.roomId)
    accepted.set(`${conversation} ${subTs}`, { roomId: room.roomId, anchorId, submissionId, fieldIds })
    remember(accepted, ACCEPTED_MAX)
    const meta = readFormMeta(defContent)
    log({ evt: 'form-submission-accepted' })
    try {
      current({
        conversation,
        form: { id: formTs, title: definition.title, submitLabel: definition.submitLabel, fields: definition.fields, ...(meta !== undefined && { meta }) },
        submission: { id: subTs, by: resolver.tokenOfPerson(by), at: ev.getTs(), values: submission.values },
        origin: { kind: command ? 'command' : 'card', anchor: anchorTs },
      })
    } catch {
      log({ evt: 'form-listener-failed' })
    }
  }

  // The key may come later: every decryption of the event is looked at until one reads it or the submission
  // passes the age limit (then a timer ends the wait); the listener leaves in both cases.
  const awaitKey = (ev: MatrixEvent, room: Room, anchorId: string): void => {
    const onDecrypted = (): void => {
      if (unreadable(ev) && now() - ev.getTs() <= FORM_SUBMISSION_MAX_AGE_MS) return
      stop()
      void take(ev, room, anchorId).catch(() => log({ evt: 'form-submission-failed' }))
    }
    const timer = setTimeout(
      () => {
        stop()
        ignore('unreadable')
      },
      Math.max(FORM_SUBMISSION_MAX_AGE_MS - (now() - ev.getTs()), 0),
    )
    timer.unref?.()
    const stop = (): void => {
      clearTimeout(timer)
      ev.off(MatrixEventEvent.Decrypted, onDecrypted)
    }
    ev.on(MatrixEventEvent.Decrypted, onDecrypted)
  }

  const consider = async (ev: MatrixEvent, room: Room, anchorId: string): Promise<void> => {
    await client.decryptEventIfNeeded(ev).catch(() => undefined)
    if (unreadable(ev)) return awaitKey(ev, room, anchorId)
    await take(ev, room, anchorId)
  }

  return {
    facade: {
      async open(req) {
        const room = h.joined(req.conversation)
        const origin = req.origin
        const { anchorId, trigger } =
          isRecord(origin) && origin.kind === 'card' && typeof origin.card === 'string' && typeof origin.person === 'string'
            ? await clickTrigger(room, origin.card, origin.person)
            : isRecord(origin) && origin.kind === 'command' && typeof origin.message === 'string'
              ? await commandTrigger(room, origin.message)
              : (() => {
                  throw new WriteError('invalid_argument')
                })()
        const content = definitionOf(anchorId, trigger, req.form, req.meta)
        if (content === undefined) throw new WriteError('invalid_argument')
        const eventId = await h.run({ kind: 'content', channel: room.roomId, content }, 'form')
        return { id: await h.acceptedTs(room, eventId) }
      },

      async result(conversation, submission, outcome) {
        const room = h.joined(conversation)
        const key = `${resolver.tokenOfRoom(room.roomId)} ${submission}`
        const entry = accepted.get(key)
        if (entry === undefined || entry.roomId !== room.roomId) throw new ReadError('message_not_found')
        const content = buildFormResultContent(entry.anchorId, entry.submissionId, resultOf(entry, outcome))
        if (readFormResult(content) === undefined) throw new WriteError('invalid_argument')
        await h.run({ kind: 'content', channel: room.roomId, content }, 'form-result')
        accepted.delete(key)
      },

      listen(next) {
        listener = next
      },
    },

    noteEvent(ev, room) {
      if (listener === undefined) return
      const rel = relationOf(ev)
      const id = ev.getId()
      if (rel.rel_type !== FORM_REL_TYPE || typeof rel.event_id !== 'string' || id === undefined || seen.has(id)) return
      if (ev.getSender() === h.me()) return
      seen.add(id)
      remember(seen, SEEN_MAX)
      void consider(ev, room, rel.event_id).catch(() => log({ evt: 'form-submission-failed' }))
    },
  }
}
