import type { ConceptKind } from './acl-types'
import type { UnsupportedShape } from './domain'

// D3 in `strict` mode (dev/test/CI): a concept with no translation throws — a red test
// before shipping, not a silent leak. In `lenient` mode (prod) the ACL degrades by nature
// instead of throwing. The error carries only the shape descriptor (never a payload/PII/
// protocol id) so it stays safe even if it surfaces in logs.
export class UntranslatableConceptError extends Error {
  readonly conceptKind: ConceptKind
  readonly shape: UnsupportedShape

  constructor(args: { conceptKind: ConceptKind; shape: UnsupportedShape }) {
    super(`Untranslatable concept: ${args.conceptKind} (${args.shape.eventType})`)
    this.name = 'UntranslatableConceptError'
    this.conceptKind = args.conceptKind
    this.shape = args.shape
  }
}

// The ACL's product-vocabulary error for "this session is no longer valid" (an expired/revoked
// access token surfaced by the SDK as M_UNKNOWN_TOKEN). Mirrors UntranslatableConceptError's rule:
// carries NO protocol id / errcode / payload — only a neutral product name — so it stays P1-safe
// even if it surfaces in logs, AND so it can cross the barrel (ui/ classifies on the TYPE, never on
// the SDK errcode — L19/ADR-007). The SDK errcode is detected and discarded in acl/internal/** (the
// only place allowed to see it). Consumer: Boot.connectWith → 'revoked' (§8.L29 / ADR-031 D8b).
export class SessionExpiredError extends Error {
  constructor() {
    super('Session expired')
    this.name = 'SessionExpiredError'
  }
}

// The ACL's product-vocabulary error for "the network didn't get us to the server" (the SDK's
// ConnectionError: fetch rejected — server down, DNS/CORS, timeout, client offline). Mirrors the
// siblings: NO protocol id / URL / cause / payload — only a neutral product name — so it stays
// P1-safe in logs AND can cross the barrel (ui/ classifies on the TYPE via instanceof — L19/
// ADR-007). Semântica ASSIMÉTRICA e deliberada: este tipo é SINAL POSITIVO de rede; a AUSÊNCIA
// dele NÃO implica "rede ok" — só implica "sem evidência de rede", que é falha local até prova
// em contrário. Consumidor: Boot.connectWith → 'error' (copy de conexão); todo o resto → 'failed'.
export class ConnectionError extends Error {
  constructor() {
    super('Connection failed')
    this.name = 'ConnectionError'
  }
}

// The ACL's product-vocabulary error for "you're doing that too fast" (the server's rate limit,
// surfaced by the SDK as M_LIMIT_EXCEEDED — e.g. rc_invites.per_user). Mirrors SessionExpiredError:
// carries NO protocol id / errcode / retry_after / payload — only a neutral product name — so it
// stays P1-safe even in logs AND can cross the barrel (ui/ classifies on the TYPE via instanceof,
// never on the SDK errcode — L19/ADR-007). The errcode is detected and discarded in acl/internal/**
// (MatrixGateway.addMember). Consumer: ChannelManagementPanel.addCandidate → dedicated copy.
export class RateLimitedError extends Error {
  constructor() {
    super('Rate limited')
    this.name = 'RateLimitedError'
  }
}

// ADR-083: the invite found the person complete, with nothing left to do. Carries no id or email.
// Consumer: the invite form (P3-2) classifies on the TYPE.
export class PersonExistsError extends Error {
  constructor() {
    super('Person already exists')
    this.name = 'PersonExistsError'
  }
}

// ADR-083: the provisioning service did not answer in time, or stopped halfway. Repeating the invite
// completes what is missing, so this is a retryable outcome, not a rejection.
export class PeopleUnavailableError extends Error {
  constructor() {
    super('People service unavailable')
    this.name = 'PeopleUnavailableError'
  }
}

// ADR-086 (Proposto) dec. 6: the name is already someone's in the organization — on creating or
// renaming an agent (the escrow's normalised collision), or on a person's nickname equal to a known
// agent's name (the client-side UX refusal, PLANO-AGENTES §0.1 item 7). Carries no name or id.
export class NameInUseError extends Error {
  constructor() {
    super('Name in use')
    this.name = 'NameInUseError'
  }
}

// ADR-118 dec. 5: the change would leave the organization without an admin. Carries no id.
export class LastAdminError extends Error {
  constructor() {
    super('Last admin')
    this.name = 'LastAdminError'
  }
}

// ADR-118 dec. 5: the person is not a member of the organization (a guest, a removed or deactivated
// account), so the role cannot be given. Carries no id.
export class NotMemberError extends Error {
  constructor() {
    super('Not a member')
    this.name = 'NotMemberError'
  }
}

// ADR-118 dec. 6: the organization service refused this session an organization verb or read, because it
// is not (or no longer) an admin. The surface closes on it. Carries no id.
export class OrgAccessDeniedError extends Error {
  constructor() {
    super('Organization access denied')
    this.name = 'OrgAccessDeniedError'
  }
}
