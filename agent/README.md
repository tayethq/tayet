# @tayet/agent

The custody agent `cofre` (ADR-057, ADR-069). It is a member of every encrypted room, receives the
room session keys like any other device, and deposits them with the escrow service, so that a user's
new device can recover history. It keeps a checkpoint to catch up on sessions created while it was
down.

## Running

Requires Node 22+ (it runs from source with native type stripping; there is no build step).

```bash
npm ci
node --experimental-strip-types src/main.ts
```

`npm run check` runs typecheck, lint and tests.

## Environment

All variables are required; the agent refuses to boot if any is missing or malformed.

| Variable | Meaning |
|---|---|
| `AGENT_HS_URL` | Server URL |
| `AGENT_TOKEN_FILE` | File holding the agent's access token |
| `AGENT_ESCROW_URL` | Escrow service URL |
| `AGENT_STORE_DIR` | Directory for the encrypted crypto store and the checkpoint |
| `AGENT_STORAGE_KEY` | Crypto store key, 32 bytes base64 — without it the store would be unencrypted |

`infra/dev-stack/` runs it integrated with the rest of the stack.
