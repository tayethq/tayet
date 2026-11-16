// A refusal of the Slack layer, with Slack's code (its own module: the router and the upload staging
// both throw it, and the staging is imported by the router).
import type { SlackErrorCode } from './contract'

export class SlackError extends Error {
  constructor(
    readonly code: SlackErrorCode,
    readonly retryAfterMs?: number,
    // Slack's `response_metadata.warnings` of the refusal (conversations.open, S-f3).
    readonly warnings?: readonly string[],
  ) {
    super(code)
    this.name = 'SlackError'
  }
}
