// The single write queue of the core (ADR-087 dec. 7; PLANO-AGENTES §0.3.7 item 4): the send queue
// (queue.ts) over the gateway (send.ts), one entry per WriteJob. A new transaction id per attempt
// (queue.ts header: the SDK refuses a cancelled one); the cancel targets the last one, in the job's
// channel. boot.ts wires it with the SDK client; the unit tests with a fake gateway (per job kind).
import { classifySendError, createSendQueue, type SendFailure, type SendResult } from './queue'
import { attemptJob, jobChannel, type WriteGateway, type WriteJob } from './send'

export interface WriteQueue {
  enqueue(job: WriteJob): Promise<SendResult>
  // Fails everything pending (in flight included) and every later enqueue. Idempotent.
  close(failure: SendFailure): void
  readonly size: number
}

export interface WriteQueueOptions {
  gateway: WriteGateway
  makeTxnId: () => string
  onRevoked: () => void
  log: (line: Record<string, unknown>) => void
}

interface Entry {
  job: WriteJob
  txnId: string
}

export function createWriteQueue(opts: WriteQueueOptions): WriteQueue {
  const queue = createSendQueue<Entry>({
    attempt: (entry) => {
      entry.txnId = opts.makeTxnId()
      return attemptJob(opts.gateway, entry.job, entry.txnId)
    },
    cancel: (entry) => opts.gateway.cancelLocal(jobChannel(entry.job), entry.txnId),
    classify: classifySendError,
    onRevoked: opts.onRevoked,
    log: opts.log,
    // The anchored writes — the pinned panel and the commands manifest (core/anchored.ts): their scheduler keeps
    // the version on the server's limit.
    handBack: (entry) => entry.job.kind === 'panel' || entry.job.kind === 'commands',
  })
  return {
    enqueue: (job) => queue.enqueue({ job, txnId: '' }),
    close: (failure) => queue.close(failure),
    get size() {
      return queue.size
    },
  }
}
