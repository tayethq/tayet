// Write gateway of the sidecar (ADR-087 dec. 7; PLANO-AGENTES §0.3.5 adj. 9, §0.3.7 items 4, 7): ONE
// attempt of each write effect, over the pure builders of @tayet/shared/internal (`buildTextContent`,
// `buildEditContent`, `buildReactionContent`, `buildAttachmentContent`, S-a2). What lives here is what
// the builders leave to the gateway (outbound.ts header): the SDK method and its arguments, and the
// checks before any effect. The retry is NOT here — the send queue (queue.ts) is its only owner, and
// the SDK's scheduler never retries (boot.ts: `new MatrixScheduler(() => -1)`).
//
// - text: thread → sendMessage(roomId, threadRoot, content, txnId); reply or no relation →
//   sendMessage(roomId, content, txnId) (no threadId: the SDK's addThreadRelationIfNeeded stays a
//   no-op, as in the client's gateway); reply inside a thread is refused (`ReplyInThread`);
// - edit: sendMessage(roomId, m.replace content, txnId), no threadId — the client's editMessage;
// - removal: redactEvent(roomId, eventId, txnId) — the client's deleteMessage;
// - reaction: sendEvent(roomId, m.reaction, annotation, txnId); its removal is the redaction of the
//   agent's own reaction event (found by the caller) — the client's react/removeReaction;
// - attachment: the message of an ALREADY uploaded file (the upload is outside the queue, §0.3.7
//   item 4), with the thread root as the SDK's threadId when there is one;
// - a channel this agent has not joined is refused before any effect (`NotMember`);
// - no optimistic echo: nothing is announced before the server accepts (the SDK's own pending event
//   lives in the detached pending list and is cancelled by the queue on failure — `cancelLocal`,
//   whatever its type: message, reaction or redaction);
// - the message text never reaches a log line.
//
// Ids are the raw protocol ids inside the core; core/write.ts tokenizes them for the local API.
import type { MatrixClient } from 'matrix-js-sdk'
import { EventStatus, EventType } from 'matrix-js-sdk'
import type { RichDoc } from '@tayet/shared'
import { brandUserId, buildEditContent, buildReactionContent, buildTextContent, type TextRelation } from '@tayet/shared/internal'

export interface TextSend {
  channel: string
  text: string
  // The formatted text (PLANO-AGENTES §0.3.12 item 4): the Slack layer's mrkdwn, translated. The native
  // API does not take it yet (S-i).
  rich?: RichDoc
  mentions?: string[]
  thread?: string
  replyTo?: string
}

// The write jobs of the queue (one discriminated union; every effect goes through the single queue,
// §0.3.7 item 4). `channel` is the raw room id; targets are raw event ids.
export type WriteJob =
  | { kind: 'text'; req: TextSend }
  | { kind: 'edit'; channel: string; target: string; text: string; rich?: RichDoc }
  | { kind: 'redact'; channel: string; target: string }
  | { kind: 'react'; channel: string; target: string; key: string }
  // The redaction of the agent's own reaction event.
  | { kind: 'unreact'; channel: string; reaction: string }
  | { kind: 'attachment'; channel: string; content: Record<string, unknown>; thread?: string }
  // ADR-091 (A3-3): an already built content of the agent's own type — an approval card or its edit
  // (shared builders) — sent like the attachment's message (sendMessage, the thread root as threadId).
  | { kind: 'content'; channel: string; content: Record<string, unknown>; thread?: string }
  // ADR-091 dec. 13 (A3-6): a pinned panel's message or its edit (shared builders), sent like `content`.
  // Its scheduler (core/panels.ts) owns its retry: the queue hands the server's limit back at once and
  // never applies the 30 s deadline (queue.ts header).
  | { kind: 'panel'; channel: string; content: Record<string, unknown> }
  // ADR-093 (A4-2a): the commands manifest's message or its edit (shared builders), sent and handed back like
  // `panel`; its scheduler is the panel's (core/anchored.ts).
  | { kind: 'commands'; channel: string; content: Record<string, unknown> }

export const jobChannel = (job: WriteJob): string => (job.kind === 'text' ? job.req.channel : job.channel)

// The channel is unknown to this agent or its membership is not `join` (an invite is not enough).
export class NotMember extends Error {
  readonly kind = 'not-member'
  constructor() {
    super('the agent is not a member of this channel')
    this.name = 'NotMember'
  }
}

export class ReplyInThread extends Error {
  readonly kind = 'reply-in-thread'
  constructor() {
    super('cannot reply inside a thread')
    this.name = 'ReplyInThread'
  }
}

export type GatewayClient = Pick<MatrixClient, 'getRoom' | 'sendMessage' | 'sendEvent' | 'redactEvent' | 'cancelPendingEvent'>

const CANCELLABLE: ReadonlySet<EventStatus | null> = new Set([EventStatus.QUEUED, EventStatus.NOT_SENT, EventStatus.ENCRYPTING])

export interface WriteGateway {
  // One attempt each. Resolves with the server's id of the accepted event; rejects with NotMember,
  // ReplyInThread, or the SDK's error (classified by the queue).
  sendText(req: TextSend, txnId: string): Promise<string>
  editText(channel: string, target: string, text: string, txnId: string, rich?: RichDoc): Promise<string>
  redact(channel: string, target: string, txnId: string): Promise<string>
  react(channel: string, target: string, key: string, txnId: string): Promise<string>
  sendAttachment(channel: string, content: Record<string, unknown>, thread: string | undefined, txnId: string): Promise<string>
  // Cancels the SDK's local pending event of a failed attempt (found by its transaction id), of any
  // type: a message, an edit, a reaction or a redaction.
  cancelLocal(channel: string, txnId: string): void
}

export function createWriteGateway(client: GatewayClient): WriteGateway {
  const member = (channel: string): void => {
    if (client.getRoom(channel)?.getMyMembership() !== 'join') throw new NotMember()
  }
  return {
    async sendText(req, txnId) {
      if (req.thread !== undefined && req.replyTo !== undefined) throw new ReplyInThread()
      member(req.channel)
      const mentions = req.mentions?.map(brandUserId)
      const relation: TextRelation | undefined =
        req.thread !== undefined ? { thread: req.thread } : req.replyTo !== undefined ? { replyTo: req.replyTo } : undefined
      const content = buildTextContent(req.text, req.rich, mentions, relation)
      const sent =
        req.thread !== undefined
          ? await client.sendMessage(req.channel, req.thread, content as never, txnId)
          : await client.sendMessage(req.channel, content as never, txnId)
      return sent.event_id
    },
    async editText(channel, target, text, txnId, rich) {
      member(channel)
      const sent = await client.sendMessage(channel, buildEditContent(text, rich, target) as never, txnId)
      return sent.event_id
    },
    async redact(channel, target, txnId) {
      member(channel)
      const sent = await client.redactEvent(channel, target, txnId)
      return sent.event_id
    },
    async react(channel, target, key, txnId) {
      member(channel)
      const sent = await client.sendEvent(channel, EventType.Reaction, buildReactionContent(target, key), txnId)
      return sent.event_id
    },
    async sendAttachment(channel, content, thread, txnId) {
      member(channel)
      const sent =
        thread !== undefined
          ? await client.sendMessage(channel, thread, content as never, txnId)
          : await client.sendMessage(channel, content as never, txnId)
      return sent.event_id
    },
    cancelLocal(channel, txnId) {
      const local = client
        .getRoom(channel)
        ?.getPendingEvents()
        .find((ev) => ev.getTxnId() === txnId)
      if (local !== undefined && CANCELLABLE.has(local.status)) client.cancelPendingEvent(local)
    },
  }
}

// One attempt of a job (the queue's `attempt` port).
export function attemptJob(gateway: WriteGateway, job: WriteJob, txnId: string): Promise<string> {
  switch (job.kind) {
    case 'text':
      return gateway.sendText(job.req, txnId)
    case 'edit':
      return gateway.editText(job.channel, job.target, job.text, txnId, job.rich)
    case 'redact':
      return gateway.redact(job.channel, job.target, txnId)
    case 'react':
      return gateway.react(job.channel, job.target, job.key, txnId)
    case 'unreact':
      return gateway.redact(job.channel, job.reaction, txnId)
    case 'attachment':
    case 'content':
      return gateway.sendAttachment(job.channel, job.content, job.thread, txnId)
    case 'panel':
    case 'commands':
      return gateway.sendAttachment(job.channel, job.content, undefined, txnId)
  }
}
