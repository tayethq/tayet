#!/usr/bin/env bash
# ADR-054, addendum "Estreitamento de invariante": on each provisioning script the Synapse admin API
# may appear only as the directory sync's existence pre-check. The addendum, verbatim:
#   - **zero** call sites de `/_synapse/admin/*` com verbo de escrita (`PUT`/`POST`/`DELETE`)
#   - **exatamente um** call site `GET /_synapse/admin/v2/users/{user}`, como pré-check de existência,
#     **por script provisionador** (`infra/deploy/deploy.sh`, `infra/dev-stack/dev-stack.sh`);
#   - **comentários que citam o caminho não contam.**
#
# This is an allowlist by CONTENT, not a hit count: after dropping comment lines, each script must
# have exactly one line naming `_synapse/admin`, and it must be the GET pre-check's URL line below.
# Any other line (a DELETE, a second GET, a reworded call) fails with `file:line: content`. ADR-069
# dec. 7 removed the last write (the dev-stack F8 DELETE); this gate keeps it from coming back.
#
# BSD/GNU-safe (runs on the macOS runner): plain grep -n and awk, no --include.
set -euo pipefail

cd "$(dirname "$0")/../.."

ALLOWED='"$HS_URL/_synapse/admin/v2/users/@$u:$ORG_SERVER_NAME")'
SCRIPTS=(infra/deploy/deploy.sh infra/dev-stack/dev-stack.sh)
fail=0

for f in "${SCRIPTS[@]}"; do
  # file:line:content for every non-comment line naming the admin API, content trimmed.
  hits=$(grep -n '_synapse/admin' "$f" | awk -v f="$f" '{
    n = index($0, ":"); line = substr($0, 1, n - 1); body = substr($0, n + 1)
    sub(/^[ \t]+/, "", body); sub(/[ \t]+$/, "", body)
    if (body ~ /^#/) next
    print f ":" line ":" body
  }')
  count=0
  allowed=0
  while IFS= read -r h; do
    [ -z "$h" ] && continue
    count=$((count + 1))
    body=${h#*:*:}
    if [ "$body" = "$ALLOWED" ]; then
      allowed=$((allowed + 1))
    else
      echo "$h"
      fail=1
    fi
  done <<< "$hits"
  if [ "$count" -ne 1 ] || [ "$allowed" -ne 1 ]; then
    echo "$f: esperado exatamente 1 call site de admin API (o GET de pré-check), achados $count ($allowed permitido)" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "ERRO: invariante do ADR-054 violado — admin API fora do GET de pré-check." >&2
  exit 1
fi
echo "ADR-054: um GET de pré-check por script provisionador, zero escrita em /_synapse/admin ✅"
