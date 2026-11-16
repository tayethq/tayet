#!/usr/bin/env bash
# Liga E2E (Megolm) nas salas de dev/teste EXISTENTES da stack — via state event direto no
# Synapse, NÃO pela ACL (PLANO-FASE-2 §4.4: a ACL não expõe "ligar cifra em sala existente";
# não é verbo de produto nesta fase. Salas NOVAS criadas pela ACL já nascem cifradas).
#
# Uso: ./encrypt-rooms.sh [usuário]   (default: alice — precisa ter PL para mandar state)
# Idempotente: sala já cifrada é pulada. Cifra é IRREVERSÍVEL por sala (remover o state event
# não descriptografa nada e clientes honram o estado mais restritivo) — ok para stack de dev;
# use ./dev-stack.sh reset se quiser voltar a um mundo cleartext.
set -euo pipefail

HS="${TAYET_HS_URL:-http://localhost:8008}"
MAS_CONTAINER="${TAYET_MAS_CONTAINER:-spike-mas-1}"
MAS_CONFIG="${TAYET_MAS_CONFIG:-/config/config.yaml}"
USER="${1:-alice}"

command -v jq >/dev/null || { echo "precisa de jq"; exit 1; }
curl -sf -m 3 "$HS/_matrix/client/versions" >/dev/null || { echo "stack DOWN ($HS)"; exit 1; }

TOKEN=$(docker exec "$MAS_CONTAINER" mas-cli manage issue-compatibility-token -c "$MAS_CONFIG" "$USER" 2>&1 | grep -o 'mct_[A-Za-z0-9_]*' | head -1)
[ -n "$TOKEN" ] || { echo "não consegui emitir token para $USER"; exit 1; }

ROOMS=$(curl -sf -H "Authorization: Bearer $TOKEN" "$HS/_matrix/client/v3/joined_rooms" | jq -r '.joined_rooms[]')
[ -n "$ROOMS" ] || { echo "nenhuma sala para $USER"; exit 0; }

for ROOM in $ROOMS; do
  ENC_ROOM=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$ROOM")
  STATE_URL="$HS/_matrix/client/v3/rooms/$ENC_ROOM/state/m.room.encryption/"
  if curl -sf -H "Authorization: Bearer $TOKEN" "$STATE_URL" >/dev/null 2>&1; then
    echo "já cifrada: $ROOM"
    continue
  fi
  if curl -sf -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"algorithm":"m.megolm.v1.aes-sha2"}' "$STATE_URL" >/dev/null; then
    echo "cifrada agora: $ROOM"
  else
    echo "FALHOU (sem PL?): $ROOM" >&2
  fi
done
