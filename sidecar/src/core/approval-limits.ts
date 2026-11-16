// The approval card's option rules, for the local API's layers (PLANO-AGENTES §0.3.16 item 12): src/api/**
// never imports @tayet/shared/internal (its lint), so the Slack layer (A3-4, slack/actions.ts) reads the
// shared constants through here — one source with the native routes (core/approvals.ts).
export { APPROVAL_LABEL_MAX, APPROVAL_MAX_OPTIONS, APPROVAL_OPTION_ID } from '@tayet/shared/internal'
