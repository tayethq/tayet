#!/usr/bin/env bash
#
# domain-guards.sh — guardas do domínio base do deploy (ADR-095 dec. 4 e 5, PLANO-DEPLOY-DOMINIO §0.3.2).
# Chamado pelo render-identity.sh (o job de CI não muda), não sozinho:
#
#   bash domain-guards.sh <cópia-pristina> <dir-de-trabalho>
#
# <cópia-pristina> é a cópia descartável do render-identity.sh ANTES de qualquer render: infra/deploy/ e
# infra/mas/ com o fixture como secrets/ (deployment.env com tayet.app incluído). Cada caso copia a
# pristina para um diretório próprio, mexe só nessa cópia e compara a árvore de infra/deploy/ (lista +
# sha256 de cada arquivo) antes e depois. Nada versionado é tocado.
#
# BSD-safe (roda nos runners macOS): sem sed -i, sem \b.
set -euo pipefail

PRISTINE="$1"
WORK="$2"
CADDY_IMAGE="${CADDY_IMAGE:?CADDY_IMAGE ausente (o render-identity.sh o exporta)}"
FAILS=0

# Stubs para os comandos que pedem stack (casos 5, 11, 13 a 15): docker, curl, npx e npm registram a
# chamada e saem sem efeito. Ficam fora de qualquer cópia. O docker responde ao `mas-cli config
# generate` do `secrets` com uma seção `secrets:` falsa, para o `secrets` chegar ao fim sem imagem.
STUBS="$WORK/stubs"
mkdir -p "$STUBS"
for t in docker npx npm; do
  printf '#!/bin/sh\necho "%s TAYET_DOMAIN=${TAYET_DOMAIN-<unset>} $*" >> "$STUB_LOG"\n' "$t" > "$STUBS/$t"
done
printf 'case "$*" in *"config generate"*) printf "secrets:\\n  encryption: fake-guard-0000\\n";; esac\n' >> "$STUBS/docker"
for t in docker npx npm; do printf 'exit 0\n' >> "$STUBS/$t"; done
printf '#!/bin/sh\necho "curl $*" >> "$STUB_LOG"\nexit 7\n' > "$STUBS/curl"
chmod +x "$STUBS"/*

new_case() { # <nome> → caminho da cópia
  local d="$WORK/guard-$1"
  rm -rf "$d"
  cp -R "$PRISTINE" "$d"
  echo "$d"
}

tree_sum() { # <cópia> → lista + sha256 de infra/deploy/ (secrets/ incluído; ausente também conta)
  (
    cd "$1/infra/deploy"
    find . -print | LC_ALL=C sort
    find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256
  )
}

# deploy.sh da cópia em ambiente limpo: as BOOTSTRAP_ADMIN_* e uma TAYET_DOMAIN do runner não vazam.
# Argumentos extras antes de `--` são atribuições de ambiente.
run_deploy() { # <cópia> [VAR=valor…] -- <comando>
  local copy="$1"; shift
  local envs=()
  while [[ "$1" != "--" ]]; do envs+=("$1"); shift; done
  shift
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" ${envs[@]+"${envs[@]}"} bash "$copy/infra/deploy/deploy.sh" "$@"
}

ok()   { echo "  ok: $*"; }
fail() { echo "  FALHOU: $*" >&2; FAILS=$((FAILS + 1)); }

expect_abort_intact() { # <rótulo> <cópia> <padrão da mensagem> [VAR=valor…] -- <comando>
  local label="$1" copy="$2" pattern="$3"; shift 3
  local before after rc out
  before="$(tree_sum "$copy")"
  set +e
  out="$(run_deploy "$copy" "$@" 2>&1)"
  rc=$?
  set -e
  after="$(tree_sum "$copy")"
  printf '%s\n' "$out" | sed -e "s|$copy|<cópia>|g" -e 's|^|    > |'
  if [[ "$rc" == 0 ]]; then fail "$label: saiu 0"; return; fi
  if ! grep -q -- "$pattern" <<<"$out"; then fail "$label: mensagem sem '$pattern'"; return; fi
  if [[ "$before" != "$after" ]]; then
    fail "$label: árvore mudou"
    diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") >&2 || true
    return
  fi
  ok "$label: exit $rc, árvore intacta"
}

hs_add_server_name() { # <cópia> <domínio>: só na cópia, nunca no fixture versionado
  printf 'server_name: "%s"\n' "$2" >> "$1/infra/deploy/secrets/rendered/homeserver.yaml"
}

BOOT=(BOOTSTRAP_ADMIN_USERNAME=guard BOOTSTRAP_ADMIN_EMAIL=guard@example.invalid
      BOOTSTRAP_ADMIN_FULL_NAME=Guard BOOTSTRAP_ADMIN_JOB_TITLE=)

# ── 1. secrets sem TAYET_DOMAIN ───────────────────────────────────────────────────────────
echo "== 1. secrets sem TAYET_DOMAIN"
c="$(new_case 1)"; rm -rf "$c/infra/deploy/secrets"
expect_abort_intact "secrets sem TAYET_DOMAIN" "$c" "TAYET_DOMAIN missing" "${BOOT[@]}" -- secrets

# ── 2. secrets com valores inválidos ──────────────────────────────────────────────────────
echo "== 2. secrets com TAYET_DOMAIN inválido"
for v in 'https://x.com' 'X.COM' 'a..b' 'a.b:443' 'a.b.'; do
  c="$(new_case 2)"; rm -rf "$c/infra/deploy/secrets"
  expect_abort_intact "secrets TAYET_DOMAIN='$v'" "$c" "invalid TAYET_DOMAIN" "${BOOT[@]}" TAYET_DOMAIN="$v" -- secrets
done

# ── 3. migração (e 8. restart com --env-file) ────────────────────────────────────────────
echo "== 3. migração do deployment sem deployment.env"
c="$(new_case 3)"
denv="$c/infra/deploy/secrets/deployment.env"
rm -f "$denv"
hs_add_server_name "$c" tayet.app
set +e; out="$(run_deploy "$c" -- render 2>&1)"; rc=$?; set -e
{ printf '%s\n' "$out" | grep -E '^Base domain|docker compose' || true; } | sed -e "s|$c|<cópia>|g" -e 's|^|    > |'
if [[ "$rc" != 0 ]]; then fail "migração: render saiu $rc"; printf '%s\n' "$out" >&2
elif [[ "$(cat "$denv" 2>/dev/null)" != "TAYET_DOMAIN=tayet.app" ]]; then fail "migração: deployment.env não é TAYET_DOMAIN=tayet.app"
elif ! grep -q "Base domain migrated: TAYET_DOMAIN=tayet.app" <<<"$out"; then fail "migração: sem aviso"
else ok "migração: render gravou TAYET_DOMAIN=tayet.app e avisou"; fi
echo "== 8. restart impresso pelo render com --env-file"
if grep -q -- "docker compose -p tayet --env-file $denv -f " <<<"$out"; then
  ok "restart com --env-file <cópia>/infra/deploy/secrets/deployment.env"
else
  fail "restart sem --env-file"
fi
touch -t 200001010000 "$denv"
touch -t 200101010000 "$WORK/guard-3.ref"
set +e; out="$(run_deploy "$c" -- render 2>&1)"; rc=$?; set -e
if [[ "$rc" != 0 ]]; then fail "migração, 2ª execução: render saiu $rc"; printf '%s\n' "$out" >&2
elif grep -q "Base domain migrated" <<<"$out"; then fail "migração, 2ª execução: avisou de novo"
elif [[ -n "$(find "$denv" -newer "$WORK/guard-3.ref")" ]]; then fail "migração, 2ª execução: reescreveu deployment.env"
else ok "migração, 2ª execução: sem aviso, deployment.env não reescrito"; fi

# ── 4. divergência deployment.env × render vivo ──────────────────────────────────────────
echo "== 4. divergência"
c="$(new_case 4)"
printf 'TAYET_DOMAIN=outro.example\n' > "$c/infra/deploy/secrets/deployment.env"
hs_add_server_name "$c" tayet.app
expect_abort_intact "render com deployment.env=outro.example e server_name=tayet.app" "$c" \
  "'outro.example'.*'tayet.app'" -- render

# ── 5. check, build e down não criam deployment.env ──────────────────────────────────────
# Sem stack: docker/curl/npx/npm são stubs que registram a chamada. O que se prova é o caminho do
# domínio (resolução, aviso, nenhuma escrita) e o que chega ao docker compose (TAYET_DOMAIN exportado,
# sem --env-file porque o arquivo não existe).
echo "== 5. check, build e down sem deployment.env"
for cmd in check build down; do
  c="$(new_case "5-$cmd")"
  rm -f "$c/infra/deploy/secrets/deployment.env"
  hs_add_server_name "$c" tayet.app
  mkdir -p "$c/client" "$c/agent"
  before="$(tree_sum "$c")"
  export STUB_LOG="$WORK/guard-5-$cmd.log"; : > "$STUB_LOG"
  set +e
  out="$(PATH="$STUBS:$PATH" run_deploy "$c" STUB_LOG="$STUB_LOG" -- "$cmd" 2>&1)"
  rc=$?
  set -e
  after="$(tree_sum "$c")"
  { printf '%s\n' "$out" | grep -E 'WARNING: .*deployment\.env' || true; } | sed -e "s|$c|<cópia>|g" -e 's|^|    > |'
  { grep -E '^docker TAYET_DOMAIN=[^ ]* compose' "$STUB_LOG" || true; } | head -n 1 | sed -e "s|$c|<cópia>|g" -e 's|^|    stub> |'
  if [[ -e "$c/infra/deploy/secrets/deployment.env" ]]; then fail "$cmd: criou deployment.env"
  elif [[ "$before" != "$after" ]]; then fail "$cmd: árvore mudou"
  elif ! grep -q "WARNING: .*deployment.env missing — using TAYET_DOMAIN=tayet.app" <<<"$out"; then fail "$cmd: sem aviso"
  else ok "$cmd (exit $rc com stubs): avisou, deployment.env não criado, árvore intacta"; fi
done
unset STUB_LOG

# ── 6. sem fonte ─────────────────────────────────────────────────────────────────────────
echo "== 6. sem fonte"
c="$(new_case 6)"
rm -f "$c/infra/deploy/secrets/deployment.env"
expect_abort_intact "render sem deployment.env e sem server_name" "$c" "deploy.sh secrets" -- render

# ── 7. TAYET_DOMAIN no ambiente ──────────────────────────────────────────────────────────
echo "== 7. TAYET_DOMAIN no ambiente"
c="$(new_case 7)"
expect_abort_intact "render com TAYET_DOMAIN=outro.example no ambiente" "$c" \
  "'outro.example'.*'tayet.app'" TAYET_DOMAIN=outro.example -- render
set +e; out="$(run_deploy "$c" TAYET_DOMAIN=tayet.app -- render 2>&1)"; rc=$?; set -e
if [[ "$rc" == 0 ]]; then ok "render com TAYET_DOMAIN=tayet.app no ambiente: exit 0"
else fail "render com TAYET_DOMAIN=tayet.app: exit $rc"; printf '%s\n' "$out" >&2; fi

# ── 9. caddy validate com a variável; caddy adapt sem ela ────────────────────────────────
echo "== 9. Caddyfile com e sem TAYET_DOMAIN"
caddyfile="$PRISTINE/infra/deploy/Caddyfile"
set +e
out="$(docker run --rm --network none -e TAYET_DOMAIN=tayet.app \
  -v "$caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)"
rc=$?
set -e
printf '%s\n' "$out" | grep -E 'Valid configuration|Error' | sed -e 's|^|    validate> |'
if [[ "$rc" == 0 ]]; then ok "caddy validate com TAYET_DOMAIN=tayet.app: exit 0"
else fail "caddy validate com a variável: exit $rc"; printf '%s\n' "$out" >&2; fi
set +e
out="$(docker run --rm --network none \
  -v "$caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" \
  caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile --pretty 2>&1)"
rc=$?
set -e
if [[ "$rc" != 0 ]]; then
  printf '%s\n' "$out" | tail -n 3 | sed -e 's|^|    adapt> |'
  ok "caddy adapt sem a variável: FALHA (exit $rc)"
else
  hosts="$(printf '%s\n' "$out" | awk '/"host": \[/{f=1; next} f && /\]/{f=0} f' | tr -d ' \t",' | LC_ALL=C sort -u | paste -sd ' ' -)"
  printf '    adapt> hosts: [%s]\n' "$hosts"
  case " $hosts " in
    *" chat. "*|*" matrix. "*|*" auth. "*|*" login. "*|"  ") ok "caddy adapt sem a variável: passa, hosts sem o domínio ($hosts)";;
    *) fail "caddy adapt sem a variável: hosts inesperados ($hosts)";;
  esac
fi

# ── Parâmetros do deployment (PLANO-DEPLOY-DOMINIO §0.3.3 itens 3, 4 e 6) ──────────────────
DENV_REL="infra/deploy/secrets/deployment.env"
LOCAL_PARAMS=(TAYET_COMPOSE_PROJECT=tayet-local TAYET_HS_PORT=28008 TAYET_HTTP_PORT=28080 TAYET_HTTPS_PORT=28443)

run_stubbed() { # <cópia> <log> [VAR=valor…] -- <comando>: deploy.sh com os stubs no PATH
  local copy="$1" log="$2"; shift 2
  : > "$log"
  PATH="$STUBS:$PATH" run_deploy "$copy" STUB_LOG="$log" "$@"
}

echo "== 10. secrets com parâmetro inválido"
for v in TAYET_HS_PORT=0 TAYET_HS_PORT=65536 TAYET_HTTP_PORT=80a TAYET_HTTPS_PORT=0443 TAYET_HTTPS_PORT= \
         TAYET_COMPOSE_PROJECT=Tayet TAYET_COMPOSE_PROJECT=-local TAYET_COMPOSE_PROJECT='a b' TAYET_COMPOSE_PROJECT=a.b; do
  c="$(new_case 10)"; rm -rf "$c/infra/deploy/secrets"
  expect_abort_intact "secrets $v" "$c" "invalid ${v%%=*}" "${BOOT[@]}" TAYET_DOMAIN=empresa.test "$v" -- secrets
done

echo "== 11. secrets grava os parâmetros presentes"
secrets_case() { # <rótulo> <esperado em deployment.env, linhas separadas por |> [VAR=valor…]
  local label="$1" want="$2" c got
  shift 2
  c="$(new_case 11)"
  rm -rf "$c/infra/deploy/secrets"; mkdir -p "$c/infra/deploy/secrets"
  cp "$PRISTINE/infra/deploy/secrets/google-oauth.env" "$c/infra/deploy/secrets/"
  set +e
  out="$(run_stubbed "$c" "$WORK/guard-11.log" "${BOOT[@]}" TAYET_DOMAIN=empresa.test "$@" -- secrets 2>&1)"
  rc=$?
  set -e
  got="$(paste -sd '|' - < "$c/$DENV_REL" 2>/dev/null || true)"
  printf '%s\n' "$got" | tr '|' '\n' | sed -e 's|^|    deployment.env> |'
  if [[ "$rc" != 0 ]]; then fail "$label: secrets saiu $rc"; printf '%s\n' "$out" >&2
  elif [[ "$got" != "$want" ]]; then fail "$label: deployment.env = '$got', esperado '$want'"
  else ok "$label: deployment.env só com o domínio e os presentes"; fi
}
secrets_case "os quatro" \
  "TAYET_DOMAIN=empresa.test|TAYET_COMPOSE_PROJECT=tayet-local|TAYET_HS_PORT=28008|TAYET_HTTP_PORT=28080|TAYET_HTTPS_PORT=28443" \
  "${LOCAL_PARAMS[@]}"
secrets_case "projeto e porta HTTPS" \
  "TAYET_DOMAIN=empresa.test|TAYET_COMPOSE_PROJECT=tayet-local|TAYET_HTTPS_PORT=28443" \
  TAYET_COMPOSE_PROJECT=tayet-local TAYET_HTTPS_PORT=28443
secrets_case "nenhum" "TAYET_DOMAIN=empresa.test"

echo "== 12. parâmetro do ambiente diferente do deployment"
c="$(new_case 12)"
printf '%s\n' "${LOCAL_PARAMS[@]}" >> "$c/$DENV_REL"
expect_abort_intact "render com TAYET_COMPOSE_PROJECT=outro no ambiente (gravado tayet-local)" "$c" \
  "'outro'.*'tayet-local'" TAYET_COMPOSE_PROJECT=outro -- render
c="$(new_case 12b)"
expect_abort_intact "render com TAYET_COMPOSE_PROJECT=tayet-local no ambiente (sem linha: padrão tayet)" "$c" \
  "'tayet-local'.*'tayet', default" TAYET_COMPOSE_PROJECT=tayet-local -- render
c="$(new_case 12c)"
printf '%s\n' "${LOCAL_PARAMS[@]}" >> "$c/$DENV_REL"
expect_abort_intact "check com TAYET_HS_PORT=8008 no ambiente (gravado 28008)" "$c" \
  "'8008'.*'28008'" TAYET_HS_PORT=8008 -- check
c="$(new_case 12d)"
printf 'TAYET_HS_PORT=8o08\n' >> "$c/$DENV_REL"
expect_abort_intact "render com TAYET_HS_PORT inválido no deployment.env" "$c" "TAYET_HS_PORT repeated or invalid" -- render

echo "== 13. os quatro gravados chegam ao compose, ao volume do agente e ao loopback do Synapse"
c="$(new_case 13)"
printf '%s\n' "${LOCAL_PARAMS[@]}" >> "$c/$DENV_REL"
mkdir -p "$c/client" "$c/agent"
log="$WORK/guard-13.log"
before="$(tree_sum "$c")"
set +e; out="$(run_stubbed "$c" "$log" -- check 2>&1)"; rc=$?; set -e
after="$(tree_sum "$c")"
{ grep -E ' compose -p ' "$log" | head -n 1; grep -E 'volume inspect' "$log" | head -n 1; grep -E '^curl ' "$log" | head -n 1; } \
  | sed -e "s|$c|<cópia>|g" -e 's|^|    stub> |'
if [[ "$before" != "$after" ]]; then fail "check com os quatro: árvore mudou"
elif ! grep -qE "^docker TAYET_DOMAIN=tayet.app compose -p tayet-local --env-file $c/$DENV_REL " "$log"; then fail "check com os quatro: compose sem -p tayet-local"
elif grep -qE ' compose -p tayet ' "$log"; then fail "check com os quatro: algum compose com -p tayet"
elif ! grep -qE '^docker .* volume inspect tayet-local_agentdata$' "$log"; then fail "check com os quatro: volume do agente não é tayet-local_agentdata"
elif ! grep -qE '^curl .*http://127\.0\.0\.1:28008/' "$log" || grep -qE '127\.0\.0\.1:8008/' "$log"; then fail "check com os quatro: loopback do Synapse não é 28008"
else ok "check (exit $rc com stubs): -p tayet-local, tayet-local_agentdata, 127.0.0.1:28008, árvore intacta"; fi

echo "== 14. deployment.env só com o domínio"
c="$(new_case 14)"
mkdir -p "$c/client" "$c/agent"
log="$WORK/guard-14.log"
before="$(tree_sum "$c")"
set +e; out="$(run_stubbed "$c" "$log" -- check 2>&1)"; rc=$?; set -e
after="$(tree_sum "$c")"
{ grep -E ' compose -p ' "$log" | head -n 1; grep -E 'volume inspect' "$log" | head -n 1; grep -E '^curl ' "$log" | head -n 1; } \
  | sed -e "s|$c|<cópia>|g" -e 's|^|    stub> |'
if [[ "$before" != "$after" ]]; then fail "deployment.env só com o domínio: árvore mudou"
elif grep -qE 'TAYET_(COMPOSE_PROJECT|HS_PORT|HTTP_PORT|HTTPS_PORT)' <<<"$out"; then fail "deployment.env só com o domínio: saída cita um parâmetro"; printf '%s\n' "$out" >&2
elif ! grep -qE "^docker TAYET_DOMAIN=tayet.app compose -p tayet --env-file " "$log"; then fail "deployment.env só com o domínio: compose sem -p tayet"
elif ! grep -qE '^docker .* volume inspect tayet_agentdata$' "$log"; then fail "deployment.env só com o domínio: volume do agente não é tayet_agentdata"
elif ! grep -qE '^curl .*http://127\.0\.0\.1:8008/' "$log"; then fail "deployment.env só com o domínio: loopback do Synapse não é 8008"
else ok "check (exit $rc com stubs): padrões tayet, tayet_agentdata, 127.0.0.1:8008, sem aviso novo, árvore intacta"; fi

echo "== 15. TAYET_COMPOSE_OVERRIDE inexistente"
c="$(new_case 15)"
log="$WORK/guard-15.log"; : > "$log"
PATH="$STUBS:$PATH" expect_abort_intact "check com TAYET_COMPOSE_OVERRIDE=/nao/existe.yaml" "$c" \
  "TAYET_COMPOSE_OVERRIDE points to a file that does not exist" STUB_LOG="$log" TAYET_COMPOSE_OVERRIDE=/nao/existe.yaml -- check
if [[ -s "$log" ]]; then fail "override inexistente: algum comando rodou"; else ok "override inexistente: nenhum docker/curl chamado"; fi

if (( FAILS > 0 )); then
  echo "ERRO: $FAILS guarda(s) de domínio falharam (acima)." >&2
  exit 1
fi
echo "Guardas de domínio OK."
