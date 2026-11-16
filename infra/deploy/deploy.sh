#!/usr/bin/env bash
#
# deploy.sh — orquestra a stack de PRODUÇÃO do Tayet sob o domínio base do deployment
# (ADR-046/047/048 e ADR-095; o deployment de referência usa `tayet.app`). Análogo do
# infra/dev-stack/dev-stack.sh, mas para produção:
#   postgres + synapse + mas + dex + escrow + caddy + agent — com secrets FRESCOS gerados fora
#   do repo (gitignored), TLS automático via Caddy. O Dex é o IdP do dogfood (ADR-048).
#
# Alvo de execução: host Linux (VPS). Mas o GATE da fatia roda no macOS/BSD do owner →
# este script é 100% BSD-safe: nenhum `sed -i`, nenhum flag GNU-only; renderização
# sempre `sed -e ... in > out`.
#
# Pré-requisito: `htpasswd` no host (hash bcrypt das senhas do Dex, §0.4). macOS já o traz;
# Debian/Ubuntu via `apt-get install apache2-utils`.
#
# Uso:
#   ./deploy.sh secrets   # 1ª vez: gera todo o material fresco em secrets/ (aborta se já existir)
#   ./deploy.sh render    # re-renderiza os TRÊS templates (synapse/mas/dex) dos secrets vivos
#   ./deploy.sh build     # assa o SPA com as envs de produção → client/dist; deps do agente → agent/node_modules
#   ./deploy.sh up        # aborta se há render pendente; pg_dump + migrate + config sync do MAS, reinicia MAS/Synapse se a config mudou, sobe a stack, reinicia o Caddy se o Caddyfile mudou (validado antes), provisiona system e o bootstrap admin (com o flag), semeia #all;
#                         # 2ª fase: provisiona o cofre, garante o token e sobe o agente de custódia (ADR-069)
#   ./deploy.sh down      # derruba PRESERVANDO volumes (JAMAIS -v — ver comentário no cmd_down)
#   ./deploy.sh check     # read-only: containers + alias #all + renders em dia + config do Synapse = render
#                         # + healthz e StartedAt do escrow + último backup + agente; falha nos dois do render
#
# NÃO há `reset`/`down -v`: produção não tem mundo descartável (PLANO-TRILHA-A §2).
set -euo pipefail

# ── Paths ──────────────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# PROJECT (nome do projeto compose) sai de TAYET_COMPOSE_PROJECT, resolvido com o domínio (abaixo).
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"

SECRETS_DIR="$SCRIPT_DIR/secrets"
RENDERED_DIR="$SECRETS_DIR/rendered"
DEPLOY_ENV="$SECRETS_DIR/deploy.env"
# Domínio base do deployment (ADR-095): uma linha TAYET_DOMAIN=<domínio>, gravada uma vez pelo `secrets`
# (ou pela migração do `render`/`up`) e nunca mudada. Também é o --env-file do compose.
DEPLOYMENT_ENV="$SECRETS_DIR/deployment.env"
MAS_SECRETS="$SECRETS_DIR/mas-secrets.yaml"
# Vestigial (ADR-048): a conta de serviço `system` não usa senha (nem por senha, nem por
# Dex) — provision_user cria-a sem caminho de login. O arquivo é mantido por compatibilidade
# de fluxo do `secrets`; sua remoção é cosmética e fica para outro PR.
SYSTEM_PASS_FILE="$SECRETS_DIR/system.pass"
# Client secret do seam MAS↔Dex: persistido (chmod 600) para o `render` re-injetar sem
# regenerá-lo — o MESMO valor entra em dex-config e mas-config (dois lados do provider).
DEX_CLIENT_SECRET_FILE="$SECRETS_DIR/dex-client.secret"
# Senha de login do owner no Dex (ADR-048): credencial real do dogfood. O hash bcrypt é
# DERIVADO dela no render (nunca persistido) — re-hashar a mesma senha valida igual.
BOOTSTRAP_ADMIN_PASSWORD_FILE="$SECRETS_DIR/bootstrap-admin.password"
# Identidade do admin de bootstrap (BOOTSTRAP_ADMIN_*): env do operador, persistida pelo
# `secrets` neste arquivo (KEY=VALUE, uma por linha) e relida pelo `render`.
BOOTSTRAP_ADMIN_ENV="$SECRETS_DIR/bootstrap-admin.env"
RENDERED_DIRECTORY="$RENDERED_DIR/directory.tsv"
# sha256 do mas-config.yaml que o último `up` aplicou: a imagem do MAS não dá como ler o hash por dentro.
MAS_CONFIG_MARKER="$RENDERED_DIR/.mas-config.sha"
# Templates próprios do MAS (ADR-084): gera _generated/ (tokens, ícone, fonte) e dá o sha da árvore.
MAS_TEMPLATES_PREPARE="$REPO_ROOT/infra/mas/prepare.sh"
# Usuários além do admin de bootstrap: dois fragmentos OPCIONAIS do operador, gitignored com o resto
# de secrets/ (nenhum usuário real em arquivo rastreado). Ausente = nenhum usuário extra.
#   - dex-users.yaml: entradas de `staticPasswords` (email/username/userID/hash), lista YAML na
#     coluna 0 — o render indenta e anexa depois do admin no dex-config;
#   - directory.extra.tsv: linhas do directory.tsv (sem cabeçalho), join por username.
DEX_USERS="$SECRETS_DIR/dex-users.yaml"
DIRECTORY_EXTRA="$SECRETS_DIR/directory.extra.tsv"
# OAuth client do Google (ADR-083 dec. 1): credencial de terceiro, criada pelo owner no console do
# Google, com GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET (KEY=VALUE). Obrigatório: o template do MAS
# tem uma forma só, e o `render` falha sem ele.
GOOGLE_OAUTH_ENV="$SECRETS_DIR/google-oauth.env"
# Dumps lógicos do Postgres feitos pelo `up` antes do `database migrate` (ADR-047). Dentro de
# secrets/ → gitignored com o resto do estado crítico.
BACKUPS_DIR="$SECRETS_DIR/backups"
# Agente de custódia (ADR-069). `agent.env` carrega a AGENT_STORAGE_KEY (env_file do serviço no
# compose — arquivo ausente quebra TODO comando do compose, por isso o compose() abaixo o exige);
# `agent-token.secret` é o mct_ do cofre, bind-montado no container; `agent.disabled` é o opt-out
# durável do serviço (dec. 11): existindo, o `up` não sobe o agente e o para se estiver de pé.
AGENT_DIR="$REPO_ROOT/agent"
AGENT_ENV="$SECRETS_DIR/agent.env"
AGENT_TOKEN_FILE="$SECRETS_DIR/agent-token.secret"
AGENT_DISABLED_FLAG="$SECRETS_DIR/agent.disabled"

# Imagem do MAS (1.27.0) — digest fixado em TRÊS lugares: aqui, infra/deploy/compose.yaml e
# infra/dev-stack/compose.yaml. Usada só no `secrets` para rodar `mas-cli config generate`
# fora da stack (antes de qualquer up).
MAS_IMAGE="ghcr.io/element-hq/matrix-authentication-service@sha256:085e37263957b3b79be85de9cfda1980b97e9653f284fba0c902445e06c200b8"

# Imagem do Synapse (1.163.0) — MESMO digest do compose.yaml (fonte única de verdade). Reusada em
# `ensure_synapse_volume_owner` só pra dar chown no volume virgem: o entrypoint do Synapse
# roda como root e a imagem tem `chown`, então NÃO introduzimos imagem nova não-pinada
# (busybox/alpine seriam dependência nova). Se o digest do compose mudar, atualize aqui.
SYNAPSE_IMAGE="ghcr.io/element-hq/synapse@sha256:e98ab72138d90fa8b8876c6421fe78a9fdb181c0d7cc690ad740e5173e0c65e6"

# Imagem do agente (node:22-bookworm-slim) — MESMO digest dos serviços escrow e agent do
# compose.yaml. Usada no `build` (npm ci das deps do agente DENTRO da imagem de runtime: deps
# Linux-nativas, sem depender do Node do host) e nos shells efêmeros sobre o volume do agente.
AGENT_IMAGE="node@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752"
# AGENT_VOLUME ("<projeto>_agentdata") deriva do nome do projeto, resolvido com o domínio (abaixo).

# Variante A (§0.3): a config principal + a seção de secrets, mescladas via `--config`
# repetido. Todas as invocações do mas-cli passam AMBAS (global, antes do subcomando).
MAS_CONFIG_ARGS=(--config /config/config.yaml --config /config/secrets.yaml)

# Loopback de OPS do host (o Synapse publica só 127.0.0.1:<TAYET_HS_PORT>, padrão 8008): o seed e os
# probes de admin usam; o público entra por matrix.<domínio base> via Caddy. HS_URL deriva da porta,
# resolvida com o domínio (abaixo).
WAIT_TIMEOUT_S="${TAYET_WAIT_TIMEOUT_S:-180}"

# ── Domínio base (ADR-095) ─────────────────────────────────────────────────────────────
# Nome de host em minúsculas, rótulos separados por ponto (pelo menos dois), sem esquema, porta, barra
# nem ponto final. Sem valor padrão em lugar nenhum.
DOMAIN_RE='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
valid_domain() { [[ "$1" =~ $DOMAIN_RE ]]; }

# `secrets`: o domínio vem só do ambiente, validado antes de gerar qualquer arquivo.
require_domain_from_env() {
  if [[ -z "${TAYET_DOMAIN+x}" ]]; then
    echo "ERROR: TAYET_DOMAIN missing — secrets requires the deployment's base domain (e.g. TAYET_DOMAIN=example.com, ADR-095). Nothing was generated." >&2
    exit 1
  fi
  if ! valid_domain "$TAYET_DOMAIN"; then
    echo "ERROR: invalid TAYET_DOMAIN ('$TAYET_DOMAIN'): lowercase host name, dot-separated labels, no scheme, port, slash or trailing dot. Nothing was generated." >&2
    exit 1
  fi
  export TAYET_DOMAIN
}

# Demais comandos: resolve uma vez, antes de qualquer outra coisa. Fonte: deployment.env; na falta
# dele, a linha server_name do render vivo do homeserver (deployment anterior ao arquivo, migrado pelo
# `render`/`up` em persist_migrated_domain). Divergência entre os dois, ou com TAYET_DOMAIN do ambiente,
# aborta sem escrever nada. Exporta TAYET_DOMAIN: na interpolação do compose a variável do shell vence
# o --env-file, e renders e compose não podem sair com domínios diferentes.
DOMAIN_FROM_LIVE=""
resolve_domain() {
  local live_hs="$SECRETS_DIR/rendered/homeserver.yaml" file_val="" live_val="" count domain source
  if [[ -f "$DEPLOYMENT_ENV" ]]; then
    count=$(grep -c '^TAYET_DOMAIN=' "$DEPLOYMENT_ENV" || true)
    file_val=$(sed -n 's|^TAYET_DOMAIN=||p' "$DEPLOYMENT_ENV")
    if [[ "$count" != "1" ]] || ! valid_domain "$file_val"; then
      echo "ERROR: $DEPLOYMENT_ENV does not have exactly one valid TAYET_DOMAIN=<domain> line — nothing was written." >&2
      exit 1
    fi
  fi
  if [[ -f "$live_hs" ]]; then
    count=$(grep -c '^server_name: "' "$live_hs" || true)
    if [[ "$count" == "1" ]]; then
      live_val=$(sed -n 's|^server_name: "\(.*\)"$|\1|p' "$live_hs")
      valid_domain "$live_val" || live_val=""
    fi
  fi
  if [[ -n "$file_val" ]]; then
    if [[ -n "$live_val" && "$live_val" != "$file_val" ]]; then
      echo "ERROR: base domain mismatch — $DEPLOYMENT_ENV says '$file_val', the server_name in $live_hs says '$live_val'." >&2
      echo "       A deployment's domain never changes (ADR-095); nothing was written." >&2
      exit 1
    fi
    domain="$file_val"; source="$DEPLOYMENT_ENV"
  elif [[ -n "$live_val" ]]; then
    domain="$live_val"; source="server_name in $live_hs"
    DOMAIN_FROM_LIVE=1
  else
    echo "ERROR: base domain not found — no $DEPLOYMENT_ENV and no readable server_name line in $live_hs." >&2
    echo "       Run TAYET_DOMAIN=<domain> ./deploy.sh secrets first (ADR-095); nothing was written." >&2
    exit 1
  fi
  if [[ -n "${TAYET_DOMAIN+x}" && "$TAYET_DOMAIN" != "$domain" ]]; then
    echo "ERROR: TAYET_DOMAIN from the environment ('$TAYET_DOMAIN') differs from the deployment's domain ('$domain', from $source)." >&2
    echo "       Unset the variable or fix it; nothing was written." >&2
    exit 1
  fi
  TAYET_DOMAIN="$domain"
  export TAYET_DOMAIN
}

# Migração (ADR-095 dec. 5): `render` e `up` gravam o valor lido do render vivo; `check`, `build` e
# `down` só avisam (warn_unpersisted_domain) e nunca escrevem.
persist_migrated_domain() {
  [[ -n "$DOMAIN_FROM_LIVE" ]] || return 0
  ( umask 077 && printf 'TAYET_DOMAIN=%s\n' "$TAYET_DOMAIN" > "$DEPLOYMENT_ENV" )
  DOMAIN_FROM_LIVE=""
  echo "Base domain migrated: TAYET_DOMAIN=$TAYET_DOMAIN (from the live render's server_name) written to $DEPLOYMENT_ENV."
}
warn_unpersisted_domain() {
  [[ -n "$DOMAIN_FROM_LIVE" ]] || return 0
  echo "WARNING: $DEPLOYMENT_ENV missing — using TAYET_DOMAIN=$TAYET_DOMAIN from the live render's server_name (nothing written; ./deploy.sh render or up writes it)." >&2
}

# ── Parâmetros do deployment (PLANO-DEPLOY-DOMINIO §0.3.3, regime do ADR-095 dec. 4) ─────────────
# Nome do projeto compose e três portas do host. O `secrets` lê do ambiente os que estiverem presentes,
# valida e grava em deployment.env (linha ausente vale o padrão); os demais comandos os releem dali, e
# variável do ambiente diferente do valor do deployment aborta sem escrever nada, como o domínio.
DEPLOY_PARAMS=(TAYET_COMPOSE_PROJECT TAYET_HS_PORT TAYET_HTTP_PORT TAYET_HTTPS_PORT)
PROJECT_RE='^[a-z0-9][a-z0-9_-]*$'
param_default() {
  case "$1" in
    TAYET_COMPOSE_PROJECT) echo tayet;;
    TAYET_HS_PORT) echo 8008;;
    TAYET_HTTP_PORT) echo 80;;
    TAYET_HTTPS_PORT) echo 443;;
  esac
}
valid_param() { # <nome> <valor>
  case "$1" in
    TAYET_COMPOSE_PROJECT) [[ "$2" =~ $PROJECT_RE ]];;
    *) [[ "$2" =~ ^[1-9][0-9]{0,4}$ ]] && (( 10#$2 <= 65535 ));;
  esac
}
param_rule() {
  case "$1" in
    TAYET_COMPOSE_PROJECT) echo "lowercase letters, digits, '_' and '-', starting with a letter or digit";;
    *) echo "integer from 1 to 65535";;
  esac
}

# `secrets`: só os presentes no ambiente, validados antes de gerar qualquer arquivo. PARAMS_FROM_ENV
# guarda quais o cmd_secrets grava.
PARAMS_FROM_ENV=()
require_params_from_env() {
  local p
  for p in "${DEPLOY_PARAMS[@]}"; do
    if [[ -n "${!p+x}" ]]; then
      if ! valid_param "$p" "${!p}"; then
        echo "ERROR: invalid $p ('${!p}'): $(param_rule "$p"). Nothing was generated." >&2
        exit 1
      fi
      PARAMS_FROM_ENV+=("$p")
    else
      printf -v "$p" '%s' "$(param_default "$p")"
    fi
    export "${p?}"
  done
}

# Demais comandos: valor de deployment.env, ou o padrão quando a linha (ou o arquivo) não existe. Um
# deployment.env só com o domínio continua válido sem ser reescrito.
resolve_params() {
  local p count file_val value source
  for p in "${DEPLOY_PARAMS[@]}"; do
    value="$(param_default "$p")"; source="default"
    if [[ -f "$DEPLOYMENT_ENV" ]]; then
      count=$(grep -c "^$p=" "$DEPLOYMENT_ENV" || true)
      if [[ "$count" != "0" ]]; then
        file_val=$(sed -n "s|^$p=||p" "$DEPLOYMENT_ENV")
        if [[ "$count" != "1" ]] || ! valid_param "$p" "$file_val"; then
          echo "ERROR: $DEPLOYMENT_ENV has $p repeated or invalid ($(param_rule "$p")) — nothing was written." >&2
          exit 1
        fi
        value="$file_val"; source="$DEPLOYMENT_ENV"
      fi
    fi
    if [[ -n "${!p+x}" && "${!p}" != "$value" ]]; then
      echo "ERROR: $p from the environment ('${!p}') differs from the deployment's value ('$value', $source)." >&2
      echo "       Unset the variable or fix it; nothing was written." >&2
      exit 1
    fi
    printf -v "$p" '%s' "$value"
    export "${p?}"
  done
}

case "${1:-}" in
  secrets) require_domain_from_env; require_params_from_env;;
  render|up)        resolve_domain; resolve_params;;
  build|down|check) resolve_domain; resolve_params; warn_unpersisted_domain;;
esac

# Derivados dos parâmetros (com os padrões, os valores de sempre: tayet, tayet_agentdata, 8008).
PROJECT="${TAYET_COMPOSE_PROJECT:-tayet}"
AGENT_VOLUME="${PROJECT}_agentdata"
HS_URL="http://127.0.0.1:${TAYET_HS_PORT:-8008}"

# Canal da organização (ADR-045): mesma mecânica do dev-stack, server_name de produção.
ORG_CHANNEL_LOCALPART="all"
ORG_SERVER_NAME="${TAYET_DOMAIN:-}"
ORG_CHANNEL_ALIAS_ENC="%23${ORG_CHANNEL_LOCALPART}%3A${ORG_SERVER_NAME}"

# Site institucional (ADR-050) é opt-in: o overlay compose.site.yaml (mount ../../site) entra
# só quando o diretório existe ao lado do deploy.
COMPOSE_FILES=(-f "$COMPOSE_FILE")
if [[ -d "$REPO_ROOT/site" ]]; then COMPOSE_FILES+=(-f "$SCRIPT_DIR/compose.site.yaml"); fi
# Compose a mais, acrescentado por último (PLANO-DEPLOY-DOMINIO §0.3.3 item 6): só do ambiente, nunca
# gravado. É o gancho da prova local (test/local-install.sh).
if [[ -n "${TAYET_COMPOSE_OVERRIDE+x}" ]]; then
  if [[ ! -f "$TAYET_COMPOSE_OVERRIDE" ]]; then
    echo "ERROR: TAYET_COMPOSE_OVERRIDE points to a file that does not exist ('$TAYET_COMPOSE_OVERRIDE') — nothing was written." >&2
    exit 1
  fi
  COMPOSE_FILES+=(-f "$TAYET_COMPOSE_OVERRIDE")
fi
# O env_file do serviço agent (secrets/agent.env) é lido ao carregar o projeto: ausente, QUALQUER
# comando do compose falha (medido: `ps` e `config` abortam com "no such file or directory"). O `up`
# o gera antes do primeiro compose (ensure_agent_secrets); aqui só a mensagem acionável.
compose() {
  if [[ ! -f "$AGENT_ENV" ]]; then
    echo "ERROR: $AGENT_ENV missing — run ./deploy.sh up (it generates the AGENT_STORAGE_KEY once, ADR-069)." >&2
    exit 1
  fi
  # --env-file com o domínio base (ADR-095) quando o arquivo existe; antes da migração gravá-lo, a
  # TAYET_DOMAIN exportada pelo resolve_domain basta (e vence o --env-file de qualquer forma).
  local env_file=()
  if [[ -f "$DEPLOYMENT_ENV" ]]; then env_file=(--env-file "$DEPLOYMENT_ENV"); fi
  docker compose -p "$PROJECT" ${env_file[@]+"${env_file[@]}"} "${COMPOSE_FILES[@]}" "$@"
}

require_secrets() {
  if [[ ! -f "$DEPLOY_ENV" ]]; then
    echo "ERROR: secrets missing ($DEPLOY_ENV). Run ./deploy.sh secrets first." >&2
    exit 1
  fi
}

# Hash bcrypt das senhas estáticas do Dex (§0.4). Única dependência nova; pré-requisito
# documentado no README. macOS traz htpasswd nativo; Linux via `apache2-utils`.
require_htpasswd() {
  if ! command -v htpasswd >/dev/null 2>&1; then
    echo "ERROR: 'htpasswd' missing — required for the bcrypt hash of the Dex passwords." >&2
    echo "       Install it: Debian/Ubuntu 'apt-get install apache2-utils'; macOS already ships it." >&2
    exit 1
  fi
}

# Deriva o hash bcrypt de uma senha, formato aceito pelo Dex ($2y$, custo 12). O 1º campo
# (usuário vazio) é descartado — o Dex só quer o hash.
bcrypt_hash() { htpasswd -nbBC 12 "" "$1" | cut -d: -f2; }

# ── Admin de bootstrap ──────────────────────────────────────────────────────────────────
# A primeira conta humana (allowlist do Dex + linha do diretório) vem de variáveis, não de
# dado versionado: BOOTSTRAP_ADMIN_USERNAME, _EMAIL, _FULL_NAME, _JOB_TITLE. Fonte: o env do
# operador; na falta, secrets/bootstrap-admin.env (escrito pelo `secrets`). _JOB_TITLE pode
# ser vazio (ausência declarada no diretório), mas precisa estar DEFINIDO.
BOOTSTRAP_ADMIN_KEYS=(BOOTSTRAP_ADMIN_USERNAME BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_FULL_NAME BOOTSTRAP_ADMIN_JOB_TITLE)

load_bootstrap_admin() {
  local key val missing=""
  for key in "${BOOTSTRAP_ADMIN_KEYS[@]}"; do
    if [[ -z "${!key+x}" && -f "$BOOTSTRAP_ADMIN_ENV" ]] && grep -q "^${key}=" "$BOOTSTRAP_ADMIN_ENV"; then
      val="$(sed -n "s/^${key}=//p" "$BOOTSTRAP_ADMIN_ENV" | head -n 1)"
      printf -v "$key" '%s' "$val"
    fi
    if [[ -z "${!key+x}" ]]; then missing="${missing} ${key}"; fi
  done
  if [[ -n "$missing" ]]; then
    echo "ERROR: bootstrap admin undefined:${missing}." >&2
    echo "       Export the variables or write them (KEY=VALUE) to $BOOTSTRAP_ADMIN_ENV — nothing was written." >&2
    exit 1
  fi
  for key in BOOTSTRAP_ADMIN_USERNAME BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_FULL_NAME; do
    if [[ -z "${!key}" ]]; then
      echo "ERROR: $key empty — nothing was written." >&2
      exit 1
    fi
  done
  # O username vira localpart do MXID (mapping do MAS) e entra no userID do Dex.
  case "$BOOTSTRAP_ADMIN_USERNAME" in
    *[!a-z0-9._=-]*)
      echo "ERROR: BOOTSTRAP_ADMIN_USERNAME outside [a-z0-9._=-] — nothing was written." >&2
      exit 1;;
  esac
  # Os valores entram em sed (delimitador |), YAML entre aspas e TSV: recusa os caracteres
  # que quebrariam qualquer um dos três.
  for key in "${BOOTSTRAP_ADMIN_KEYS[@]}"; do
    case "${!key}" in
      *[\|\&\\\"]*|*$'\t'*|*$'\n'*)
        echo "ERROR: $key contains an unsupported character (| & \\ \" TAB or line break) — nothing was written." >&2
        exit 1;;
    esac
  done
  # userID estável do Dex (claim `sub`, que o MAS usa para ligar a conta upstream).
  BOOTSTRAP_ADMIN_USER_ID="tayet-${BOOTSTRAP_ADMIN_USERNAME}-0001"
}

# Lê o fragmento do Google. Falta aborta: placeholder sem valor derrubaria o MAS no boot.
load_google_oauth() {
  local key
  if [[ ! -f "$GOOGLE_OAUTH_ENV" ]]; then
    echo "ERROR: $GOOGLE_OAUTH_ENV missing — the MAS template has the Google provider." >&2
    echo "       Create the OAuth client (SELF-HOSTING.md, the self-hosting guide at the repository root) and write GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET — nothing was written." >&2
    exit 1
  fi
  GOOGLE_CLIENT_ID="$(sed -n 's/^GOOGLE_CLIENT_ID=//p' "$GOOGLE_OAUTH_ENV" | head -n 1)"
  GOOGLE_CLIENT_SECRET="$(sed -n 's/^GOOGLE_CLIENT_SECRET=//p' "$GOOGLE_OAUTH_ENV" | head -n 1)"
  for key in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
    case "${!key}" in
      ''|*[!A-Za-z0-9._-]*)
        echo "ERROR: $key empty or with unexpected characters in ${GOOGLE_OAUTH_ENV##*/} — nothing was written." >&2
        exit 1;;
    esac
  done
}

# Shim one-shot: o arquivo de senha do bootstrap tinha nome pessoal. Se o legado existe e o
# novo não, move e segue.
migrate_bootstrap_password_file() {
  local legacy="$SECRETS_DIR/marcel.password"
  if [[ -f "$legacy" && ! -f "$BOOTSTRAP_ADMIN_PASSWORD_FILE" ]]; then
    mv "$legacy" "$BOOTSTRAP_ADMIN_PASSWORD_FILE"
    echo "Bootstrap password: $legacy → $BOOTSTRAP_ADMIN_PASSWORD_FILE (migrated)."
  fi
}

# Diretório renderizado = o directory.tsv versionado (só cabeçalho) + as linhas de
# secrets/directory.extra.tsv + a linha do admin de bootstrap. É ESTA cópia que o `up` sincroniza.
render_directory() {
  cat "$SCRIPT_DIR/directory.tsv"
  if [[ -f "$DIRECTORY_EXTRA" ]]; then
    awk '!/^[[:space:]]*(#|$)/' "$DIRECTORY_EXTRA"
  fi
  printf '%s\t%s\t%s\t%s\n' "$BOOTSTRAP_ADMIN_USERNAME" "$BOOTSTRAP_ADMIN_FULL_NAME" \
    "$BOOTSTRAP_ADMIN_JOB_TITLE" "$BOOTSTRAP_ADMIN_EMAIL"
}

# Entradas extras do Dex, prontas para anexar ao dex-config renderizado: cada `- …` ganha uma
# linha em branco antes e tudo ganha 2 espaços (o nível da lista `staticPasswords`, que é a
# última chave do template — validate_extra_users confere). Sem fragmento, não imprime nada.
render_dex_users() {
  if [[ -f "$DEX_USERS" ]]; then
    awk '/^[[:space:]]*(#|$)/ { next } /^- / { print "" } { print "  " $0 }' "$DEX_USERS"
  fi
}

# Valida os fragmentos antes de qualquer render (exit 1 sem escrever nada):
#   - o template termina na lista `staticPasswords` (senão o anexo cairia em outra chave);
#   - dex-users.yaml: cada entrada tem email/username/userID/hash não vazios, hash bcrypt ($2…),
#     username único e diferente do admin; linha fora da forma `- chave: valor` / `  chave: valor`
#     aborta (indentação errada viraria YAML inválido no Dex);
#   - directory.extra.tsv: 4 campos por TAB e username com entrada em dex-users.yaml (o TSV é
#     tabela de atributos; a allowlist do Dex é a espinha).
validate_extra_users() {
  local tmpl="$SCRIPT_DIR/dex/config.yaml.tmpl" users=""
  if ! awk '/^[^[:space:]#]/ { last = $1 } END { exit last != "staticPasswords:" }' "$tmpl"; then
    echo "ERROR: the last key of ${tmpl##*/} is not staticPasswords: — the extra users would have nowhere to go. Nothing was written." >&2
    exit 1
  fi
  if [[ -f "$DEX_USERS" ]]; then
    users="$(awk -v admin="$BOOTSTRAP_ADMIN_USERNAME" -v file="secrets/${DEX_USERS##*/}" '
      function err(msg) { print "ERROR: " file ": " msg > "/dev/stderr"; bad = 1 }
      function value(line) {
        sub(/^(- |  )[A-Za-z]+:[[:space:]]*/, "", line); sub(/[[:space:]]+$/, "", line)
        if (line ~ /^".*"$/) line = substr(line, 2, length(line) - 2)
        return line
      }
      function close_entry(   i, label) {
        if (n == 0) return
        label = "entry " n (f["username"] != "" ? " (" f["username"] ")" : "")
        for (i = 1; i <= 4; i++) if (f[keys[i]] == "") err(label ": field " keys[i] " missing or empty")
        if (f["hash"] != "" && f["hash"] !~ /^\$2/) err(label ": hash is not bcrypt (expected $2…)")
        if (f["username"] != "" && f["username"] == admin) err(label ": username is the bootstrap admin'\''s")
        if (f["username"] != "" && (f["username"] in seen)) err(label ": duplicate username")
        if (f["username"] != "") { seen[f["username"]] = 1; print f["username"] }
        split("", f)
      }
      BEGIN { split("email username userID hash", keys, " ") }
      /^[[:space:]]*(#|$)/ { next }
      /^- [A-Za-z]+:/ { close_entry(); n++; k = $2; sub(/:$/, "", k); f[k] = value($0); next }
      /^  [A-Za-z]+:/ && n > 0 { k = $1; sub(/:$/, "", k); f[k] = value($0); next }
      { err("line " NR " outside the form \"- key: value\" / \"  key: value\": " $0) }
      END { close_entry(); exit bad }
    ' "$DEX_USERS")" || { echo "ERROR: secrets/${DEX_USERS##*/} invalid (above) — nothing was written." >&2; exit 1; }
  fi
  if [[ -f "$DIRECTORY_EXTRA" ]]; then
    awk -F'\t' -v users="$(printf '%s' "$users" | tr '\n' ' ')" -v file="secrets/${DIRECTORY_EXTRA##*/}" '
      function err(msg) { print "ERROR: " file ": line " NR ": " msg > "/dev/stderr"; bad = 1 }
      BEGIN { n = split(users, u, " "); for (i = 1; i <= n; i++) ok[u[i]] = 1 }
      /^[[:space:]]*(#|$)/ { next }
      NF != 4 { err("expected 4 TAB-separated fields, found " NF); next }
      !($1 in ok) { err("username \"" $1 "\" has no entry in secrets/dex-users.yaml") }
      END { exit bad }
    ' "$DIRECTORY_EXTRA" || { echo "ERROR: secrets/${DIRECTORY_EXTRA##*/} invalid (above) — nothing was written." >&2; exit 1; }
  fi
}

# ── secrets ──────────────────────────────────────────────────────────────────────────────
# Gera TODO o material fresco de uma vez, fora do repo (secrets/ inteiro gitignored).
# Aborta se já existir: produção não tem mundo descartável; remoção é ato manual e
# consciente (diferente do `reset` throwaway do dev-stack).
cmd_secrets() {
  if [[ -e "$DEPLOY_ENV" || -e "$MAS_SECRETS" ]]; then
    echo "ABORT: secrets already exist in $SECRETS_DIR." >&2
    echo "Production has no disposable world; removal is a manual, deliberate act." >&2
    echo "(Regenerating the org key with live deposits orphans the E2E history — ADR-019/047.)" >&2
    exit 1
  fi

  # Pré-requisito do hash bcrypt das senhas do Dex (§0.4) — falha cedo, antes de gerar nada.
  require_htpasswd
  # Identidade do admin de bootstrap — também antes de gerar qualquer coisa.
  load_bootstrap_admin
  validate_extra_users
  load_google_oauth

  umask 077
  mkdir -p "$RENDERED_DIR"

  # Org key do escrow: 32 bytes base64 — contrato exato do importOrgKey (escrow/crypto.ts:
  # "org key must decode to exactly 32 bytes"). Os demais secrets são hex (sed-delimiter-safe).
  local escrow_org_key escrow_client_secret escrow_mas_admin_secret reg_secret macaroon_secret form_secret mas_shared system_pass
  local dex_client_secret admin_password admin_hash
  escrow_org_key="$(openssl rand -base64 32)"
  escrow_client_secret="$(openssl rand -hex 32)"
  escrow_mas_admin_secret="$(openssl rand -hex 32)"
  reg_secret="$(openssl rand -hex 32)"
  macaroon_secret="$(openssl rand -hex 32)"
  form_secret="$(openssl rand -hex 32)"
  mas_shared="$(openssl rand -hex 32)"
  system_pass="$(openssl rand -hex 24)"
  # Seam MAS↔Dex + credencial de login do admin de bootstrap no Dex (ADR-048). O hash bcrypt
  # sai da senha via htpasswd; a senha em claro fica só em secrets/ (gitignored) como credencial.
  dex_client_secret="$(openssl rand -hex 32)"
  admin_password="$(openssl rand -hex 24)"
  admin_hash="$(bcrypt_hash "$admin_password")"

  # env-file do escrow (ORG_KEY + CLIENT_SECRET + MAS_ADMIN_CLIENT_SECRET). Os dois secrets de
  # client são os MESMOS valores renderizados no MAS (__ESCROW_INTROSPECTION_SECRET__ e
  # __ESCROW_MAS_ADMIN_SECRET__, ADR-082 dec. 3).
  {
    printf 'ESCROW_ORG_KEY=%s\n' "$escrow_org_key"
    printf 'ESCROW_CLIENT_SECRET=%s\n' "$escrow_client_secret"
    printf 'ESCROW_MAS_ADMIN_CLIENT_SECRET=%s\n' "$escrow_mas_admin_secret"
  } > "$DEPLOY_ENV"

  # Domínio base (ADR-095), validado no topo do script: gravado uma vez, relido por todo outro comando.
  printf 'TAYET_DOMAIN=%s\n' "$TAYET_DOMAIN" > "$DEPLOYMENT_ENV"
  # Parâmetros do deployment presentes no ambiente (§0.3.3 item 3), validados no topo; ausente = padrão.
  local param
  for param in ${PARAMS_FROM_ENV[@]+"${PARAMS_FROM_ENV[@]}"}; do
    printf '%s=%s\n' "$param" "${!param}" >> "$DEPLOYMENT_ENV"
  done

  # AGENT_STORAGE_KEY do agente de custódia (ADR-069 dec. 4) — numa instalação existente quem a
  # gera é o `up` (ensure_agent_secrets), porque este comando aborta com secrets já presentes.
  ensure_agent_secrets

  # Conta de serviço `system` (dona do canal #all) NÃO usa senha (ADR-048, passwords
  # desabilitado) — arquivo mantido por compatibilidade de fluxo, vestigial (ver
  # SYSTEM_PASS_FILE). provision_user já não o lê.
  printf '%s\n' "$system_pass" > "$SYSTEM_PASS_FILE"

  # Client secret do seam MAS↔Dex: persistido para o `render` re-injetar sem regenerá-lo.
  printf '%s\n' "$dex_client_secret" > "$DEX_CLIENT_SECRET_FILE"
  # Senha de login do admin de bootstrap no Dex — ESTA é a credencial do dogfood. Anote-a; o
  # hash é re-derivável dela no `render`, mas a senha em claro só existe aqui.
  printf '%s\n' "$admin_password" > "$BOOTSTRAP_ADMIN_PASSWORD_FILE"
  # Identidade do admin de bootstrap, relida pelo `render`.
  {
    printf 'BOOTSTRAP_ADMIN_USERNAME=%s\n' "$BOOTSTRAP_ADMIN_USERNAME"
    printf 'BOOTSTRAP_ADMIN_EMAIL=%s\n' "$BOOTSTRAP_ADMIN_EMAIL"
    printf 'BOOTSTRAP_ADMIN_FULL_NAME=%s\n' "$BOOTSTRAP_ADMIN_FULL_NAME"
    printf 'BOOTSTRAP_ADMIN_JOB_TITLE=%s\n' "$BOOTSTRAP_ADMIN_JOB_TITLE"
  } > "$BOOTSTRAP_ADMIN_ENV"

  # Seção `secrets:` do MAS (chaves de assinatura + encryption) via `mas-cli config
  # generate` (§0.3). Extrai o bloco top-level `secrets:` até a próxima chave top-level.
  echo "MAS: generating signing keys (config generate)…"
  docker run --rm "$MAS_IMAGE" config generate 2>/dev/null \
    | awk '/^secrets:/{f=1; print; next} f && /^[^[:space:]]/{f=0} f{print}' > "$MAS_SECRETS"
  if ! grep -q '^secrets:' "$MAS_SECRETS"; then
    echo "ERROR: could not extract the secrets: section from mas-cli config generate." >&2
    exit 1
  fi

  # Render dos templates → secrets/rendered/ (portável BSD/GNU: sed -e ... in > out).
  sed -e "s|__TAYET_DOMAIN__|$TAYET_DOMAIN|g" \
      -e "s|__REGISTRATION_SHARED_SECRET__|$reg_secret|g" \
      -e "s|__MACAROON_SECRET_KEY__|$macaroon_secret|g" \
      -e "s|__FORM_SECRET__|$form_secret|g" \
      -e "s|__MAS_SHARED_SECRET__|$mas_shared|g" \
      "$SCRIPT_DIR/synapse/homeserver.yaml.tmpl" > "$RENDERED_DIR/homeserver.yaml"

  # MAS: o provider Dex (ADR-048) recebe o client secret do seam — sem credencial externa
  # pendente, o `up` sobe direto (não há mais sentinela a recusar).
  sed -e "s|__TAYET_DOMAIN__|$TAYET_DOMAIN|g" \
      -e "s|__MAS_SHARED_SECRET__|$mas_shared|g" \
      -e "s|__ESCROW_INTROSPECTION_SECRET__|$escrow_client_secret|g" \
      -e "s|__ESCROW_MAS_ADMIN_SECRET__|$escrow_mas_admin_secret|g" \
      -e "s|__DEX_CLIENT_SECRET__|$dex_client_secret|g" \
      -e "s|__GOOGLE_CLIENT_ID__|$GOOGLE_CLIENT_ID|g" \
      -e "s|__GOOGLE_CLIENT_SECRET__|$GOOGLE_CLIENT_SECRET|g" \
      "$SCRIPT_DIR/mas/config.yaml.tmpl" > "$RENDERED_DIR/mas-config.yaml"

  # Dex: mesmo client secret (o outro lado do seam) + admin de bootstrap (identidade + hash).
  sed -e "s|__TAYET_DOMAIN__|$TAYET_DOMAIN|g" \
      -e "s|__DEX_CLIENT_SECRET__|$dex_client_secret|g" \
      -e "s|__BOOTSTRAP_ADMIN_EMAIL__|$BOOTSTRAP_ADMIN_EMAIL|g" \
      -e "s|__BOOTSTRAP_ADMIN_USERNAME__|$BOOTSTRAP_ADMIN_USERNAME|g" \
      -e "s|__BOOTSTRAP_ADMIN_USER_ID__|$BOOTSTRAP_ADMIN_USER_ID|g" \
      -e "s|__BOOTSTRAP_ADMIN_PASSWORD_HASH__|$admin_hash|g" \
      "$SCRIPT_DIR/dex/config.yaml.tmpl" > "$RENDERED_DIR/dex-config.yaml"
  render_dex_users >> "$RENDERED_DIR/dex-config.yaml"

  # Diretório: o versionado + as linhas extras de secrets/ + a linha do admin de bootstrap.
  render_directory > "$RENDERED_DIRECTORY"

  # FIX (findings — deploy limpo tayet.app): `umask 077` (acima) faz os renders nascerem
  # 0600 root, mas os containers são nonroot (MAS 65532, Synapse 991, Dex nonroot) e
  # montam estes configs via bind → precisam de LEITURA (senão Permission denied e o
  # processo cai em default/falha). O diretório secrets/ segue 0700 (não-root do host não
  # atravessa); só os ARQUIVOS montados por container nonroot vão a 0644. deploy.env /
  # *.pass / bootstrap-admin.password / dex-client.secret NÃO são montados como arquivo em
  # container nonroot (o escrow recebe deploy.env via env_file, lido pelo daemon root) →
  # permanecem 0600. mas-secrets.yaml É montado no MAS (/config/secrets.yaml) → entra aqui.
  chmod 0644 "$RENDERED_DIR/homeserver.yaml" \
             "$RENDERED_DIR/mas-config.yaml" \
             "$RENDERED_DIR/dex-config.yaml" \
             "$MAS_SECRETS"

  echo "Secrets generated in $SECRETS_DIR (gitignored)."
  cat <<EOF

  BACKUP REMINDER — make a TESTED backup of the critical state BEFORE real conversations:
    - secrets/             (the escrow org key ABOVE ALL — losing it = losing the E2E history)
    - volume escrowdata    (4S deposits and session keys)
    - Postgres             (accounts, rooms; ./deploy.sh up dumps both databases into secrets/backups/)
    - volume synapsedata   (uploaded files and the server signing key)
  Keep the backups of secrets/ and escrowdata in SEPARATE places. Commands and the restore
  procedure: SELF-HOSTING.md, the self-hosting guide at the repository root.

  BOOTSTRAP ADMIN LOGIN: the Dex login password is in secrets/bootstrap-admin.password.
  Keep it; the user is BOOTSTRAP_ADMIN_EMAIL (login at the deployment's IdP).

  NEXT: ./deploy.sh build && ./deploy.sh up (no external credential pending).
EOF
}

# ── build ────────────────────────────────────────────────────────────────────────────────
# Assa o SPA com as envs de PRODUÇÃO (as VITE_* são cozidas no bundle; o artefato é o
# client/dist estático que o Caddy serve em chat.<domínio base>).
#
# `npm ci` (não `install`) ANTES do build: o `ci` apaga o node_modules e instala exatamente
# o lockfile, então o artefato vira função de (commit, lockfile) — não do que por acaso
# estava na máquina. Sem `--omit=dev`: o build é `tsc --noEmit && vite build`, e tanto
# `typescript` quanto `vite` são devDependencies.
# Motivador: um node_modules anterior ao ADR-051 quebrou o build de produção com 15 TS2307
# de `@tiptap/*` (registro no §8 do PLANO-PERFIL-ORG).
# Custo aceito: ~8s de `ci` em todo `build`. Determinismo vale mais que o segundo economizado
# num comando que roda raramente — por isso a instalação é incondicional, sem cache por hash.
cmd_build() {
  # engine-strict exige npm ≥ 12; o host/a imagem trazem o 10 — npx resolve sem estado.
  ( cd "$REPO_ROOT/client" && \
    npx -y npm@12.2.1 ci && \
    VITE_SERVER_URL="https://matrix.$TAYET_DOMAIN" \
    VITE_OIDC_CLIENT_ID=000000000000000000000TAYET \
    VITE_SSO_LABEL="sua conta" \
    VITE_ESCROW_URL=/escrow \
    npm run build )
  install_agent_deps
}

# Deps do agente de custódia (ADR-069): `npm ci --omit=dev` DENTRO da imagem pinada do serviço — o
# mesmo Node do runtime, deps nativas de Linux (o prebuild do level), nenhuma dependência do Node
# do host. Só runtime: o agente roda da fonte com strip-types, sem tsc nem testes no VPS.
install_agent_deps() {
  echo "Agent: npm ci --omit=dev inside the pinned image…"
  # engine-strict exige npm ≥ 12; o host/a imagem trazem o 10 — npx resolve sem estado.
  docker run --rm -v "$AGENT_DIR:/app" -w /app "$AGENT_IMAGE" npx -y npm@12.2.1 ci --omit=dev
}

# ── render ───────────────────────────────────────────────────────────────────────────────
# Re-renderiza OS TRÊS templates (synapse/mas/dex) a partir dos secrets vivos — fecho
# operacional do F9/F10 (PLANO-CRIPTO-COBERTURA §8.7): "mudou um template → git pull →
# ./deploy.sh render → restart do serviço afetado". Fontes de valor:
#   - persistidos pelo `secrets`: dex-client.secret, bootstrap-admin.password (hash
#     re-derivado), bootstrap-admin.env (identidade do admin de bootstrap, também usada no
#     diretório renderizado), ESCROW_CLIENT_SECRET e ESCROW_MAS_ADMIN_CLIENT_SECRET (deploy.env);
#   - extraídos do RENDER VIVO por anchor inequívoco (nunca foram persistidos):
#     registration_shared_secret, macaroon_secret_key, form_secret e o shared secret
#     MAS↔Synapse — os quatro têm linha única no homeserver.yaml vivo.
# Round-trip como verificação embutida: template inalterado → render novo byte-idêntico
# ao vivo (por construção) → nada é escrito. Divergência → `.bak` (um nível) + diff no
# stdout (o registro do operador; sem prompt) + aplica + chmod 0644 (FIX dos containers
# nonroot, ver cmd_secrets). Extração vazia/ambígua, placeholder sobrando ou render vivo
# ausente → abort SEM escrever nada.
# Exceção deliberada: o hash bcrypt do admin de bootstrap re-salteia a cada derivação → dex-config
# nunca é byte-idêntico e é sempre re-aplicado (comportamento do render só-Dex de
# sempre; é o que mantém a rotação de senha via secrets/bootstrap-admin.password funcional).
# Diff SÓ na linha do hash = mesma senha, revalida igual.

# Extrai o valor de `<prefixo>VALOR<sufixo>` de um arquivo vivo. Aborta se o anchor casar
# 0 ou >1 linhas — a inequivocidade é provada em runtime, não suposta: `secret:` é
# substring de `registration_shared_secret:`, por isso todo prefixo é ancorado em ^ com
# a indentação real da linha — ou se o valor tiver caracteres fora do material gerado
# (hex), que quebrariam o sed de render. Nenhum abort daqui escreve coisa alguma.
extract_live_value() {
  local label="$1" file="$2" prefix="$3" suffix="$4" count val
  count=$(grep -c "^${prefix}" "$file" || true)
  if [[ "$count" != "1" ]]; then
    echo "ERROR: anchor for ${label} matched ${count} line(s) in ${file} (expected 1) — nothing was written." >&2
    exit 1
  fi
  val=$(sed -n "s|^${prefix}\(.*\)${suffix}\$|\1|p" "$file")
  if [[ -z "$val" ]]; then
    echo "ERROR: extraction of ${label} came back empty from ${file} — nothing was written." >&2
    exit 1
  fi
  case "$val" in
    *[!A-Za-z0-9_-]*)
      echo "ERROR: ${label} extracted from ${file} has characters outside the generated material — nothing was written." >&2
      exit 1;;
  esac
  printf '%s\n' "$val"
}

# Aplica um render staging sobre o vivo: no-op quando byte-idêntico (round-trip OK);
# senão `.bak` + diff no stdout + move + chmod 0644. Acumula o serviço afetado em
# RENDER_CHANGED para a mensagem final do cmd_render.
RENDER_CHANGED=""
apply_render() {
  local live="$1" new="$2" service="$3" name
  name="${live##*/}"
  if cmp -s "$live" "$new"; then
    rm -f "$new"
    echo "${name}: byte-identical to the live render (round-trip OK) — nothing applied."
    return 0
  fi
  cp "$live" "${live}.bak"
  echo
  echo "── ${name}: live render → new render (backup: ${name}.bak) ──"
  diff -u "$live" "$new" || true
  mv "$new" "$live"
  chmod 0644 "$live"
  RENDER_CHANGED="${RENDER_CHANGED} ${service}"
}

# Staging comum dos renders: os TRÊS templates (synapse/mas/dex) + o diretório, com os MESMOS seds
# do cmd_secrets, escritos em <dir>/{homeserver.yaml,mas-config.yaml,dex-config.yaml,directory.tsv}.
# Não toca nada vivo. Usado pelo cmd_render (que depois aplica) e pela verificação "renders em dia"
# do check e do up (que só compara). Erro de validação → exit 1; quem chama apaga o <dir> (trap).
stage_renders() {
  local out="$1"
  require_secrets
  require_htpasswd
  load_bootstrap_admin
  validate_extra_users
  load_google_oauth

  local live_hs="$RENDERED_DIR/homeserver.yaml"
  local live_mas="$RENDERED_DIR/mas-config.yaml"
  local live_dex="$RENDERED_DIR/dex-config.yaml"

  # O render pressupõe um deployment já semeado: os persistidos E os três renders vivos —
  # reg/macaroon/form/mas_shared só existem NELES (o cmd_secrets não os persiste).
  local f
  for f in "$DEX_CLIENT_SECRET_FILE" "$BOOTSTRAP_ADMIN_PASSWORD_FILE" "$live_hs" "$live_mas" "$live_dex"; do
    if [[ ! -f "$f" ]]; then
      echo "ERROR: $f missing — render assumes ./deploy.sh secrets has already run." >&2
      exit 1
    fi
  done

  # Persistidos.
  local dex_client_secret admin_hash escrow_client_secret escrow_mas_admin_secret
  dex_client_secret="$(cat "$DEX_CLIENT_SECRET_FILE")"
  case "$dex_client_secret" in
    ''|*[!A-Za-z0-9_-]*)
      echo "ERROR: $DEX_CLIENT_SECRET_FILE empty or with unexpected characters — nothing was written." >&2
      exit 1;;
  esac
  admin_hash="$(bcrypt_hash "$(cat "$BOOTSTRAP_ADMIN_PASSWORD_FILE")")"
  escrow_client_secret="$(extract_live_value "ESCROW_CLIENT_SECRET" "$DEPLOY_ENV" "ESCROW_CLIENT_SECRET=" "")"
  escrow_mas_admin_secret="$(extract_live_value "ESCROW_MAS_ADMIN_CLIENT_SECRET" "$DEPLOY_ENV" "ESCROW_MAS_ADMIN_CLIENT_SECRET=" "")"

  # Extraídos do render vivo do homeserver. `^  secret: "` (2 espaços + aspas) é a linha
  # do bloco matrix_authentication_service — a única indentada com essa forma; as demais
  # são chaves top-level de nome completo (sem risco de substring).
  local reg_secret macaroon_secret form_secret mas_shared
  reg_secret="$(extract_live_value "registration_shared_secret" "$live_hs" "registration_shared_secret: \"" "\"")"
  macaroon_secret="$(extract_live_value "macaroon_secret_key" "$live_hs" "macaroon_secret_key: \"" "\"")"
  form_secret="$(extract_live_value "form_secret" "$live_hs" "form_secret: \"" "\"")"
  mas_shared="$(extract_live_value "MAS shared secret (matrix_authentication_service.secret)" "$live_hs" "  secret: \"" "\"")"

  local new_hs="$out/homeserver.yaml" new_mas="$out/mas-config.yaml" new_dex="$out/dex-config.yaml"

  sed -e "s|__TAYET_DOMAIN__|$TAYET_DOMAIN|g" \
      -e "s|__REGISTRATION_SHARED_SECRET__|$reg_secret|g" \
      -e "s|__MACAROON_SECRET_KEY__|$macaroon_secret|g" \
      -e "s|__FORM_SECRET__|$form_secret|g" \
      -e "s|__MAS_SHARED_SECRET__|$mas_shared|g" \
      "$SCRIPT_DIR/synapse/homeserver.yaml.tmpl" > "$new_hs"

  sed -e "s|__TAYET_DOMAIN__|$TAYET_DOMAIN|g" \
      -e "s|__MAS_SHARED_SECRET__|$mas_shared|g" \
      -e "s|__ESCROW_INTROSPECTION_SECRET__|$escrow_client_secret|g" \
      -e "s|__ESCROW_MAS_ADMIN_SECRET__|$escrow_mas_admin_secret|g" \
      -e "s|__DEX_CLIENT_SECRET__|$dex_client_secret|g" \
      -e "s|__GOOGLE_CLIENT_ID__|$GOOGLE_CLIENT_ID|g" \
      -e "s|__GOOGLE_CLIENT_SECRET__|$GOOGLE_CLIENT_SECRET|g" \
      "$SCRIPT_DIR/mas/config.yaml.tmpl" > "$new_mas"

  sed -e "s|__TAYET_DOMAIN__|$TAYET_DOMAIN|g" \
      -e "s|__DEX_CLIENT_SECRET__|$dex_client_secret|g" \
      -e "s|__BOOTSTRAP_ADMIN_EMAIL__|$BOOTSTRAP_ADMIN_EMAIL|g" \
      -e "s|__BOOTSTRAP_ADMIN_USERNAME__|$BOOTSTRAP_ADMIN_USERNAME|g" \
      -e "s|__BOOTSTRAP_ADMIN_USER_ID__|$BOOTSTRAP_ADMIN_USER_ID|g" \
      -e "s|__BOOTSTRAP_ADMIN_PASSWORD_HASH__|$admin_hash|g" \
      "$SCRIPT_DIR/dex/config.yaml.tmpl" > "$new_dex"
  render_dex_users >> "$new_dex"

  render_directory > "$out/directory.tsv"

  # Placeholder sobrando em linha não-comentário = o template ganhou um placeholder que
  # este render não conhece → abort sem aplicar NADA (os comentários dos templates citam
  # `__PLACEHOLDER__` literalmente, daí o filtro de comentários).
  local n
  for n in "$new_hs" "$new_mas" "$new_dex"; do
    if grep -v "^[[:space:]]*#" "$n" | grep "__[A-Z0-9_]\{1,\}__" >&2; then
      echo "ERROR: unsubstituted placeholder in ${n##*/} (lines above) — nothing was applied." >&2
      exit 1
    fi
  done
}

# Diretório de staging dentro de secrets/rendered (os renders carregam secrets; mesmo filesystem
# do vivo, então o apply_render é um rename).
make_stage_dir() {
  if [[ ! -d "$RENDERED_DIR" ]]; then
    echo "ERROR: $RENDERED_DIR missing — render assumes ./deploy.sh secrets has already run." >&2
    exit 1
  fi
  mktemp -d "$RENDERED_DIR/.stage.XXXXXX"
}

# Linha do hash bcrypt do dex-config (`    hash: "…"`, do template) neutralizada: o hash re-salteia
# a cada render, então diff SÓ nessa linha é a mesma senha e conta como em dia.
strip_dex_hash() { sed -e 's|^\(    hash: \)".*"$|\1"<bcrypt>"|' "$1"; }

# Imprime, um por linha, os renders vivos que diferem do staging <dir>. Não aplica nada.
pending_renders() {
  local stage="$1" n
  for n in homeserver.yaml mas-config.yaml; do
    cmp -s "$RENDERED_DIR/$n" "$stage/$n" || echo "$n"
  done
  if ! cmp -s "$RENDERED_DIR/dex-config.yaml" "$stage/dex-config.yaml" \
     && ! cmp -s <(strip_dex_hash "$RENDERED_DIR/dex-config.yaml") <(strip_dex_hash "$stage/dex-config.yaml"); then
    echo "dex-config.yaml"
  fi
  if [[ ! -f "$RENDERED_DIRECTORY" ]] || ! cmp -s "$RENDERED_DIRECTORY" "$stage/directory.tsv"; then
    echo "directory.tsv"
  fi
}

# Verificação "renders em dia" (check e up): renderiza em staging e compara com os vivos, sem
# aplicar nada. Resultado em RENDERS_RC (0 em dia, 3 pendente, outro = erro, com a mensagem do
# stage_renders acima) e a linha impressa em RENDERS_MSG. Roda em subshell com o trap do staging:
# o diretório temporário some em qualquer saída, inclusive no exit 1 de uma validação.
# Chame como comando simples, NUNCA em `if`/`||`/`&&`: nesses contextos o bash ignora o `set -e`
# até dentro do subshell, e um sed falho passaria em silêncio. Por isso a função não retorna
# não-zero; o `set +e` em volta do subshell só impede que a falha dele derrube quem chama.
RENDERS_RC=0
RENDERS_MSG=""
check_renders_up_to_date() {
  local out
  set +e
  out="$(
    set -e
    stage="$(make_stage_dir)"
    trap 'rm -rf "$stage"' EXIT
    stage_renders "$stage"
    pending="$(pending_renders "$stage")"
    if [[ -n "$pending" ]]; then
      printf '%s\n' "$pending" | paste -sd ',' - | sed -e 's|,|, |g'
      exit 3
    fi
  )"
  RENDERS_RC=$?
  set -e
  case "$RENDERS_RC" in
    0) RENDERS_MSG="Renders up to date ✅";;
    3) RENDERS_MSG="Render pending: $out — run ./deploy.sh render ❌";;
    *) RENDERS_MSG="Renders: check failed (error above) ❌";;
  esac
  echo "$RENDERS_MSG"
}

# Comando de restart de um serviço, com todos os -f do script (o mesmo que o render imprime).
restart_cmd() { echo "docker compose -p $PROJECT --env-file $DEPLOYMENT_ENV ${COMPOSE_FILES[*]} restart $1"; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# O que o MAS leu no boot: o render da config + a árvore dos templates próprios (ADR-084), que
# também só é lida no boot. É o valor do marcador do `up`.
mas_applied_sum() {
  echo "$(sha256_of "$RENDERED_DIR/mas-config.yaml") $("$MAS_TEMPLATES_PREPARE" sum)"
}

# Id do container de um serviço, só se está rodando; vazio caso contrário.
running_cid() {
  local cid
  cid="$(compose ps -q "$1" 2>/dev/null)" || true
  if [[ -n "$cid" && "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null)" == "true" ]]; then
    echo "$cid"
  fi
}

# sha256 da config que o Synapse lê, de dentro do container; vazio se ilegível.
synapse_config_sum() {
  compose exec -T synapse sha256sum /data/homeserver.yaml 2>/dev/null | cut -d' ' -f1 || true
}

# A config que o Synapse lê é a do host? O render troca o arquivo por rename, e o bind mount de
# arquivo segue o inode antigo até o container reiniciar: render sem restart = Synapse lendo a
# config velha. Compara o sha256 do render vivo com o de /data/homeserver.yaml no container.
check_synapse_config_matches() {
  local host_sum ctr_sum
  if [[ -z "$(running_cid synapse)" ]]; then
    echo "Synapse config: no running container — not verified ❌"
    return 1
  fi
  host_sum="$(sha256_of "$RENDERED_DIR/homeserver.yaml")"
  ctr_sum="$(synapse_config_sum)"
  if [[ -n "$ctr_sum" && "$ctr_sum" == "$host_sum" ]]; then
    echo "Synapse config = host render ✅"
    return 0
  fi
  echo "Synapse config differs from the host render (container ${ctr_sum:-unreadable}, host $host_sum) — restart: $(restart_cmd synapse) ❌"
  return 1
}

# O MAS aplicou o render vivo? Compara com o marcador do último `up` (restart_mas_if_config_changed).
check_mas_config_matches() {
  local host_sum applied
  host_sum="$(mas_applied_sum)"
  applied="$(cat "$MAS_CONFIG_MARKER" 2>/dev/null)" || true
  if [[ "$applied" == "$host_sum" ]]; then
    echo "MAS config = render ✅"
    return 0
  fi
  echo "MAS config differs from the render (marker ${applied:-missing}, render $host_sum) — run ./deploy.sh up ❌"
  return 1
}

# Domínio persistido = server_name do render vivo = homeserver do render do MAS (ADR-095). Read-only.
check_domain_consistency() {
  local persisted hs mas
  persisted="$(sed -n 's|^TAYET_DOMAIN=||p' "$DEPLOYMENT_ENV" 2>/dev/null)" || true
  hs="$(sed -n 's|^server_name: "\(.*\)"$|\1|p' "$RENDERED_DIR/homeserver.yaml" 2>/dev/null)" || true
  mas="$(sed -n 's|^  homeserver: \(.*\)$|\1|p' "$RENDERED_DIR/mas-config.yaml" 2>/dev/null)" || true
  if [[ -n "$persisted" && "$persisted" == "$hs" && "$hs" == "$mas" ]]; then
    echo "Base domain $persisted = Synapse server_name = MAS homeserver ✅"
    return 0
  fi
  echo "Base domain: persisted '${persisted:-missing}', server_name '${hs:-unreadable}', MAS homeserver '${mas:-unreadable}' — must be equal (ADR-095) ❌"
  return 1
}

cmd_render() {
  require_secrets
  migrate_bootstrap_password_file

  local live_hs="$RENDERED_DIR/homeserver.yaml"
  local live_mas="$RENDERED_DIR/mas-config.yaml"
  local live_dex="$RENDERED_DIR/dex-config.yaml"

  # Staging apagado em qualquer saída (as validações do stage_renders saem com exit 1).
  local stage
  stage="$(make_stage_dir)"
  # shellcheck disable=SC2064  # expande agora: o local some antes do EXIT
  trap "rm -rf '$stage'" EXIT
  stage_renders "$stage"
  # Deployment anterior ao deployment.env (ADR-095 dec. 5): grava o domínio lido do render vivo.
  persist_migrated_domain
  local new_hs="$stage/homeserver.yaml" new_mas="$stage/mas-config.yaml" new_dex="$stage/dex-config.yaml"
  local new_dir="$stage/directory.tsv"

  RENDER_CHANGED=""
  apply_render "$live_hs"  "$new_hs"  synapse
  apply_render "$live_mas" "$new_mas" mas
  apply_render "$live_dex" "$new_dex" dex
  # Diretório renderizado: nenhum serviço o monta (o `up` o lê). A 1ª vez (deployment anterior
  # a este arquivo) só cria; depois, mesmo round-trip dos demais. Mudou → rode ./deploy.sh up.
  if [[ -f "$RENDERED_DIRECTORY" ]]; then
    apply_render "$RENDERED_DIRECTORY" "$new_dir" directory
  else
    mv "$new_dir" "$RENDERED_DIRECTORY"
    echo "directory.tsv: render created (apply it with ./deploy.sh up)."
  fi

  echo
  if [[ -z "$RENDER_CHANGED" ]]; then
    echo "Nothing changed — the three renders already reflect the templates."
    return 0
  fi
  echo "Renders updated:${RENDER_CHANGED}. Apply by restarting only the affected ones:"
  local s
  for s in $RENDER_CHANGED; do
    if [[ "$s" == "directory" ]]; then
      echo "  ./deploy.sh up   # organization directory (no container to restart)"
      continue
    fi
    echo "  $(restart_cmd "$s")"
  done
  case "$RENDER_CHANGED" in
    *dex*)
      echo "(dex: the bcrypt hash is re-salted on every render — a diff ONLY on the hash line = same"
      echo " password, validates the same; restarting dex is harmless in that case)";;
  esac
}

# ── backup do Postgres (ADR-047) ─────────────────────────────────────────────────────────
# Os dois bancos da instância compartilhada: `synapse` (POSTGRES_DB do compose) e `mas`
# (postgres-init/create-mas-db.sql). Banco novo nessa instância entra AQUI também.
PG_BACKUP_DBS=(synapse mas)
# Retenção: os 5 dumps mais recentes. 5 ups ≈ uma semana típica de deploys do dogfood —
# janela para notar um migrate ruim e ainda ter o estado anterior a ele. Revisável.
PG_BACKUP_KEEP=5

# Diretórios de backup completos, do mais antigo ao mais novo (o nome é o timestamp UTC,
# ordenável como texto). O `.partial` de um dump abortado não casa o padrão.
list_pg_backups() {
  local d
  for d in "$BACKUPS_DIR"/[0-9]*T[0-9]*Z; do
    if [[ -d "$d" ]]; then echo "${d##*/}"; fi
  done | sort
}

# Dump lógico (`pg_dump -Fc`, restaurável com `pg_restore`) dos dois bancos ANTES do migrate:
# o migrate do MAS é forward-only (PLANO-RELEASE-PUBLICA §8.13 achado 3), então o estado
# anterior a ele só existe se for guardado aqui. Roda em TODO `up`, mesmo sem migração
# pendente — barato, e é o que o ADR-047 pede: backup antes de qualquer gesto no estado
# crítico. Cobre só `pgdata`; `secrets/` e `escrowdata` seguem manuais (README).
# Falha em qualquer dump → aborta o up ANTES de migrar.
backup_postgres_before_migrate() {
  local ts dir partial db f
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  dir="$BACKUPS_DIR/$ts"
  partial="$dir.partial"
  if [[ -e "$dir" || -e "$partial" ]]; then
    echo "ERROR: backup before migrate failed — up aborted ($dir already exists)." >&2
    exit 1
  fi
  mkdir -p "$BACKUPS_DIR"
  chmod 700 "$BACKUPS_DIR"
  mkdir -m 700 "$partial"

  echo "Postgres: pg_dump of ${PG_BACKUP_DBS[*]} before migrate…"
  for db in "${PG_BACKUP_DBS[@]}"; do
    f="$partial/$db.dump"
    if ! compose exec -T postgres pg_dump -U synapse -Fc "$db" > "$f" || [[ ! -s "$f" ]]; then
      rm -rf "$partial"
      echo "ERROR: backup before migrate failed — up aborted" >&2
      exit 1
    fi
  done
  mv "$partial" "$dir"

  echo "Postgres backup: $dir"
  for db in "${PG_BACKUP_DBS[@]}"; do
    echo "  $db.dump  $(du -h "$dir/$db.dump" | cut -f1)"
  done

  # Retenção: apaga os mais antigos além de PG_BACKUP_KEEP — nunca o recém-criado (relógio
  # que volta no tempo o deixaria fora da ordem).
  local all=() d n
  while IFS= read -r d; do all+=("$d"); done < <(list_pg_backups)
  n=${#all[@]}
  if (( n > PG_BACKUP_KEEP )); then
    for d in "${all[@]:0:n-PG_BACKUP_KEEP}"; do
      [[ "$d" == "$ts" ]] && continue
      rm -rf "${BACKUPS_DIR:?}/$d"
      echo "  retention: removed $d"
    done
  fi
}

# ── up ───────────────────────────────────────────────────────────────────────────────────
# Migrate + config sync do MAS ANTES do server (padrão exato do dev-stack, mesmo
# abort-em-falha), depois sobe a stack, provisiona `system` e semeia o canal #all.
mas_migrate_and_sync() {
  echo "MAS: database migrate…"
  # FIX (findings — deploy limpo tayet.app): `compose run` NÃO honra
  # `depends_on: condition: service_healthy` como o `up` faz — ele sobe o Postgres via
  # depends_on mas dispara o comando sem esperar o healthcheck. Em VPS virgem o migrate
  # pega o Postgres na janela do restart de fim-de-init (Connection refused). Subir o
  # postgres com --wait fecha a corrida antes do primeiro `compose run`.
  compose up -d --wait postgres
  backup_postgres_before_migrate
  if ! compose run --rm mas "${MAS_CONFIG_ARGS[@]}" database migrate; then
    echo "ERROR: 'mas-cli database migrate' failed — up was aborted (MAS would come up broken)." >&2
    exit 1
  fi
  echo "MAS: config sync --prune…"
  if ! compose run --rm mas "${MAS_CONFIG_ARGS[@]}" config sync --prune; then
    echo "ERROR: 'mas-cli config sync --prune' failed — up was aborted (MAS would come up broken)." >&2
    exit 1
  fi
}

# O compose não recria um serviço quando só o conteúdo de um bind mount de arquivo muda, e o render
# troca o arquivo por rename: o container segue no inode antigo, e o `up` termina verde com a config
# velha (incidente de 02/Nov, PLANO-PESSOAS §8.4). Sem container de pé não há o que reiniciar: o
# `up -d` que vem depois lê o render vivo.
restart_mas_if_config_changed() {
  local sum
  sum="$(mas_applied_sum)"
  if [[ "$(cat "$MAS_CONFIG_MARKER" 2>/dev/null)" == "$sum" ]]; then return 0; fi
  if [[ -n "$(running_cid mas)" ]]; then
    compose restart mas
    echo "MAS: config changed — restarted ✅"
  fi
  printf '%s\n' "$sum" > "$MAS_CONFIG_MARKER"
}

# Mesma lacuna do MAS; aqui o hash lido de dentro do container dispensa o marcador.
restart_synapse_if_config_changed() {
  if [[ -z "$(running_cid synapse)" ]]; then return 0; fi
  if [[ "$(synapse_config_sum)" == "$(sha256_of "$RENDERED_DIR/homeserver.yaml")" ]]; then return 0; fi
  compose restart synapse
  echo "Synapse: config changed — restarted ✅"
}

# sha256 do Caddyfile que o Caddy lê, de dentro do container (a imagem pinada traz o sha256sum do
# busybox); vazio se ilegível.
caddy_config_sum() {
  compose exec -T caddy sha256sum /etc/caddy/Caddyfile 2>/dev/null | cut -d' ' -f1 || true
}

# Mesma lacuna, agora do Caddyfile: o `git pull` troca o inode, o bind de arquivo único segue o
# antigo, e o `up -d` não recria o Caddy porque a config do compose não mudou (PLANO-RELEASE-PUBLICA
# §8.16 e o deploy do #333). Roda DEPOIS do `up -d` da fase 1: sem container de pé não há o que
# reiniciar, e o container que existe é o que o compose acabou de garantir. Valida o arquivo novo
# ANTES do restart, com a mesma imagem do container (lida dele, sem duplicar o digest do compose):
# Caddyfile inválido aborta o up e o Caddy segue servindo a config antiga.
restart_caddy_if_config_changed() {
  local cid image out
  cid="$(running_cid caddy)"
  if [[ -z "$cid" ]]; then return 0; fi
  if [[ "$(caddy_config_sum)" == "$(sha256_of "$SCRIPT_DIR/Caddyfile")" ]]; then return 0; fi
  image="$(docker inspect -f '{{.Config.Image}}' "$cid")"
  # -e TAYET_DOMAIN: a validação vê os mesmos hosts que o contêiner vai servir (ADR-095).
  if ! out="$(docker run --rm -e TAYET_DOMAIN="$TAYET_DOMAIN" -v "$SCRIPT_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" "$image" \
      caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)"; then
    printf '%s\n' "$out" | tail -n 20 >&2
    echo "ERROR: $SCRIPT_DIR/Caddyfile changed and is invalid (caddy validate) — Caddy NOT restarted, it keeps the old config." >&2
    echo "       Fix the Caddyfile and run ./deploy.sh up again." >&2
    exit 1
  fi
  compose restart caddy
  echo "Caddy: config changed — restarted ✅"
}

# FIX (findings — deploy limpo tayet.app): volume nomeado NOVO nasce root:root; o Synapse
# (uid 991 após o step-down do entrypoint) não escreve a signing key em /data no 1º boot
# (PermissionError [Errno 13]). Só morde em volume VIRGEM — o dev-stack reusa volume, por
# isso nunca pegou. Idempotente: chown de volume já-991 é no-op. Reusa a imagem JÁ pinada
# do Synapse (root no entrypoint, tem chown) via --entrypoint → zero imagem nova.
ensure_synapse_volume_owner() {
  # Cria o volume com os labels do compose (no-op se já existe) para não colidir com um
  # volume "criado fora do compose"; depois ajusta o dono pro uid do Synapse.
  compose up -d --no-start synapse >/dev/null 2>&1 || true
  local vol="${PROJECT}_synapsedata"
  docker run --rm -v "${vol}:/data" --entrypoint chown "$SYNAPSE_IMAGE" -R 991:991 /data
}

probe_synapse() { curl -sf -m 3 "$HS_URL/_matrix/client/versions" >/dev/null 2>&1; }

wait_for_synapse() {
  echo "Waiting for Synapse to respond at $HS_URL (timeout ${WAIT_TIMEOUT_S}s)…"
  local start; start=$(date +%s)
  until probe_synapse; do
    if (( $(date +%s) - start > WAIT_TIMEOUT_S )); then
      echo "ERROR: Synapse did not respond within ${WAIT_TIMEOUT_S}s. See: ./deploy.sh check and docker logs." >&2
      exit 1
    fi
    sleep 2
  done
  echo "Synapse OK ✅"
}

# Provisiona um usuário quando ausente. Idempotência por "User already exists" (mesmo
# padrão do dev-stack): o up rotineiro não cunha nada; só o up criador provisiona.
provision_user() {
  local user="$1" email="${2:-}" out mas_cid
  mas_cid="$(compose ps -q mas)"
  if [[ -z "$mas_cid" ]]; then
    echo "ERROR: MAS container is not up — cannot provision $user." >&2
    exit 1
  fi
  # FIX (findings — deploy limpo tayet.app + ADR-048): o ADR-048 fixou passwords.enabled:
  # false no MAS (autenticação é do Dex). register-user --password é recusado
  # ("Password manager is disabled"). --password é OPCIONAL (mas-cli 1.18); SEM ele a conta
  # nasce sem caminho de login — exatamente o que uma conta de serviço interna quer. O seed
  # do #all cunha um compatibility-token nessa conta (issue-compatibility-token, provado).
  if out=$(docker exec "$mas_cid" mas-cli "${MAS_CONFIG_ARGS[@]}" manage register-user \
      --yes ${email:+--email "$email"} "$user" 2>&1); then
    echo "User $user provisioned ✅"
  elif grep -q "User already exists" <<<"$out"; then
    echo "User $user already exists — skip."
  else
    echo "ERROR: provisioning of $user failed:" >&2
    echo "$out" >&2
    exit 1
  fi
}

# Canal da organização (ADR-045): sala PÚBLICA e EM CLARO (sem m.room.encryption — a regra
# "public → claro"), de posse do `system`, alias canônico #all:<domínio base>. Idempotência por
# resolução de alias ANTES de cunhar token: up rotineiro (sala já existe) não cunha nada.
# Probe de ativação de token (issue #7 M2): um mct_ recém-cunhado pode ser rejeitado
# M_UNKNOWN_TOKEN no PRIMEIRO uso (janela entre o mint no mas-cli e a visibilidade na
# introspecção MAS→Synapse — 2 boot-fails no soak de Jul/2026, PLANO-GATES §8.1).
# Espera o whoami aceitar o token antes de qualquer uso. Budget 30s, poll 1s. Gêmeo do
# probe_token_active do dev-stack.sh.
probe_token_active() {
  local token="$1" start now code
  start=$(date +%s)
  while :; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
      -H "Authorization: Bearer $token" \
      "$HS_URL/_matrix/client/v3/account/whoami")
    if [ "$code" = "200" ]; then
      return 0
    fi
    now=$(date +%s)
    if [ $((now - start)) -ge 30 ]; then
      echo "ERROR: token did not activate after $((now - start))s (last HTTP $code on whoami)." >&2
      exit 1
    fi
    sleep 1
  done
}

# ── Pertencimento à organização (ADR-083) ────────────────────────────────────────────────
# Admin da organização = flag `admin` do MAS (ADR-083 dec. 7), idempotente. NUNCA para `system`
# (ADR-054 dec. 3).
promote_org_admin() {
  local user="$1" out mas_cid
  mas_cid="$(compose ps -q mas)"
  if ! out=$(docker exec "$mas_cid" mas-cli "${MAS_CONFIG_ARGS[@]}" manage promote-admin "$user" 2>&1); then
    echo "ERROR: promote-admin of $user failed:" >&2
    echo "$out" >&2
    exit 1
  fi
  echo "Org admin: $user ✅"
}

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
    *)  echo "ERROR: PUT of $ORG_MEMBER_EVENT for $key returned HTTP $code." >&2; exit 1;;
  esac
}

seed_org_channel() {
  local code token res mas_cid
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
    "$HS_URL/_matrix/client/v3/directory/room/$ORG_CHANNEL_ALIAS_ENC")
  if [ "$code" = "200" ]; then
    echo "Channel #${ORG_CHANNEL_LOCALPART} already exists — skip."
    return 0
  fi
  if [ "$code" != "404" ]; then
    echo "ERROR: resolving the org channel alias returned HTTP $code (expected 200|404)." >&2
    exit 1
  fi
  mas_cid="$(compose ps -q mas)"
  token=$(docker exec "$mas_cid" mas-cli "${MAS_CONFIG_ARGS[@]}" manage issue-compatibility-token \
    system 2>&1 | grep -m1 -oE 'mct_[A-Za-z0-9_]+') || true
  if [ -z "$token" ]; then
    echo "ERROR: could not mint a token for the system account." >&2
    exit 1
  fi
  probe_token_active "$token"
  # Nenhum m.room.encryption no initial_state → nasce em claro (ADR-045). Preset public_chat +
  # join_rule invite (ADR-083 dec. 2), não private_chat: este liga guest_access e, sob
  # encryption_enabled_by_default_for_room_type, a cifra. room_alias_name registra o alias canônico.
  res=$(curl -s -m 10 -X POST \
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
    -d "{\"preset\":\"public_chat\",\"room_alias_name\":\"$ORG_CHANNEL_LOCALPART\",\"name\":\"$ORG_CHANNEL_LOCALPART\",\"initial_state\":[{\"type\":\"m.room.join_rules\",\"state_key\":\"\",\"content\":{\"join_rule\":\"invite\"}}],\"power_level_content_override\":{\"events\":$ORG_POWER_EVENTS}}" \
    "$HS_URL/_matrix/client/v3/createRoom")
  if grep -q '"room_id"' <<<"$res"; then
    echo "Channel #${ORG_CHANNEL_LOCALPART} created ✅"
  else
    echo "ERROR: creating the org channel failed: $res" >&2
    exit 1
  fi
}

# Idempotente, a cada `up`: migra #all (one-shot) e reconcilia o pertencimento. O evento vem ANTES do
# convite, para a pessoa já ser `member` no primeiro boot, e vale para quem ainda não logou: o convite
# de conta sem 1º login é aceito (200) e não a cria (o pré-check do sync_org_directory segue em 404).
sync_org_membership() {
  local mas_cid resolved room_id room token state status allowlist line mxid membership u key code body kind backfilled=0
  allowlist=$(awk '/^[[:space:]]+username:/ { gsub(/.*username:[[:space:]]*"?|"[[:space:]]*$/, ""); print }' "$RENDERED_DIR/dex-config.yaml")
  if [ -z "$allowlist" ]; then
    echo "ERROR: Dex allowlist unreadable or empty in $RENDERED_DIR/dex-config.yaml." >&2
    exit 1
  fi

  resolved=$(curl -s -m 5 "$HS_URL/_matrix/client/v3/directory/room/$ORG_CHANNEL_ALIAS_ENC")
  room_id=$(sed -nE 's/.*"room_id":"([^"]+)".*/\1/p' <<<"$resolved")
  if [ -z "$room_id" ]; then
    echo "ERROR: org channel alias did not resolve: $resolved" >&2
    exit 1
  fi
  room=${room_id/!/%21}
  room=${room/:/%3A}

  mas_cid="$(compose ps -q mas)"
  token=$(docker exec "$mas_cid" mas-cli "${MAS_CONFIG_ARGS[@]}" manage issue-compatibility-token \
    system 2>&1 | grep -m1 -oE 'mct_[A-Za-z0-9_]+') || true
  if [ -z "$token" ]; then
    echo "ERROR: could not mint a token for the system account." >&2
    exit 1
  fi
  probe_token_active "$token"

  state=$(curl -s -m 15 -H "Authorization: Bearer $token" "$HS_URL/_matrix/client/v3/rooms/$room/state")
  status=$(org_state_summary <<<"$state") || {
    echo "ERROR: org channel state unreadable: ${state:0:200}" >&2
    exit 1
  }

  # 1. Migração one-shot de #all nascido público (ADR-083 dec. 2); reversível por PUT manual.
  if ! grep -qx 'joinrule invite' <<<"$status"; then
    code=$(org_room_call PUT "$HS_URL/_matrix/client/v3/rooms/$room/state/m.room.join_rules" \
      '{"join_rule":"invite"}' "$token")
    case "$code" in
      2*) echo "Channel #${ORG_CHANNEL_LOCALPART} migrated to invite ✅";;
      *)  echo "ERROR: join_rule migration returned HTTP $code." >&2; exit 1;;
    esac
  fi
  if ! grep -qx 'gated' <<<"$status"; then
    body=$(curl -s -m 10 -H "Authorization: Bearer $token" \
      "$HS_URL/_matrix/client/v3/rooms/$room/state/m.room.power_levels" | org_power_levels_gated)
    code=$(org_room_call PUT "$HS_URL/_matrix/client/v3/rooms/$room/state/m.room.power_levels" "$body" "$token")
    case "$code" in
      2*) echo "Channel #${ORG_CHANNEL_LOCALPART}: $ORG_MEMBER_EVENT restricted to system ✅";;
      *)  echo "ERROR: power-levels migration returned HTTP $code." >&2; exit 1;;
    esac
  fi

  # Em todo passo abaixo: `kind` gravado (vivo ou lápide) não é reescrito, e conta `a-` (agente,
  # ADR-086 dec. 1/3) é pulada inteira: nunca marcada member, nunca convidada para #all.

  # 2. Quem já está em #all é da org (migração); contas de serviço não são gente.
  while read -r _ mxid membership; do
    [ "$membership" = "join" ] || continue
    u=${mxid#@}
    u=${u%%:*}
    case "$u" in system|"$CUSTODY_ACCOUNT"|a-*) continue;; esac
    key=${mxid#@}
    grep -qx "kind $key" <<<"$status" || org_mark_member "$key" "$token" "$room"
  done <<<"$(grep '^member ' <<<"$status")"

  # 3. Toda a allowlist é membro, exista a conta ou não.
  for u in $allowlist; do
    case "$u" in a-*) continue;; esac
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
      2*)      echo "Invite to #${ORG_CHANNEL_LOCALPART}: $u ✅";;
      403|409) echo "Invite to #${ORG_CHANNEL_LOCALPART}: $u refused (HTTP $code) — continuing.";;
      *)       echo "ERROR: invite of $u returned HTTP $code." >&2; exit 1;;
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
  [ "$backfilled" -eq 0 ] || echo "Email of $backfilled person(s) filled in $ORG_MEMBER_EVENT ✅"

  # O token não sobrevive à função.
  unset token
  echo "Organization membership synced ✅"
}

# ── Diretório organizacional (ADR-054) ───────────────────────────────────────────────────
# Sync DECLARATIVO do diretório para o sink MSC4133 do perfil (dec. 4/5). A ESPINHA é a
# allowlist do Dex e o TSV é a TABELA DE ATRIBUTOS, join por `username`. Ambos são lidos dos
# RENDERS em secrets/rendered/ (o admin de bootstrap e os usuários extras só existem neles — vêm de
# variável e de secrets/dex-users.yaml + directory.extra.tsv); as fontes versionadas
# (dex/config.yaml.tmpl, directory.tsv) chegam lá pelo `render`. Campo vazio não é "não mexer": é ausência declarada →
# DELETE da chave. Apagar no TSV apaga no servidor.
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
DIRECTORY_TSV="$RENDERED_DIRECTORY"
DEX_CONFIG_RENDERED="$RENDERED_DIR/dex-config.yaml"

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
      *)  echo "ERROR: PUT of $key on $u returned HTTP $code after an approved pre-check." >&2
          exit 1;;
    esac
  else
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X DELETE \
      -H "Authorization: Bearer $token" "$url")
    case "$code" in
      2*|404|405) echo "  $u · $key deleted (declared absence) ✅";;
      *) echo "ERROR: DELETE of $key on $u returned HTTP $code." >&2; exit 1;;
    esac
  fi
}

sync_org_directory() {
  local allowlist u line token="" full_name job_title work_email code d mas_cid

  # 1. Org sem diretório é estado VÁLIDO, não erro.
  if [ ! -f "$DIRECTORY_TSV" ]; then
    echo "Organization directory missing ($DIRECTORY_TSV — run ./deploy.sh render) — no organizational layer."
    return 0
  fi

  # 2. A allowlist é a espinha. Ilegível não é "sem gente": é erro duro.
  allowlist=$(awk '/^[[:space:]]+username:/ { gsub(/.*username:[[:space:]]*"?|"[[:space:]]*$/, ""); print }' "$DEX_CONFIG_RENDERED")
  if [ -z "$allowlist" ]; then
    echo "ERROR: Dex allowlist unreadable or empty in $DEX_CONFIG_RENDERED." >&2
    exit 1
  fi

  echo "Syncing the organization directory…"

  # 3/4. Na ordem da allowlist. O token é cunhado NA PRIMEIRA linha casada e reusado pelo
  # loop inteiro — allowlist sem nenhum join não cunha nada (disciplina anti-acumulação de
  # compat session, a mesma do provision_user e do seed_org_channel).
  for u in $allowlist; do
    line=$(org_tsv_line "$DIRECTORY_TSV" "$u")
    if [ -z "$line" ]; then
      echo "Org profile of $u: no line in the directory — no organizational layer."
      continue
    fi

    if [ -z "$token" ]; then
      mas_cid="$(compose ps -q mas)"
      if [[ -z "$mas_cid" ]]; then
        echo "ERROR: MAS container is not up — cannot sync the directory." >&2
        exit 1
      fi
      token=$(docker exec "$mas_cid" mas-cli "${MAS_CONFIG_ARGS[@]}" manage \
        issue-compatibility-token --yes-i-want-to-grant-synapse-admin-privileges system 2>&1 \
        | grep -m1 -oE 'mct_[A-Za-z0-9_]+') || true
      if [ -z "$token" ]; then
        echo "ERROR: could not mint the directory's ephemeral admin token." >&2
        exit 1
      fi
    fi

    code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
      -H "Authorization: Bearer $token" \
      "$HS_URL/_synapse/admin/v2/users/@$u:$ORG_SERVER_NAME")
    case "$code" in
      404) echo "Org profile of $u: target does not exist yet (first login pending) — skip."
           continue;;
      200) ;;
      *)   echo "ERROR: pre-check of $u returned HTTP $code (expected 200|404)." >&2
           unset token
           exit 1;;
    esac

    full_name=$(printf '%s' "$line" | cut -f2)
    job_title=$(printf '%s' "$line" | cut -f3)
    work_email=$(printf '%s' "$line" | cut -f4)
    echo "Org profile of $u:"
    org_apply_key "$u" "io.tayet.full_name"  "$full_name"  "$token"
    org_apply_key "$u" "io.tayet.job_title"  "$job_title"  "$token"
    org_apply_key "$u" "io.tayet.work_email" "$work_email" "$token"
  done

  # 5. Linha no diretório sem correspondente na allowlist: typo provável. Avisa e SEGUE —
  # o TSV é editado à mão, e reprovar o `up` inteiro por um typo é desproporcional.
  while IFS= read -r d; do
    [ -z "$d" ] && continue
    if ! printf '%s\n' "$allowlist" | grep -qx "$d"; then
      echo "WARNING: '$d' is in the directory but not in the Dex allowlist — typo?" >&2
    fi
  done <<< "$(awk -F'\t' '!/^#/ && NF && $1 != "" { print $1 }' "$DIRECTORY_TSV")"

  # 6. O token não sobrevive à função.
  unset token
  echo "Organization directory synced ✅"
}

# ── Revogação da sessão de serviço (ADR-054 dec. 5, addendum de 2026-07-23) ──────────────
# Sweep de TODAS as compat sessions da conta de serviço ao fim do `up`. Armada por `trap` no
# cmd_up, cobre sucesso, falha e interrupção. Alvo EXCLUSIVO: a conta de serviço — NUNCA conta
# humana.
#
# (i)   O grão — TODAS as sessões do usuário — é ACERTO, não limitação. `system` é conta de
#       serviço: nasce por register-user --yes, não tem caminho de login (ADR-048), e todos os
#       consumidores são one-shot (seed_org_channel cunha/cria/termina; sync_org_directory
#       cunha/escreve/termina). Nenhuma sessão legítima de `system` é longeva, logo « derrubar
#       todas » ≡ « derrubar as que já cumpriram seu papel » (§8 do PLANO, "Grão de revogação").
# (ii)  Efeito colateral aceito: quem cunhar um token manual de `system` e rodar `up` em seguida
#       PERDE esse token — o único caso em que o grão morde (§8 do PLANO, "Grão de revogação").
# (iii) A sweep ENCERRA (finished_at), NÃO remove: as linhas permanecem. Ela troca credencial
#       ATIVA (superfície de ataque) por linha finalizada (trilha de auditoria) — e NÃO elimina
#       acúmulo de linhas (§8 do PLANO, "A sweep troca o que acumula").
#
# Idempotente: kill-sessions sobre conta sem sessão ativa é no-op (medido, PR-1b §0.3).
# Degrada limpo: MAS não subiu — caso real do `up` que falhou ANTES do `compose up -d` — vira
# aviso + return, sem empilhar um segundo erro confuso sobre o primeiro.
# NUNCA mascara o código de saída original: a função roda de um trap, então captura o status na
# ENTRADA (rc) e o RESTAURA em toda saída. Sob `set -e`, um comando interno que falha sem guarda
# no trap flipa exit 0 → exit 1 (medido) — por isso cada comando é guardado.
SERVICE_ACCOUNT="system"
revoke_service_sessions() {
  local rc=$?
  local mas_cid out
  mas_cid="$(compose ps -q mas 2>/dev/null)" || true
  if [[ -z "$mas_cid" ]]; then
    echo "WARNING: MAS container unavailable — sessions of $SERVICE_ACCOUNT not revoked." >&2
    return "$rc"
  fi
  if out=$(docker exec "$mas_cid" mas-cli "${MAS_CONFIG_ARGS[@]}" manage kill-sessions "$SERVICE_ACCOUNT" 2>&1); then
    echo "Sessions of $SERVICE_ACCOUNT revoked ✅"
  else
    echo "WARNING: revoking the sessions of $SERVICE_ACCOUNT failed:" >&2
    echo "$out" >&2
  fi
  return "$rc"
}

# ── Agente de custódia `cofre` (ADR-057 dec. 5; forma operacional no ADR-069) ────────────────
# Conta de serviço sem login, como o `system` (ADR-048 dec. 4): register-user --yes sem senha. O
# token é um mct_ do MESMO mas-cli que o `system` usa (issue-compatibility-token), cunhado uma vez e
# reusado: cada mint cunha um DEVICE novo, e o store do agente é amarrado ao device. O trap do `up`
# (revoke_service_sessions) segue escopado ao `system` e NÃO alcança o cofre.
CUSTODY_ACCOUNT="cofre"
CUSTODY_MXID="@${CUSTODY_ACCOUNT}:${ORG_SERVER_NAME}"

# Gera a AGENT_STORAGE_KEY uma vez (32 bytes base64 — contrato do loadConfig do agente). Idempotente:
# chave presente nunca é trocada (trocá-la torna o store ilegível → F8).
ensure_agent_secrets() {
  if [[ -f "$AGENT_ENV" ]] && grep -q '^AGENT_STORAGE_KEY=' "$AGENT_ENV"; then
    return 0
  fi
  echo "Generating AGENT_STORAGE_KEY (once) in $AGENT_ENV…"
  ( umask 077; printf 'AGENT_STORAGE_KEY=%s\n' "$(openssl rand -base64 32)" > "$AGENT_ENV" )
}

agent_volume_exists() { docker volume inspect "$AGENT_VOLUME" >/dev/null 2>&1; }

# Shell efêmero sobre o volume do agente, na imagem pinada. Só com o volume existente: `docker run`
# num volume ausente o criaria fora do compose (sem labels). `mode` = ro (check) | rw (remediação).
agent_data_sh() {
  local mode="$1" cmd="$2"
  docker run --rm -v "${AGENT_VOLUME}:/data:${mode}" "$AGENT_IMAGE" sh -c "$cmd"
}

whoami_code() {
  curl -s -o /dev/null -w '%{http_code}' -m 5 -H "Authorization: Bearer $1" \
    "$HS_URL/_matrix/client/v3/account/whoami" || echo "000"
}

# Probe SOFT de ativação (irmão do probe_token_active, sem o exit): 0 = whoami aceitou, 1 = budget
# de 30 s esgotado.
probe_token_soft() {
  local token="$1" start
  start=$(date +%s)
  while :; do
    [[ "$(whoami_code "$token")" == "200" ]] && return 0
    if (( $(date +%s) - start >= 30 )); then return 1; fi
    sleep 1
  done
}

# Mint do cofre com o ramo M2 (issue #7; PLANO-GATES §8.10): um mct_ recém-cunhado pode perder o
# device numa corrida do mint e nunca ativar. No dev-stack o discriminador é a introspecção direta no
# MAS; aqui o MAS não publica porta, então o ramo é por budget: whoami que não aceita em 30 s →
# re-cunha UMA vez, com a linha contável [m2-device-race]; segunda falha → exit 1. Só mas-cli + whoami.
MINTED_TOKEN=""
mint_custody_token() {
  local mas_cid attempt
  mas_cid="$(compose ps -q mas)"
  if [[ -z "$mas_cid" ]]; then
    echo "ERROR: MAS container is not up — cannot mint the cofre token." >&2
    exit 1
  fi
  for attempt in 1 2; do
    MINTED_TOKEN=$(docker exec "$mas_cid" mas-cli "${MAS_CONFIG_ARGS[@]}" manage issue-compatibility-token \
      "$CUSTODY_ACCOUNT" 2>&1 | grep -m1 -oE 'mct_[A-Za-z0-9_]+') || true
    if [[ -z "$MINTED_TOKEN" ]]; then
      echo "ERROR: could not mint a token for the $CUSTODY_ACCOUNT account." >&2
      exit 1
    fi
    if probe_token_soft "$MINTED_TOKEN"; then return 0; fi
    if [[ "$attempt" == "1" ]]; then
      echo "[m2-device-race] re-mint for $CUSTODY_ACCOUNT (token mct_…${MINTED_TOKEN: -6} did not activate within 30 s)" >&2
    fi
  done
  echo "ERROR: $CUSTODY_ACCOUNT token did not activate after the re-mint (signature [m2-device-race] repeated)." >&2
  exit 1
}

# Estado do store do agente, para o ensure_agent_token e o check_agent: `lost` (volume ausente),
# `present` (/data/identity.json existe) ou `absent` (volume sem o marcador). A leitura no volume tem de
# devolver exatamente um de dois valores; qualquer outra saída, ou falha do `docker run`, é return 1 e o
# chamador decide (o `up` aborta sem tocar o token). Volume ausente nunca chama agent_data_sh (criaria o
# volume fora do compose).
agent_store_state() {
  local out
  if ! agent_volume_exists; then echo lost; return 0; fi
  out=$(agent_data_sh ro 'if [ -f /data/identity.json ]; then echo present; else echo absent; fi' 2>/dev/null) || return 1
  case "$out" in
    present|absent) echo "$out";;
    *) return 1;;
  esac
}

# Token do cofre (ADR-069 dec. 3, 5 e 7). Quatro casos:
#   · token presente e vivo (whoami 200) com o marcador identity.json no store → reusa;
#   · token morto (whoami 401: reaper de 30 dias do ADR-062, revogação manual) → re-mint. O device
#     velho já morreu com a sessão; o agente vê device-changed no boot e começa com store virgem
#     (o único wipe que ele mesmo faz, agent/src/main.ts);
#   · sentinela REMEDIATION_NEEDED no store (F8): o agente achou store inutilizável ou chaves
#     divergentes e PAROU. Remediação, NESTA ordem: stop → kill-sessions do cofre (encerra a sessão
#     velha; o MAS apaga o device — nunca DELETE de admin, invariante do ADR-054) → mint → wipe do
#     store, sentinela incluída → o chamador sobe o agente. O kill vem ANTES do mint: depois, mataria
#     o token novo. Wipe que falha aborta o up (set -e) com a sentinela no lugar; o próximo up remedia
#     de novo;
#   · token vivo (whoami 200) com o volume `agentdata` ausente ou sem identity.json (ADR-069 dec. 5:
#     perda do volume = F8): o agente subiria com store virgem no MESMO device, o servidor aceitaria as
#     device keys novas e recusaria as one-time keys com 400 — o zumbi, com o `check` verde (medido no
#     Param PR 4b, PLANO-DEPLOY-DOMINIO §8). A sentinela não cobre o caso: ela mora no store perdido.
#     Mesmo caminho da F8: stop → kill-sessions → mint → wipe (só se o volume existe; ausente, o
#     agent_data_sh o criaria fora do compose) → o chamador sobe o agente. Leitura do store que falha
#     aborta o up sem tocar o token.
# Qualquer outro status no whoami (000/429/5xx) aborta SEM tocar o token: na ambiguidade, re-cunhar
# trocaria o device à toa.
ensure_agent_token() {
  local sentinel="" code mas_cid out store="" remediate=""
  if [[ -s "$AGENT_TOKEN_FILE" ]]; then
    if agent_volume_exists; then
      sentinel=$(agent_data_sh ro 'cat /data/REMEDIATION_NEEDED 2>/dev/null || true' | tr -d '[:space:]')
    fi
    if [[ -z "$sentinel" ]]; then
      if ! store=$(agent_store_state); then
        echo "ERROR: could not read the agent store ($AGENT_VOLUME) — token kept, up aborted (run it again)." >&2
        exit 1
      fi
      code=$(whoami_code "$(cat "$AGENT_TOKEN_FILE")")
      case "$code" in
        200) if [[ "$store" == "present" ]]; then
               echo "cofre token: OK ✅ (reused)"; return 0
             fi
             echo "Agent store missing with a live token (no identity marker) — F8: stop → kill-sessions → mint → up."
             remediate=1;;
        401) echo "cofre token dead (HTTP 401) — re-mint (new device; the agent starts with an empty store).";;
        *)   echo "ERROR: cofre whoami returned HTTP $code — token kept, up aborted (run it again)." >&2
             exit 1;;
      esac
    else
      echo "Agent remediation sentinel ($sentinel) — F8: stop → kill-sessions → mint → wipe → up."
      remediate=1
    fi
    if [[ -n "$remediate" ]]; then
      compose stop agent >/dev/null 2>&1 || true
      mas_cid="$(compose ps -q mas)"
      if ! out=$(docker exec "$mas_cid" mas-cli "${MAS_CONFIG_ARGS[@]}" manage kill-sessions "$CUSTODY_ACCOUNT" 2>&1); then
        echo "ERROR: kill-sessions of $CUSTODY_ACCOUNT failed — remediation aborted before the mint:" >&2
        echo "$out" >&2
        exit 1
      fi
      echo "Sessions of $CUSTODY_ACCOUNT ended (the old device goes away through the MAS device sync) ✅"
    fi
  fi
  mint_custody_token
  ( umask 077; printf '%s\n' "$MINTED_TOKEN" > "$AGENT_TOKEN_FILE" )
  MINTED_TOKEN=""
  echo "cofre token minted ✅"
  if [[ -n "$remediate" ]] && agent_volume_exists; then
    agent_data_sh rw 'find /data -mindepth 1 -delete'
    echo "Agent store wiped TOGETHER with the mint (F8 — never apart) ✅"
  fi
}

# Fase 2 do `up`: o agente. Opt-out durável (ADR-069 dec. 11) pelo arquivo secrets/agent.disabled.
# Sem agent/node_modules o serviço fica fora, com aviso — nunca um container em crash-loop mudo.
start_agent() {
  if [[ -e "$AGENT_DISABLED_FLAG" ]]; then
    compose stop agent >/dev/null 2>&1 || true
    echo "WARNING: custody agent DISABLED by opt-out ($AGENT_DISABLED_FLAG) — session custody stopped; agentdata volume preserved." >&2
    return 0
  fi
  if [[ ! -d "$AGENT_DIR/node_modules" ]]; then
    echo "WARNING: agent/node_modules missing — custody agent does NOT start. Run ./deploy.sh build and then ./deploy.sh up." >&2
    return 0
  fi
  ensure_agent_token
  # --force-recreate: o agente roda da fonte por bind mount, como o escrow (ver cmd_up). O stop
  # rotineiro é seguro: SIGTERM → flush do Level + checkpoint dentro do stop_grace_period do compose.
  compose up -d --force-recreate agent
  echo "Custody agent (cofre) up ✅"
}

# Read-only, irmã do bloco do escrow no check: estado do container, sentinela, frescor do checkpoint
# (escrito a cada CHECKPOINT_MS = 10 s com o sync saudável, agent/src/main.ts), whoami do token e
# salas cifradas sem o cofre. Não muta estado, não cunha token.
AGENT_CHECKPOINT_STALE_S=60
check_agent() {
  local cid state sentinel ts age code rooms store
  if [[ -e "$AGENT_DISABLED_FLAG" ]]; then
    echo "WARNING: custody agent DISABLED by opt-out ($AGENT_DISABLED_FLAG)." >&2
  fi
  cid="$(compose ps -aq agent 2>/dev/null)" || true
  if [[ -z "$cid" ]]; then
    echo "WARNING: custody agent container does not exist — run ./deploy.sh up." >&2
  else
    state=$(docker inspect -f '{{.State.Status}} restarts={{.RestartCount}}' "$cid" 2>/dev/null || echo "unknown")
    case "$state" in
      running*) echo "Custody agent: $state ✅";;
      *)        echo "WARNING: custody agent: $state" >&2;;
    esac
  fi
  if agent_volume_exists; then
    sentinel=$(agent_data_sh ro 'cat /data/REMEDIATION_NEEDED 2>/dev/null || true' | tr -d '[:space:]')
    if [[ -n "$sentinel" ]]; then
      echo "WARNING: REMEDIATION_NEEDED sentinel in the agent store ($sentinel) — the next ./deploy.sh up remediates it (F8)." >&2
    fi
    ts=$(agent_data_sh ro 'cat /data/checkpoint.json 2>/dev/null || true' | sed -n 's/.*"lastAliveTs":\([0-9]*\).*/\1/p')
    if [[ -n "$ts" ]]; then
      age=$(( $(date +%s) - ts / 1000 ))
      if (( age > AGENT_CHECKPOINT_STALE_S )); then
        echo "WARNING: last agent checkpoint ${age}s ago (sync stopped or agent down)." >&2
      else
        echo "Agent checkpoint: ${age}s ago ✅"
      fi
    else
      echo "WARNING: agent has no checkpoint (never synced healthy in this store)." >&2
    fi
  fi
  if [[ -s "$AGENT_TOKEN_FILE" ]]; then
    # Token presente com o store sem marcador: o próximo `up` passa pela F8 (ensure_agent_token).
    # Leitura que falha não vira aviso aqui; o `up` aborta nela.
    store=$(agent_store_state) || store=""
    case "$store" in
      lost|absent) echo "WARNING: agent store has no identity marker and the cofre token is present — the next ./deploy.sh up remediates it (F8)." >&2;;
    esac
    code=$(whoami_code "$(cat "$AGENT_TOKEN_FILE")")
    if [[ "$code" == "200" ]]; then
      echo "cofre token: whoami OK ✅"
    else
      echo "WARNING: cofre token returned HTTP $code on whoami — the next ./deploy.sh up re-mints it if it is 401." >&2
    fi
  else
    echo "WARNING: cofre token missing ($AGENT_TOKEN_FILE) — run ./deploy.sh up." >&2
  fi
  # Salas cifradas com mais de um membro `join` em que o cofre não está invite|join: o convite da
  # criação é fail-open (ADR-069, Consequências). Lista vazia = ok; uma sala listada é o gatilho do
  # ADR de retrofit.
  rooms=$(compose exec -T postgres psql -U synapse -d synapse -tA -c "
SELECT e.room_id FROM current_state_events e
WHERE e.type = 'm.room.encryption'
  AND (SELECT count(*) FROM current_state_events j
       WHERE j.room_id = e.room_id AND j.type = 'm.room.member' AND j.membership = 'join') > 1
  AND NOT EXISTS (SELECT 1 FROM current_state_events m
       WHERE m.room_id = e.room_id AND m.type = 'm.room.member'
         AND m.state_key = '${CUSTODY_MXID}' AND m.membership IN ('invite', 'join'))
ORDER BY 1" 2>/dev/null) || rooms="(query failed)"
  if [[ -z "$rooms" ]]; then
    echo "Encrypted rooms without the cofre: none ✅"
  else
    echo "WARNING: encrypted rooms (more than one member) without the cofre — trigger for the retrofit ADR (ADR-069):" >&2
    while IFS= read -r r; do [[ -n "$r" ]] && echo "  $r" >&2; done <<< "$rooms"
  fi
}

# Aviso de SPA velho (PLANO-RELEASE-PUBLICA §8.23, lição C): `up` não assa o cliente — o Caddy serve
# o client/dist que estiver lá. Dois deploys (#186, #187) subiram sem `build` e a produção ficou no
# bundle anterior. Aqui só se AVISA: build implícito no `up` está fora de questão (o `build` faz
# `npm ci` e é passo próprio do runbook). Critério: algum arquivo de client/src mais novo (mtime)
# que client/dist/index.html — o `git pull` grava o mtime dos arquivos que mudaram, então isso
# pega "pull depois do último build" mesmo quando o commit é mais antigo que o build. POSIX
# `find -newer`, BSD/GNU.
warn_stale_client_dist() {
  local dist_index="$REPO_ROOT/client/dist/index.html" newer
  if [[ ! -f "$dist_index" ]]; then
    echo "WARNING: client/dist missing — run ./deploy.sh build before up (Caddy would have no SPA to serve)." >&2
    return 0
  fi
  newer="$(find "$REPO_ROOT/client/src" -type f -newer "$dist_index" -print -quit 2>/dev/null || true)"
  if [[ -n "$newer" ]]; then
    echo "WARNING: client/src changed after the last build (e.g. ${newer#"$REPO_ROOT"/})." >&2
    echo "         up does NOT build the client: run ./deploy.sh build first, otherwise production stays on the previous bundle." >&2
  fi
}

cmd_up() {
  require_secrets
  # Renders em dia ANTES de tudo (pg_dump, pull, qualquer container): template mudado e não
  # renderizado subiria com a config velha — foi o upgrade do Synapse 1.163.0, em que o
  # `default_room_version` do template não chegou ao vivo (PLANO-RELEASE-PUBLICA §8.39).
  migrate_bootstrap_password_file
  check_renders_up_to_date
  if [[ "$RENDERS_RC" != "0" ]]; then
    echo "ERROR: up aborted before any backup or container — nothing came up." >&2
    exit 1
  fi
  # Deployment anterior ao deployment.env (ADR-095 dec. 5): grava o domínio lido do render vivo.
  persist_migrated_domain
  # ANTES de qualquer compose: o env_file do agente precisa existir (ver compose()).
  ensure_agent_secrets
  warn_stale_client_dist
  # Revoga a credencial de serviço em TODA saída do up — sucesso, exit 1 e SIGINT/TERM.
  # Por que trap e não última linha de cmd_up: sob `set -e`, o exit 1 de um pré-check anômalo ou
  # de um PUT reprovado (seed_org_channel / sync_org_directory) PULA a última linha — e é
  # exatamente a volta em que a credencial admin viva é mais indesejada (§8 do PLANO, "O caminho
  # de falha"). EXIT cobre sucesso e exit 1; INT/TERM cobrem interrupção. Os dois podem disparar
  # em sequência — a 2ª execução é no-op pela idempotência da função. NUNCA no escopo global: o
  # trap pertence ao `up`, não a um subcomando que possa entregar um token ao operador.
  trap revoke_service_sessions EXIT INT TERM
  # Fonte obrigatória aqui: o `build` (npm ci do client) vem antes do `up` no runbook.
  MAS_TEMPLATES_REQUIRE_FONTS=1 "$MAS_TEMPLATES_PREPARE"
  mas_migrate_and_sync
  restart_mas_if_config_changed
  ensure_synapse_volume_owner
  restart_synapse_if_config_changed
  # FASE 1 — tudo MENOS o agente (lista explícita; serviço novo entra aqui): o token do cofre nasce
  # do MAS, que precisa estar de pé antes do mint, e o bind de agent-token.secret precisa do arquivo
  # existente antes do container (senão o docker cria um diretório no lugar).
  compose up -d postgres synapse mas dex escrow caddy
  restart_caddy_if_config_changed
  # Escrow e agente rodam da FONTE por bind mount (../../escrow, ../../agent): o `up -d` só recria
  # um container quando a config do compose muda, e um `git pull` não muda config nenhuma. Sem o
  # --force-recreate o processo segue com o código antigo — foi o deploy do #199 (PLANO
  # §8.34): o veto de retrieve do cofre só valeu depois de um `restart escrow` manual. Seguro com a
  # stack de pé: o store do escrow só publica arquivo completo (tmp + link/rename). O agente é
  # recriado na fase 2 (start_agent).
  compose up -d --force-recreate escrow
  wait_for_synapse
  provision_user system
  # A política fecha o cadastro (ADR-083 dec. 1): o bootstrap admin nasce aqui, e o 1º login pelo Dex
  # liga a esta conta (`on_conflict: add`). Conta existente = skip. --email do register-user, e não
  # `manage add-email`, para o skip cobrir os dois.
  load_bootstrap_admin
  provision_user "$BOOTSTRAP_ADMIN_USERNAME" "$BOOTSTRAP_ADMIN_EMAIL"
  promote_org_admin "$BOOTSTRAP_ADMIN_USERNAME"
  seed_org_channel
  sync_org_membership
  sync_org_directory
  # FASE 2 — agente de custódia (ADR-069). Identidade estrutural fora do directory.tsv e do #all por
  # omissão deliberada: não é gente.
  provision_user "$CUSTODY_ACCOUNT"
  start_agent
  echo
  echo "Production stack up. Run ./deploy.sh check for the read-only state."
}

# ── down ─────────────────────────────────────────────────────────────────────────────────
# `docker compose down` — JAMAIS `-v`. O footgun `down -v`/`reset` do dev-stack NÃO existe
# aqui por decisão (PLANO-TRILHA-A §2): apagar pgdata/escrowdata = perder contas, salas e
# depósitos do 4S de toda a org. Remoção de volume é ato manual e consciente, nunca script.
cmd_down() {
  compose down
  echo "Stack down (volumes PRESERVED — down -v does not exist here, by design)."
}

# ── check ──────────────────────────────────────────────────────────────────────────────────
# Há quanto tempo o container de um serviço que roda da fonte está de pé: StartedAt (UTC) + o
# Status do docker ("Up 3 minutes"). Sem parse de data no shell (BSD/GNU divergem).
show_started_at() {
  local svc="$1" label="$2" cid started status
  cid="$(compose ps -q "$svc" 2>/dev/null)" || true
  if [[ -z "$cid" ]]; then
    echo "WARNING: $label has no running container." >&2
    return 0
  fi
  started=$(docker inspect -f '{{.State.StartedAt}}' "$cid" 2>/dev/null || echo "unknown")
  status=$(docker ps --filter "id=$cid" --format '{{.Status}}' 2>/dev/null || true)
  echo "$label up since $started ($status) — must be after the last ./deploy.sh up"
}


# Irmão read-only: status dos containers, resolução do alias #all, renders em dia (staging
# temporário, apagado; nada aplicado), config que o Synapse lê = render do host (sha256), config do MAS = render, /healthz do
# escrow via loopback INTERNO do container (docker exec), StartedAt de escrow e agente, último backup e
# o agente de custódia (check_agent).
# Não muta estado, não cunha token. Sai com falha se os renders estão pendentes ou se Synapse ou MAS
# não leem o render.
cmd_check() {
  local failed=""
  compose ps || true
  echo
  if probe_synapse; then echo "Synapse probe: OK ✅ ($HS_URL)"; else echo "Synapse probe: FAILED ❌ ($HS_URL)"; fi
  # Renders em dia e Synapse lendo o render do host: os dois ❌ fazem o check sair com falha.
  check_renders_up_to_date
  if [[ "$RENDERS_RC" != "0" ]]; then failed=1; fi
  check_synapse_config_matches || failed=1
  check_mas_config_matches || failed=1
  check_domain_consistency || failed=1

  local code esc_cid
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
    "$HS_URL/_matrix/client/v3/directory/room/$ORG_CHANNEL_ALIAS_ENC" 2>/dev/null || echo "000")
  if [ "$code" = "200" ]; then
    echo "Org channel #${ORG_CHANNEL_LOCALPART}: OK ✅"
  else
    echo "WARNING: org channel missing (HTTP $code) — run ./deploy.sh up." >&2
  fi

  esc_cid="$(compose ps -q escrow)"
  if [[ -n "$esc_cid" ]] && docker exec "$esc_cid" \
      node -e "fetch('http://localhost:8090/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "Escrow /healthz: OK ✅"
  else
    echo "WARNING: escrow did not respond on /healthz (internal loopback)." >&2
  fi
  # Escrow e agente rodam da fonte (ver cmd_up): de pé desde ANTES do último deploy = código antigo.
  show_started_at escrow "Escrow"
  show_started_at agent "Custody agent"

  local latest db sizes=""
  latest="$(list_pg_backups | tail -n 1)"
  if [[ -n "$latest" ]]; then
    for db in "${PG_BACKUP_DBS[@]}"; do
      sizes="$sizes $db.dump $(du -h "$BACKUPS_DIR/$latest/$db.dump" 2>/dev/null | cut -f1)"
    done
    echo "Latest Postgres backup: $latest (UTC) —$sizes"
  else
    echo "WARNING: no Postgres backup in $BACKUPS_DIR — the next ./deploy.sh up creates one." >&2
  fi

  check_agent

  if [[ -n "$failed" ]]; then
    echo
    echo "check: FAILED (❌ items above)." >&2
    exit 1
  fi
}

case "${1:-}" in
  secrets) shift; cmd_secrets "$@";;
  render)  shift; cmd_render "$@";;
  build)   shift; cmd_build "$@";;
  up)      shift; cmd_up "$@";;
  down)    shift; cmd_down "$@";;
  check)   shift; cmd_check "$@";;
  *) echo "usage: $0 {secrets|render|build|up|down|check}" >&2; exit 1;;
esac
