**English** · [Português (Brasil)](SELF-HOSTING.pt-BR.md)

# Self-hosting Tayet

This guide takes one server from nothing to a running Tayet for your organization, and then covers
backup, restore and updates. It is written to be executed: the steps give the commands to run and,
for most of them, what you should see and a way to check it. You are done installing when
`./deploy.sh check` exits with status 0.

Steps marked **[human]** need a person: choosing the domain, creating DNS records, creating the
Google OAuth client, the first sign-in and the first invitation. Everything else can be run by an
operator or by a coding agent with a shell on the server.

Two rules for whoever runs the commands, person or agent:

- `./deploy.sh secrets` runs **once** per deployment. It refuses to run again.
- Never delete `infra/deploy/secrets/`. It holds the organization key. Without it, the encrypted
  history of the whole organization cannot be read again.

## Before you start: limits of this version

- **The base domain is permanent.** It becomes part of every account. Changing it later is not supported.
- **People you invite sign in with a Google account.** There is no other sign-in provider for invited people in this version.
- **The first administrator signs in with a password** generated during installation.
- **No outgoing email.** Tayet does not send invitations; you pass the instructions to the person yourself.
- **No federation.** The server does not talk to other Matrix servers.
- **The product interface and the sign-in pages are in English and Brazilian Portuguese.**
- **Tested with Chromium only.** Other browsers are untested.
- **One server, one Compose stack.** There is no high-availability setup.

## 1. Requirements

A Linux server with a public IP address and ports 80 and 443 reachable from the internet. TLS
certificates are issued automatically.

On the server:

- `git`
- Docker Engine with the Compose plugin
- `htpasswd` (Debian/Ubuntu: `apt-get install apache2-utils`)
- Node.js 22 or newer, with `npm` (the web client is built on the server)
- `openssl`, `curl`, `sha256sum`

Check:

```bash
docker compose version
htpasswd -nbBC 12 "" test | cut -d: -f2 | cut -c1-4
node --version
openssl version
```

Expected: a Compose version line, `$2y$`, `v22` or higher, an OpenSSL version line.

## 2. Choose the base domain **[human]**

Pick the domain Tayet will live under. It can be a domain you own (`example.com`) or a subdomain
dedicated to Tayet (`tayet.example.com`). If the domain already serves your website, use a
dedicated subdomain.

Tayet answers on five hostnames derived from it:

| Host | What it serves |
|---|---|
| `<domain>` | Server discovery (`/.well-known/matrix/*`) |
| `chat.<domain>` | The web app. This is the address people use. |
| `matrix.<domain>` | The chat server |
| `auth.<domain>` | Sign-in |
| `login.<domain>` | Sign-in for the first administrator |

This choice cannot be changed after step 7.

## 3. Create the DNS records **[human]**

Create five A (or AAAA) records pointing to the server: the base domain and the four subdomains
above.

Check, with your domain in `D`:

```bash
D=example.com
for h in "$D" "chat.$D" "matrix.$D" "auth.$D" "login.$D"; do
  printf '%s -> ' "$h"; getent hosts "$h" | awk '{print $1}'
done
```

Expected: five lines, each ending with the server's IP address.

## 4. Create the Google OAuth client **[human]**

In the Google Cloud console:

1. Create a project for this deployment. The consent screen is per project, so do not reuse the project of another app.
2. Google Auth Platform: set the app name and support email, audience **External**.
3. Branding: add your domain as an authorized domain. Do not upload a logo: a logo triggers Google's verification process.
4. Clients → Create client, type **Web application**. Authorized redirect URI, with your base domain:
   `https://auth.<domain>/upstream/callback/01M6EV4GP9QK3T7YH2ZD8NXGG1`
5. Data access: only `openid`, `userinfo.email` and `userinfo.profile`. Any other scope triggers verification.
6. Audience → **Publish app** (In production). In Testing mode only listed test users can sign in, and they have to sign in again every 7 days.

Keep the client ID and the client secret for step 6.

## 5. Get the code

```bash
git clone https://github.com/tayethq/tayet.git
cd tayet
git tag --list 'v*'
git checkout <tag>
cd infra/deploy
```

Use the newest tag listed. All commands from here on run in `infra/deploy`.

## 6. Write the Google credentials

```bash
mkdir -p secrets
( umask 077; printf 'GOOGLE_CLIENT_ID=%s\nGOOGLE_CLIENT_SECRET=%s\n' '<client id>' '<client secret>' > secrets/google-oauth.env )
```

Check:

```bash
grep -c '^GOOGLE_CLIENT_' secrets/google-oauth.env
```

Expected: `2`.

## 7. Generate the secrets (once)

Set the base domain and the first administrator, then generate:

```bash
export TAYET_DOMAIN=example.com
export BOOTSTRAP_ADMIN_USERNAME=ana BOOTSTRAP_ADMIN_EMAIL=ana@example.com
export BOOTSTRAP_ADMIN_FULL_NAME="Ana Lima" BOOTSTRAP_ADMIN_JOB_TITLE=""
./deploy.sh secrets
```

The username takes lowercase letters, digits and `. _ = -`. The job title may be empty but must be
set.

Expected: a line starting with `Secrets generated in`, followed by a backup reminder.

From this point the base domain is fixed, and `secrets/` must never be deleted.

## 8. Build and start

```bash
./deploy.sh build
./deploy.sh up
./deploy.sh check
```

`up` prints one line per step. The last ones are:

```
Custody agent (cofre) up ✅
Sessions of system revoked ✅
```

`check` must exit with status 0. Its output includes:

```
Renders up to date ✅
Synapse config = host render ✅
MAS config = render ✅
Org channel #all: OK ✅
Escrow /healthz: OK ✅
cofre token: whoami OK ✅
Encrypted rooms without the cofre: none ✅
```

In the first minute after the first `up`, `check` may also print
`WARNING: agent has no checkpoint (never synced healthy in this store).` Run it again.

Check from outside:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "https://chat.$TAYET_DOMAIN/"
curl -sS "https://$TAYET_DOMAIN/.well-known/matrix/client"
```

Expected: `200`, then a JSON object whose `base_url` is `https://matrix.<domain>`.

## 9. First sign-in **[human]**

The interface follows your browser's language, English or Brazilian Portuguese. The labels in steps 9 and 10 are the English ones.

1. Open `https://chat.<domain>` and choose **Continue with your account**.
2. On the sign-in page choose **Continue with your company account**.
3. Email: the value of `BOOTSTRAP_ADMIN_EMAIL`. Password: the content of `secrets/bootstrap-admin.password`.

You land in the app, in the channel `#all`. You are the administrator of the organization.

## 10. First invitation **[human]**

1. Open **Your account**, then **Organization**, then **People**, and choose **Invite person**.
2. Fill in the person's name and the email of their Google account, and choose the type: **Member** joins `#all`; **Guest** sees only the channels you add.
3. When the dialog shows **Invite ready**, choose **Copy instructions** and send them to the person yourself. Tayet does not send email.
4. The person opens `https://chat.<domain>` and chooses **Continue with Google**, with that Google account.

## 11. Back up

Four things hold the state of your organization. Back up all four.

| What | Holds | If lost |
|---|---|---|
| `secrets/` | The organization key and every generated secret | Encrypted history unreadable, for everyone |
| Volume `escrowdata` | Key deposits | People cannot recover history on a new device |
| Postgres (databases `synapse` and `mas`) | Accounts, channels, messages | Everything |
| Volume `synapsedata` | Uploaded files and the server signing key | Attachments |

Rules:

- **Keep the copies of `secrets/` and `escrowdata` in different places.** Together they decrypt everything the organization holds in custody. This is a requirement, not a suggestion.
- **Copy the backup off the server.** A backup on the same disk is not a backup.
- **Encrypting the server disk and the backup files is recommended.** The backup contains keys and, in the database, unencrypted channel messages. How to encrypt is your decision.
- The volume `agentdata` is left out on purpose: restoring an old copy would break key custody. The TLS certificates are also left out: they are issued again.

Run, in `infra/deploy`, as a user that can run Docker:

```bash
P=$(sed -n 's/^TAYET_COMPOSE_PROJECT=//p' secrets/deployment.env); P=${P:-tayet}
DC="docker compose -p $P --env-file secrets/deployment.env -f compose.yaml"
IMG=$(sed -n 's/^AGENT_IMAGE="\(.*\)"$/\1/p' deploy.sh)
OUT=$HOME/tayet-backup/$(date -u +%Y%m%dT%H%M%SZ)
( umask 077; mkdir -p "$OUT" )
```

Database first, then the volumes, in this order:

```bash
for db in synapse mas; do
  $DC exec -T postgres pg_dump -U synapse -Fc "$db" > "$OUT/$db.dump"
done
for v in synapsedata escrowdata; do
  docker run --rm -v "${P}_$v:/data:ro" -v "$OUT:/out" "$IMG" \
    tar czf "/out/$v.tgz" --numeric-owner -C /data .
done
tar czf "$OUT/secrets.tgz" --exclude=secrets/backups secrets
ls -l "$OUT"
```

Expected: five files, none empty: `synapse.dump`, `mas.dump`, `synapsedata.tgz`, `escrowdata.tgz`,
`secrets.tgz`.

Then copy `secrets.tgz` to one place and `escrowdata.tgz` to a different one, copy the other three
files to either, and remove the directory from the server:

```bash
rm -rf "$OUT"
```

The stack can stay up during the backup. `./deploy.sh up` also dumps both databases into
`secrets/backups/` every time it runs and keeps the five most recent; those dumps are only as
recent as your last `up`.

Rehearse the restore once before you depend on it.

## 12. Restore

Use this on a new server, or on the same server after losing data. You need the five backup files
in one directory, the server prepared as in step 1, the DNS records pointing to it, and the same
release of the code that was running when the backup was made (step 5).

If `infra/deploy/secrets/` already exists, stop the stack and move it aside. Do not delete it.

```bash
./deploy.sh down
mv secrets secrets.before-restore
```

Restore the secrets and build:

```bash
IN=/path/to/backup
tar xzf "$IN/secrets.tgz"
P=$(sed -n 's/^TAYET_COMPOSE_PROJECT=//p' secrets/deployment.env); P=${P:-tayet}
DC="docker compose -p $P --env-file secrets/deployment.env -f compose.yaml"
IMG=$(sed -n 's/^AGENT_IMAGE="\(.*\)"$/\1/p' deploy.sh)
./deploy.sh build
```

Restore the databases:

```bash
$DC up -d --wait postgres
for db in synapse mas; do
  $DC exec -T postgres pg_restore -U synapse -d "$db" --clean --if-exists < "$IN/$db.dump"
done
```

Restore the two volumes:

```bash
$DC up --no-start synapse escrow
for v in synapsedata escrowdata; do
  docker run --rm -v "${P}_$v:/data" -v "$IN:/in:ro" "$IMG" \
    sh -c "find /data -mindepth 1 -delete && tar xzf /in/$v.tgz --numeric-owner -C /data"
done
```

Start and check:

```bash
./deploy.sh up
./deploy.sh check
```

During this `up` you will see:

```
Agent store missing with a live token (no identity marker) — F8: stop → kill-sessions → mint → up.
cofre token minted ✅
```

That is expected: the custody agent starts over with a new identity, and what it had already
deposited is in `escrowdata`.

`check` must exit with status 0. Then sign in and confirm that channels and messages are there.

What a restore does not bring back: anything written after the backup was taken.

## 13. Update

If `secrets/postgres.password` does not exist, your installation predates the per-installation
database password: run `./deploy.sh db-password` once, with the stack up, right after checking out
the new code and before `render`, `build` and `up`.

```bash
git fetch --tags
git checkout <tag>
./deploy.sh render
./deploy.sh build
./deploy.sh up
./deploy.sh check
```

Run `check` only after `up`: between `render` and `up` it reports configuration differences that
`up` then applies.

`render` shows what changed in the generated configuration. For `dex-config.yaml` it always shows a
changed `hash:` line; that is not a change. If it shows any other difference in that file, run the
restart command for `dex` that `render` prints.

`up` dumps both databases before applying anything.

## Where to go next

- Day-to-day operation, the custody agent, rollback and troubleshooting: [`infra/deploy/README.md`](infra/deploy/README.md).
- Reporting a vulnerability: [`SECURITY.md`](SECURITY.md).
