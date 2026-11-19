// A refusal of the Slack layer, with Slack's code (its own module: the router and the upload staging
// both throw it, and the staging is imported by the router).
import { refusedOf, type EdgeLeak } from '../edge'
import type { SlackErrorCode } from './contract'

export class SlackError extends Error {
  constructor(
    readonly code: SlackErrorCode,
    readonly retryAfterMs?: number,
    // Slack's `response_metadata.warnings` of the refusal (conversations.open, S-f3).
    readonly warnings?: readonly string[],
    // Slack's `response_metadata.messages` of the refusal: one `[ERROR] …` line per problem.
    readonly messages?: readonly string[],
  ) {
    super(code)
    this.name = 'SlackError'
  }
}

// A write's probe found something, before any effect: `invalid_arguments` with one line per finding (the kind
// of id only, never the matched text) when every finding is an id shape in the content the app sent, else
// `internal_error`. The `leak-blocked` lines are the caller's.
export function refusalOf(leaks: readonly EdgeLeak[]): SlackError {
  const refused = refusedOf(leaks)
  if (refused === null) return new SlackError('internal_error')
  return new SlackError(
    'invalid_arguments',
    undefined,
    undefined,
    refused.map((r) => `[ERROR] content looks like an internal id: ${r.pattern}`),
  )
}
