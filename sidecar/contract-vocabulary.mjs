// The protocol vocabulary the local API's contract may never use (PLANO-AGENTES §0.3.6 adj. 12): the
// barrel's deny list (client/eslint.config.js, shared/eslint.config.js — a deliberate copy, packages
// import nothing from each other; a change to one is a change to all three). Read by eslint.config.js
// (names in src/api/contract.ts) and by the test that scans the keys of real responses.
export const CONTRACT_VOCAB_DENY = String.raw`homeserver|mxid|federation|powerlevel|power_level|roomid|room_id|eventid|event_id|olm|megolm|crosssigning|cross_signing|secretstorage|secret_storage|recoverykey|recovery_key|devicekey|device_key|4s|ssss|encrypted|escrow`

// The Slack layer's contract (src/api/slack/contract.ts, PLANO-AGENTES §0.3.12 item 2) is denied the same
// list MINUS this closed allowlist: Slack envelope fields whose value is opaque in the sidecar. Exact
// names only (`event_id` is allowed, `event_ids` is not), only under src/api/slack/** (negative test in
// test/unit/lint-boundary.test.ts; the runtime key scan in src/api/slack/edge.ts).
export const SLACK_VOCAB_ALLOW = ['event_id']

// The deny pattern of the Slack contract: a name in the allowlist never matches; any other name with a
// denied word does (the same substring match as CONTRACT_VOCAB_DENY).
export const SLACK_VOCAB_DENY = String.raw`^(?!(?:${SLACK_VOCAB_ALLOW.join('|')})$).*(?:${CONTRACT_VOCAB_DENY})`
