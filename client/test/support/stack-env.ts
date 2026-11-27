// Stack namespace of the harness (PLANO-CI-INTEGRACAO §8.R2, fase 2b): the ONE place where e2e/ and
// test/ read the host endpoints and container names of the dev-stack they run against. Every default
// is the owner's `spike` of today, so the local flow does not change; the CI exports the whole set
// to point the harness at its own namespace (`spike-ci`, ADR-071 dec. 2) — a partial set would mix
// the two stacks, which `.github/scripts/assert-stack-namespace.mjs` refuses before any gate runs.
// Read at module load: the values are fixed for the process (tests that need another value stub the
// env and re-import, test/stack-env.test.ts).

export const HS_URL = process.env.TAYET_HS_URL ?? 'http://localhost:8008'
export const MAS_URL = process.env.TAYET_MAS_URL ?? 'http://localhost:8080'
export const ESCROW_URL = process.env.TAYET_ESCROW_URL ?? 'http://localhost:8090'
// The push service's health port on the host (the homeserver reaches the service on its own network).
export const PUSH_URL = process.env.TAYET_PUSH_URL ?? 'http://localhost:8095'
// The SPA origin (vite dev / preview); its port is the one the MAS client's redirect_uri is
// registered for (5173 in infra/dev-stack/mas/config.yaml; the 2a render shifts it with the namespace).
export const APP_URL = `http://localhost:${process.env.TAYET_SPA_PORT ?? '5173'}`

export const MAS_CONTAINER = process.env.TAYET_MAS_CONTAINER ?? 'spike-mas-1'
export const MAS_CONFIG = process.env.TAYET_MAS_CONFIG ?? '/config/config.yaml'
export const AGENT_CONTAINER = process.env.TAYET_AGENT_CONTAINER ?? 'spike-agent-1'
export const AGENT_VOLUME = process.env.TAYET_AGENT_VOLUME ?? 'spike_agentdata'

// The SPA's OIDC client in the MAS (infra/dev-stack/mas/config.yaml) and its redirect_uri.
export const SPA_CLIENT_ID = process.env.TAYET_SPA_CLIENT_ID ?? '000000000000000000000TAYET'
export const SPA_REDIRECT = process.env.TAYET_SPA_REDIRECT ?? `${APP_URL}/`

// CI only (issue #7, fatia 4): a missing stack is FATAL instead of a silent skip — see synapse.ts.
export const REQUIRE_STACK = process.env.TAYET_REQUIRE_STACK === '1'

export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

// Matches a request URL on any of the given origins: `^(?:u1|u2)\/`, each origin escaped.
export const hostUrlPattern = (...urls: string[]): RegExp => new RegExp(`^(?:${urls.map(escapeRegExp).join('|')})\\/`)
