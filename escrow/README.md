# @tayet/escrow

The per-organization custody service (ADR-021, ADR-047). It holds the organization's key-backup
deposits and the session keys deposited by the custody agent, authenticates every request by token
introspection against the identity provider, and writes an append-only audit log of each access.

## Running

Requires Node 22+ (it runs from source with native type stripping; there is no build step).

```bash
npm ci
node --experimental-strip-types src/server.ts
```

When ready it prints one JSON line, `{"listening": <port>}`. `npm run check` runs typecheck, lint
and tests.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `ESCROW_STORE_DIR` | yes | Data directory (deposits, sessions, `audit.jsonl`) |
| `ESCROW_ORG_KEY` | yes | Organization key, 32 bytes base64 — never commit it |
| `ESCROW_INTROSPECTION_URL` | yes | Token introspection endpoint (RFC 7662) |
| `ESCROW_CLIENT_ID` / `ESCROW_CLIENT_SECRET` | yes | Introspection client credentials |
| `ESCROW_PORT` | no | Listen port (default `0`, ephemeral) |
| `ESCROW_BIND` | no | Bind address (default `127.0.0.1`) |
| `ESCROW_CUSTODY_USERNAME` | no | Identity allowed to deposit sessions (default `cofre`) |
| `ESCROW_MAS_ADMIN_URL` | no | MAS admin API on the internal listener (ADR-082); without it `revoke-others` answers 503 |
| `ESCROW_MAS_ADMIN_CLIENT_ID` / `ESCROW_MAS_ADMIN_CLIENT_SECRET` | with the URL | `client_credentials` client allowed `urn:mas:admin` |

People and agents (`/v1/people`, `/v1/agents`) are served by the organization service, `org/`, behind
the same `/escrow` prefix.

`infra/dev-stack/` runs it integrated with the rest of the stack.
