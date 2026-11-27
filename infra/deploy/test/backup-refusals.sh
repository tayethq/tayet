#!/usr/bin/env bash
#
# backup-refusals.sh — refusals of `deploy.sh backup` and `deploy.sh restore`, without Docker
# (PLANO-RELEASE-PUBLICA, backup and restore slice). Called by render-identity.sh (the CI job does not
# change), not on its own:
#
#   bash backup-refusals.sh <pristine copy> <work dir>
#
# <pristine copy> is render-identity.sh's throwaway copy before any render: infra/deploy/ and infra/mas/
# with the fixture as secrets/. Each case copies it to its own directory, changes only that copy, and
# compares the tree of the copy (paths + sha256 of every file, the backup directories included) before
# and after. `docker` is a stub on PATH that records its calls: a refusal must happen before any of them,
# except in the case about running containers, where only `docker ps` may run.
#
# BSD-safe (runs on the macOS runners): no sed -i, no \b.
set -euo pipefail

PRISTINE="$1"
WORK="$2"
FAILS=0

STUBS="$WORK/backup-stubs"
mkdir -p "$STUBS"
# `docker ps` prints STUB_PS_OUT (empty by default); every call is recorded in STUB_LOG.
cat > "$STUBS/docker" <<'EOF'
#!/bin/sh
echo "docker $*" >> "$STUB_LOG"
if [ "$1" = ps ] && [ -n "${STUB_PS_OUT:-}" ]; then echo "$STUB_PS_OUT"; fi
exit 0
EOF
chmod +x "$STUBS/docker"

ok()   { echo "  ok: $*"; }
fail() { echo "  FAILED: $*" >&2; FAILS=$((FAILS + 1)); }

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

new_case() { # <name> → case directory, holding copy/ (the deploy tree) and bk/ (backups)
  local d="$WORK/backup-$1"
  rm -rf "$d"
  mkdir -p "$d/bk"
  cp -R "$PRISTINE" "$d/copy"
  echo "$d"
}

tree_sum() { # <case dir> → every path + sha256 of every file, copy and backups
  (
    cd "$1"
    find . -print | LC_ALL=C sort
    find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256
  )
}

# A backup in the format `backup` writes, made by hand: keys/ holds the fixture's secrets/ (plus a fake
# mas-secrets.yaml, which the fixture lacks, and a backup-manifest.key) as secrets.tgz; data/ holds the
# files of the format (five in format 2, four in format 1, which has no orgdata.tgz) as random bytes and
# MANIFEST.sig, the HMAC-SHA256 of data/MANIFEST under that key — computed here with openssl,
# independently of deploy.sh's own HMAC (the key on openssl's command line is test-only). FMT picks the
# format of every manifest written (default 2, what `backup` writes now).
DATA2=(synapse.dump mas.dump synapsedata.tgz escrowdata.tgz orgdata.tgz)
DATA1=(synapse.dump mas.dump synapsedata.tgz escrowdata.tgz)
FMT=2
data_files() { if [[ "$FMT" == 1 ]]; then echo "${DATA1[*]}"; else echo "${DATA2[*]}"; fi; }
make_backup() { # <case dir> <backup id> <out dir>
  local c="$1" id="$2" out="$3" f
  mkdir -p "$out/keys" "$out/data" "$WORK/stage-$id"
  cp -R "$c/copy/infra/deploy/secrets" "$WORK/stage-$id/secrets"
  printf 'secrets:\n  encryption: fake-refusal-0000\n' > "$WORK/stage-$id/secrets/mas-secrets.yaml"
  openssl rand -hex 32 > "$WORK/stage-$id/secrets/backup-manifest.key"
  cp "$WORK/stage-$id/secrets/backup-manifest.key" "$out/test-only.key"
  tar czf "$out/keys/secrets.tgz" -C "$WORK/stage-$id" secrets
  rm -rf "$WORK/stage-$id"
  for f in $(data_files); do
    head -c 4096 /dev/urandom > "$out/data/$f"
  done
  write_manifest "$out/keys" keys "$id" secrets.tgz
  # shellcheck disable=SC2046 # the file names have no spaces
  write_manifest "$out/data" data "$id" $(data_files)
  sign_data "$out"
}
sign_data() { # <backup dir>: data/MANIFEST.sig under the backup's key
  openssl dgst -sha256 -mac HMAC -macopt "hexkey:$(cat "$1/test-only.key")" "$1/data/MANIFEST" | awk '{ print $NF }' \
    > "$1/data/MANIFEST.sig"
}
write_manifest() { # <dir> <part> <id> <file…>
  local dir="$1" part="$2" id="$3" f
  shift 3
  {
    echo "tayet-backup $FMT"
    echo "backup $id"
    echo "part $part"
    echo "commit unknown"
    for f in "$@"; do echo "file $f $(wc -c < "$dir/$f" | tr -d ' ') $(sha "$dir/$f")"; done
  } > "$dir/MANIFEST"
}

# Runs the copy's deploy.sh in a clean environment, with the docker stub first on PATH. Extra
# arguments before `--` are environment assignments.
run_deploy() { # <case dir> [VAR=value…] -- <command…>
  local c="$1"; shift
  local envs=()
  while [[ "$1" != "--" ]]; do envs+=("$1"); shift; done
  shift
  ( cd "$c" && env -i PATH="$STUBS:$PATH" HOME="$c/home" STUB_LOG="$c.docker.log" ${envs[@]+"${envs[@]}"} \
      bash "$c/copy/infra/deploy/deploy.sh" "$@" )
}

expect_refusal() { # <label> <case dir> <message pattern> <allowed docker calls (regex) or ''> [VAR=value…] -- <command…>
  local label="$1" c="$2" pattern="$3" allowed="$4"; shift 4
  local before after rc out calls
  rm -f "$c.docker.log"
  before="$(tree_sum "$c")"
  set +e
  out="$(run_deploy "$c" "$@" 2>&1)"
  rc=$?
  set -e
  after="$(tree_sum "$c")"
  printf '%s\n' "$out" | sed -e "s|$c|<case>|g" -e 's|^|    > |'
  calls="$(cat "$c.docker.log" 2>/dev/null || true)"
  if [[ "$rc" == 0 ]]; then fail "$label: exit 0"; return; fi
  if ! grep -q -- "$pattern" <<<"$out"; then fail "$label: message without '$pattern'"; return; fi
  if [[ "$before" != "$after" ]]; then
    fail "$label: something was written"
    diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") >&2 || true
    return
  fi
  if [[ -n "$calls" ]] && { [[ -z "$allowed" ]] || grep -vqE "$allowed" <<<"$calls"; }; then
    fail "$label: docker was called: $(tr '\n' ';' <<<"$calls")"
    return
  fi
  ok "$label: exit $rc, nothing written, docker calls: $(grep -c . <<<"$calls" || true)"
}

ID1=20261124T100000Z
ID2=20261124T110000Z

# ── 1. restore over an existing secrets/ ──────────────────────────────────────────────────
echo "== 1. restore with secrets/ present"
c="$(new_case 1)"
make_backup "$c" "$ID1" "$c/bk/$ID1"
expect_refusal "restore over secrets/" "$c" "already exists — restore never writes over it" '' \
  -- restore "$c/bk/$ID1/keys" "$c/bk/$ID1/data"

# ── 2. tampered backups ───────────────────────────────────────────────────────────────────
echo "== 2. restore with a tampered backup"
c="$(new_case 2)"
make_backup "$c" "$ID1" "$c/bk/$ID1"
rm -rf "$c/copy/infra/deploy/secrets"
printf 'x' >> "$c/bk/$ID1/data/escrowdata.tgz"
expect_refusal "file changed after the manifest" "$c" "does not match its manifest" '' \
  -- restore "$c/bk/$ID1/keys" "$c/bk/$ID1/data"

c="$(new_case 2b)"
make_backup "$c" "$ID1" "$c/bk/$ID1"
rm -rf "$c/copy/infra/deploy/secrets"
m="$c/bk/$ID1/keys/MANIFEST"
awk '$1 == "file" { $4 = "0000000000000000000000000000000000000000000000000000000000000000" } { print }' "$m" > "$m.new"
mv "$m.new" "$m"
expect_refusal "checksum changed in the manifest" "$c" "does not match its manifest" '' \
  -- restore "$c/bk/$ID1/keys" "$c/bk/$ID1/data"

c="$(new_case 2c)"
make_backup "$c" "$ID1" "$c/bk/$ID1"
rm -rf "$c/copy/infra/deploy/secrets"
rm -f "$c/bk/$ID1/data/mas.dump"
expect_refusal "file missing" "$c" "mas.dump is missing" '' \
  -- restore "$c/bk/$ID1/keys" "$c/bk/$ID1/data"

c="$(new_case 2d)"
make_backup "$c" "$ID1" "$c/bk/$ID1"
rm -rf "$c/copy/infra/deploy/secrets"
expect_refusal "halves swapped" "$c" "lists an unexpected file" '' \
  -- restore "$c/bk/$ID1/data" "$c/bk/$ID1/keys"

# ── 3. halves of different backups ────────────────────────────────────────────────────────
echo "== 3. restore with halves of two backups"
c="$(new_case 3)"
make_backup "$c" "$ID1" "$c/bk/$ID1"
make_backup "$c" "$ID2" "$c/bk/$ID2"
rm -rf "$c/copy/infra/deploy/secrets"
expect_refusal "keys of $ID1, data of $ID2" "$c" "different backups (keys $ID1, data $ID2)" '' \
  -- restore "$c/bk/$ID1/keys" "$c/bk/$ID2/data"

# ── 4. secrets.tgz with an entry outside secrets/ ─────────────────────────────────────────
echo "== 4. restore with an archive that writes outside secrets/"
c="$(new_case 4)"
make_backup "$c" "$ID1" "$c/bk/$ID1"
rm -rf "$c/copy/infra/deploy/secrets"
mkdir -p "$WORK/stage-evil/secrets"
printf 'x\n' > "$WORK/stage-evil/secrets/deploy.env"
printf 'x\n' > "$WORK/stage-evil/compose.yaml"
tar czf "$c/bk/$ID1/keys/secrets.tgz" -C "$WORK/stage-evil" secrets compose.yaml
rm -rf "$WORK/stage-evil"
write_manifest "$c/bk/$ID1/keys" keys "$ID1" secrets.tgz
expect_refusal "entry outside secrets/" "$c" "holds entries outside secrets/" '' \
  -- restore "$c/bk/$ID1/keys" "$c/bk/$ID1/data"

# ── 5. containers of the project running ──────────────────────────────────────────────────
echo "== 5. restore with containers of the project running"
c="$(new_case 5)"
make_backup "$c" "$ID1" "$c/bk/$ID1"
rm -rf "$c/copy/infra/deploy/secrets"
expect_refusal "project tayet running" "$c" "containers of project tayet are running" \
  '^docker ps -q --filter label=com.docker.compose.project=tayet$' STUB_PS_OUT=0123456789ab \
  -- restore "$c/bk/$ID1/keys" "$c/bk/$ID1/data"

# ── 5b. signature of data/MANIFEST ────────────────────────────────────────────────────────
echo "== 5b. restore with a data half not signed by the keys half"
c="$(new_case 5b)"
make_backup "$c" "$ID1" "$c/bk/$ID1"
rm -rf "$c/copy/infra/deploy/secrets"
head -c 4096 /dev/urandom > "$c/bk/$ID1/data/synapse.dump"
write_manifest "$c/bk/$ID1/data" data "$ID1" "${DATA2[@]}"
expect_refusal "dump swapped, manifest rebuilt without the key" "$c" "does not match the key in the keys half" '' \
  -- restore "$c/bk/$ID1/keys" "$c/bk/$ID1/data"

c="$(new_case 5c)"
make_backup "$c" "$ID1" "$c/bk/$ID1"
rm -rf "$c/copy/infra/deploy/secrets"
rm -f "$c/bk/$ID1/data/MANIFEST.sig"
expect_refusal "signature missing" "$c" "MANIFEST.sig is missing" '' \
  -- restore "$c/bk/$ID1/keys" "$c/bk/$ID1/data"

c="$(new_case 5d)"
make_backup "$c" "$ID1" "$c/bk/$ID1"
make_backup "$c" "$ID2" "$c/bk/$ID2"
rm -rf "$c/copy/infra/deploy/secrets"
# data/ of another installation (another key), relabelled with this backup's id and re-signed with its own key.
write_manifest "$c/bk/$ID2/data" data "$ID1" "${DATA2[@]}"
sign_data "$c/bk/$ID2"
expect_refusal "data half of another installation, same id" "$c" "does not match the key in the keys half" '' \
  -- restore "$c/bk/$ID1/keys" "$c/bk/$ID2/data"

c="$(new_case 5e)"
make_backup "$c" "$ID1" "$c/bk/$ID1"
rm -rf "$c/copy/infra/deploy/secrets"
: > "$c/bk/$ID1/data/MANIFEST.sig"
expect_refusal "MANIFEST.sig empty" "$c" "is not a signature" '' \
  -- restore "$c/bk/$ID1/keys" "$c/bk/$ID1/data"

c="$(new_case 5f)"
make_backup "$c" "$ID1" "$c/bk/$ID1"
rm -rf "$c/copy/infra/deploy/secrets"
printf '   \n\t \n' > "$c/bk/$ID1/data/MANIFEST.sig"
expect_refusal "MANIFEST.sig only whitespace" "$c" "is not a signature" '' \
  -- restore "$c/bk/$ID1/keys" "$c/bk/$ID1/data"

# ── 5g. the two formats ───────────────────────────────────────────────────────────────────
# restore takes format 2 (with orgdata.tgz) and format 1 (before the org service, without it), each with
# exactly its own files, both halves in the same format.
echo "== 5g. backup formats"
c="$(new_case 5g1)"
FMT=1 make_backup "$c" "$ID1" "$c/bk/$ID1"
rm -rf "$c/copy/infra/deploy/secrets"
expect_refusal "format 1 passes every check of the halves (stopped only by the running project)" "$c" \
  "containers of project tayet are running" \
  '^docker ps -q --filter label=com.docker.compose.project=tayet$' STUB_PS_OUT=0123456789ab \
  -- restore "$c/bk/$ID1/keys" "$c/bk/$ID1/data"

c="$(new_case 5g2)"
FMT=1 make_backup "$c" "$ID1" "$c/bk/$ID1"
rm -rf "$c/copy/infra/deploy/secrets"
printf 'x' >> "$c/bk/$ID1/data/escrowdata.tgz"
expect_refusal "format 1, file changed after the manifest" "$c" "does not match its manifest" '' \
  -- restore "$c/bk/$ID1/keys" "$c/bk/$ID1/data"

c="$(new_case 5g3)"
make_backup "$c" "$ID1" "$c/bk/$ID1"
rm -rf "$c/copy/infra/deploy/secrets"
rm -f "$c/bk/$ID1/data/orgdata.tgz"
write_manifest "$c/bk/$ID1/data" data "$ID1" "${DATA1[@]}"
sign_data "$c/bk/$ID1"
expect_refusal "format 2 without orgdata.tgz" "$c" "does not list orgdata.tgz" '' \
  -- restore "$c/bk/$ID1/keys" "$c/bk/$ID1/data"

c="$(new_case 5g4)"
FMT=1 make_backup "$c" "$ID1" "$c/bk/$ID1"
rm -rf "$c/copy/infra/deploy/secrets"
head -c 4096 /dev/urandom > "$c/bk/$ID1/data/orgdata.tgz"
FMT=1 write_manifest "$c/bk/$ID1/data" data "$ID1" "${DATA2[@]}"
sign_data "$c/bk/$ID1"
expect_refusal "format 1 listing orgdata.tgz" "$c" "lists an unexpected file ('orgdata.tgz')" '' \
  -- restore "$c/bk/$ID1/keys" "$c/bk/$ID1/data"

c="$(new_case 5g5)"
make_backup "$c" "$ID1" "$c/bk/$ID1"
rm -rf "$c/copy/infra/deploy/secrets"
FMT=3 write_manifest "$c/bk/$ID1/data" data "$ID1" "${DATA2[@]}"
sign_data "$c/bk/$ID1"
expect_refusal "unknown format" "$c" "is not a 'tayet-backup 2' or 'tayet-backup 1' manifest" '' \
  -- restore "$c/bk/$ID1/keys" "$c/bk/$ID1/data"

c="$(new_case 5g6)"
make_backup "$c" "$ID1" "$c/bk/$ID1"
rm -rf "$c/copy/infra/deploy/secrets"
FMT=1 write_manifest "$c/bk/$ID1/keys" keys "$ID1" secrets.tgz
expect_refusal "keys in format 1, data in format 2" "$c" "different formats" '' \
  -- restore "$c/bk/$ID1/keys" "$c/bk/$ID1/data"

# ── 6. backup directory inside secrets/ ───────────────────────────────────────────────────
echo "== 6. backup into secrets/"
c="$(new_case 6)"
expect_refusal "DIR = secrets/backups/x (relative)" "$c" "is inside" '' \
  -- backup copy/infra/deploy/secrets/backups/x
expect_refusal "DIR = secrets (absolute)" "$c" "is inside" '' \
  -- backup "$c/copy/infra/deploy/secrets"
ln -s "$c/copy/infra/deploy/secrets" "$c/bk/link"
expect_refusal "DIR through a symlink into secrets/" "$c" "is inside" '' \
  -- backup "$c/bk/link/new"

if [[ "$FAILS" != 0 ]]; then
  echo "backup-refusals: $FAILS FAILED" >&2
  exit 1
fi
echo "backup-refusals: every refusal held, nothing written."
