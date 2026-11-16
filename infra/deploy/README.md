# Tayet deployment: operations reference (`infra/deploy/`)

Installing, backing up and restoring a deployment are covered step by step in
[`SELF-HOSTING.md`](../../SELF-HOSTING.md), at the repository root. This file is the reference for
operating a deployment that is already running: what each command does, how changes reach a live
deployment, the custody agent, Postgres dumps and rollback.

All commands below run in `infra/deploy`. `<domain>` is the deployment's base domain (`TAYET_DOMAIN`)
and `<project>` its Compose project name (`TAYET_COMPOSE_PROJECT`, default `tayet`). When a command
here and a command printed by `deploy.sh` differ in the `-f` files, use the printed one: it carries
every Compose file the deployment uses.

## Topology

Caddy is the only public entry point (ports 80 and 443), issues the TLS certificates itself (ACME),
and routes by host:

| Host | Internal target | Role |
|---|---|---|
| `<domain>` | Caddy, static | `/.well-known/matrix/{server,client}` (ADR-023/046), plus an optional site |
| `chat.<domain>` | `client/dist` | The web app (static), plus `/escrow` same-origin → `escrow:8090` |
| `matrix.<domain>` | `synapse:8008` | Matrix homeserver |
| `auth.<domain>` | `mas:8080` | MAS (issuer and `public_base`); sign-in providers |
| `login.<domain>` | `dex:5556` | OIDC provider for the bootstrap admin (ADR-048) |

Who talks to whom (internal Compose network; no public port except Caddy's):

- `escrow` → `mas:8080/oauth2/introspect` (RFC 7662, ADR-017): introspection against the deployment's
  own MAS.
- `mas` → `synapse:8008` (auth delegation), `postgres:5432` (database `mas`) and `dex:5556` (token,
  JWKS and userinfo of the upstream provider; split horizon: the browser reaches Dex through
  `login.<domain>`, MAS reaches it server to server on the internal network).
- `synapse` → `postgres:5432` and `mas:8080` (delegation).
- `agent` → `synapse:8008` and `escrow:8090`.
- `caddy` → `synapse:8008`, `mas:8080`, `dex:5556`, `escrow:8090`.
- `synapse` publishes **only** `127.0.0.1:<TAYET_HS_PORT>` on the host: an operations loopback
  (`deploy.sh` seeds `#all` and runs its probes there). Public traffic enters through
  `matrix.<domain>`.

## Commands and deployment parameters

```bash
./deploy.sh secrets   # once: generates every secret in secrets/ (aborts if they already exist)
./deploy.sh render    # re-renders the three templates (synapse/mas/dex) from the live secrets
./deploy.sh build     # builds the web app into client/dist; agent dependencies into agent/node_modules
./deploy.sh up        # aborts on a pending render; pg_dump + migrate + MAS config sync, starts the stack,
                      # restarts MAS/Synapse/Caddy when their config changed, provisions the service
                      # accounts and the bootstrap admin, seeds #all; second phase: the custody agent
./deploy.sh down      # stops the stack, PRESERVING volumes
./deploy.sh check     # read-only: probes, renders up to date, Synapse and MAS config = render,
                      # base domain, #all, escrow, latest backup, custody agent
```

**Deployment parameters.** `TAYET_DOMAIN` is required by `secrets` and has no default (ADR-095).
`secrets` writes it once to `secrets/deployment.env`, and it never changes: every other command reads
it from there and aborts if the environment variable, the file and the rendered `server_name`
disagree.

Four more parameters can be set when `secrets` runs:

| Variable | Default | Meaning |
|---|---|---|
| `TAYET_COMPOSE_PROJECT` | `tayet` | Compose project name; volumes are `<project>_<volume>` |
| `TAYET_HS_PORT` | `8008` | Host loopback port of Synapse |
| `TAYET_HTTP_PORT` | `80` | Host port for HTTP |
| `TAYET_HTTPS_PORT` | `443` | Host port for HTTPS |

The ones present in the environment are written to `secrets/deployment.env` and follow the same rule
as the domain: they never change afterwards, and an environment value that differs from the
deployment's aborts the command without writing anything. The absent ones take the default, and no
line is written for them.

`TAYET_COMPOSE_OVERRIDE` names one extra Compose file, added last to every Compose call. It comes
only from the environment and is never written to `secrets/`. It is the hook of the local test
install.

## Identity

- **Invited people sign in with Google.** The MAS template has the Google provider (id
  `01M6EV4GP9QK3T7YH2ZD8NXGG1`). `render` and `secrets` require `secrets/google-oauth.env` with
  `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, from a Web OAuth client whose redirect URI is
  `https://auth.<domain>/upstream/callback/01M6EV4GP9QK3T7YH2ZD8NXGG1`. Registration is closed
  (`allowed_usernames: { literals: [] }`, ADR-083): new accounts are created only by an invitation
  (`POST /v1/people` on the escrow, see `escrow/README.md`).
- **The bootstrap admin signs in through Dex** at `login.<domain>` (ADR-048), with
  `BOOTSTRAP_ADMIN_EMAIL` and the password in `secrets/bootstrap-admin.password`. The Dex `userID` is
  derived from the username (`tayet-<username>-0001`). The account is created by `up` with that
  email and the `admin` flag; the first Dex sign-in links to it. An existing account is skipped.
- **`htpasswd` is a host prerequisite.** `deploy.sh` derives the bcrypt hash of the Dex passwords
  with `htpasswd -nbBC 12` (Debian/Ubuntu: `apt-get install apache2-utils`; macOS ships it). Dex
  accepts `$2y$` and `$2a$` hashes; this recipe emits `$2y$`.

`secrets/dex-users.yaml` and `secrets/directory.extra.tsv` are optional, validated by `render` when
they exist, and serve deployments that predate invitations.

## Deploying a change

**Rule: a change in `client/` needs `./deploy.sh build` before `up`.** `up` does not build the web
app: Caddy serves whatever `client/dist` is on the host. `up` warns when a file in `client/src` is
newer than `client/dist/index.html`, but only warns.

```bash
curl -s https://chat.<domain>/ | grep -o 'index-[A-Za-z0-9_-]*\.js'   # hash BEFORE
git fetch --tags && git checkout <tag>
./deploy.sh build      # if the change touched client/
./deploy.sh up
./deploy.sh check
curl -s https://chat.<domain>/ | grep -o 'index-[A-Za-z0-9_-]*\.js'   # hash AFTER
```

**Rule: `up` always recreates the escrow and the agent.** Both run from source through a bind mount
(`../../escrow`, `../../agent`), and `compose up -d` only recreates a container when the Compose
config changes; a code update does not change it. Without recreating, the process keeps running the
old code. So `up` runs `compose up -d --force-recreate escrow` in phase 1 and starts the agent with
`--force-recreate` in phase 2. Recreating with the stack up is safe: the escrow store only publishes
complete files (a blob is written to a temporary file and only then published), and the agent
flushes on SIGTERM within the `stop_grace_period`. The other services do not run from source: Caddy
serves the static `client/dist` (no restart needed), and the other bind mounts are configuration,
with their own restart path (next section; `up` restarts Caddy itself when the `Caddyfile` changes,
see the operation notes). `check` shows since when the escrow and the agent are up: earlier than the
last `up` means old code.

**Post-deploy check:** with a change in `client/`, the `index-*.js` hash **changes**. The same hash
after the deploy means the web app was not rebuilt (or the browser served a cached copy: check with
`curl`, not with the open tab). A change that touches a configuration template also follows the next
section.

## Propagating a template change

`./deploy.sh secrets` **aborts** on live secrets (regenerating the org key would orphan the E2E
history), so a new template does not change a live deployment by itself. `./deploy.sh render` closes
that gap for the **three** templates (`synapse/homeserver.yaml.tmpl`, `mas/config.yaml.tmpl`,
`dex/config.yaml.tmpl`): it re-renders them with the live secrets (the ones persisted in `secrets/`
and the four that only exist in the live render: `registration_shared_secret`,
`macaroon_secret_key`, `form_secret` and the MAS↔Synapse shared secret, extracted from it by
anchor), shows the diff live render → new render, and prints the restart command of each affected
service.

```bash
git fetch --tags && git checkout <tag>
./deploy.sh render     # diff on stdout (the record); a .bak of every overwritten file
docker compose -p <project> --env-file secrets/deployment.env -f compose.yaml restart <service named by render>
./deploy.sh check
```

`up` aborts before any dump or container while a render is pending, and between `render` and `up`
`check` fails on the config lines that `up` then applies. `up` restarts MAS and Synapse when their
config changed (`MAS: config changed — restarted ✅`, `Synapse: config changed — restarted ✅`); it
does not restart Dex.

Operation notes for `render`:

- **Built-in round trip:** unchanged template → new render byte-identical to the live one → nothing
  is written. Empty or ambiguous extraction, or an unknown placeholder in the template → abort
  without writing anything.
- **Cheap rollback:** every overwritten file leaves `secrets/rendered/<name>.bak` (one level only).
- **First `render` on a deployment that went through the old manual procedure** (ADR-052 knobs
  appended with `cat >>` at the end of `homeserver.yaml`): the diff is bigger than the template
  change, because the knobs leave the end of the file and return to their place in the template.
  Expected; apply it.
- **`dex-config.yaml` is always re-applied:** the bcrypt hash of the bootstrap admin is re-salted on
  every render (same password, validates the same). A diff only on the `hash:` line is not an
  effective change; restarting `dex` is harmless in that case.
- **Rendered directory:** `render` also produces `secrets/rendered/directory.tsv` (the versioned
  header + `secrets/directory.extra.tsv` + the bootstrap admin's line). That is the copy `up`
  syncs, together with the allowlist read from `secrets/rendered/dex-config.yaml`. Changed →
  `./deploy.sh up` (no container to restart).
- **Optional site:** `deploy.sh` adds `compose.site.yaml` (mount `../../site`) only when that
  directory exists; without it the apex answers the `.well-known` paths and 404 for the rest. With
  the overlay active, manual Compose commands need the same `-f compose.site.yaml` (`render` prints
  the full command).

**Zero drift:** a future `./deploy.sh secrets` (a new deployment) renders the same templates and
produces the same result; `render` exists only for a deployment that is **already running**.

## Custody agent

The agent (`cofre` account, ADR-057 dec. 5; operational form in ADR-069) is the structural
recipient of every encrypted room: it receives the session keys through the normal Megolm flow and
deposits them in the escrow. Recovering a new device (ADR-061) reads them from there. Without it, a
message sent while the recipient has no live device stays unreadable forever.

**What `deploy.sh` does:**

- `build` installs the agent's runtime dependencies (`npm ci --omit=dev`) **inside** the service's
  pinned image → `agent/node_modules`. Without them, `up` warns and does not start the agent.
- `up`, first thing: generates `secrets/agent.env` once (`AGENT_STORAGE_KEY`, 32 bytes base64, mode
  0600). Without that file **every** Compose command fails, so on a deployment that predates the
  agent, run `up` before `check`. A new install gets it from `secrets`.
- `up`, phase 2, after `#all` and the directory:
  - provisions `cofre`: a service account without sign-in, like `system`;
  - the `cofre` token: minted once into `secrets/agent-token.secret`, reused while whoami accepts it,
    minted again on 401, with a single re-mint on the device race (line `[m2-device-race]`);
  - F8 remediation when the store has the sentinel, or when the token is live and the store has no
    identity marker (below);
  - `compose up -d --force-recreate agent` (always recreated, see "Deploying a change").
  - The `up` trap revokes **only** the sessions of `system`; the `cofre` token survives `up`.

**First deploy of the agent** (or of any change that touches `agent/`):

```bash
./deploy.sh build      # web app + agent dependencies
./deploy.sh up         # generates agent.env, provisions cofre, mints the token, starts the agent
./deploy.sh check
```

**`check`** (read-only):

- container state and restart count;
- the `REMEDIATION_NEEDED` sentinel in the store;
- a store without the identity marker while the token is present (`WARNING: agent store has no
  identity marker and the cofre token is present — the next ./deploy.sh up remediates it (F8).`);
- age of the last checkpoint (the agent writes it every 10 s while sync is healthy; warning above
  60 s);
- whoami of the `cofre` token;
- **encrypted rooms with more than one `join` member where `cofre` is not `invite|join`**. An empty
  list is normal. A listed room means the invitation at creation failed (it is fail-open): it is the
  trigger of the retrofit ADR (ADR-069, re-evaluation triggers). Do not fix it by hand.

**Logs:** one JSON line per event (`evt`); never key material.

```bash
docker compose -p <project> --env-file secrets/deployment.env -f compose.yaml logs --tail=200 agent
docker compose -p <project> --env-file secrets/deployment.env -f compose.yaml logs --since 15m agent | grep session-deposited
```

| `evt` | Meaning |
|---|---|
| `whoami`, `identity`, `boot`, `started` | normal boot |
| `joined` | `cofre` joined a room (pending invitation accepted) |
| `room-key-received`, `session-deposited` | key received and deposited in the escrow (`addressedCount` = members addressed when the session was created, `cofre` included) |
| `session-skipped` | session received in the middle of the ratchet (before `cofre` joined) or from a dead room: outside coverage by design |
| `session-skipped` `reason: room-gone` | room purged or `cofre` out of it (`/context` 404/403, or room out of reach after sync): terminal skip, one per session and per restart (ADR-079) |
| `pending-sessions`, `deposit-retry`, `join-ratelimited`, `join-stalled` | delay: the agent retries by itself |
| `join-unconfirmed` | the server accepted the join and the SDK did not see the transition in 5 min: the room goes back to the slow cadence |
| `sync-state` | sync transition (`from` → `to`); `RECONNECTING`/`ERROR` without going back to `SYNCING` = blind agent |
| `join-skipped-sync` | join queue skipped with sync down (one per outage) |
| `tick-slow` | tick above 3 s (`tickMs`, `exportMs`, `sessions`): investigate if it repeats |
| `room-dead`, `invite-rejected` | room without any member: the invitation is dropped |
| `identity-reset`, `remediation-needed`, `fatal` | **action**: see F8 below |

**F8: the agent stopped with the sentinel.** Symptom: `check` reports the sentinel, the container
restarts in a loop, the log shows `remediation-needed`. The agent does **not** remediate itself: a
local wipe with the live token produces a zombie device. The remediation lives in `up`:

```bash
./deploy.sh up         # detects the sentinel: stop → kill-sessions cofre → mint → store wipe → start
./deploy.sh check      # no sentinel, whoami OK, fresh checkpoint
```

**F8: store lost with a live token.** The volume `<project>_agentdata` is gone, or it has no
`/data/identity.json` (a restore, a removed volume). Started on the same token, the agent would
create a fresh store on the same device: the server accepts the new device keys and refuses the new
one-time keys with 400, and `check` stays green while no session key arrives (ADR-069 dec. 5: losing
the volume is F8). `up` treats it as F8: `Agent store missing with a live token (no identity marker)
— F8: stop → kill-sessions → mint → up.`, then `cofre token minted ✅`, and the store wipe only when
the volume exists. A failure to read the store aborts `up` without touching the token
(`ERROR: could not read the agent store (…) — token kept, up aborted (run it again).`).

Database check after either F8: `cofre` is back to **one** device (the new one). `kill-sessions`
ends the old session and MAS deletes the device through its device sync, which is asynchronous:
repeat until one is left. Never an admin `DELETE` (ADR-054 invariant).

```bash
docker compose -p <project> --env-file secrets/deployment.env -f compose.yaml exec -T postgres \
  psql -U synapse -d synapse -tAc "SELECT device_id FROM devices WHERE user_id='@cofre:<domain>'"
```

Accepted window: sessions created between `kill-sessions` and the boot of the new device do not
reach `cofre`.

**Reaper (ADR-062 D3):** with the agent stopped for 30 days, MAS ends the `cofre` session and the
device goes away. `check` reports whoami 401; the next `up` mints again (new device, empty store).
Messages sent in that window are not in custody.

**Reboot:** `restart: unless-stopped` brings the agent back. With the sentinel, it enters a noisy
crash loop until the next `up`.

**Backup policy (ADR-069 dec. 5 and 6):** `secrets/` and the volume `escrowdata` go to **separate**
destinations: together, the org key and the deposits (4S **and** sessions, `escrowdata/sessions/`)
decrypt the whole custody. `secrets/` holds `agent.env` (the `AGENT_STORAGE_KEY`) and
`agent-token.secret` (the `cofre` token), so a backup of the whole directory carries them. The
volume `agentdata` stays **out** of the backup on purpose: the agent's store is not a source of
truth (what matters is deposited in `escrowdata`), and restoring an old store brings back the zombie
device. Losing the volume → F8 above: new device, coverage resumes.

**Rollback (ADR-069 dec. 11):**

- **Short:** `docker compose -p <project> --env-file secrets/deployment.env -f compose.yaml stop agent`.
  The next `./deploy.sh up` starts it again (`up` starts everything).
- **Durable (opt-out):** `touch secrets/agent.disabled`. With the file present, `up` does not start
  the agent and stops it if it is up; `check` warns that it is disabled. To go back:
  `rm secrets/agent.disabled && ./deploy.sh up`.
- In both cases, **keep the volume `agentdata`** (no `docker volume rm`). What was already deposited
  is in `escrowdata` and does not depend on the agent. Rooms keep encrypting to the `cofre` device;
  when it comes back, the agent drains its queue and catches up to the last checkpoint. Stopped for
  more than 30 days, the reaper above applies.

## Postgres dumps and rollback

Every `./deploy.sh up` runs `pg_dump -Fc` of the two databases (`synapse` and `mas`) **after**
starting Postgres and **before** `mas-cli database migrate`: the MAS migration is forward-only. It
runs even with no pending migration. A failure in any dump aborts `up` before migrating.

- **Destination:** `secrets/backups/<UTC timestamp>/{synapse,mas}.dump` (inside `secrets/`, out of
  git with the rest). Retention: the **5** most recent; `up` deletes older ones.
- **Logical, not the volume:** it covers the content of the databases, not the `pgdata` directory.
- `./deploy.sh check` shows the latest dump (timestamp and sizes).

**Restoring a dump** is an incident operation, with the stack stopped (only Postgres up, nothing
writing to the databases). Per database, from the same backup directory. If the reason is going back
from a MAS upgrade, also revert the image digest pins before `up`.

```bash
B=secrets/backups/<timestamp>
docker compose -p <project> --env-file secrets/deployment.env -f compose.yaml stop          # whole stack stopped
docker compose -p <project> --env-file secrets/deployment.env -f compose.yaml up -d --wait postgres
for db in synapse mas; do
  docker compose -p <project> --env-file secrets/deployment.env -f compose.yaml exec -T postgres \
    pg_restore -U synapse -d "$db" --clean --if-exists < "$B/$db.dump"
done
./deploy.sh up     # takes a new dump (of the restored state) before migrating
./deploy.sh check
```

### Synapse upgrade and rollback

This restore does not serve to go back from a **Synapse** upgrade; use the procedure below.

**Upgrade**, with the new release checked out:

```bash
docker compose -p <project> --env-file secrets/deployment.env -f compose.yaml pull synapse   # optional: shortens the downtime
./deploy.sh render   # always: the diff on stdout is the record
./deploy.sh up       # dumps synapse and mas into secrets/backups/<UTC>/ BEFORE the new Synapse starts
```

`up` aborts before the dump and before any container if a render is pending (template changed and
not rendered). Without the `render`, Synapse would start with the live `homeserver.yaml` and miss
settings the new template adds (for example `default_room_version`).

1. **Note the `<UTC>`** that `up` prints (`Postgres backup: …`) and copy that directory off the host
   before going on.
2. **Check:**
   - `./deploy.sh check`: Synapse probe, org channel and escrow OK; `Renders up to date ✅`;
     `Synapse config = host render ✅`; latest backup = `<UTC>`; agent OK. It fails if a render is
     pending or if Synapse reads a config other than the host's.
   - `curl -s 127.0.0.1:<TAYET_HS_PORT>/_matrix/federation/v1/version` shows the new version.
   - `docker compose -p <project> --env-file secrets/deployment.env -f compose.yaml logs synapse | grep -E "Schema now up to date| - ERROR - "`:
     the schema line and no `ERROR`; later, `No more background updates to do`.
3. **Rollback criterion:** Synapse not becoming healthy, a migration `ERROR` in the log, or sign-in
   or sync broken in the smoke test. Decide before reopening use: everything written after `<UTC>` is
   lost in the restore.

**Rollback** = database `synapse` recreated + restore of the `<UTC>` dump + previous release. A
`pg_restore --clean` does not work here: it only drops what is in the dump, and the tables added by
the new version stay in the database holding foreign keys (`rooms` is not dropped and not
restored), which leaves the database inconsistent and breaks the next upgrade
(`relation "profile_updates_sequence" already exists`). The `mas` database does not change in a
Synapse upgrade and is not restored. Rolling back only the image, without the restore, may start but
is not the procedure: background updates of the new version can change the schema in ways the old
version does not expect.

After checking out the previous release, run `render` too: `up` aborts if the reverted template
differs from the live render. The final check confirms the renders and the config Synapse reads.

```bash
B=secrets/backups/<UTC>
git checkout <previous tag>
./deploy.sh render
docker compose -p <project> --env-file secrets/deployment.env -f compose.yaml stop
docker compose -p <project> --env-file secrets/deployment.env -f compose.yaml up -d --wait postgres
docker compose -p <project> --env-file secrets/deployment.env -f compose.yaml exec -T postgres psql -U synapse -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE synapse" \
  -c "CREATE DATABASE synapse OWNER synapse ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0"
docker compose -p <project> --env-file secrets/deployment.env -f compose.yaml exec -T postgres \
  pg_restore -U synapse -d synapse --exit-on-error < "$B/synapse.dump"
./deploy.sh up
./deploy.sh check   # renders up to date + Synapse config = host render; fails otherwise
```

## Deliberate absences and operation notes

- **No `reset` and no `down -v`.** A production deployment has no disposable world. `./deploy.sh
  down` preserves volumes; removing a volume is a manual, deliberate act, never a script.
- **No federation.** `federation_domain_whitelist: []`. The federable identity is prepared (the
  `.well-known` paths are served), but no external server talks to the deployment.
- **`secrets/` is entirely out of git** (`.gitignore`). `./deploy.sh secrets` runs `mkdir -p`; there
  is no `.gitkeep`.
- **Pinned digests** for every image (postgres, synapse, mas, dex, node, caddy).
- **MAS with two `--config`:** the main rendered config + `secrets/mas-secrets.yaml` (signing keys
  from `mas-cli config generate`), merged at boot.
- **A host reboot brings the stack back** by itself (`restart: unless-stopped`); after a reboot, run
  `./deploy.sh check`.
- **Compression:** Caddy compresses (`encode zstd gzip`) on `chat.`, `auth.` and `matrix.`; the apex
  and `login.` are not compressed.
- **A `Caddyfile` change goes through `up`:** Compose mounts the file read-only as a single-file
  bind, a code update replaces the inode, and `up -d` does not recreate Caddy (the Compose config did
  not change). After the phase 1 `up -d`, `up` compares the sha256 of the host `Caddyfile` with that
  of `/etc/caddy/Caddyfile` read inside the container; when they differ → `caddy validate` of the new
  file with the container's image and, if valid, `restart caddy` (`Caddy: config changed —
  restarted ✅`). Invalid → `up` exits 1 **without** restarting: Caddy keeps serving the old config;
  fix the file and run `up` again. There is no manual `restart caddy`.

## Local test install

[`test/local-install.sh`](test/local-install.sh) assembles the public tree, starts the stack on
`empresa.test` (project `tayet-local`, ports 28008, 28080 and 28443) with Caddy's local
certificates, checks the five hosts with `curl`, signs in once in the browser as the bootstrap admin
and tears everything down (`--keep` keeps it). It is run by hand, not from a worktree, and is not
part of CI. It runs only from the development repository: it calls
`.github/scripts/assemble-public-tree.sh`, which is not part of the public tree.
