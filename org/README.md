# @tayet/org

The organization service of an installation (ADR-118). It invites and removes people and creates,
edits, removes and reissues agents, against the MAS admin API and the organization channel `#all`.
It authenticates every request by token introspection against the identity provider and writes an
append-only audit log of each call. It holds no organization key and has no runtime dependency.

## Running

Requires Node 22+ (it runs from source with native type stripping; there is no build step).

```bash
npm ci
node --experimental-strip-types src/server.ts
```

When ready it prints one JSON line, `{"listening": <port>}`. `npm run check` runs typecheck, lint
and unit tests.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `ORG_STORE_DIR` | yes | Data directory (`audit.jsonl` only) |
| `ORG_INTROSPECTION_URL` | yes | Token introspection endpoint (RFC 7662) |
| `ORG_CLIENT_ID` / `ORG_CLIENT_SECRET` | yes | Introspection client credentials |
| `ORG_MAS_ADMIN_URL` | yes | MAS admin API on the internal listener |
| `ORG_MAS_ADMIN_CLIENT_ID` / `ORG_MAS_ADMIN_CLIENT_SECRET` | yes | `client_credentials` client allowed `urn:mas:admin` |
| `ORG_HS_URL` | yes | Homeserver client API, on the internal network |
| `ORG_SERVER_NAME` | yes | Server name, used for user ids and the `#all` alias |
| `ORG_PEOPLE_PROVIDER_ID` | yes | Upstream provider id of the login link created for each invited person |
| `ORG_PORT` | no | Listen port (default `0`, ephemeral) |
| `ORG_BIND` | no | Bind address (default `127.0.0.1`) |
| `ORG_CUSTODY_USERNAME` | no | The custody account, which can never be removed (default `cofre`) |

## People

`POST` and `DELETE` require a token whose MAS user has the `admin` flag; anyone else gets 403. Every call is audited
with `actor` and `target`. `GET /v1/people/me` is open to any valid token and audited as `people.me`.

| Route | Body | Result |
|---|---|---|
| `GET /v1/people/me` | none | 200 `{ admin }` for the caller |
| `POST /v1/people` | `{ email, name, kind }`, `kind` is `member` or `guest` | 201 `{ userId, kind }`, with `completed` on an existing account; 409 `{ reason: 'exists', userId, kind }` |
| `DELETE /v1/people/:userId` | none; `:userId` is the URL-encoded Matrix user id | 200 `{ removed: true }`; 400 for the caller, `system` or the custody account; 404; 409 `{ reason: 'last_admin', userId }` for the last active admin |

An invite creates the account, its email and its upstream link, then writes `io.tayet.member` in `#all` and, for a
member, sends the invite. A failure after that starts is a 502 `{ error: 'partial', step }`. There is no rollback:
repeat the same call. It completes what is missing and answers 201 with `completed`, a list of `email`, `link` and
`org`; `email` is the one in `io.tayet.member`. Only with nothing missing does it answer 409. A stored `kind` is never
overwritten.

The one exception is a failure adding the email, since the account could not be found again: it is deactivated once,
and audited as `people.invite.compensated`.

Removal deactivates the account without erasing it, deletes its upstream links so the email can be invited again,
and empties `io.tayet.member`.

The service writes to `#all` as `system` through a MAS personal session: 60 s TTL, scope `urn:matrix:client:api:*`,
one per operation, revoked at the end. Boot revokes any expired one left behind. Rate limits are waited out up to
20 s per write.

## Admin role

Being an organization admin is the MAS `admin` flag. All three routes require a caller with the flag (403 otherwise),
take no body, and are audited as `people.promote`, `people.demote` and `org.access`, with `actor` and `target`; the
access lists are never audited. A MAS failure is 502 `{ error: 'admin_unavailable' }`.

| Route | Result |
|---|---|
| `PUT /v1/people/:userId/admin` | 200 `{ userId, admin: true }`, idempotent; 400 `bad_target` (malformed, another server, `system`, the custody account); 409 `{ reason: 'is_agent', userId, kind: 'agent' }` for an `a-` account, before any read; 404 `not_found`; 409 `{ reason: 'not_member', userId }` for a deactivated or locked account, or one without a live `kind: member` record in `#all` (a guest, a tombstone, a legacy `{}`) |
| `DELETE /v1/people/:userId/admin` | 200 `{ userId, admin: false }`, idempotent, without reading `#all`; 400 `bad_target`; 404 `not_found`; 409 `{ reason: 'last_admin', userId }` when the target is the only active admin |
| `GET /v1/org/access` | 200 `{ admins, withoutAccess }`, sorted user ids |

`admins` are the active accounts with the flag. `withoutAccess` are the active accounts, except `system` and the
custody account, with no app session: for a person, no active OAuth2 or compat session (a MAS browser session is only
the login page); for an agent, no active personal session acting as it. The lists are read in bulk, 1000 rows per
page. The service does not filter by `#all`: the client joins the sets to its list of people.

**The last-admin guard.** MAS has no guard and no conditional write, so one in-process lock serializes demotion,
promotion and person removal, from the caller check to the write; demotion and removal recount the active admins
inside it. The guard holds only with a single `org` process.

**Recovery.** `node --experimental-strip-types src/cli.ts promote-admin <email>` applies the promotion rules without a
caller: it finds the account by email and promotes it if it is an active, live member. It prints
`<username>: promoted` or `<username>: already an admin`; a refusal is one line on stderr (`no account for this
email`, `not a member`, `deactivated or locked`, `agent`, `reserved account`) and a non-zero exit. It is audited as
`people.promote` with `actor: "deploy.sh"`. In production, `./deploy.sh promote-admin EMAIL` runs it in the container.

## Agents

`POST /v1/agents`, `PATCH /v1/agents/:userId`, `DELETE /v1/agents/:userId` and
`POST /v1/agents/:userId/reissue` follow the same regime as people: the caller comes only from the
token, `:userId` is the URL-encoded Matrix user id of the target, and every call is audited with
`actor` and `target`, never the token. The token of a new or reissued agent is returned once, in
the 201, and never stored.

`infra/dev-stack/` runs it integrated with the rest of the stack.
