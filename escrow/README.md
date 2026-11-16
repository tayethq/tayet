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
| `ESCROW_MAS_ADMIN_URL` | no | MAS admin API on the internal listener (ADR-082); without it `revoke-others` answers 503 and `/v1/people` does not exist |
| `ESCROW_MAS_ADMIN_CLIENT_ID` / `ESCROW_MAS_ADMIN_CLIENT_SECRET` | with the URL | `client_credentials` client allowed `urn:mas:admin` |
| `ESCROW_HS_URL` | with the URL | Homeserver client API, on the internal network |
| `ESCROW_SERVER_NAME` | with the URL | Server name, used for user ids and the `#all` alias |
| `ESCROW_PEOPLE_PROVIDER_ID` | with the URL | Upstream provider id of the login link created for each invited person |

## People

`POST` and `DELETE` require a token whose MAS user has the `admin` flag; anyone else gets 403. Every call is audited
with `actor` and `target`. `GET /v1/people/me` is open to any valid token and audited as `people.me`.

| Route | Body | Result |
|---|---|---|
| `GET /v1/people/me` | none | 200 `{ admin }` for the caller |
| `POST /v1/people` | `{ email, name, kind }`, `kind` is `member` or `guest` | 201 `{ userId, kind }`, with `completed` on an existing account; 409 `{ reason: 'exists', userId, kind }` |
| `DELETE /v1/people/:userId` | none; `:userId` is the URL-encoded Matrix user id | 200 `{ removed: true }`; 400 for the caller, `system` or the custody account; 404 |

An invite creates the account, its email and its upstream link, then writes `io.tayet.member` in `#all` and, for a
member, sends the invite. A failure after that starts is a 502 `{ error: 'partial', step }`. There is no rollback:
repeat the same call. It completes what is missing and answers 201 with `completed`, a list of `email`, `link` and
`org`; `email` is the one in `io.tayet.member`. Only with nothing missing does it answer 409. A stored `kind` is never
overwritten.

The one exception is a failure adding the email, since the account could not be found again: it is deactivated once,
and audited as `people.invite.compensated`.

Removal deactivates the account without erasing it, deletes its upstream links so the email can be invited again,
and empties `io.tayet.member`.

The escrow writes to `#all` as `system` through a MAS personal session: 60 s TTL, scope `urn:matrix:client:api:*`,
one per operation, revoked at the end. Boot revokes any expired one left behind. Rate limits are waited out up to
20 s per write.

`infra/dev-stack/` runs it integrated with the rest of the stack.
