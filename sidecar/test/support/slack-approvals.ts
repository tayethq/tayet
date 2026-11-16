// A fake ApprovalFacade over the Slack world (A3-4; no SDK, no stack): the card is a message of the agent
// with `approval` (options + state), as the core projects one of its own cards; `close` and `state` follow
// the core's contract (a closed card closes again with no write; an answered card stays answered).
import type { ApprovalFacade, ApprovalRequest } from '../../src/core/approvals'
import type { ApiApproval, ApiMessage } from '../../src/api/contract'
import { ReadError } from '../../src/core/read'
import { ME, message, type Call, type World } from './slack-world'

export interface FakeApprovals extends ApprovalFacade {
  calls: Call[]
  // The person answered (the state the core would read).
  answer(conversation: string, ts: string, option: string, by: string, at: number): void
}

let n = 0
const nextTs = (): string => `${1_732_000_000 + ++n}.000100`

export function fakeApprovals(world: World): FakeApprovals {
  const calls: Call[] = []
  const card = (conversation: string, ts: string): ApiMessage & { approval: ApiApproval } => {
    const m = (world.messages.get(conversation) ?? []).find((x) => x.id === ts)
    if (m?.approval === undefined) throw new ReadError('message_not_found')
    return m as ApiMessage & { approval: ApiApproval }
  }
  return {
    calls,
    request(conversation, req: ApprovalRequest) {
      world.read.conversation(conversation)
      if (req.thread !== undefined && !(world.messages.get(conversation) ?? []).some((m) => m.id === req.thread)) return Promise.reject(new ReadError('message_not_found'))
      const fail = world.failNext.shift()
      if (fail !== undefined) return Promise.reject(fail)
      calls.push({ op: 'request', conversation, ...req })
      const m = message({
        id: nextTs(),
        conversation,
        author: ME.id,
        text: req.text,
        ...(req.rich !== undefined && { rich: req.rich as unknown as Record<string, unknown> }),
        ...(req.thread !== undefined && { thread: req.thread }),
        ...(req.mentions !== undefined && { mentions: req.mentions }),
        approval: { options: req.options.map((o) => ({ ...o })), state: 'open' },
      })
      world.messages.set(conversation, [m, ...(world.messages.get(conversation) ?? [])])
      return Promise.resolve(m)
    },
    close(conversation, ts, text) {
      const m = card(conversation, ts)
      if (m.approval.state === 'open') {
        calls.push({ op: 'close', conversation, ts, ...(text !== undefined && { text }) })
        m.approval.state = 'closed'
      }
      return Promise.resolve(m)
    },
    state(conversation, ts) {
      const m = card(conversation, ts)
      return Promise.resolve({ conversation, id: ts, approval: m.approval })
    },
    answer(conversation, ts, option, by, at) {
      const m = card(conversation, ts)
      m.approval.state = 'answered'
      m.approval.answer = { option, by, at }
    },
  }
}
