#!/usr/bin/env bash
#
# dev-stack.sh — sobe/derruba a stack Fase 0 (Postgres + Synapse + MAS + Dex) para o
# GATE LOCAL de integração ACL↔Synapse do Tayet.
#
# Este script é um WRAPPER em cima do compose que vive AO LADO dele em
# infra/dev-stack/compose.yaml. Ele NÃO define uma stack nova — só orquestra a existente
# e garante o contrato que o harness de teste espera (client/test/support/synapse.ts):
#   - Synapse alcançável em TAYET_HS_URL  (probe: GET /_matrix/client/versions)
#   - container do MAS chamado `spike-mas-1`  (project name default = spike; TAYET_COMPOSE_PROJECT troca)
#   - tokens emitidos via `mas-cli manage issue-compatibility-token`
#
# Uso:
#   ./dev-stack.sh up        # sobe a stack e espera o Synapse responder
#   ./dev-stack.sh status    # mostra estado dos containers + probe
#   ./dev-stack.sh token alice   # emite um mct_… para conferência manual
#   ./dev-stack.sh test      # exporta o env e roda a suíte (as suítes de integração deixam de skipar)
#   ./dev-stack.sh down      # derruba SEM apagar volumes (preserva usuários alice/bob)
#   ./dev-stack.sh reset     # derruba COM -v (apaga Postgres) — footgun fix de estado sujo do MAS
#   ./dev-stack.sh ci-reset  # down -v SÓ do projeto spike-ci (guard literal) + render/token do projeto
#   ./dev-stack.sh render-check  # prova que o render de mas/ e dex/ com portas default é a identidade
#
set -euo pipefail

# ── Resolução de paths ───────────────────────────────────────────────────────────────────
# A stack vive AO LADO deste script. Resolvemos o próprio dir para achar o compose.yaml,
# independente de onde o script é invocado.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Project name default `spike` — o harness faz `docker exec spike-mas-1` por default. Não mude sem
# mudar TAYET_MAS_CONTAINER no ambiente de teste junto. (Belt-and-suspenders com o `name:` do
# compose.yaml; o `-p "$PROJECT"` daqui vence.) Fase 2 (ADR-071 dec. 2): TAYET_COMPOSE_PROJECT
# troca o namespace inteiro (ex.: `spike-ci` no CI); sem a var, tudo segue `spike`.
PROJECT="${TAYET_COMPOSE_PROJECT:-spike}"

# Dir do pacote do cliente (vitest). Monorepo: client/ vive na RAIZ do repo, não aqui em
# infra/dev-stack/. Resolvemos via git para não depender do cwd. NÃO é o spike/client/
# (hello-world descartável que ficou na branch spike).
REPO_ROOT="$(git rev-parse --show-toplevel)"
CLIENT_DIR="${TAYET_CLIENT_DIR:-$REPO_ROOT/client}"

# Portas de host por projeto (fase 2, §8.R2); defaults = spike.
HS_PORT="${TAYET_HS_PORT:-8008}"
DEX_PORT="${TAYET_DEX_PORT:-5556}"
MAS_PORT="${TAYET_MAS_PORT:-8080}"
SPA_PORT="${TAYET_SPA_PORT:-5173}"   # só entra no render (redirect_uri do client); não é porta do compose

HS_URL="${TAYET_HS_URL:-http://localhost:${HS_PORT}}"
MAS_CONTAINER="${TAYET_MAS_CONTAINER:-${PROJECT}-mas-1}"
MAS_CONFIG="${TAYET_MAS_CONFIG:-/config/config.yaml}"
WAIT_TIMEOUT_S="${TAYET_WAIT_TIMEOUT_S:-120}"
ESCROW_PORT="${TAYET_ESCROW_PORT:-8090}"
# The router publishes the escrow's port on the host loopback and splits by path between the escrow and
# the org service; neither of them publishes a port.
ESCROW_BASE="http://localhost:${ESCROW_PORT}"
ORG_CONTAINER="${PROJECT}-org-1"
ROUTER_CONTAINER="${PROJECT}-router-1"
ESCROW_ENV_FILE="$SCRIPT_DIR/escrow.secret.env"
# Throwaway VAPID pair of the push service, generated once (gitignored; the integration test reads the
# public key from it).
PUSH_ENV_FILE="$SCRIPT_DIR/push.secret.env"
# Templates próprios do MAS (ADR-084): gera _generated/ e dá o sha da árvore para o marcador.
MAS_TEMPLATES_PREPARE="$REPO_ROOT/infra/mas/prepare.sh"

# Token do cofre por projeto: `spike` mantém agent-token.secret; outro projeto usa
# agent-token.<projeto>.secret (gitignored). O compose recebe só o basename.
if [[ "$PROJECT" == "spike" ]]; then
  AGENT_TOKEN_BASENAME="agent-token.secret"
else
  AGENT_TOKEN_BASENAME="agent-token.${PROJECT}.secret"
fi

# Push network per project (ADR-117 dec. 7): a /29 whose gateway is .1, the homeserver .2 and the push
# gateway .3. homeserver.yaml allows the push address of `spike` and `spike-ci` only, so any other
# project must bring its own TAYET_PUSH_SUBNET (and allow that address there) to deliver pushes.
case "$PROJECT" in
  spike)    PUSH_SUBNET_DEFAULT="10.213.78.0/29";;
  spike-ci) PUSH_SUBNET_DEFAULT="10.213.78.8/29";;
  *)        PUSH_SUBNET_DEFAULT="";;
esac
PUSH_SUBNET="${TAYET_PUSH_SUBNET:-$PUSH_SUBNET_DEFAULT}"
if [[ ! "$PUSH_SUBNET" =~ ^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9]))\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])/29$ ]] || (( 10#${BASH_REMATCH[5]} % 8 != 0 || 10#${BASH_REMATCH[5]} > 248 )); then
  echo "ERRO: TAYET_PUSH_SUBNET ('$PUSH_SUBNET') precisa ser uma /29 alinhada (a.b.c.N/29, N múltiplo de 8); projeto $PROJECT sem padrão." >&2
  exit 1
fi
PUSH_SYNAPSE_IP="${BASH_REMATCH[1]}.$(( 10#${BASH_REMATCH[5]} + 2 ))"
PUSH_IP="${BASH_REMATCH[1]}.$(( 10#${BASH_REMATCH[5]} + 3 ))"
PUSH_PORT="${TAYET_PUSH_PORT:-8095}"
PUSH_BASE="http://localhost:${PUSH_PORT}"   # /healthz published on the host loopback

# Exporta o namespace para o compose: assim `compose()` sem --env-file (status/down/logs)
# interpola exatamente o mesmo projeto/portas/token que o `up`.
export TAYET_COMPOSE_PROJECT="$PROJECT" TAYET_HS_PORT="$HS_PORT" TAYET_DEX_PORT="$DEX_PORT" \
  TAYET_MAS_PORT="$MAS_PORT" TAYET_ESCROW_PORT="$ESCROW_PORT" TAYET_AGENT_TOKEN_FILE="$AGENT_TOKEN_BASENAME" \
  TAYET_PUSH_SUBNET="$PUSH_SUBNET" TAYET_PUSH_SYNAPSE_IP="$PUSH_SYNAPSE_IP" TAYET_PUSH_IP="$PUSH_IP" \
  TAYET_PUSH_PORT="$PUSH_PORT"

# Configs de MAS/Dex por projeto (fase 2, §8.R2): `spike` monta os dirs commitados (mas/, dex/);
# outro projeto monta o render em .render/<projeto>/ (gitignored), com as portas de host
# deslocadas. O path vale para TODO compose do projeto (status/down/ci-reset), não só o `up`;
# quem ESCREVE os arquivos é render_project_configs, chamado só pelo `up`.
RENDER_DIR="$SCRIPT_DIR/.render/$PROJECT"
if [[ "$PROJECT" != "spike" ]]; then
  export TAYET_MAS_CONFIG_DIR="$RENDER_DIR/mas" TAYET_DEX_CONFIG_DIR="$RENDER_DIR/dex"
fi

# Fatia 3 (CI #7): toggle CI-only de rate-limits rc_* permissivos. OFF por default → o gate LOCAL
# fica em defaults (mais perto de prod). Quando =1 (setado SÓ no ci.yml), o compose() layera o
# compose.ci.yaml, que troca o command do synapse p/ um segundo --config-path (homeserver.ci.yaml).
CI_RATELIMIT="${TAYET_CI_RATELIMIT:-0}"

# ── Helpers ──────────────────────────────────────────────────────────────────────────────
# Override CI-only (fatia 3): array vazio por default. O idiom ${arr[@]+"${arr[@]}"} expande para
# NADA quando o array é vazio, sem disparar "unbound variable" sob `set -u` (inclusive no bash 3.2
# default do macOS) — por isso não usamos "${arr[@]}" cru. Só popula quando o toggle está on.
CI_COMPOSE_OVERRIDE=()
if [[ "$CI_RATELIMIT" == "1" ]]; then
  CI_COMPOSE_OVERRIDE=(-f "$SCRIPT_DIR/compose.ci.yaml")
fi

compose() { docker compose -p "$PROJECT" -f "$SCRIPT_DIR/compose.yaml" ${CI_COMPOSE_OVERRIDE[@]+"${CI_COMPOSE_OVERRIDE[@]}"} "$@"; }

probe() { curl -sf -m 3 "$HS_URL/_matrix/client/versions" >/dev/null 2>&1; }

require_compose() {
  if [[ ! -f "$SCRIPT_DIR/compose.yaml" ]]; then
    echo "ERRO: não achei $SCRIPT_DIR/compose.yaml" >&2
    echo "      A stack vive AO LADO deste script em infra/dev-stack/. Este erro só ocorre" >&2
    echo "      se o checkout está corrompido ou o arquivo foi removido — restaure-o" >&2
    echo "      (git checkout infra/dev-stack/compose.yaml)." >&2
    exit 1
  fi
}

wait_for_synapse() {
  echo "Esperando o Synapse responder em $HS_URL (timeout ${WAIT_TIMEOUT_S}s)…"
  local start; start=$(date +%s)
  until probe; do
    if (( $(date +%s) - start > WAIT_TIMEOUT_S )); then
      echo "ERRO: Synapse não respondeu em ${WAIT_TIMEOUT_S}s. Veja os logs:" >&2
      echo "      ./dev-stack.sh logs synapse" >&2
      exit 1
    fi
    sleep 2
  done
  echo "Synapse OK ✅"
}

check_mas() {
  if ! docker ps --format '{{.Names}}' | grep -qx "$MAS_CONTAINER"; then
    echo "AVISO: container $MAS_CONTAINER não está up — emissão de token e auth vão falhar." >&2
    return 1
  fi
  if docker exec "$MAS_CONTAINER" mas-cli --help >/dev/null 2>&1; then
    echo "MAS OK ✅ ($MAS_CONTAINER)"
  else
    echo "AVISO: mas-cli não respondeu em $MAS_CONTAINER." >&2
  fi
}

# Gera a org key do escrow UMA VEZ (ADR-021): 32 bytes base64, gitignored, NUNCA
# commitada, NUNCA auto-regenerada (regenerar com depósitos vivos os orfana).
# Idempotente: arquivo+linha presentes → skip. Consumida só pelo `up` (via --env-file).
ensure_org_key() {
  if [[ -f "$ESCROW_ENV_FILE" ]] && grep -q '^ESCROW_ORG_KEY=' "$ESCROW_ENV_FILE"; then
    return 0
  fi
  echo "Gerando ESCROW_ORG_KEY (uma vez) em escrow.secret.env…"
  ( umask 077; printf 'ESCROW_ORG_KEY=%s\n' "$(openssl rand -base64 32)" > "$ESCROW_ENV_FILE" )
}

# P-256 pair from openssl: the raw scalar and the uncompressed point, base64url, cut from the 121-byte
# SEC1 DER (same recipe as infra/deploy/deploy.sh).
ensure_push_key() {
  if [[ -f "$PUSH_ENV_FILE" ]] && grep -q '^PUSH_VAPID_PRIVATE_KEY=' "$PUSH_ENV_FILE" && grep -q '^PUSH_VAPID_PUBLIC_KEY=' "$PUSH_ENV_FILE"; then
    return 0
  fi
  echo "Gerando o par VAPID do push (uma vez) em push.secret.env…"
  local der
  der="$(openssl ecparam -name prime256v1 -genkey -noout -outform DER | base64 | tr -d '\n')"
  ( umask 077
    printf 'PUSH_VAPID_PRIVATE_KEY=%s\n' "$(printf '%s' "$der" | base64 -d | head -c 39 | tail -c 32 | base64 | tr -d '\n=' | tr '+/' '-_')"
    printf 'PUSH_VAPID_PUBLIC_KEY=%s\n' "$(printf '%s' "$der" | base64 -d | tail -c 65 | base64 | tr -d '\n=' | tr '+/' '-_')" ) > "$PUSH_ENV_FILE"
  chmod 600 "$PUSH_ENV_FILE"
}

# Synapse auto-gera a signing key e cria o media_store em /data (bind-mount ./synapse) no
# primeiro boot, ambos como UID 991. Em Linux NATIVO o UID do container não grava o dir do host
# (o macOS mascara via Docker Desktop — por isso só o CI/Linux quebrava com PermissionError).
# Tornamos o dir gravável p/ qualquer UID antes do up: stack throwaway, zero superfície de
# segurança.
# Idempotente, uid-agnóstico. git ignora bits de perm exceto +x, e `X` não adiciona +x a
# não-executáveis → zero git-diff nos arquivos tracked; só o comportamento em disco muda.
# `|| true` (PR-5): num RE-up em Linux nativo (caso real: a remediação F8 do gate do agente
# re-invoca `up` dentro do job de CI), signing key e media_store JÁ existem como UID 991 e o
# chmod do usuário do runner falha neles — mas esses são exatamente os arquivos que o container
# já escreve; engolir a falha não perde a falsificabilidade, porque o assert real ("Synapse
# consegue escrever") é o boot saudável que o próprio `up` espera logo em seguida.
ensure_synapse_writable() {
  chmod -R a+rwX "$SCRIPT_DIR/synapse" 2>/dev/null || true
}

check_escrow() {
  if curl -sf -m 3 "$ESCROW_BASE/healthz" >/dev/null 2>&1; then
    echo "Escrow OK ✅ ($ESCROW_BASE)"
  else
    echo "AVISO: escrow não respondeu em $ESCROW_BASE/healthz." >&2
    return 1
  fi
}

wait_for_escrow() {
  echo "Esperando o escrow em $ESCROW_BASE/healthz (timeout ${WAIT_TIMEOUT_S}s)…"
  local start; start=$(date +%s)
  until curl -sf -m 3 "$ESCROW_BASE/healthz" >/dev/null 2>&1; do
    if (( $(date +%s) - start > WAIT_TIMEOUT_S )); then
      echo "ERRO: escrow não respondeu em ${WAIT_TIMEOUT_S}s. Veja: ./dev-stack.sh logs escrow" >&2
      exit 1
    fi
    sleep 2
  done
  echo "Escrow OK ✅"
}

# The org service has no published port: its /healthz is read inside the container.
org_healthy() {
  docker exec "$ORG_CONTAINER" node -e "fetch('http://localhost:8091/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
}

check_org() {
  if org_healthy; then
    echo "Org OK ✅ ($ORG_CONTAINER)"
  else
    echo "AVISO: org não respondeu em /healthz ($ORG_CONTAINER)." >&2
    return 1
  fi
}

wait_for_org() {
  local start; start=$(date +%s)
  until org_healthy; do
    if (( $(date +%s) - start > WAIT_TIMEOUT_S )); then
      echo "ERRO: org não respondeu em ${WAIT_TIMEOUT_S}s. Veja: ./dev-stack.sh logs org" >&2
      exit 1
    fi
    sleep 2
  done
  echo "Org OK ✅"
}

# The router is what answers on $ESCROW_BASE: running, and its /healthz (the escrow's) through it.
check_router() {
  if docker ps --format '{{.Names}}' | grep -qx "$ROUTER_CONTAINER" && curl -sf -m 3 "$ESCROW_BASE/healthz" >/dev/null 2>&1; then
    echo "Router OK ✅ ($ESCROW_BASE → escrow, org)"
  else
    echo "AVISO: router ($ROUTER_CONTAINER) não está de pé ou não alcança o escrow em $ESCROW_BASE." >&2
    return 1
  fi
}

check_push() {
  if curl -sf -m 3 "$PUSH_BASE/healthz" >/dev/null 2>&1; then
    echo "Push OK ✅ ($PUSH_BASE)"
  else
    echo "AVISO: push não respondeu em $PUSH_BASE/healthz." >&2
    return 1
  fi
}

wait_for_push() {
  local start; start=$(date +%s)
  until curl -sf -m 3 "$PUSH_BASE/healthz" >/dev/null 2>&1; do
    if (( $(date +%s) - start > WAIT_TIMEOUT_S )); then
      echo "ERRO: push não respondeu em ${WAIT_TIMEOUT_S}s. Veja: ./dev-stack.sh logs push" >&2
      exit 1
    fi
    sleep 2
  done
  echo "Push OK ✅"
}

# Read-only de propósito (PF-1): count via SELECT no DB `mas`, NUNCA register-user (muta)
# nem issue-compatibility-token (cunha device). Schema confirmado contra MAS 1.18 e 1.27 (as 11
# migrações 1.19→1.27 não alteram `public.users`): public.users(username text). Container do postgres via `compose -q` (sem hardcode).
check_seed() {
  local pg n
  pg=$(compose ps -q postgres 2>/dev/null) || true
  if [[ -z "$pg" ]]; then
    echo "Seed alice/bob: indeterminado (postgres não está up)."
    return 0
  fi
  n=$(docker exec "$pg" psql -U synapse -d mas -tAc \
        "SELECT count(*) FROM users WHERE username IN ('alice','bob')" 2>/dev/null | tr -d '[:space:]')
  if [[ "$n" == "2" ]]; then
    echo "Seed alice/bob: OK ✅"
  else
    echo "AVISO: seed alice/bob incompleto (${n:-0}/2) — rode ./dev-stack.sh up." >&2
  fi
}

print_env() {
  cat <<EOF

Env que o harness de teste consome (já são os defaults; export só se você mudou algo):
  export TAYET_HS_URL=$HS_URL
  export TAYET_MAS_CONTAINER=$MAS_CONTAINER
  export TAYET_MAS_CONFIG=$MAS_CONFIG

Próximo passo: rodar a suíte com a stack up → as suítes acl-attachment* deixam de auto-skipar.
  ./dev-stack.sh test
EOF
}

# ── Render de configs por projeto (fase 2, §8.R2) ─────────────────────────────────────────
# Renderiza mas/ e dex/ para <dest>/{mas,dex} trocando as portas de host que o BROWSER/host
# enxerga (issuer/public_base do MAS, issuer do Dex, redirect_uri do SPA). Portas internas da
# rede do compose (mas:8080, dex:5556, synapse:8008) não têm o prefixo `localhost:` e ficam.
# Arquivo não-yaml é copiado verbatim.
# Re-render NO LUGAR: o dir <dest>/<sub> é bind-montado nos containers vivos do projeto, e
# apagá-lo (rm -rf + mkdir) deixa o container apontando para o inode morto — o `docker exec
# mas-cli -c /config/config.yaml` do re-`up` lê config vazia (`missing field matrix`, medido no
# re-up do gate F8). Só os ARQUIVOS são trocados; o dir fica.
# Subdiretórios ficam onde estão, nos dois lados: o `mas/secrets/` (chaves geradas no `up`,
# ensure_mas_secrets) nunca é copiado da fonte nem apagado do destino.
render_files() {
  local dest="$1" mas_port="$2" dex_port="$3" spa_port="$4" sub f
  for sub in mas dex; do
    mkdir -p "$dest/$sub"
    find "$dest/$sub" -mindepth 1 -maxdepth 1 -type f -exec rm -f {} +
    for f in "$SCRIPT_DIR/$sub"/*; do
      [[ -f "$f" ]] || continue
      case "$f" in
        *.yaml|*.yml)
          sed -e "s|localhost:8080|localhost:${mas_port}|g" \
              -e "s|localhost:5556|localhost:${dex_port}|g" \
              -e "s|localhost:5173|localhost:${spa_port}|g" "$f" > "$dest/$sub/$(basename "$f")";;
        *) cp "$f" "$dest/$sub/";;
      esac
    done
  done
}

# Chamado só pelo `up`. `spike` não renderiza nada (monta os dirs commitados).
# Guard anti-vacuidade: depois do sed, (a) nenhum `localhost:` com porta default pode sobrar e
# (b) todo `localhost:<porta>` renderizado tem de ser uma das portas do projeto — um literal
# novo na config que o sed não conhece ABORTA, não passa calado (comentário incluso).
render_project_configs() {
  local f n bad
  if [[ "$PROJECT" == "spike" ]]; then
    return 0
  fi
  render_files "$RENDER_DIR" "$MAS_PORT" "$DEX_PORT" "$SPA_PORT"
  for f in "$RENDER_DIR"/mas/* "$RENDER_DIR"/dex/*; do
    # Só arquivos renderizados: `mas/secrets/` (gerado no `up`) existe a partir do segundo `up`.
    [[ -f "$f" ]] || continue
    n=$(grep -c 'localhost:\(8080\|5556\|5173\)' "$f" || true)
    bad=$(grep -on 'localhost:[0-9][0-9]*' "$f" \
      | grep -v -e ":localhost:${MAS_PORT}\$" -e ":localhost:${DEX_PORT}\$" -e ":localhost:${SPA_PORT}\$" || true)
    if [[ "$n" != "0" || -n "$bad" ]]; then
      echo "ERRO: render de $f deixou porta de host que o sed não conhece (default restante: $n):" >&2
      [[ -n "$bad" ]] && echo "$bad" >&2
      exit 1
    fi
  done
  echo "Configs MAS/Dex renderizadas para $PROJECT em .render/$PROJECT/ ✅"
}

# Prova do subcomando `render-check`: render com as portas DEFAULT num tmp e `diff -r` contra
# mas/ e dex/. Vazio = o render cobre todos os arquivos e, com portas default, é a identidade.
# `mas/secrets/` fica de fora: é gerado no `up` (por projeto), não renderizado.
render_roundtrip_check() {
  local tmp rc=0
  tmp=$(mktemp -d)
  render_files "$tmp" 8080 5556 5173
  diff -r -x secrets "$SCRIPT_DIR/mas" "$tmp/mas" || rc=1
  diff -r "$SCRIPT_DIR/dex" "$tmp/dex" || rc=1
  rm -rf "$tmp"
  return "$rc"
}

# ── Chaves do MAS (ADR-092) ───────────────────────────────────────────────────────────────
# A config versionada só aponta os arquivos (`secrets.encryption_file` e `secrets.keys_dir`);
# o material vive ao lado da config que o container monta em /config: `mas/secrets/` na `spike`,
# `.render/<projeto>/mas/secrets/` nos outros projetos. Gitignored, nunca commitado.
MAS_SECRETS_DIR="${TAYET_MAS_CONFIG_DIR:-$SCRIPT_DIR/mas}/secrets"

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
  else shasum -a 256 | cut -d' ' -f1; fi
}

# Formato, no host. O `config check` do MAS 1.27 não lê os arquivos apontados (aceita arquivo
# ausente, chave corrompida e campo com nome errado — medido): esta é a verificação de conteúdo.
# `encryption`: exatamente 64 caracteres hex, sem quebra de linha no fim. Chaves: ao menos uma,
# cada uma uma chave privada PEM que o openssl lê.
validate_mas_secrets() {
  local dir="$1" enc f n=0
  enc="$dir/encryption"
  if [[ ! -f "$enc" ]] || [[ "$(wc -c < "$enc" | tr -d ' ')" != "64" ]] \
      || ! LC_ALL=C grep -qE '^[0-9a-f]{64}$' "$enc"; then
    echo "ERRO: $enc ausente ou fora do formato (64 caracteres hex, sem quebra de linha no fim)." >&2
    return 1
  fi
  for f in "$dir"/keys/*; do
    [[ -f "$f" ]] || continue
    if ! openssl pkey -in "$f" -noout >/dev/null 2>&1; then
      echo "ERRO: $f não é uma chave privada PEM legível." >&2
      return 1
    fi
    n=$((n + 1))
  done
  if (( n == 0 )); then
    echo "ERRO: nenhuma chave em $dir/keys/." >&2
    return 1
  fi
}

# Gera as chaves do MAS UMA VEZ, com `config generate` da imagem do serviço `mas` (a mesma do
# compose, sem digest novo), e separa a `encryption` e as chaves em arquivos. Existentes → não toca:
# trocar as chaves custa a sessão do MAS no browser (ADR-092 dec. 3). Estado parcial (só um dos
# dois) aborta em vez de completar: misturar material de duas gerações não é estado conhecido.
# Arquivos 0644 e diretórios 0755: o MAS roda como uid 65532 e lê o bind-mount.
# Depois, falha fechada: formato no host e `config check` da imagem, antes de migrar.
ensure_mas_secrets() {
  local dir="$MAS_SECRETS_DIR" tmp gen n
  if [[ -e "$dir/encryption" && -d "$dir/keys" ]]; then
    echo "MAS: chaves já existem em ${dir#"$SCRIPT_DIR"/} — mantidas."
  elif [[ -e "$dir/encryption" || -e "$dir/keys" ]]; then
    echo "ERRO: ${dir#"$SCRIPT_DIR"/} incompleto (encryption ou keys/ ausente)." >&2
    echo "      Apague o diretório inteiro para gerar de novo (custa a sessão do MAS no browser)." >&2
    exit 1
  else
    echo "MAS: gerando as chaves (uma vez) em ${dir#"$SCRIPT_DIR"/}…"
    mkdir -p "$(dirname "$dir")"
    tmp="$(mktemp -d "$(dirname "$dir")/.secrets.XXXXXX")"
    gen="$tmp/generate.log"
    mkdir -p "$tmp/out/keys"
    # -T: sem TTY, senão o compose devolve CRLF. stdout é o YAML; stderr é log.
    if ! compose run --rm --no-deps -T mas config generate > "$tmp/config.yaml" 2> "$gen"; then
      cat "$gen" >&2
      rm -rf "$tmp"
      echo "ERRO: 'mas-cli config generate' falhou — o up foi abortado." >&2
      exit 1
    fi
    awk -v out="$tmp/out" '
      /^secrets:/ { s = 1; next }
      s && /^[^[:space:]]/ { s = 0 }
      !s { next }
      /^  encryption: / { printf "%s", $2 > (out "/encryption"); close(out "/encryption"); next }
      /^  - key: \|$/ { if (f) close(f); n++; f = sprintf("%s/keys/%02d.pem", out, n); next }
      f && /^      / { print substr($0, 7) > f; next }
      { if (f) close(f); f = "" }
    ' "$tmp/config.yaml"
    n=$(find "$tmp/out/keys" -type f | wc -l | tr -d ' ')
    if [[ "$n" != "4" ]] || ! validate_mas_secrets "$tmp/out"; then
      rm -rf "$tmp"
      echo "ERRO: não consegui separar a encryption e as 4 chaves do 'config generate' ($n chaves)." >&2
      exit 1
    fi
    chmod 0755 "$tmp/out" "$tmp/out/keys"
    chmod 0644 "$tmp/out/encryption" "$tmp/out/keys"/*
    mv "$tmp/out" "$dir"
    rm -rf "$tmp"
    echo "MAS: chaves geradas ✅"
  fi
  if ! validate_mas_secrets "$dir"; then
    echo "ERRO: chaves do MAS inválidas — o up foi abortado." >&2
    exit 1
  fi
  if ! compose run --rm --no-deps -T mas --config "$MAS_CONFIG" config check; then
    echo "ERRO: 'mas-cli config check' falhou com as referências de arquivo — o up foi abortado." >&2
    exit 1
  fi
}

# Hash do conteúdo de secrets/ (nomes e bytes), para o marcador de restart do MAS.
mas_secrets_sum() {
  local f
  ( cd "$MAS_SECRETS_DIR" && find . -type f | LC_ALL=C sort | while IFS= read -r f; do
      printf '%s %s\n' "$f" "$(sha256_stdin < "$f")"
    done ) | sha256_stdin
}

# Depois do boot: o MAS publica no JWKS uma chave por arquivo de keys/. É a única prova, contra o
# binário, de que `keys_dir` foi lido (o `config check` não lê). Falha aborta o up.
check_mas_keys() {
  local want got jwks start
  want=$(find "$MAS_SECRETS_DIR/keys" -type f | wc -l | tr -d ' ')
  start=$(date +%s)
  until jwks=$(curl -sf -m 3 "$MAS_HOST_URL/oauth2/keys.json"); do
    if (( $(date +%s) - start > WAIT_TIMEOUT_S )); then
      echo "ERRO: JWKS do MAS não respondeu em ${WAIT_TIMEOUT_S}s ($MAS_HOST_URL/oauth2/keys.json)." >&2
      exit 1
    fi
    sleep 2
  done
  # Cada JWK do MAS carrega um `kid`; contar a chave basta (sem jq/node no host).
  got=$(grep -o '"kid"' <<<"$jwks" | wc -l | tr -d ' ')
  if [[ "$got" != "$want" ]]; then
    echo "ERRO: o MAS publica $got chave(s) no JWKS; keys/ tem $want — keys_dir não foi lido." >&2
    exit 1
  fi
  echo "MAS: $got chaves no JWKS ✅"
}

# ── Comandos ─────────────────────────────────────────────────────────────────────────────

# Migrações + config sync do MAS, ANTES do server do MAS subir. `compose run` honra o
# depends_on (postgres healthy), então o Postgres sobe primeiro e o initdb (banco `mas`)
# já aconteceu quando o migrate roda. Ambos idempotentes: migrate aplica só o que falta,
# sync compara com o banco. Falha aqui aborta o up — seguir com MAS quebrado só adiaria o
# erro para o aviso tardio "container não está up" do check_mas.
mas_migrate_and_sync() {
  echo "MAS: database migrate…"
  if ! compose run --rm mas --config "$MAS_CONFIG" database migrate; then
    echo "ERRO: 'mas-cli database migrate' falhou — o up foi abortado (MAS subiria quebrado)." >&2
    echo "      Veja os logs acima; estado sujo do Postgres se resolve com ./dev-stack.sh reset." >&2
    exit 1
  fi
  echo "MAS: config sync --prune…"
  if ! compose run --rm mas --config "$MAS_CONFIG" config sync --prune; then
    echo "ERRO: 'mas-cli config sync --prune' falhou — o up foi abortado (MAS subiria quebrado)." >&2
    exit 1
  fi
}

# O MAS só lê a config no boot, e o `up -d` não recria o serviço quando só o conteúdo montado muda
# (incidente de produção de 02/Nov, PLANO-PESSOAS §8.4). Mesma regra do deploy.sh, com o marcador em
# .render/. Sem container de pé não há o que reiniciar: o `up -d` lê a config atual.
restart_mas_if_config_changed() {
  local config marker sum
  config="${TAYET_MAS_CONFIG_DIR:-$SCRIPT_DIR/mas}/$(basename "$MAS_CONFIG")"
  marker="$RENDER_DIR/.mas-config.sha"
  if command -v sha256sum >/dev/null 2>&1; then sum="$(sha256sum "$config" | cut -d' ' -f1)"
  else sum="$(shasum -a 256 "$config" | cut -d' ' -f1)"; fi
  # Os templates (ADR-084) também só são lidos no boot: entram no marcador.
  sum="$sum $("$MAS_TEMPLATES_PREPARE" sum)"
  # As chaves de secrets/ também (ADR-092 dec. 3): trocá-las reinicia o MAS.
  sum="$sum $(mas_secrets_sum)"
  if [[ "$(cat "$marker" 2>/dev/null)" == "$sum" ]]; then return 0; fi
  if [[ "$(docker inspect -f '{{.State.Running}}' "$MAS_CONTAINER" 2>/dev/null)" == "true" ]]; then
    docker restart "$MAS_CONTAINER" >/dev/null
    echo "MAS: config mudou — reiniciado ✅"
  fi
  mkdir -p "$RENDER_DIR"
  printf '%s\n' "$sum" > "$marker"
}

# Provisiona um usuário de teste quando ausente (o caso pós-`reset`). Detecção de
# existência: o próprio register-user — o erro "User already exists" é o sinal de skip.
# Mais direto que issue-compatibility-token (sucesso = existe), que cunharia uma compat
# session/device NOVA a cada up — exatamente a acumulação que este ciclo quer evitar.
# --ignore-password-complexity é obrigatório: as senhas throwaway documentadas no README
# não passam no minimum_complexity 3 da config (PF no README).
provision_user() {
  local user="$1" pass="$2" out
  if out=$(docker exec "$MAS_CONTAINER" mas-cli manage register-user -c "$MAS_CONFIG" \
      --yes --ignore-password-complexity --password "$pass" "$user" 2>&1); then
    echo "Usuário $user provisionado ✅"
  elif grep -q "User already exists" <<<"$out"; then
    echo "Usuário $user já existe — skip."
  else
    echo "ERRO: provisionamento de $user falhou:" >&2
    echo "$out" >&2
    exit 1
  fi
}

# Admin da organização = flag `admin` do MAS (ADR-083 dec. 7), idempotente. No dev-stack é `alice`,
# a fixture admin da org. NUNCA para `system` (ADR-054 dec. 3).
promote_org_admin() {
  local user="$1" out
  if ! out=$(docker exec "$MAS_CONTAINER" mas-cli manage promote-admin -c "$MAS_CONFIG" "$user" 2>&1); then
    echo "ERRO: promote-admin de $user falhou:" >&2
    echo "$out" >&2
    exit 1
  fi
  echo "Admin da org: $user ✅"
}

# Canal da organização (ADR-045): sala PÚBLICA e EM CLARO (sem m.room.encryption — a regra
# "public → claro" da ADR-045), de posse da conta system, com alias canônico. Idempotência
# por resolução de alias ANTES de cunhar token: o up rotineiro (sala já existe) não cunha
# compat session nenhuma — só o up criador cunha uma, uma vez (mesma disciplina anti-
# acumulação do provision_user acima). server_name fixo do dev-stack (homeserver.yaml).
ORG_CHANNEL_LOCALPART="all"
ORG_SERVER_NAME="tayet.local"
ORG_CHANNEL_ALIAS_ENC="%23${ORG_CHANNEL_LOCALPART}%3A${ORG_SERVER_NAME}"

# Probe de ativação de token (issue #7 M2): um mct_ recém-cunhado pode ser rejeitado
# M_UNKNOWN_TOKEN no PRIMEIRO uso (janela entre o mint no mas-cli e a visibilidade na
# introspecção MAS→Synapse — 2 boot-fails no soak de Jul/2026, PLANO-GATES §8.1).
# Espera o whoami aceitar o token antes de qualquer uso. Budget 30s, poll 1s.
# Causa (PLANO-GATES §8.10): corrida de device no mint — o issue-compatibility-token faz
# upsert_device ANTES de gravar a compat session e fora do lock do SyncDevicesJob; um sync
# concorrente apaga o device e nada o recria sem um novo SyncDevicesJob da conta. Assinatura:
# whoami 401 com o MAS dizendo ativo. No PRIMEIRO whoami 401 o token é introspectado direto no
# MAS: ativo → return 2 (o chamador re-cunha via mint_active_token); qualquer outro resultado
# segue o poll. Estritamente 401: 429/5xx com MAS ativo não são a corrida e não entram na conta.
probe_token_active() {
  local token="$1" start now code introspected=""
  start=$(date +%s)
  while :; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
      -H "Authorization: Bearer $token" \
      "$HS_URL/_matrix/client/v3/account/whoami")
    if [ "$code" = "200" ]; then
      return 0
    fi
    if [ -z "$introspected" ] && [ "$code" = "401" ]; then
      introspected=$(mas_introspect "$token")
      if [ "$introspected" = "active" ]; then
        return 2
      fi
    fi
    now=$(date +%s)
    if [ $((now - start)) -ge 30 ]; then
      echo "ERRO: token não ativou após $((now - start))s (último HTTP $code no whoami;" \
        "introspecção MAS: 1º 401=${introspected:-não feita}, no budget=$(mas_introspect "$token"))." >&2
      exit 1
    fi
    sleep 1
  done
}

# Introspecção direta no MAS publicado no host — o discriminador do M2 (PLANO-GATES §8.10).
# Cópia DECLARADA do client de introspecção throwaway de mas/config.yaml (`clients:`, o
# ...ESCR0W); o shell não importa do harness TS, cuja fonte única é test/support/escrow-harness.ts.
# Ecoa active | inactive só com HTTP 200; outro status → diag-failed(http-<code>); falha de
# transporte → diag-failed. Nunca falha (best-effort, não derruba o up).
MAS_HOST_URL="${TAYET_MAS_URL:-http://localhost:${MAS_PORT}}"
MAS_INTROSPECT_CLIENT_ID="${TAYET_MAS_INTROSPECT_CLIENT_ID:-00000000000000000000ESCR0W}"
MAS_INTROSPECT_CLIENT_SECRET="${TAYET_MAS_INTROSPECT_CLIENT_SECRET:-tayet-dev-stack-throwaway-escrow-introspection}"
mas_introspect() {
  local out status body
  out=$(curl -s -m 5 -w '\n%{http_code}' -u "$MAS_INTROSPECT_CLIENT_ID:$MAS_INTROSPECT_CLIENT_SECRET" \
    --data-urlencode "token=$1" -d token_type_hint=access_token \
    "$MAS_HOST_URL/oauth2/introspect") || { echo "diag-failed"; return 0; }
  status=${out##*$'\n'}
  body=${out%$'\n'*}
  if [ "$status" != "200" ]; then
    echo "diag-failed(http-$status)"
  elif grep -q '"active":true' <<<"$body"; then
    echo "active"
  else
    echo "inactive"
  fi
}

# Cunha um mct_ para <conta> e espera a ativação; na assinatura do M2 (probe → 2) re-cunha UMA
# vez, com a linha contável [m2-device-race] em stderr. Segunda assinatura → exit 1. O token sai
# em MINTED_TOKEN (global, não subshell: o exit 1 tem de derrubar o script, não um $(…)).
MINTED_TOKEN=""
mint_active_token() {
  local account="$1" attempt rc
  for attempt in 1 2; do
    MINTED_TOKEN=$(docker exec "$MAS_CONTAINER" mas-cli manage issue-compatibility-token \
      -c "$MAS_CONFIG" "$account" 2>&1 | grep -m1 -oE 'mct_[A-Za-z0-9_]+') || true
    if [ -z "$MINTED_TOKEN" ]; then
      echo "ERRO: não consegui cunhar token para a conta $account." >&2
      exit 1
    fi
    rc=0
    probe_token_active "$MINTED_TOKEN" || rc=$?
    if [ "$rc" -eq 0 ]; then
      return 0
    fi
    if [ "$attempt" -eq 1 ]; then
      echo "[m2-device-race] re-mint para $account (token mct_…${MINTED_TOKEN: -6})" >&2
    fi
  done
  echo "ERRO: token não ativou para a conta $account — a assinatura [m2-device-race]" \
    "(whoami 401 com MAS ativo) repetiu após o re-mint." >&2
  exit 1
}

# ── Pertencimento à organização (ADR-083) ────────────────────────────────────────────────
# Quem é da org é quem o `system` convidou para o #all; `kind` é o state event io.tayet.member, com
# state_key = mxid SEM o `@`: o Synapse recusa state_key `@…` de outra conta, mesmo com PL 100
# (403 "You are not allowed to set others state", medido). Ausência do evento = guest.
ORG_MEMBER_EVENT="io.tayet.member"

# Mapa `events` inteiro no createRoom: power_level_content_override SUBSTITUI o default do Synapse,
# então citar só a chave nova baixaria m.room.power_levels & cia. de 100 para o state_default (50).
ORG_POWER_EVENTS='{"m.room.name":50,"m.call.invite":50,"m.room.power_levels":100,"m.room.history_visibility":100,"m.room.canonical_alias":50,"m.room.avatar":50,"m.room.tombstone":100,"m.room.server_acl":100,"m.room.encryption":100,"io.tayet.member":100}'

# Uma chamada de escrita de #all, com 429 honrado; ecoa o HTTP final. /invite e PUT de state caem
# no rc_message do EMISSOR (burst 10, depois 1 a cada 5 s no default, medido): espera o retry_after
# em vez de insistir, porque tentativa rejeitada também conta e martelar escala a espera.
org_room_call() {
  local method="$1" url="$2" body="$3" token="$4" attempt out code ms
  for attempt in 1 2 3 4 5 6 7 8; do
    out=$(curl -s -m 15 -w '\n%{http_code}' -X "$method" \
      -H "Authorization: Bearer $token" -H "Content-Type: application/json" -d "$body" "$url")
    code=${out##*$'\n'}
    if [ "$code" != "429" ]; then
      echo "$code"
      return 0
    fi
    ms=$(sed -nE 's/.*"retry_after_ms":([0-9]+).*/\1/p' <<<"$out")
    sleep $(( ${ms:-5000} / 1000 + 1 ))
  done
  echo "$code"
}

# Resumo do state de #all, uma linha por fato: `joinrule <regra>`, `gated`, `member <mxid> <membership>`,
# `kind <state_key>`, `kind <state_key> email` (o evento já tem email), `guest <state_key>`,
# `removed <state_key>` (lápide). Evento io.tayet.member de conteúdo vazio é ausência (remoção legada,
# ADR-083 dec. 8); a lápide `{ removed: true, kind }` é `kind` gravado e imutável (ADR-086 dec. 4).
org_state_summary() {
  perl -MJSON::PP -e '
    local $/; my $state = decode_json(<STDIN>);
    for my $e (@$state) {
      my ($t, $k, $c) = ($e->{type}, $e->{state_key}, $e->{content} // {});
      if    ($t eq "m.room.join_rules")  { print "joinrule $c->{join_rule}\n" }
      elsif ($t eq "m.room.power_levels") { print "gated\n" if exists $c->{events}{"io.tayet.member"} }
      elsif ($t eq "m.room.member")      { print "member $k $c->{membership}\n" }
      elsif ($t eq "io.tayet.member" && %$c) {
        print "kind $k\n";
        print "kind $k email\n" if length($c->{email} // "");
        print "guest $k\n" if ($c->{kind} // "") eq "guest";
        print "removed $k\n" if $c->{removed};
      }
    }'
}

# O mesmo power-levels com io.tayet.member fixado em 100; o resto do evento fica como está.
org_power_levels_gated() {
  perl -MJSON::PP -e '
    local $/; my $c = decode_json(<STDIN>);
    $c->{events}{"io.tayet.member"} = 100;
    print JSON::PP->new->canonical->encode($c)'
}

# Conteúdo de io.tayet.member; campo vazio fica de fora.
org_member_content() {
  perl -MJSON::PP -e '
    my %c = (kind => $ARGV[0]);
    $c{name} = $ARGV[1] if length $ARGV[1];
    $c{email} = $ARGV[2] if length $ARGV[2];
    print JSON::PP->new->canonical->encode(\%c)' "$1" "$2" "$3"
}

# Linha da pessoa no diretório renderizado; vazia sem diretório ou sem a pessoa.
org_member_line() {
  [ -f "$DIRECTORY_TSV" ] || return 0
  org_tsv_line "$DIRECTORY_TSV" "${1%%:*}"
}

# Grava o evento, com nome e email quando a TSV os tem; ecoa nada, falha alto: sem o evento a pessoa
# viraria guest em silêncio.
org_mark_member() {
  local key="$1" token="$2" room="$3" kind="${4:-member}" line code
  line=$(org_member_line "$key")
  code=$(org_room_call PUT \
    "$HS_URL/_matrix/client/v3/rooms/$room/state/$ORG_MEMBER_EVENT/${key/:/%3A}" \
    "$(org_member_content "$kind" "$(cut -f2 <<<"$line")" "$(cut -f4 <<<"$line")")" "$token")
  case "$code" in
    2*) ;;
    *)  echo "ERRO: PUT de $ORG_MEMBER_EVENT para $key devolveu HTTP $code." >&2; exit 1;;
  esac
}

seed_org_channel() {
  local code token res
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
    "$HS_URL/_matrix/client/v3/directory/room/$ORG_CHANNEL_ALIAS_ENC")
  if [ "$code" = "200" ]; then
    echo "Canal #${ORG_CHANNEL_LOCALPART} já existe — skip."
    return 0
  fi
  if [ "$code" != "404" ]; then
    echo "ERRO: resolução do alias do canal da org devolveu HTTP $code (esperado 200|404)." >&2
    exit 1
  fi
  mint_active_token system
  token="$MINTED_TOKEN"
  # Nenhum m.room.encryption no initial_state — nasce em claro (ADR-045). Preset public_chat +
  # join_rule invite (ADR-083 dec. 2), não private_chat: este liga guest_access e, sob
  # encryption_enabled_by_default_for_room_type, a cifra. room_alias_name registra o alias (o
  # Synapse o promove a canonical alias na criação).
  res=$(curl -s -m 10 -X POST \
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
    -d "{\"preset\":\"public_chat\",\"room_alias_name\":\"$ORG_CHANNEL_LOCALPART\",\"name\":\"$ORG_CHANNEL_LOCALPART\",\"initial_state\":[{\"type\":\"m.room.join_rules\",\"state_key\":\"\",\"content\":{\"join_rule\":\"invite\"}}],\"power_level_content_override\":{\"events\":$ORG_POWER_EVENTS}}" \
    "$HS_URL/_matrix/client/v3/createRoom")
  if grep -q '"room_id"' <<<"$res"; then
    echo "Canal #${ORG_CHANNEL_LOCALPART} criado ✅"
  else
    echo "ERRO: criação do canal da org falhou: $res" >&2
    exit 1
  fi
}

# Idempotente, a cada `up`: migra #all (one-shot) e reconcilia o pertencimento. O evento vem ANTES do
# convite, para a pessoa já ser `member` no primeiro boot, e vale para quem ainda não logou: o convite
# de conta sem 1º login é aceito (200) e não a cria (o pré-check do sync_org_directory segue em 404).
# ORG_GUESTS: fixture só do dev-stack. Contas da allowlist que ficam de fora de #all, para o tier E2E
# ter guest nascido pelo Dex; em produção guest é quem o admin não convidou (P2).
ORG_GUESTS="lua nic gho fal enzo"
sync_org_membership() {
  local resolved room_id room token state status allowlist line mxid membership u key code body kind backfilled=0
  allowlist=$(awk '/^[[:space:]]+username:/ { gsub(/.*username:[[:space:]]*"?|"[[:space:]]*$/, ""); print }' "$SCRIPT_DIR/dex/config.yaml")
  if [ -z "$allowlist" ]; then
    echo "ERRO: allowlist do Dex ilegível ou vazia." >&2
    exit 1
  fi

  resolved=$(curl -s -m 5 "$HS_URL/_matrix/client/v3/directory/room/$ORG_CHANNEL_ALIAS_ENC")
  room_id=$(sed -nE 's/.*"room_id":"([^"]+)".*/\1/p' <<<"$resolved")
  if [ -z "$room_id" ]; then
    echo "ERRO: alias do canal da org não resolveu: $resolved" >&2
    exit 1
  fi
  room=${room_id/!/%21}
  room=${room/:/%3A}

  mint_active_token system
  token="$MINTED_TOKEN"

  state=$(curl -s -m 15 -H "Authorization: Bearer $token" "$HS_URL/_matrix/client/v3/rooms/$room/state")
  status=$(org_state_summary <<<"$state") || {
    echo "ERRO: state do canal da org ilegível: ${state:0:200}" >&2
    exit 1
  }

  # 1. Migração one-shot de #all nascido público (ADR-083 dec. 2); reversível por PUT manual.
  if ! grep -qx 'joinrule invite' <<<"$status"; then
    code=$(org_room_call PUT "$HS_URL/_matrix/client/v3/rooms/$room/state/m.room.join_rules" \
      '{"join_rule":"invite"}' "$token")
    case "$code" in
      2*) echo "Canal #${ORG_CHANNEL_LOCALPART} migrado para convite ✅";;
      *)  echo "ERRO: migração do join_rule devolveu HTTP $code." >&2; exit 1;;
    esac
  fi
  if ! grep -qx 'gated' <<<"$status"; then
    body=$(curl -s -m 10 -H "Authorization: Bearer $token" \
      "$HS_URL/_matrix/client/v3/rooms/$room/state/m.room.power_levels" | org_power_levels_gated)
    code=$(org_room_call PUT "$HS_URL/_matrix/client/v3/rooms/$room/state/m.room.power_levels" "$body" "$token")
    case "$code" in
      2*) echo "Canal #${ORG_CHANNEL_LOCALPART}: $ORG_MEMBER_EVENT restrito ao system ✅";;
      *)  echo "ERRO: migração do power-levels devolveu HTTP $code." >&2; exit 1;;
    esac
  fi

  # Em todo passo abaixo: `kind` gravado (vivo ou lápide) não é reescrito, e conta `a-` (agente,
  # ADR-086 dec. 1/3) é pulada inteira: nunca marcada member, nunca convidada para #all.

  # 2. Quem já está em #all é da org (migração); contas de serviço não são gente.
  while read -r _ mxid membership; do
    [ "$membership" = "join" ] || continue
    u=${mxid#@}
    u=${u%%:*}
    case "$u" in system|cofre|a-*) continue;; esac
    case " $ORG_GUESTS " in *" $u "*) continue;; esac
    key=${mxid#@}
    grep -qx "kind $key" <<<"$status" || org_mark_member "$key" "$token" "$room"
  done <<<"$(grep '^member ' <<<"$status")"

  # 3. Toda a allowlist é membro, exista a conta ou não.
  for u in $allowlist; do
    case "$u" in a-*) continue;; esac
    case " $ORG_GUESTS " in *" $u "*) continue;; esac
    key="$u:$ORG_SERVER_NAME"
    grep -qx "kind $key" <<<"$status" || org_mark_member "$key" "$token" "$room"
    # Removido (lápide) ou guest gravado não volta para #all pelo provisionador.
    if grep -qxE "(removed|guest) $key" <<<"$status"; then
      continue
    fi
    if grep -qE "^member @$u:$ORG_SERVER_NAME (join|invite)$" <<<"$status"; then
      continue
    fi
    code=$(org_room_call POST "$HS_URL/_matrix/client/v3/rooms/$room/invite" \
      "{\"user_id\":\"@$key\"}" "$token")
    case "$code" in
      2*)      echo "Convite para #${ORG_CHANNEL_LOCALPART}: $u ✅";;
      403|409) echo "Convite para #${ORG_CHANNEL_LOCALPART}: $u recusado (HTTP $code) — segue.";;
      *)       echo "ERRO: convite de $u devolveu HTTP $code." >&2; exit 1;;
    esac
  done

  # 4. Backfill de email para a lista de Pessoas (P3): evento vivo sem email, com linha na TSV. O
  # `kind` gravado fica; lápide e agente não são tocados; sem linha, nada.
  for key in $(sed -nE 's/^kind ([^ ]+)$/\1/p' <<<"$status"); do
    case "$key" in a-*) continue;; esac
    grep -qx "removed $key" <<<"$status" && continue
    grep -qx "kind $key email" <<<"$status" && continue
    line=$(org_member_line "$key")
    [ -n "$(cut -f4 <<<"$line")" ] || continue
    kind=member
    grep -qx "guest $key" <<<"$status" && kind=guest
    org_mark_member "$key" "$token" "$room" "$kind"
    backfilled=$((backfilled + 1))
  done
  [ "$backfilled" -eq 0 ] || echo "Email de $backfilled pessoa(s) preenchido em $ORG_MEMBER_EVENT ✅"

  # O token não sobrevive à função.
  unset token
  echo "Pertencimento à organização sincronizado ✅"
}

# ── Diretório organizacional (ADR-054) ───────────────────────────────────────────────────
# Sync DECLARATIVO de directory.tsv para o sink MSC4133 do perfil (dec. 4/5). A ESPINHA é a
# allowlist do Dex; o TSV é a TABELA DE ATRIBUTOS, join por `username`. Campo vazio não é
# "não mexer": é ausência declarada → DELETE da chave. Apagar no TSV apaga no servidor.
#
# O writer usa um token admin EFÊMERO (dec. 5): o privilégio é do TOKEN, nunca da conta —
# nada de promote-admin. O token vive só nesta função, em variável local, e morre no unset.
#
# Alvo que ainda não fez o 1º login não existe no Synapse (ADR-048: a conta nasce no 1º
# login). No Synapse 1.154.0, escrever cego nele crashava com TypeError não tratado e devolvia
# 500 M_UNKNOWN (medido — addendum da dec. 6); desde o 1.161.0 (#20172) o PUT devolve 404
# M_NOT_FOUND (re-medido no 1.163.0, PLANO-RELEASE-PUBLICA §8.39). O pré-check segue: um
# `GET /_synapse/admin/v2/users/{alvo}`, que trata alvo inexistente como erro modelado
# (404 M_NOT_FOUND, zero Traceback). O writer pergunta na rota que responde e
# escreve na rota que escreve. É também a única ocorrência de admin API permitida neste
# repo — GET, nunca escrita (invariante estreitado e ratificado no addendum).
DIRECTORY_TSV="$SCRIPT_DIR/directory.tsv"
DEX_CONFIG="$SCRIPT_DIR/dex/config.yaml"

# Escapa um valor de TSV para interpolação em JSON: barra invertida ANTES da aspa, senão a
# barra injetada pelo segundo passo seria re-escapada pelo primeiro.
json_escape() { printf '%s' "$1" | perl -pe 's/\\/\\\\/g; s/"/\\"/g'; }

# Linha do TSV de um username (vazio se ausente). `#` e linhas em branco são ignoradas.
org_tsv_line() { awk -F'\t' -v u="$2" '!/^#/ && $1 == u { print; exit }' "$1"; }

# Aplica UMA chave org no perfil do alvo, via client-API (dec. 5 — NUNCA a admin API, que
# responde 200 e descarta o campo custom: falha silenciosa provada). Valor não-vazio → PUT;
# vazio → DELETE, que é o que torna o sync declarativo. 404/405 no DELETE de chave que já
# não existe é benigno (nada a apagar = estado desejado). PUT que falha DEPOIS de um
# pré-check aprovado só pode ser servidor com problema → falha alto, como provision_user.
# NUNCA fazemos GET do perfil antes de escrever: não funciona (403 sob os knobs do ADR-052)
# e read-before-write não é o modelo — o TSV é a autoridade.
org_apply_key() {
  local u="$1" key="$2" val="$3" token="$4" url code
  url="$HS_URL/_matrix/client/v3/profile/@$u:$ORG_SERVER_NAME/$key"
  if [ -n "$val" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X PUT \
      -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
      -d "{\"$key\": \"$(json_escape "$val")\"}" "$url")
    case "$code" in
      2*) echo "  $u · $key ← \"$val\" ✅";;
      *)  echo "ERRO: PUT de $key em $u devolveu HTTP $code após pré-check aprovado." >&2
          exit 1;;
    esac
  else
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X DELETE \
      -H "Authorization: Bearer $token" "$url")
    case "$code" in
      2*|404|405) echo "  $u · $key apagado (ausência declarada) ✅";;
      *) echo "ERRO: DELETE de $key em $u devolveu HTTP $code." >&2; exit 1;;
    esac
  fi
}

sync_org_directory() {
  local allowlist u line token="" full_name job_title work_email code d

  # 1. Org sem diretório é estado VÁLIDO, não erro.
  if [ ! -f "$DIRECTORY_TSV" ]; then
    echo "Diretório organizacional ausente ($DIRECTORY_TSV) — sem camada organizacional."
    return 0
  fi

  # 2. A allowlist é a espinha. Ilegível não é "sem gente": é erro duro.
  allowlist=$(awk '/^[[:space:]]+username:/ { gsub(/.*username:[[:space:]]*"?|"[[:space:]]*$/, ""); print }' "$DEX_CONFIG")
  if [ -z "$allowlist" ]; then
    echo "ERRO: allowlist do Dex ilegível ou vazia em $DEX_CONFIG." >&2
    exit 1
  fi

  echo "Sincronizando diretório organizacional…"

  # 3/4. Na ordem da allowlist. O token é cunhado NA PRIMEIRA linha casada e reusado pelo
  # loop inteiro — allowlist sem nenhum join não cunha nada (disciplina anti-acumulação de
  # compat session, a mesma do provision_user e do seed_org_channel).
  for u in $allowlist; do
    line=$(org_tsv_line "$DIRECTORY_TSV" "$u")
    if [ -z "$line" ]; then
      echo "Perfil org de $u: sem linha no diretório — sem camada organizacional."
      continue
    fi

    if [ -z "$token" ]; then
      token=$(docker exec "$MAS_CONTAINER" mas-cli manage issue-compatibility-token \
        -c "$MAS_CONFIG" --yes-i-want-to-grant-synapse-admin-privileges system 2>&1 \
        | grep -m1 -oE 'mct_[A-Za-z0-9_]+') || true
      if [ -z "$token" ]; then
        echo "ERRO: não consegui cunhar o token admin efêmero do diretório." >&2
        exit 1
      fi
    fi

    code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
      -H "Authorization: Bearer $token" \
      "$HS_URL/_synapse/admin/v2/users/@$u:$ORG_SERVER_NAME")
    case "$code" in
      404) echo "Perfil org de $u: alvo ainda não existe (1º login pendente) — skip."
           continue;;
      200) ;;
      *)   echo "ERRO: pré-check de $u devolveu HTTP $code (esperado 200|404)." >&2
           unset token
           exit 1;;
    esac

    full_name=$(printf '%s' "$line" | cut -f2)
    job_title=$(printf '%s' "$line" | cut -f3)
    work_email=$(printf '%s' "$line" | cut -f4)
    echo "Perfil org de $u:"
    org_apply_key "$u" "io.tayet.full_name"  "$full_name"  "$token"
    org_apply_key "$u" "io.tayet.job_title"  "$job_title"  "$token"
    org_apply_key "$u" "io.tayet.work_email" "$work_email" "$token"
  done

  # 5. Linha no diretório sem correspondente na allowlist: typo provável. Avisa e SEGUE —
  # o TSV é editado à mão, e reprovar o `up` inteiro por um typo é desproporcional.
  while IFS= read -r d; do
    [ -z "$d" ] && continue
    if ! printf '%s\n' "$allowlist" | grep -qx "$d"; then
      echo "AVISO: '$d' está no diretório mas não na allowlist do Dex — typo?" >&2
    fi
  done <<< "$(awk -F'\t' '!/^#/ && NF && $1 != "" { print $1 }' "$DIRECTORY_TSV")"

  # 6. O token não sobrevive à função.
  unset token
  echo "Diretório organizacional sincronizado ✅"
}

# ── Revogação da sessão de serviço (ADR-054 dec. 5, addendum de 2026-07-23) ──────────────
# Sweep de TODAS as compat sessions da conta de serviço ao fim do `up`. Armada por `trap` no
# cmd_up, cobre sucesso, falha e interrupção. Alvo EXCLUSIVO: a conta de serviço — NUNCA conta
# humana. O harness de integração cunha tokens de alice/bob (mintToken); varrê-los derrubaria
# teste em execução (§3 do PLANO).
#
# (i)   O grão — TODAS as sessões do usuário — é ACERTO, não limitação. `system` é conta de
#       serviço: nasce por register-user --yes, não tem caminho de login (ADR-048), e todos os
#       consumidores são one-shot (seed_org_channel cunha/cria/termina; sync_org_directory
#       cunha/escreve/termina). Nenhuma sessão legítima de `system` é longeva, logo « derrubar
#       todas » ≡ « derrubar as que já cumpriram seu papel » (§8 do PLANO, "Grão de revogação").
# (ii)  Efeito colateral aceito EM DEV: quem cunhar um token manual de `system`
#       (./dev-stack.sh token system) e rodar `up` em seguida PERDE esse token. É o único caso
#       em que o grão morde — comentário, não desenho (§8 do PLANO, "Grão de revogação").
# (iii) A sweep ENCERRA (finished_at), NÃO remove: as linhas permanecem. Ela troca credencial
#       ATIVA (superfície de ataque) por linha finalizada (trilha de auditoria) — e NÃO elimina
#       acúmulo de linhas (§8 do PLANO, "A sweep troca o que acumula").
#
# Idempotente: kill-sessions sobre conta sem sessão ativa é no-op (medido, PR-1b §0.3).
# Degrada limpo: MAS ausente/mudo — caso real do `up` que falhou ANTES de subir a stack —
# vira aviso + return, sem empilhar um segundo erro confuso sobre o primeiro.
# NUNCA mascara o código de saída original: a função roda de um trap, então captura o status na
# ENTRADA (rc) e o RESTAURA em toda saída. Sob `set -e`, um comando interno que falha sem guarda
# no trap flipa exit 0 → exit 1 (medido) — por isso cada comando é guardado.
SERVICE_ACCOUNT="system"
revoke_service_sessions() {
  local rc=$?
  local out
  if ! docker exec "$MAS_CONTAINER" mas-cli --help >/dev/null 2>&1; then
    echo "AVISO: MAS ($MAS_CONTAINER) indisponível — sessões de $SERVICE_ACCOUNT não revogadas." >&2
    return "$rc"
  fi
  if out=$(docker exec "$MAS_CONTAINER" mas-cli manage kill-sessions -c "$MAS_CONFIG" "$SERVICE_ACCOUNT" 2>&1); then
    echo "Sessões de $SERVICE_ACCOUNT revogadas ✅"
  else
    echo "AVISO: revogação das sessões de $SERVICE_ACCOUNT falhou:" >&2
    echo "$out" >&2
  fi
  return "$rc"
}

# ── Agente de custódia `cofre` (PR-3, ADR-057 dec. 5) ────────────────────────────────────
# Secrets do agente, AO LADO do escrow.secret.env e com a mesma disciplina (gitignored,
# umask 077, gerados uma vez, NUNCA auto-regenerados sem motivo):
#   agent.secret.env    — AGENT_STORAGE_KEY (32 bytes base64; cifra o crypto store — S2.1)
#   agent-token.secret  — mct_ do cofre, bind-montado no container
AGENT_DIR="$REPO_ROOT/agent"
AGENT_SECRET_ENV="$SCRIPT_DIR/agent.secret.env"
AGENT_TOKEN_FILE_HOST="$SCRIPT_DIR/$AGENT_TOKEN_BASENAME"

ensure_agent_storage_key() {
  if [[ -f "$AGENT_SECRET_ENV" ]] && grep -q '^AGENT_STORAGE_KEY=' "$AGENT_SECRET_ENV"; then
    return 0
  fi
  echo "Gerando AGENT_STORAGE_KEY (uma vez) em agent.secret.env…"
  ( umask 077; printf 'AGENT_STORAGE_KEY=%s\n' "$(openssl rand -base64 32)" > "$AGENT_SECRET_ENV" )
}

# Shell efêmero com o volume de dados do agente montado (agentdata é volume nomeado,
# sem bind no host). `compose run` reusa a definição do serviço — imagem pinada e mounts
# vêm do compose.yaml, zero duplicação de digest aqui. --no-deps: nada sobe junto.
agent_data_sh() {
  compose run --rm --no-deps agent sh -c "$1" 2>/dev/null
}

# Token do cofre: mct_ de CLI não expira (S2.5) — minta UMA vez e reuse. Cada mint cunha
# um DEVICE novo e o crypto store do agente é amarrado ao device: re-mint gratuito
# forçaria identity-reset (store novo, janela de não-recepção). Re-minta em DOIS casos:
#   · token existente morreu (reset apagou o banco do MAS; revogação manual) — probe
#     soft no whoami; o wipe fica com o próprio agente (device-changed, o único wipe
#     que sobrou nele);
#   · sentinela REMEDIATION_NEEDED no store (F8, PR-3.1): o agente achou store
#     inutilizável ou chaves divergentes e PAROU (o wipe local com token vivo produz o
#     agente-zumbi do A1 — device keys re-aceitas, OTKs órfãs, servidor servindo chave
#     morta com check verde). Aqui a remediação é UMA operação, NESTA ordem: stop →
#     kill-sessions cofre (ADR-069 dec. 7) → mint novo (device novo) → wipe do store+
#     sentinela → sobe. Kill que falha aborta antes do mint; wipe que falha ABORTA o up (set
#     -e): mint-sem-wipe é exatamente o meio-caminho que o F8 existe para impedir — a
#     sentinela fica, e o próximo up re-remedia.
# O trap de revogação do up segue escopado a `system` (ADR-054 dec. 5) e NÃO alcança o
# cofre.
ensure_agent_token() {
  local token code sentinel="" out
  if [[ -s "$AGENT_TOKEN_FILE_HOST" ]]; then
    sentinel=$(agent_data_sh 'cat /data/REMEDIATION_NEEDED 2>/dev/null' | tr -d '[:space:]') || true
    if [[ -z "$sentinel" ]]; then
      token=$(cat "$AGENT_TOKEN_FILE_HOST")
      code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 -H "Authorization: Bearer $token" \
        "$HS_URL/_matrix/client/v3/account/whoami")
      if [[ "$code" == "200" ]]; then
        echo "Token do cofre: OK ✅ (reuso — mct_ sem expiração)"
        return 0
      fi
      echo "Token do cofre morto (HTTP $code) — re-mint (device novo; o agente sinaliza identity-reset)."
    else
      echo "Sentinela de remediação do agente encontrada ($sentinel) — F8: stop → kill-sessions → mint → wipe → sobe."
      # Container parado durante a troca: elimina a janela em que um boot do crash-loop
      # leria o store no meio do wipe. O compose up -d agent (fase 2) o religa.
      docker stop "${PROJECT}-agent-1" >/dev/null 2>&1 || true
      # Encerra a sessão VELHA do cofre no MAS antes do mint (ADR-069 dec. 7): o MAS apaga o
      # device pelo SyncDevicesJob. Um DELETE de admin no Synapse não bastava — a compat session
      # seguia viva e o sync RECRIAVA o device (§8.22; os 20 devices do cofre do §8.33). Kill
      # ANTES do mint, senão mataria o token novo. Falha aqui aborta antes de cunhar: a sentinela
      # fica, o próximo up remedia de novo (paridade com deploy.sh).
      if ! out=$(docker exec "$MAS_CONTAINER" mas-cli manage kill-sessions -c "$MAS_CONFIG" cofre 2>&1); then
        echo "ERRO: kill-sessions do cofre falhou — remediação abortada antes do mint:" >&2
        echo "$out" >&2
        exit 1
      fi
      echo "Sessões do cofre encerradas (o device velho sai pelo sync de devices do MAS) ✅"
    fi
  fi
  # O re-mint do M2 acontece DENTRO de mint_active_token, antes da escrita abaixo: só o token
  # que passou no probe é persistido.
  mint_active_token cofre
  token="$MINTED_TOKEN"
  ( umask 077; printf '%s\n' "$token" > "$AGENT_TOKEN_FILE_HOST" )
  echo "Token do cofre cunhado ✅"
  if [[ -n "$sentinel" ]]; then
    # O mint JÁ aconteceu e o arquivo de token JÁ carrega o novo — o wipe fecha a
    # operação atômica; qualquer boot daqui em diante nasce virgem com device novo.
    agent_data_sh 'find /data -mindepth 1 -delete'
    echo "Store do agente wipado JUNTO do mint (F8 — nunca separados) ✅"
  fi
}

# Read-only, irmã do check_escrow: o agente não tem porta publicada — o sinal é o
# container de pé (o boot fail-closed derruba o processo se algo essencial falta).
check_agent() {
  if docker ps --format '{{.Names}}' | grep -qx "${PROJECT}-agent-1"; then
    echo "Agente de custódia: OK ✅ (${PROJECT}-agent-1)"
  else
    echo "AVISO: agente de custódia (${PROJECT}-agent-1) não está up — rode ./dev-stack.sh up." >&2
  fi
}

# Irmã read-only de check_seed: mesma resolução de alias não-autenticada, sem cunhar token
# nem mutar estado. 200 → canal presente; qualquer outro → aviso com hint de rodar `up`.
check_org_channel() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
    "$HS_URL/_matrix/client/v3/directory/room/$ORG_CHANNEL_ALIAS_ENC")
  if [ "$code" = "200" ]; then
    echo "Canal da org: OK ✅"
  else
    echo "AVISO: canal da org #${ORG_CHANNEL_LOCALPART} ausente (HTTP $code) — rode ./dev-stack.sh up." >&2
  fi
}

cmd_up() {
  require_compose
  # Revoga a credencial de serviço em TODA saída do up — sucesso, exit 1 e SIGINT/TERM.
  # Por que trap e não última linha de cmd_up: sob `set -e`, o exit 1 de um pré-check anômalo ou
  # de um PUT reprovado (seed_org_channel / sync_org_directory) PULA a última linha — e é
  # exatamente a volta em que a credencial admin viva é mais indesejada (§8 do PLANO, "O caminho
  # de falha"). EXIT cobre sucesso e exit 1; INT/TERM cobrem interrupção. Os dois podem disparar
  # em sequência — a 2ª execução é no-op pela idempotência da função.
  # NUNCA no escopo global: cmd_token cunha um token de compat e o ENTREGA ao operador; um trap
  # global o revogaria no mesmo instante, deixando o comando inútil. O trap pertence ao `up`.
  trap revoke_service_sessions EXIT INT TERM
  ensure_org_key
  ensure_push_key
  ensure_agent_storage_key
  ensure_synapse_writable
  render_project_configs
  ensure_mas_secrets
  "$MAS_TEMPLATES_PREPARE"
  mas_migrate_and_sync
  restart_mas_if_config_changed
  # --env-file SÓ aqui: interpola ${ESCROW_ORG_KEY} no compose.yaml para o serviço escrow.
  # ps/status/down/logs seguem chamando `compose` sem --env-file → interpola vazio, sem
  # efeito colateral (status a frio não cria nem lê a key).
  # FASE 1 — tudo MENOS o agente (lista explícita; serviço novo entra aqui): o token do
  # cofre nasce do MAS, que precisa estar de pé antes do mint, e o bind de
  # agent-token.secret precisa do arquivo existente antes do container (senão o docker
  # cria um diretório no lugar).
  # The push pair is interpolated the same way, from push.secret.env, only here.
  PUSH_VAPID_PRIVATE_KEY="$(sed -n 's/^PUSH_VAPID_PRIVATE_KEY=//p' "$PUSH_ENV_FILE")" \
  PUSH_VAPID_PUBLIC_KEY="$(sed -n 's/^PUSH_VAPID_PUBLIC_KEY=//p' "$PUSH_ENV_FILE")" \
    compose --env-file "$ESCROW_ENV_FILE" up -d postgres dex mas synapse escrow org router push
  wait_for_synapse
  check_mas || true
  check_mas_keys
  wait_for_escrow
  wait_for_org
  wait_for_push
  # Senhas throwaway, local-only (ver aviso no README). O harness só precisa que os
  # usuários EXISTAM — os tokens são cunhados pelos testes (mintToken).
  provision_user alice alicepass123
  provision_user bob bobpass123
  provision_user system systempass123
  # Identidade estrutural de custódia (F3, ADR-057 dec. 5). Fora do directory.tsv e do
  # canal da org por OMISSÃO deliberada: não é gente — a ocultação de UI é PR-4; aqui
  # ele só não é semeado como humano.
  # Senha ALINHADA ao gate do escrow (escrow-sessions-mas.test.ts, PR-2), que loga o
  # cofre via OIDC headless: o register idempotente NÃO atualiza senha de usuário
  # existente, então provisionar aqui com outra senha quebrava o gate de forma latente
  # após todo reset→up (mordeu no §0 da PR-3.1 — remediado com set-password e fixado
  # aqui na fonte).
  provision_user cofre custodypass123
  seed_org_channel
  sync_org_membership
  sync_org_directory
  # mel: admin só do people.spec.ts. O flag exige a conta, por isso ela não nasce no 1º login como o resto do tier.
  provision_user mel melpass123
  # rae: admin só do agents.spec.ts (ADR-086, fatia 3) — mesma razão de mel.
  provision_user rae raepass123
  # tai: admin só do agent-sidecar.spec.ts (S-e) — mesma razão de mel.
  provision_user tai taipass123
  # bia: admin only for agent-form.narrow.spec.ts (PLANO-MOBILE M8), for the same reason as mel.
  provision_user bia biapass123
  # luz: admin only for awaiting.narrow.spec.ts (PLANO-MOBILE M9b), for the same reason as mel.
  provision_user luz luzpass123
  # cris: admin only for connection.narrow.spec.ts (PLANO-MOBILE §8.26), for the same reason as mel.
  provision_user cris crispass123
  # iara, davi and mila: the trio of org-admin.spec.ts (PLANO-ADMIN slice 1c). iara is the admin, for the same
  # reason as mel; davi and mila exist before their first login so the spec can promote one of them.
  provision_user iara iarapass123
  provision_user davi davipass123
  provision_user mila milapass123
  promote_org_admin alice
  promote_org_admin mel
  promote_org_admin rae
  promote_org_admin tai
  promote_org_admin bia
  promote_org_admin luz
  promote_org_admin cris
  promote_org_admin iara
  # FASE 2 — agente de custódia. Sem node_modules no host (caso CI: o runner não roda
  # `npm ci` em agent/) o serviço fica FORA do up, com aviso — nunca um container em
  # crash-loop mudo nem um up vermelho por dep de dev local.
  if [[ -d "$AGENT_DIR/node_modules" ]]; then
    ensure_agent_token
    AGENT_STORAGE_KEY="$(grep '^AGENT_STORAGE_KEY=' "$AGENT_SECRET_ENV" | cut -d= -f2-)" \
      compose --env-file "$ESCROW_ENV_FILE" up -d agent
    echo "Agente de custódia (cofre) up ✅"
  else
    echo "AVISO: agent/node_modules ausente — agente de custódia NÃO sobe (cd agent && npm install; depois ./dev-stack.sh up)." >&2
  fi
  cat <<'EOF'

Nota sobre usuários alice/bob/system:
  - `up` provisiona alice/bob quando ausentes (acima) — o ciclo reset→up é autossuficiente.
  - `up`/`down` PRESERVAM os volumes → alice/bob continuam existindo entre execuções.
  - Os testes emitem o token sozinhos (mintToken); só precisam que os usuários EXISTAM.
EOF
  print_env
}

cmd_down() {
  # down não aceita flags — não repassa nada ao compose; volumes só caem via reset
  # (registro: PLANO-FIDELIDADE-DESIGN §8 item 6 — `down -v` engolido mordeu o track).
  if [[ $# -gt 0 ]]; then
    echo "ERRO: down não aceita flags/argumentos (recebido: $*). Volumes só caem via: $0 reset" >&2
    exit 1
  fi
  require_compose
  compose down
  echo "Stack derrubada (volumes preservados)."
}
cmd_reset()  { require_compose; compose down -v; echo "Stack derrubada + volumes apagados (pgdata, escrowdata, orgdata, agentdata). O próximo up recria o banco e re-provisiona alice/bob."; }
# Fase 2 (ADR-071 dec. 2): `down -v` do namespace do CI, e SÓ dele. Guard LITERAL do nome do
# projeto — não é "qualquer projeto ≠ spike": é exatamente `spike-ci`. O `reset` da spike
# (fluxo local do README) não muda. Também apaga o render e o token do projeto: no runner o
# checkout é limpo a cada run (git clean -ffdx) e os volumes persistem — org key nova sobre
# escrowdata velho = depósitos indecifráveis (§8.R2); por isso o ci-reset roda ANTES do up no
# CI, não só depois.
cmd_ci_reset() {
  if [[ "$PROJECT" != "spike-ci" ]]; then
    echo "ERRO: ci-reset só opera no projeto spike-ci (TAYET_COMPOSE_PROJECT=spike-ci); projeto atual: $PROJECT" >&2
    exit 1
  fi
  require_compose
  compose down -v
  rm -rf "$SCRIPT_DIR/.render/$PROJECT" "$AGENT_TOKEN_FILE_HOST"
  echo "spike-ci derrubada + volumes apagados (pgdata, escrowdata, orgdata, agentdata) + render/token do projeto removidos."
}
cmd_status() {
  require_compose
  compose ps || true
  echo
  if probe; then echo "Probe Synapse: OK ✅ ($HS_URL)"; else echo "Probe Synapse: FALHOU ❌ ($HS_URL)"; fi
  check_mas || true
  check_escrow || true
  check_org || true
  check_router || true
  check_push || true
  check_agent || true
  check_seed
  check_org_channel
}
cmd_logs()   { require_compose; compose logs --tail=120 "${1:-}"; }

cmd_token() {
  local user="${1:?uso: ./dev-stack.sh token <username>}"
  docker exec "$MAS_CONTAINER" mas-cli manage issue-compatibility-token -c "$MAS_CONFIG" "$user"
}

cmd_test() {
  if ! probe; then
    echo "ERRO: Synapse não está respondendo — suba a stack primeiro (./dev-stack.sh up)." >&2
    exit 1
  fi
  if [[ ! -f "$CLIENT_DIR/package.json" ]]; then
    echo "ERRO: não achei $CLIENT_DIR/package.json. Aponte TAYET_CLIENT_DIR para o dir do cliente." >&2
    exit 1
  fi
  export TAYET_HS_URL="$HS_URL" TAYET_MAS_CONTAINER="$MAS_CONTAINER" TAYET_MAS_CONFIG="$MAS_CONFIG"
  # Fase 2 (§8.R2): o harness (client/agent/escrow) recebe o namespace inteiro pelo `test`.
  export TAYET_MAS_URL="$MAS_HOST_URL" TAYET_ESCROW_URL="$ESCROW_BASE" \
    TAYET_AGENT_CONTAINER="${PROJECT}-agent-1" TAYET_AGENT_VOLUME="${PROJECT}_agentdata"
  # Roda o vitest no pacote do cliente. Caminhos de teste são relativos a CLIENT_DIR
  # (ex.: test/integration/acl-attachment.test.ts — SEM o prefixo client/).
  npm --prefix "$CLIENT_DIR" test -- "$@"
}

case "${1:-}" in
  up)     shift; cmd_up "$@";;
  down)   shift; cmd_down "$@";;
  reset)  shift; cmd_reset "$@";;
  status) shift; cmd_status "$@";;
  logs)   shift; cmd_logs "$@";;
  token)  shift; cmd_token "$@";;
  test)   shift; cmd_test "$@";;
  ci-reset) shift; cmd_ci_reset "$@";;
  render-check) shift; render_roundtrip_check;;
  *) echo "uso: $0 {up|down|reset|ci-reset|status|logs|token <user>|test [args]|render-check}" >&2; exit 1;;
esac
