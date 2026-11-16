#!/usr/bin/env bash
# Prepara os templates próprios do MAS (ADR-084): gera infra/mas/templates/_generated/ a partir de
# artefatos do repo — nunca re-autora nada.
#
#   prepare.sh        gera _generated/ (tokens.html, google-g.html, fonts/)
#   prepare.sh sum    imprime o sha256 da árvore inteira (com _generated/), para o marcador de
#                     restart do MAS: o MAS só lê templates no boot, e o compose não recria o
#                     serviço quando muda só o conteúdo de um bind mount (PLANO-PESSOAS §8.4).
#
# Por que `.html`: o loader do MAS só registra .html/.txt/.subject (PLANO-PESSOAS §0.4), e o
# `{% include %}` do base.html/idp_brand.html precisa achar o arquivo como template.
#
# A fonte (woff2 do @fontsource, a mesma do client) precisa do client/node_modules. Sem ele, o
# prepare avisa e segue — a página cai na fonte de fallback do token. Com
# MAS_TEMPLATES_REQUIRE_FONTS=1 (o deploy), a ausência é erro.
set -euo pipefail

MAS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$MAS_DIR/../.." && pwd)"
TEMPLATES="$MAS_DIR/templates"
GEN="$TEMPLATES/_generated"
TOKENS="$REPO_ROOT/client/src/ui/tokens/tokens.css"
FONT="$REPO_ROOT/client/node_modules/@fontsource-variable/hanken-grotesk/files/hanken-grotesk-latin-wght-normal.woff2"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
  else shasum -a 256 | cut -d' ' -f1; fi
}

cmd_prepare() {
  [[ -f "$TOKENS" ]] || { echo "ERROR: $TOKENS missing (npm run tokens in the client)." >&2; exit 1; }
  # Apaga só o conteúdo: os composes montam o diretório pai, que não muda de inode.
  mkdir -p "$GEN"
  rm -rf "${GEN:?}"/*
  cp "$TOKENS" "$GEN/tokens.html"
  cp "$TEMPLATES/_assets/google-g.svg" "$GEN/google-g.html"
  if [[ -f "$FONT" ]]; then
    mkdir -p "$GEN/fonts"
    cp "$FONT" "$GEN/fonts/"
  elif [[ "${MAS_TEMPLATES_REQUIRE_FONTS:-0}" == "1" ]]; then
    echo "ERROR: $FONT missing — run the client build (npm ci) first." >&2
    exit 1
  else
    echo "WARNING: client font missing ($FONT); the MAS page uses the fallback font." >&2
  fi
  # Leitura pelo MAS (nonroot 65532) e pelo Caddy, mesmo sob o umask 077 do deploy.sh.
  chmod -R a+rX "$GEN"
}

cmd_sum() {
  local f
  ( cd "$TEMPLATES" && find . -type f | LC_ALL=C sort | while read -r f; do
      printf '%s %s\n' "$f" "$(sha256 < "$f")"
    done ) | sha256
}

case "${1:-prepare}" in
  prepare) cmd_prepare ;;
  sum) cmd_sum ;;
  *) echo "usage: $0 [prepare|sum]" >&2; exit 2 ;;
esac
