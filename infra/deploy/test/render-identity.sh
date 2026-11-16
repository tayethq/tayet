#!/usr/bin/env bash
#
# render-identity.sh — prova de identidade do deploy parametrizado por domínio (ADR-095 dec. 10 (a),
# PLANO-DEPLOY-DOMINIO §8.1 e §8.2). Fixa o que infra/deploy/ produz e compara com duas linhas de base:
#   - test/golden/tayet.app/        o deployment de referência (a identidade);
#   - test/golden/empresa.example/  um domínio de exemplo (onde o domínio aparece).
#
#   bash infra/deploy/test/render-identity.sh            # compara; diff → exit 1
#   bash infra/deploy/test/render-identity.sh --update   # regrava as linhas de base (de propósito, no PR)
#
# O que é produzido, por domínio, numa cópia descartável de infra/deploy/ + infra/mas/ (mesma posição
# relativa), com test/fixture/ no lugar de secrets/. O domínio chega como o deploy.sh o entrega: o
# secrets/deployment.env do fixture (tayet.app), trocado na cópia para empresa.example:
#   1. os três renders e o diretório, pelo `deploy.sh render` da cópia — o hash bcrypt do Dex
#      neutralizado pelo próprio `strip_dex_hash` do deploy.sh;
#   2. `docker compose -p tayet --env-file secrets/deployment.env … config` com os arquivos que o
#      deploy.sh passa: sem o site e com o overlay do site (o deploy.sh o inclui quando ../../site
#      existe); o caminho da cópia vira /__REPO__;
#   3. o Caddyfile adaptado para JSON pela imagem do Caddy pinada no compose.yaml, com TAYET_DOMAIN no
#      ambiente do contêiner.
# Depois, as guardas do domínio (test/domain-guards.sh) rodam sobre cópias da mesma cópia pristina.
#
# Copia só os arquivos que o git conhece (rastreados ou novos não ignorados), com o conteúdo do working
# tree: nada gitignored (um secrets/ real, o _generated/ do MAS) entra na cópia. Nenhum container de
# longa vida, nenhuma rede: `docker compose config` e `caddy adapt`/`validate` descartáveis.
#
# BSD-safe (roda nos runners macOS): sem sed -i, sem \b.
set -euo pipefail

usage() { echo "uso: $0 [--update]" >&2; exit 2; }
MODE=compare
case "${1:-}" in
  '') ;;
  --update) MODE=update ;;
  *) usage ;;
esac

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$TEST_DIR" rev-parse --show-toplevel)"
FIXTURE="$TEST_DIR/fixture"
DOMAINS=(tayet.app empresa.example)

for tool in docker htpasswd diff; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERRO: '$tool' ausente." >&2; exit 1; }
done

# pwd -P: o compose imprime caminhos resolvidos (no macOS /var → /private/var).
WORK="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/render-identity.XXXXXX")" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
PRISTINE="$WORK/pristine"
mkdir -p "$PRISTINE" "$WORK/out"

# ── cópia pristina ─────────────────────────────────────────────────────────────────────────
# O próprio test/ fica de fora (a linha de base não se descreve a si mesma).
(
  cd "$REPO_ROOT"
  git ls-files -z --cached --others --exclude-standard -- infra/deploy infra/mas \
    | while IFS= read -r -d '' f; do
        case "$f" in infra/deploy/test/*) continue ;; esac
        [[ -f "$f" ]] || continue   # rastreado e apagado no working tree
        mkdir -p "$PRISTINE/$(dirname "$f")"
        cp -p "$f" "$PRISTINE/$f"
      done
)
mkdir -p "$PRISTINE/infra/deploy/secrets"
cp -R "$FIXTURE/." "$PRISTINE/infra/deploy/secrets/"
chmod 0700 "$PRISTINE/infra/deploy/secrets"

CADDY_IMAGE="$(sed -n 's|^[[:space:]]*image:[[:space:]]*\(caddy@sha256:[0-9a-f]\{64\}\).*|\1|p' "$PRISTINE/infra/deploy/compose.yaml")"
[[ -n "$CADDY_IMAGE" && "$(printf '%s\n' "$CADDY_IMAGE" | wc -l | tr -d ' ')" == "1" ]] \
  || { echo "ERRO: imagem do Caddy pinada não encontrada (ou ambígua) no compose.yaml." >&2; exit 1; }
export CADDY_IMAGE

# ── produção dos sete arquivos para um domínio ─────────────────────────────────────────────
produce() { # <domínio> <saída>
  local domain="$1" out="$2" copy deploy
  copy="$WORK/copy-$domain"
  deploy="$copy/infra/deploy"
  cp -R "$PRISTINE" "$copy"
  printf 'TAYET_DOMAIN=%s\n' "$domain" > "$deploy/secrets/deployment.env"
  mkdir -p "$out"

  # 1. renders. env -i: as BOOTSTRAP_ADMIN_* (e uma TAYET_DOMAIN) do ambiente venceriam as do fixture.
  # Os renders vivos do fixture são esboços com só as linhas que o render extrai; o primeiro render
  # os substitui pela saída real dos templates.
  if ! env -i PATH="$PATH" HOME="${HOME:-/tmp}" bash "$deploy/deploy.sh" render > "$WORK/render-$domain.log" 2>&1; then
    cat "$WORK/render-$domain.log" >&2
    echo "ERRO: deploy.sh render falhou na cópia ($domain)." >&2
    exit 1
  fi
  eval "$(grep '^strip_dex_hash() {' "$deploy/deploy.sh")"
  declare -F strip_dex_hash >/dev/null || { echo "ERRO: strip_dex_hash() não encontrado no deploy.sh." >&2; exit 1; }
  cp "$deploy/secrets/rendered/homeserver.yaml" "$out/homeserver.yaml"
  cp "$deploy/secrets/rendered/mas-config.yaml" "$out/mas-config.yaml"
  strip_dex_hash "$deploy/secrets/rendered/dex-config.yaml" > "$out/dex-config.yaml"
  cp "$deploy/secrets/rendered/directory.tsv" "$out/directory.tsv"

  # 2. compose config: mesmo projeto, mesmo --env-file e mesmos -f do compose() do deploy.sh; o
  # ambiente limpo evita que uma variável do runner interpole no resultado.
  compose_config() {
    env -i PATH="$PATH" HOME="${HOME:-/tmp}" DOCKER_CONFIG="${DOCKER_CONFIG:-${HOME:-/tmp}/.docker}" \
      docker compose -p tayet --env-file "$deploy/secrets/deployment.env" "$@" config \
      | sed -e "s|$copy|/__REPO__|g"
  }
  compose_config -f "$deploy/compose.yaml" > "$out/compose.config.yaml"
  compose_config -f "$deploy/compose.yaml" -f "$deploy/compose.site.yaml" > "$out/compose.site.config.yaml"

  # 3. Caddyfile → JSON, com o domínio no ambiente como o compose o entrega ao serviço caddy.
  docker run --rm --network none -e TAYET_DOMAIN="$domain" \
    -v "$deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
    "$CADDY_IMAGE" caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile --pretty \
    > "$out/Caddyfile.json" 2> "$WORK/caddy-$domain.log" \
    || { cat "$WORK/caddy-$domain.log" >&2; echo "ERRO: caddy adapt falhou ($domain)." >&2; exit 1; }
}

for d in "${DOMAINS[@]}"; do produce "$d" "$WORK/out/$d"; done

# ── onde o domínio aparece (empresa.example) ───────────────────────────────────────────────
# Fora de comentário, nenhum `tayet.app` (o log config é synapse/log.config desde o PR 4a,
# PLANO-DEPLOY-DOMINIO §0.3.4); nome do servidor, homeserver do MAS e ESCROW_SERVER_NAME
# são o domínio; os hosts do Caddy são os cinco derivados dele.
check_example() {
  local d=empresa.example dir="$WORK/out/empresa.example" bad=0 f leftover hosts want
  for f in "$dir"/*; do
    leftover="$(grep -v '^[[:space:]]*#' "$f" | grep 'tayet\.app' || true)"
    if [[ -n "$leftover" ]]; then
      echo "ERRO: ${f##*/} ($d) tem tayet.app fora de comentário:" >&2
      printf '%s\n' "$leftover" >&2
      bad=1
    fi
  done
  grep -qx "server_name: \"$d\"" "$dir/homeserver.yaml" || { echo "ERRO: server_name ≠ $d" >&2; bad=1; }
  grep -qx "  homeserver: $d" "$dir/mas-config.yaml" || { echo "ERRO: homeserver do MAS ≠ $d" >&2; bad=1; }
  for f in compose.config.yaml compose.site.config.yaml; do
    grep -qx "      ESCROW_SERVER_NAME: $d" "$dir/$f" || { echo "ERRO: ESCROW_SERVER_NAME ≠ $d em $f" >&2; bad=1; }
  done
  hosts="$(awk '/"host": \[/{f=1; next} f && /\]/{f=0} f' "$dir/Caddyfile.json" | tr -d ' \t",' | LC_ALL=C sort | paste -sd ' ' -)"
  want="$(printf '%s\n' "$d" "chat.$d" "matrix.$d" "auth.$d" "login.$d" | LC_ALL=C sort | paste -sd ' ' -)"
  [[ "$hosts" == "$want" ]] || { echo "ERRO: hosts do Caddy ($d): [$hosts], esperado [$want]" >&2; bad=1; }
  if [[ "$bad" != 0 ]]; then return 1; fi
  echo "empresa.example: nenhum tayet.app fora de comentário; server_name, homeserver do MAS e ESCROW_SERVER_NAME = $d; hosts [$hosts]."
}
# Falha aqui e nas guardas não interrompe: a comparação com as linhas de base roda de qualquer forma,
# para o diff aparecer junto; o exit final soma tudo.
rc=0
check_example || rc=1

# ── guardas do domínio ─────────────────────────────────────────────────────────────────────
bash "$TEST_DIR/domain-guards.sh" "$PRISTINE" "$WORK" || rc=1

# ── comparar ou regravar ───────────────────────────────────────────────────────────────────
if [[ "$MODE" == update ]]; then
  if [[ "$rc" != 0 ]]; then
    echo "ERRO: conferência do domínio de exemplo ou guardas falharam (acima) — linhas de base NÃO regravadas." >&2
    exit 1
  fi
  for d in "${DOMAINS[@]}"; do
    golden="$TEST_DIR/golden/$d"
    rm -rf "$golden"
    mkdir -p "$golden"
    cp "$WORK/out/$d"/* "$golden"/
    echo "Linha de base regravada em ${golden#"$REPO_ROOT"/}:"
    (cd "$golden" && ls -1)
  done
  exit 0
fi

for d in "${DOMAINS[@]}"; do
  golden="$TEST_DIR/golden/$d"
  if [[ ! -d "$golden" ]]; then
    echo "ERRO: linha de base ausente (${golden#"$REPO_ROOT"/}); rode com --update." >&2
    rc=1
    continue
  fi
  if diff -ru "$golden" "$WORK/out/$d"; then
    echo "Identidade OK: infra/deploy/ produz a linha de base de $d."
  else
    echo "ERRO: a saída de infra/deploy/ diverge da linha de base de $d (diff acima, golden → atual)." >&2
    rc=1
  fi
done
if [[ "$rc" != 0 ]]; then
  echo "      Mudança intencional: rode com --update e revise o diff no PR (ADR-095 dec. 10 (a))." >&2
fi
exit "$rc"
