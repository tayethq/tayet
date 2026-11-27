#!/usr/bin/env bash
#
# restore-proof.sh — proof of `deploy.sh backup` and `deploy.sh restore` with real content, no manual step
# (PLANO-RELEASE-PUBLICA, backup and restore slice, fork B4). Built on test/local-install.sh --keep: the
# same assembled public tree, domain empresa.test, project tayet-local, ports 28008/28080/28443.
#
#   bash infra/deploy/test/restore-proof.sh                 # new server: the loss is down -v
#   bash infra/deploy/test/restore-proof.sh --same-server   # same server: the volumes stay (R2)
#   bash infra/deploy/test/restore-proof.sh --format-1      # the backup turned into format 1 (no orgdata)
#
# Run by hand in the main checkout (the stack does not come up in a worktree), detached at the commit to
# prove. Not in CI. Same prerequisites as local-install.sh.
#
#   1. local-install.sh --keep: assemble, secrets, build, up, check, first sign-in
#   2. sign in, create a private channel, send M1 and a file (restore-proof.mjs PHASE=seed)
#   3. a new access, before the backup, reads M1 and downloads the file: the custody deposit and the
#      upload exist before the copy
#   4. ./deploy.sh backup into a temporary directory outside the tree; each half copied to its own
#      destination with the runbook's schedule recipe (local directories here), the backup removed;
#      --format-1: the copies turned into a 'tayet-backup 1' backup (orgdata.tgz out, data/ re-signed with
#      the key of the keys half), as a release older than the org service would have written it
#   4b. observation set-up: a new access made after the backup (profile B), then every session of the
#      admin ended on the server (mas-cli manage kill-sessions)
#   4c. --same-server only: M3 sent after the backup, so the databases and agentdata are ahead of it
#   5. new server: total loss, down -v of tayet-local and secrets/ moved aside; --same-server: ./deploy.sh
#      down and secrets/ moved aside, every volume kept
#   6. ./deploy.sh restore — orgdata holds the org audit of the backup, or is empty with --format-1 —
#      then up (it must show the F8 lines) and check, both with status 0
#   7. in a new access: (i) sign-in, (ii) M1 reads, (iii) the file downloads with the same sha256,
#      (iv) M2 is sent and another new access reads it; --same-server also: M3 is gone. Then what profiles
#      A (step 3, before the backup, its session ended in 4b) and B (step 4b, after it) show — observations
#   8. green, or a failure before the backup: everything torn down and the temporary directory removed.
#      A failure from the backup on keeps the installation up as evidence and prints how to tear it down.
#
# Secrets: the admin password is read from its file by restore-proof.mjs and only goes into the form
# field. No trace, video or screenshot. Only the literal project tayet-local is ever torn down.
#
# BSD-safe: no sed -i, no \b, greps with explicit paths.
set -euo pipefail

SAME_SERVER=0
FORMAT_1=0
for arg in "$@"; do
  case "$arg" in
    --same-server) SAME_SERVER=1 ;;
    --format-1) FORMAT_1=1 ;;
    *) echo "usage: $0 [--same-server] [--format-1]" >&2; exit 2 ;;
  esac
done
KEEP_EVIDENCE=0   # set at the backup step: from there on, a failure keeps everything up

DOMAIN="empresa.test"
PROJECT="tayet-local"
HTTPS_PORT=28443
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
START=$SECONDS
STEP_START=$SECONDS
TIMES=()

step() {
  if [[ -n "${STEP_NAME:-}" ]]; then TIMES+=("$STEP_NAME: $((SECONDS - STEP_START)) s"); fi
  STEP_NAME="$*"; STEP_START=$SECONDS
  echo; echo "══ $* (at $((SECONDS - START)) s)"
}
die() { echo "FAILED: $*" >&2; exit 1; }
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# Outside the assembled tree: the tree path, the file to attach and the backup.
WORK="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/restore-proof.XXXXXX")" && pwd -P)"
TREE=""

teardown_project() {
  [[ "$PROJECT" == "tayet-local" ]] || return 0
  local ids
  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")"
  if [[ -n "$ids" ]]; then docker rm -f $ids >/dev/null 2>&1 || true; fi
  ids="$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")"
  if [[ -n "$ids" ]]; then docker volume rm $ids >/dev/null 2>&1 || true; fi
  ids="$(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT")"
  if [[ -n "$ids" ]]; then docker network rm $ids >/dev/null 2>&1 || true; fi
}

cleanup() {
  local rc=$?
  if [[ "$rc" != 0 && "$KEEP_EVIDENCE" == 1 ]]; then
    TIMES+=("$STEP_NAME: $((SECONDS - STEP_START)) s")
    echo
    echo "step times:"
    printf '  %s\n' "${TIMES[@]}"
    echo "total: $((SECONDS - START)) s — FAILED (exit $rc). Installation KEPT as evidence:"
    echo "  tree: $TREE"
    echo "  work: $WORK (backup copies, logs, browser profiles)"
    echo "  tear down by hand:"
    echo "    docker compose -p $PROJECT --env-file $TREE/infra/deploy/secrets/deployment.env -f $TREE/infra/deploy/compose.yaml -f $TREE/infra/deploy/test/compose.local.yaml down -v --remove-orphans"
    echo "    rm -rf '$TREE' '$WORK'"
    exit "$rc"
  fi
  step "8. teardown"
  teardown_project
  echo "containers: $(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" | wc -l | tr -d ' ')," \
    "volumes: $(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" | wc -l | tr -d ' ')"
  if [[ -n "$TREE" && -d "$TREE" ]]; then rm -rf "$TREE"; fi
  rm -rf "$WORK"
  TIMES+=("$STEP_NAME: $((SECONDS - STEP_START)) s")
  echo
  echo "step times:"
  printf '  %s\n' "${TIMES[@]}"
  echo "total: $((SECONDS - START)) s — $([[ "$rc" == 0 ]] && echo PASSED || echo "FAILED (exit $rc)")"
  exit "$rc"
}
trap cleanup EXIT

# ── 1. installation ───────────────────────────────────────────────────────────────────────
step "1. local-install.sh --keep"
LOCAL_INSTALL_TREE_FILE="$WORK/tree" bash "$TEST_DIR/local-install.sh" --keep || die "local-install.sh exited $?."
TREE="$(cat "$WORK/tree")"
DEPLOY="$TREE/infra/deploy"
[[ -x "$DEPLOY/deploy.sh" ]] || die "no deploy.sh in $TREE."
cd "$DEPLOY"
export TAYET_COMPOSE_OVERRIDE="$DEPLOY/test/compose.local.yaml"
DC=(docker compose -p "$PROJECT" --env-file secrets/deployment.env -f compose.yaml -f "$TAYET_COMPOSE_OVERRIDE")

TS="$(date +%s)"
FILE="$WORK/anexo-$TS.bin"
head -c 65536 /dev/urandom > "$FILE"
export TREE DOMAIN HTTPS_PORT FILE
export ADMIN_EMAIL="admin@$DOMAIN"
export PASSWORD_FILE="$DEPLOY/secrets/bootstrap-admin.password"
export CHANNEL="backup-$TS"
export M1="M1 before the backup $TS"
export M2="M2 after the restore $TS"
FILE_SHA256="$(sha "$FILE")"
export FILE_SHA256
export PROFILE_A="$WORK/profile-a" PROFILE_B="$WORK/profile-b"
browser() { PHASE="$1" node "$TEST_DIR/restore-proof.mjs" || die "browser phase $1."; }

# ── 2. content ────────────────────────────────────────────────────────────────────────────
step "2. private channel, M1 and a file"
browser seed

# ── 3. new access before the backup ───────────────────────────────────────────────────────
step "3. new access before the backup reads M1 and downloads the file"
browser before

# ── 4. backup ─────────────────────────────────────────────────────────────────────────────
step "4. ./deploy.sh backup"
KEEP_EVIDENCE=1
./deploy.sh backup "$WORK/backup" || die "backup exited $?."
BK="$(find "$WORK/backup" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*T[0-9]*Z')"
[[ -n "$BK" && "$(printf '%s\n' "$BK" | wc -l | tr -d ' ')" == 1 ]] || die "expected one backup directory in $WORK/backup."
echo "modes: $(ls -ld "$BK" | cut -c1-10) <UTC>, $(ls -ld "$BK/keys" | cut -c1-10) keys, $(ls -ld "$BK/data" | cut -c1-10) data"
echo "keys/MANIFEST and data/MANIFEST:"
sed -e 's|^|  |' "$BK/keys/MANIFEST" "$BK/data/MANIFEST"
members="$(tar tzf "$BK/keys/secrets.tgz")"
if grep -q -e '^secrets/backups' -e '^secrets/last-backup' <<<"$members"; then
  die "secrets.tgz holds secrets/backups or secrets/last-backup."
fi
./deploy.sh check > "$WORK/check-before.log" 2>&1 || { cat "$WORK/check-before.log"; die "check after the backup exited non-zero."; }
grep -E 'Latest \./deploy\.sh backup' "$WORK/check-before.log" || die "check does not show the backup."
# The runbook's schedule recipe, with local directories for the two destinations: the latest backup by
# name, each half to its own place, the server copy removed. The restore below reads the copies.
B=$(ls -d "$WORK"/backup/*Z | tail -n 1)
mkdir -p "$WORK/dest-keys" "$WORK/dest-data"
rsync -a "$B/keys/" "$WORK/dest-keys/${B##*/}/"
rsync -a "$B/data/" "$WORK/dest-data/${B##*/}/"
rm -rf "$B"
KEYS="$WORK/dest-keys/${BK##*/}"
DATA="$WORK/dest-data/${BK##*/}"
echo "copied: $KEYS, $DATA; backup directory removed: $([[ -e "$BK" ]] && echo no || echo yes)"
grep -q '^file orgdata.tgz ' "$DATA/MANIFEST" || die "data/MANIFEST does not list orgdata.tgz."
ORG_AUDIT_LINES="$(tar xzOf "$DATA/orgdata.tgz" ./audit.jsonl 2>/dev/null | grep -c . || true)"
echo "orgdata.tgz: audit.jsonl with $ORG_AUDIT_LINES line(s)"
[[ "$ORG_AUDIT_LINES" -gt 0 ]] || die "orgdata.tgz holds no org audit (the sign-ins read the caller's role from the org service)."
if [[ "$FORMAT_1" == 1 ]]; then
  # What a release older than the org service wrote: no orgdata.tgz, format 1 in both manifests, the data
  # half signed with the key that travels in the keys half (HMAC-SHA256; the key on openssl's command
  # line is test-only, in this throwaway work directory).
  rm -f "$DATA/orgdata.tgz"
  awk 'NR == 1 { print "tayet-backup 1"; next } $1 == "file" && $2 == "orgdata.tgz" { next } { print }' \
    "$DATA/MANIFEST" > "$DATA/MANIFEST.new" && mv "$DATA/MANIFEST.new" "$DATA/MANIFEST"
  awk 'NR == 1 { print "tayet-backup 1"; next } { print }' "$KEYS/MANIFEST" > "$KEYS/MANIFEST.new" && mv "$KEYS/MANIFEST.new" "$KEYS/MANIFEST"
  tar xzOf "$KEYS/secrets.tgz" secrets/backup-manifest.key > "$WORK/format-1.key"
  openssl dgst -sha256 -mac HMAC -macopt "hexkey:$(cat "$WORK/format-1.key")" "$DATA/MANIFEST" | awk '{ print $NF }' \
    > "$DATA/MANIFEST.sig"
  rm -f "$WORK/format-1.key"
  echo "turned into format 1:"
  sed -e 's|^|  |' "$KEYS/MANIFEST" "$DATA/MANIFEST"
fi

step "4b. observation set-up: access after the backup, then the admin's sessions ended"
browser post-backup
"${DC[@]}" exec -T mas mas-cli --config /config/config.yaml --config /config/secrets.yaml manage kill-sessions admin > /dev/null \
  || die "kill-sessions admin."
echo "sessions of admin ended on the server (profiles A and B, and the earlier accesses)"

if [[ "$SAME_SERVER" == 1 ]]; then
  step "4c. M3 after the backup (databases and agentdata ahead of it)"
  export M3="M3 after the backup $TS"
  browser m3
fi

# ── 5. loss ───────────────────────────────────────────────────────────────────────────────
[[ "$PROJECT" == "tayet-local" ]] || die "refusing to tear down project '$PROJECT'."
if [[ "$SAME_SERVER" == 1 ]]; then
  step "5. same-server loss: ./deploy.sh down and secrets/ moved aside, volumes kept"
  ./deploy.sh down
  mv secrets "$WORK/secrets.lost"
  for v in pgdata synapsedata escrowdata orgdata agentdata; do
    docker volume inspect "${PROJECT}_$v" >/dev/null 2>&1 || die "volume ${PROJECT}_$v missing after down."
  done
else
  step "5. total loss: down -v and secrets/ moved aside"
  "${DC[@]}" down -v --remove-orphans
  mv secrets "$WORK/secrets.lost"
  [[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")" ]] || die "volumes of $PROJECT survived down -v."
fi
echo "containers: $(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" | wc -l | tr -d ' ')," \
  "volumes: $(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" | wc -l | tr -d ' '), secrets/: $([[ -e secrets ]] && echo present || echo absent)"
export PASSWORD_FILE="$DEPLOY/secrets/bootstrap-admin.password"

# ── 6. restore, up, check ─────────────────────────────────────────────────────────────────
step "6a. ./deploy.sh restore"
./deploy.sh restore "$KEYS" "$DATA" > "$WORK/restore.log" 2>&1 || { cat "$WORK/restore.log"; die "restore exited $?."; }
cat "$WORK/restore.log"
# The org audit in the volume, read before up (the next sign-in appends to it).
org_lines="$(docker run --rm -v "${PROJECT}_orgdata:/data:ro" "$(sed -n 's|^[[:space:]]*image:[[:space:]]*\(node@sha256:[0-9a-f]\{64\}\).*|\1|p' compose.yaml | head -n 1)" \
  sh -c 'if [ -f /data/audit.jsonl ]; then grep -c . /data/audit.jsonl; else echo 0; fi; find /data -mindepth 1 | wc -l')"
read -r ORG_LINES_AFTER ORG_ENTRIES_AFTER <<<"$(printf '%s\n' "$org_lines" | paste -sd ' ' -)"
if [[ "$FORMAT_1" == 1 ]]; then
  grep -q "volume ${PROJECT}_orgdata emptied" "$WORK/restore.log" || die "restore of a format 1 backup did not say it emptied orgdata."
  [[ "$ORG_ENTRIES_AFTER" == 0 ]] || die "orgdata is not empty after restoring a format 1 backup ($ORG_ENTRIES_AFTER entries)."
  echo "assert: format 1 restored, orgdata empty"
else
  [[ "$ORG_LINES_AFTER" == "$ORG_AUDIT_LINES" ]] || die "orgdata audit has $ORG_LINES_AFTER line(s) after the restore, the backup had $ORG_AUDIT_LINES."
  echo "assert: orgdata restored, audit.jsonl with the backup's $ORG_AUDIT_LINES line(s)"
fi
step "6b. ./deploy.sh up"
./deploy.sh up > "$WORK/up.log" 2>&1 || { cat "$WORK/up.log"; die "up after the restore exited non-zero."; }
grep -E 'F8|cofre token|Custody agent|Production stack up' "$WORK/up.log" || true
grep -q -- '— F8: stop → kill-sessions → mint → up.' "$WORK/up.log" && grep -q 'cofre token minted' "$WORK/up.log" \
  || die "up after the restore did not take the F8 path."
echo "assert: up took the F8 path (new cofre identity)"
step "6c. ./deploy.sh check"
./deploy.sh check > "$WORK/check-after.log" 2>&1 || { cat "$WORK/check-after.log"; die "check after the restore exited non-zero."; }
echo "check: exit 0"
grep -E '✅|❌|WARNING' "$WORK/check-after.log" || true

# ── 7. the four assertions ────────────────────────────────────────────────────────────────
step "7. assertions in new accesses"
browser after

echo
echo "Restore proof PASSED ($([[ "$SAME_SERVER" == 1 ]] && echo same server || echo new server)$([[ "$FORMAT_1" == 1 ]] && echo ", format 1")): sign-in, M1 decrypted, file sha256 equal, M2 custodied after the restore$([[ "$SAME_SERVER" == 1 ]] && echo ", M3 gone")."
