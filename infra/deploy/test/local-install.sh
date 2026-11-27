#!/usr/bin/env bash
#
# local-install.sh — prova de instalação nova num domínio de teste, local, com TLS interno, a partir da
# árvore pública montada (ADR-095 dec. 10 (c), PLANO-DEPLOY-DOMINIO §0.3.3 itens 7 a 11 e §8.3).
#
#   bash infra/deploy/test/local-install.sh          # monta, sobe, confere, faz login, derruba
#   bash infra/deploy/test/local-install.sh --keep   # idem, sem derrubar no fim (a stack e <árvore> ficam)
#
# Rodado à mão, no checkout principal (a stack não sobe em worktree), em detached no commit a provar. Não
# entra no CI. Pede docker, htpasswd, curl, node (o do client: Node 22, npm via npx) e o Chromium do
# Playwright já instalado na máquina.
#
# Domínio empresa.test, projeto compose tayet-local, portas 28008 (loopback do Synapse), 28080 e 28443.
# O Caddyfile versionado não muda: o script gera um Caddyfile com um bloco global de certificados locais
# na frente do versionado e o monta por um override compose (TAYET_COMPOSE_OVERRIDE). Quem valida a
# cadeia TLS é o curl, com a CA interna do Caddy; o navegador ignora o erro de certificado.
#
# Segredos: a senha do admin de bootstrap é lida do arquivo pelo local-login.mjs e não aparece em saída;
# o Google fica com a credencial falsa do fixture. Sem trace, vídeo ou screenshot.
#
# BSD-safe: sem sed -i, sem \b, greps com caminhos explícitos.
set -euo pipefail

KEEP=0
case "${1:-}" in
  '') ;;
  --keep) KEEP=1 ;;
  *) echo "uso: $0 [--keep]" >&2; exit 2 ;;
esac

DOMAIN="empresa.test"
PROJECT="tayet-local"
HS_PORT=28008
HTTP_PORT=28080
HTTPS_PORT=28443
HOSTS=("$DOMAIN" "chat.$DOMAIN" "matrix.$DOMAIN" "auth.$DOMAIN" "login.$DOMAIN")

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$TEST_DIR" rev-parse --show-toplevel)"
START=$SECONDS

step() { echo; echo "── $* ($((SECONDS - START)) s)"; }
die()  { echo "FALHOU: $*" >&2; exit 1; }

for tool in docker htpasswd curl node git lsof; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' ausente."
done

# ── 1. recusa se as portas estão ocupadas ou se o projeto já existe ────────────────────────────
step "1. portas e projeto livres"
for p in "$HS_PORT" "$HTTP_PORT" "$HTTPS_PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then die "porta $p ocupada."; fi
done
if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")" ]]; then
  die "já existe container do projeto $PROJECT."
fi
if [[ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")" ]]; then
  die "já existe volume do projeto $PROJECT."
fi
echo "portas $HS_PORT, $HTTP_PORT e $HTTPS_PORT livres; nenhum container ou volume de $PROJECT."

# pwd -P: caminhos resolvidos (no macOS /var → /private/var), os que o Docker Desktop compartilha.
TREE="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/local-install.XXXXXX")" && pwd -P)"
DEPLOY="$TREE/infra/deploy"
OVERRIDE="$DEPLOY/test/compose.local.yaml"
CA="$TREE/caddy-root.crt"
# Entry point of test/restore-proof.sh: where <tree> is, for a caller that runs this with --keep.
if [[ -n "${LOCAL_INSTALL_TREE_FILE:-}" ]]; then printf '%s\n' "$TREE" > "$LOCAL_INSTALL_TREE_FILE"; fi

# Derruba só o que é do projeto tayet-local, também em falha no meio. Primeiro o compose (down -v); se
# o compose não carrega (falha antes do secrets, sem agent.env), varre por label do projeto.
cleanup() {
  local rc=$?
  if [[ "$KEEP" == 1 ]]; then
    echo
    echo "--keep: stack $PROJECT e <árvore> ($TREE) mantidas."
    exit "$rc"
  fi
  if [[ "$PROJECT" == "tayet-local" ]]; then
    echo
    echo "── derrubando $PROJECT (down -v)"
    if [[ -f "$DEPLOY/secrets/agent.env" && -f "$DEPLOY/secrets/deployment.env" ]]; then
      docker compose -p "$PROJECT" --env-file "$DEPLOY/secrets/deployment.env" \
        -f "$DEPLOY/compose.yaml" -f "$OVERRIDE" down -v --remove-orphans >/dev/null 2>&1 || true
    fi
    local ids
    ids="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")"
    if [[ -n "$ids" ]]; then docker rm -f $ids >/dev/null 2>&1 || true; fi
    ids="$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")"
    if [[ -n "$ids" ]]; then docker volume rm $ids >/dev/null 2>&1 || true; fi
    ids="$(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT")"
    if [[ -n "$ids" ]]; then docker network rm $ids >/dev/null 2>&1 || true; fi
    echo "containers: $(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" | wc -l | tr -d ' ')," \
      "volumes: $(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" | wc -l | tr -d ' ')"
  fi
  rm -rf "$TREE"
  echo "tempo total: $((SECONDS - START)) s"
  exit "$rc"
}
trap cleanup EXIT

# ── 2. árvore pública montada a partir do HEAD ─────────────────────────────────────────────────
step "2. árvore pública (HEAD $(git -C "$REPO_ROOT" rev-parse --short HEAD))"
( cd "$REPO_ROOT" && bash .github/scripts/assemble-public-tree.sh "$TREE" ) >/dev/null
[[ -x "$DEPLOY/deploy.sh" && -x "$TREE/infra/mas/prepare.sh" ]] || die "árvore sem infra/deploy/deploy.sh ou infra/mas/prepare.sh."
[[ ! -e "$TREE/site" ]] || die "a árvore pública tem site/."
echo "<árvore>: $(find "$TREE" -type f | wc -l | tr -d ' ') arquivos; infra/mas presente; sem site/."
# Daqui em diante tudo roda dentro de <árvore>.
cd "$DEPLOY"

# ── 3. ambiente do deployment de teste ────────────────────────────────────────────────────────
step "3. ambiente: $DOMAIN, projeto $PROJECT, portas $HS_PORT/$HTTP_PORT/$HTTPS_PORT"
( umask 077 && mkdir -p secrets )
cp test/fixture/google-oauth.env secrets/google-oauth.env
export TAYET_DOMAIN="$DOMAIN"
export TAYET_COMPOSE_PROJECT="$PROJECT"
export TAYET_HS_PORT="$HS_PORT" TAYET_HTTP_PORT="$HTTP_PORT" TAYET_HTTPS_PORT="$HTTPS_PORT"
export BOOTSTRAP_ADMIN_USERNAME=admin
export BOOTSTRAP_ADMIN_EMAIL="admin@$DOMAIN"
export BOOTSTRAP_ADMIN_FULL_NAME="Admin Local"
export BOOTSTRAP_ADMIN_JOB_TITLE=""

# ── 4. Caddyfile com certificados locais e o override que o monta ─────────────────────────────
step "4. Caddyfile local e override compose"
{
  printf '{\n\tlocal_certs\n\tskip_install_trust\n}\n\n'
  cat Caddyfile
} > test/Caddyfile.local
cat > "$OVERRIDE" <<EOF
# Gerado por test/local-install.sh: só a prova local. Monta o Caddyfile com certificados locais.
services:
  caddy:
    volumes:
      - $DEPLOY/test/Caddyfile.local:/etc/caddy/Caddyfile:ro
EOF
export TAYET_COMPOSE_OVERRIDE="$OVERRIDE"
echo "Caddyfile.local = bloco global (local_certs, skip_install_trust) + Caddyfile versionado ($(wc -l < Caddyfile | tr -d ' ') linhas, sem alteração)."

# ── 5. secrets, build, up, check ──────────────────────────────────────────────────────────────
for cmd in secrets build up check; do
  step "5. ./deploy.sh $cmd"
  ./deploy.sh "$cmd" || die "./deploy.sh $cmd saiu $?."
done
echo
echo "deployment.env:"
sed -e 's|^|  |' secrets/deployment.env

# ── 6. raiz da CA interna do Caddy ────────────────────────────────────────────────────────────
step "6. raiz da CA interna"
caddy_cid="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=caddy")"
[[ -n "$caddy_cid" ]] || die "container do Caddy ausente."
for _ in $(seq 1 30); do
  if docker exec "$caddy_cid" cat /data/caddy/pki/authorities/local/root.crt > "$CA" 2>/dev/null && [[ -s "$CA" ]]; then break; fi
  sleep 1
done
[[ -s "$CA" ]] || die "raiz da CA interna não apareceu em 30 s."
grep -q 'BEGIN CERTIFICATE' "$CA" || die "raiz da CA interna ilegível."
echo "raiz da CA extraída ($(grep -c 'BEGIN CERTIFICATE' "$CA") certificado)."

# ── 7. os cinco hosts por curl, validando a cadeia ────────────────────────────────────────────
step "7. os cinco hosts (curl --cacert, sem -k)"
CONNECT=()
for h in "${HOSTS[@]}"; do CONNECT+=(--connect-to "$h:443:127.0.0.1:$HTTPS_PORT"); done
fetch() { curl -sS --fail --max-time 20 --cacert "$CA" "${CONNECT[@]}" "$@"; }
code_of() { curl -sS -o /dev/null -w '%{http_code}' --max-time 20 --cacert "$CA" "${CONNECT[@]}" "$1"; }
json_field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s)[process.argv[1]];process.stdout.write(typeof v==="string"?v:JSON.stringify(v))})' "$1"; }
checks=0
pass() { echo "  ok: $*"; checks=$((checks + 1)); }

body="$(fetch "https://$DOMAIN/.well-known/matrix/server")" || die "well-known server inalcançável."
grep -q "matrix.$DOMAIN" <<<"$body" || die "well-known server sem matrix.$DOMAIN: $body"
pass "https://$DOMAIN/.well-known/matrix/server → $body"
body="$(fetch "https://$DOMAIN/.well-known/matrix/client")" || die "well-known client inalcançável."
grep -q "matrix.$DOMAIN" <<<"$body" || die "well-known client sem matrix.$DOMAIN: $body"
pass "https://$DOMAIN/.well-known/matrix/client → $body"

code="$(code_of "https://chat.$DOMAIN/")"
[[ "$code" == 200 ]] || die "https://chat.$DOMAIN/ → HTTP $code"
pass "https://chat.$DOMAIN/ → HTTP $code"
index="$(fetch "https://chat.$DOMAIN/")"
bundle="$(printf '%s\n' "$index" | sed -n 's|.*src="\(/assets/index-[^"]*\.js\)".*|\1|p' | head -n 1)"
[[ -n "$bundle" ]] || die "index.html sem o bundle /assets/index-*.js."
hits="$(fetch "https://chat.$DOMAIN$bundle" | grep -o "https://matrix\.$DOMAIN" | wc -l | tr -d ' ')"
[[ "$hits" -ge 1 ]] || die "bundle $bundle sem https://matrix.$DOMAIN."
pass "bundle $bundle servido com https://matrix.$DOMAIN ($hits ocorrência)"

body="$(fetch "https://chat.$DOMAIN/.well-known/tayet/agent")" || die "well-known do agente inalcançável."
grep -q "https://matrix.$DOMAIN" <<<"$body" || die "well-known do agente sem https://matrix.$DOMAIN: $body"
pass "https://chat.$DOMAIN/.well-known/tayet/agent → $body"

code="$(code_of "https://matrix.$DOMAIN/_matrix/client/versions")"
[[ "$code" == 200 ]] || die "https://matrix.$DOMAIN/_matrix/client/versions → HTTP $code"
pass "https://matrix.$DOMAIN/_matrix/client/versions → HTTP $code"

iss="$(fetch "https://auth.$DOMAIN/.well-known/openid-configuration" | json_field issuer)"
[[ "$iss" == "https://auth.$DOMAIN/" ]] || die "issuer do MAS = '$iss'"
pass "https://auth.$DOMAIN/.well-known/openid-configuration → issuer $iss"
iss="$(fetch "https://login.$DOMAIN/.well-known/openid-configuration" | json_field issuer)"
[[ "$iss" == "https://login.$DOMAIN" ]] || die "issuer do Dex = '$iss'"
pass "https://login.$DOMAIN/.well-known/openid-configuration → issuer $iss"

# ── 8. login no navegador com o admin de bootstrap ────────────────────────────────────────────
step "8. login no navegador (admin de bootstrap, pelo provedor do Dex)"
LOGIN_START=$SECONDS
TREE="$TREE" DOMAIN="$DOMAIN" HTTPS_PORT="$HTTPS_PORT" ADMIN_EMAIL="$BOOTSTRAP_ADMIN_EMAIL" \
  PASSWORD_FILE="$DEPLOY/secrets/bootstrap-admin.password" \
  node "$DEPLOY/test/local-login.mjs" || die "login no navegador."
echo "login: $((SECONDS - LOGIN_START)) s"

# Medição: algum contêiner tentou resolver um host público do domínio de teste?
step "8b. resolução de host público pelos contêineres"
dns_hits="$(docker compose -p "$PROJECT" --env-file secrets/deployment.env -f compose.yaml -f "$OVERRIDE" logs --no-color 2>/dev/null \
  | grep -iE "(auth|login|matrix|chat)\.$DOMAIN" \
  | grep -icE 'resolve|lookup|dns|name or service|no such host|temporary failure|getaddrinfo|could not connect|connection refused' || true)"
echo "linhas de log com falha de resolução ou conexão para um host público de $DOMAIN: $dns_hits"
[[ "$dns_hits" == 0 ]] || die "algum contêiner tentou alcançar um host público (acima)."

# ── 9. nenhum literal de tayet.app nos renders ─────────────────────────────────────────────────
step "9. tayet.app nos renders"
# Ancorado: io.tayet.approval não é o domínio. Comentário de template não conta (§8.2, pendência do ADR-095).
leftover="$(cd secrets/rendered && grep -nE 'tayet\.app([^a-z0-9]|$)' homeserver.yaml mas-config.yaml dex-config.yaml directory.tsv \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true)"
comments="$(cd secrets/rendered && grep -nE 'tayet\.app([^a-z0-9]|$)' homeserver.yaml mas-config.yaml dex-config.yaml directory.tsv \
  | grep -cE '^[^:]+:[0-9]+:[[:space:]]*#' || true)"
if [[ -n "$leftover" ]]; then
  printf '%s\n' "$leftover" >&2
  die "tayet.app fora de comentário nos renders (acima)."
fi
echo "fora de comentário: 0 linhas; em comentário de template: $comments linhas."
# Desde o PR 4a (PLANO-DEPLOY-DOMINIO §0.3.4) o log config é synapse/log.config: zero, sem exceção.
sources="$(docker compose -p "$PROJECT" --env-file secrets/deployment.env -f compose.yaml -f "$OVERRIDE" config 2>/dev/null \
  | grep -E 'tayet\.app([^a-z0-9]|$)' | sed -e "s|$TREE|<árvore>|g" -e 's|^ *||' || true)"
if [[ -n "$sources" ]]; then
  printf '%s\n' "$sources" >&2
  die "tayet.app no compose config (acima)."
fi
echo "compose config com tayet.app: 0 linhas."

# ── 10. /escrow routing: org and escrow behind the same prefix ────────────────────────────────
# After 8b: the 502s of the stopped processes reach the Caddy log with the chat.<domain> host and the
# failed resolution of the stopped service, which the 8b measurement would read as an attempt to reach
# a public host. Without a token, org and escrow answer 401. Stopping one process at a time shows who
# answers each path: the stopped process's path is no longer 401 (Caddy cannot reach it), the other
# stays 401.
step "10. roteamento do /escrow (org × escrow, um processo parado de cada vez)"
DC=(docker compose -p "$PROJECT" --env-file secrets/deployment.env -f compose.yaml -f "$OVERRIDE")
PEOPLE_ME="https://chat.$DOMAIN/escrow/v1/people/me"
SECRET="https://chat.$DOMAIN/escrow/v1/secret"
wait_code() { # <url> <code>, up to 60 s
  local c=""
  for _ in $(seq 1 60); do
    c="$(code_of "$1" || true)"
    [[ "$c" == "$2" ]] && return 0
    sleep 1
  done
  die "$1 → HTTP $c, esperado $2 em 60 s."
}
route() { # <label> <expected code of people/me: 401 or not401> <expected code of secret: same>
  local pm sc
  pm="$(code_of "$PEOPLE_ME" || true)"
  sc="$(code_of "$SECRET" || true)"
  case "$2" in 401) [[ "$pm" == 401 ]] ;; not401) [[ "$pm" != 401 ]] ;; esac || die "$1: people/me → HTTP $pm"
  case "$3" in 401) [[ "$sc" == 401 ]] ;; not401) [[ "$sc" != 401 ]] ;; esac || die "$1: secret → HTTP $sc"
  pass "$1: /escrow/v1/people/me → HTTP $pm, /escrow/v1/secret → HTTP $sc"
}
wait_code "$PEOPLE_ME" 401
wait_code "$SECRET" 401
route "tudo de pé" 401 401
"${DC[@]}" stop escrow >/dev/null
route "escrow parado" 401 not401
"${DC[@]}" start escrow >/dev/null
wait_code "$SECRET" 401
"${DC[@]}" stop org >/dev/null
route "escrow de volta, org parado" not401 401
"${DC[@]}" start org >/dev/null
wait_code "$PEOPLE_ME" 401
route "tudo religado" 401 401

# ── 11. a second up promotes nobody; promote-admin recovers the org admin ─────────────────────
# The bootstrap admin is promoted only by the up that created the account. promote-admin runs the org
# service's own command in its container: idempotent for a live member, a non-zero refusal otherwise.
step "11. segundo up e ./deploy.sh promote-admin"
second_up="$(./deploy.sh up 2>&1)" || { printf '%s\n' "$second_up" >&2; die "o segundo ./deploy.sh up falhou."; }
if grep -q '^Org admin:' <<<"$second_up"; then die "o segundo up promoveu alguém (linha Org admin:)."; fi
pass "segundo ./deploy.sh up: sem a linha Org admin:"
promoted="$(./deploy.sh promote-admin "$BOOTSTRAP_ADMIN_EMAIL" 2>&1)" || die "promote-admin do admin de bootstrap: $promoted"
grep -qx "$BOOTSTRAP_ADMIN_USERNAME: already an admin" <<<"$promoted" || die "promote-admin do admin de bootstrap: $promoted"
pass "promote-admin $BOOTSTRAP_ADMIN_EMAIL → $BOOTSTRAP_ADMIN_USERNAME: already an admin"
if refused="$(./deploy.sh promote-admin "nobody@$DOMAIN" 2>&1)"; then die "promote-admin de email sem conta saiu 0: $refused"; fi
grep -qx 'promote-admin: no account for this email' <<<"$refused" || die "promote-admin de email sem conta: $refused"
pass "promote-admin nobody@$DOMAIN → recusa (status ≠ 0, no account for this email)"

echo
echo "Prova local OK: $checks conferências por curl, login no navegador, $((SECONDS - START)) s até aqui."
