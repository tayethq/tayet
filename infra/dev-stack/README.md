# Tayet — dev-stack (gate local de integração)

> ⚠️ **Segredos descartáveis, local-only, JAMAIS produção.** Os valores em
> `synapse/homeserver.yaml`, `mas/` e `dex/` são throwaway e protegem apenas um Synapse
> local em `tayet.local` que não federa de fato. Nunca reusar este padrão para nada real.
>
> **Chaves do MAS: geradas no primeiro `up`, nunca commitadas (ADR-092).** A `mas/config.yaml`
> só aponta os arquivos (`secrets.encryption_file`, `secrets.keys_dir`). O `up` gera a chave de
> cifragem e as quatro chaves de assinatura com `config generate` da imagem do MAS, uma vez, em
> `mas/secrets/` (projeto `spike`) ou `.render/<projeto>/mas/secrets/` (os outros), ambos
> gitignored, e as mantém enquanto existirem. Apagar o diretório gera chaves novas no próximo
> `up` sem `reset`: os tokens sobrevivem, a sessão do MAS no browser não.

Stack da Fase 0 (Postgres + Synapse + MAS + Dex) com lar estável no `main` para o **gate
local de integração ACL↔Synapse** (issue #7, metade local). As suítes `acl-attachment*` /
integração deixam de auto-skipar quando a stack está up.

## Uso
```bash
./dev-stack.sh up          # sobe, gera+injeta a org key, espera Synapse + escrow + org, semeia alice/bob/system + canal da org; alice é a admin da org (flag do MAS)
./dev-stack.sh status      # estado dos containers + probe Synapse + escrow + org + router + seed (read-only)
./dev-stack.sh token alice # emite um compat token p/ conferência manual
./dev-stack.sh test        # roda a suíte do client/ com a stack up
./dev-stack.sh down        # derruba PRESERVANDO volumes (alice/bob e depósitos sobrevivem)
./dev-stack.sh reset       # derruba COM -v: APAGA o Postgres, o escrowdata e o orgdata (footgun de estado sujo)
```

> **Efeito colateral do `up` sobre tokens de `system` (ADR-054 dec. 5).** O `up` revoga, ao
> fim (via `trap`, em todos os caminhos de saída), **todas** as compat sessions da conta de
> serviço `system` — encerra-as (`finished_at`), trocando credencial admin ativa por trilha de
> auditoria. Consequência prática: um `./dev-stack.sh token system` cunhado à mão **para de
> valer** se você rodar `up` em seguida. É por desenho — `system` só tem consumidores one-shot
> (nenhuma sessão longeva legítima). Tokens de `alice`/`bob` (humanos) **não** são tocados.

### Migrações e config sync do MAS
O `up` já roda `database migrate` + `config sync --prune` antes de subir o server do MAS
(idempotentes; falha aborta o up). O banco `mas` do Postgres nasce com o volume:
`postgres-init/create-mas-db.sql` roda no initdb (volume virgem — o caso pós-`reset`).
Não há mais passo manual de primeira vez.

Para execução manual avulsa (debug, sem passar pelo `up`):
```bash
docker compose -p spike -f compose.yaml run --rm mas --config /config/config.yaml database migrate
docker compose -p spike -f compose.yaml run --rm mas --config /config/config.yaml config sync --prune
```

### Provisionar alice/bob a frio (clone limpo ou após `reset`)
O `up` provisiona `alice`/`bob` automaticamente quando ausentes, via
`mas-cli manage register-user` (senhas `alicepass123`/`bobpass123` — throwaway,
local-only). Idempotente: usuário existente → skip. Não há mais passo manual nem browser
no caminho; `reset` → `up` → `test` funciona num só fôlego.

### Canal da organização (ADR-045)
O `up` provisiona também a conta `system` e semeia o **canal da organização**: uma sala
**por convite (ADR-083) e em claro** (sem `m.room.encryption` — a regra "public → claro" da ADR-045), de
posse do `system`, com alias canônico `#all:tayet.local`. Idempotente entre execuções
(resolução de alias antes de cunhar token; sala já existente → skip, nenhum token novo). É
recriado no primeiro `up` após um `reset` (que apaga o volume). `status` mostra `Canal da
org: OK ✅` quando presente.

### Pertencimento à organização (ADR-083)
`#all` é **por convite**: quem é da org é quem o `system` convidou, e `kind: member` é o state event
`io.tayet.member` de `#all`, com `state_key` = mxid sem o `@`. O `up` roda `sync_org_membership` logo
depois do seed, idempotente: migra `#all` nascido público (uma vez), marca quem já está lá e marca e
convida toda a allowlist do Dex, exista a conta ou não. Conta fora disso é **guest**.

- **`ORG_GUESTS`** (`dev-stack.sh`, fixture só do dev): contas da allowlist que ficam de fora de `#all`,
  para o tier E2E ter guest nascido pelo Dex. Hoje `lua`, `nic`, `gho` e `fal`.
- **`kind` gravado não muda (ADR-086 dec. 4).** O sync não reescreve evento com `kind` — vivo ou lápide
  `{ removed: true, kind }` —, não reconvida lápide nem guest gravado, e pula contas `a-` (agentes, que
  só o escrow cria e que ficam fora de `#all`). Vale igual para o `deploy.sh`.
- **Usuário fresco de integração é guest.** Suíte que precisa de `#all` ou de Role ≠ `guest` chama
  `admitToOrg` (`client/test/support/org-membership.ts`).
- **Custo do `rc_message`:** convite e PUT de state contam no balde do `system` (burst 10, depois 1 a
  cada 5 s), e o script espera o `retry_after`. Stack limpa, cerca de 80 escritas: ~6 min no primeiro
  `up`, ~13 s nos seguintes. CI não paga: `homeserver.ci.yaml` levanta o balde.

### Diretório organizacional (ADR-054)
O `up` também sincroniza `directory.tsv` para os campos org do perfil
(`io.tayet.full_name` / `job_title` / `work_email`), logo após semear o canal. A **espinha**
é a allowlist do Dex (`dex/config.yaml`); o TSV é a **tabela de atributos**, join por
`username`, separador **TAB**. O sync é **declarativo**: campo vazio = ausência declarada →
a chave é apagada no servidor (é o caso do `job_title` do `bob`, de propósito).

Quem está na allowlist mas **ainda não fez o 1º login** não existe no Synapse (ADR-048), e o
sync **pula sem erro** — é o caso da `carol`, que existe na allowlist e **nunca é
provisionada**, de propósito, como sujeito vivo dessa ramificação. Linha no TSV sem
correspondente na allowlist (o `dave`) vira **aviso** de typo, sem abortar. Escrita via
client-API com token admin efêmero; a admin API entra só como pré-check `GET` de existência.

<details>
<summary>Fallback/registro histórico: round-trip OIDC via browser</summary>

O caminho original (e ainda funcional) de criação é o round-trip OIDC via Dex:

1. `./dev-stack.sh up`
2. No browser: `http://localhost:8080/login` → "Continuar com Dex" → entre como
   `alice@tayet.local` / `alicepass123`. Isso provisiona `@alice:tayet.local`.
3. Repita para `bob@tayet.local` / `bobpass123`.

</details>

> Provisionamento a frio sem browser (`mas-cli manage register-user`) anda junto do
> follow-up de drop do Dex, rastreado na issue #7.

### Provisionamento a frio sem browser — verificação
PF executado contra o binário pinado (MAS 1.18.0; stack hoje em 1.27.0, container `spike-mas-1`), com a config
desta stack (delegação + upstream Dex ligados):

```bash
docker exec spike-mas-1 mas-cli manage register-user -c /config/config.yaml \
  --yes --ignore-password-complexity --password probepass123 probe-user
```

- `--yes` torna o comando não-interativo; `--ignore-password-complexity` é necessário
  porque a config exige `minimum_complexity: 3` e as senhas throwaway são fracas (sem o
  flag: "That password is too weak").
- O usuário criado é utilizável pelo mesmo caminho do `token`/`mintToken`:
  `issue-compatibility-token` emitiu `mct_…` e o token autenticou no Synapse
  (`GET /_matrix/client/v3/account/whoami` → `@probe-user:tayet.local`).

Conclusão: `register-user` funciona contra esta config — o round-trip OIDC por browser
não é o único caminho de criação de usuário.

### Escrow (Fase 2) — serviço do compose para o app real (ADR-021)
O serviço de escrow (`escrow/` na raiz do repo) **é um serviço do compose** desde a fatia
`dev-stack-escrow` (ADR-021): roda da fonte (`node --experimental-strip-types
src/server.ts`, zero build, volume read-only), com store persistente no volume nomeado
`escrowdata`, **sem porta publicada**: o host o alcança pelo `router` (abaixo). Dentro
do container o bind é `0.0.0.0` (`ESCROW_BIND`); o default do serviço continua `127.0.0.1`.

- **Org key gitignored, gerada uma vez.** O `up` gera `escrow.secret.env`
  (`openssl rand -base64 32`) se ausente e a injeta no `compose up` via `--env-file`
  (interpolação de `${ESCROW_ORG_KEY}`). **Nunca commitada, nunca auto-regenerada** —
  regenerá-la com depósitos vivos os torna indecifráveis. Só o `up` passa `--env-file`;
  `status`/`down`/`logs` interpolam vazio, sem efeito colateral.
- **O harness segue independente.** O gate de integração (`escrow/test/integration/`,
  `client/test/support/escrow-harness.ts`) continua spawnando o **seu próprio** escrow
  efêmero (porta efêmera, storeDir por-run — "mundo virgem" do C2). Coexistem.
- **Browser → escrow via proxy de dev.** O app de browser alcança o escrow same-origin
  por `/escrow` (proxy do Vite → `:8090`, o `router`), sem CORS no serviço. Ver ADR-021.

O cliente de introspecção RFC 7662 em `mas/config.yaml` (`clients:`, id `…ESCR0W`, segredo
throwaway classe deste README) é absorvido pelo `config sync --prune` que o `up` já roda.
O client admin do escrow (id `…ESCADM1N`, ADR-082 dec. 3) segue o mesmo regime; a admin API do MAS
fica no listener interno (`mas:8081`), sem porta no host.

### Serviço `org` e o `router` (ADR-118)
Pessoas e agentes (`/v1/people*`, `/v1/agents*`) são do serviço `org` (`org/` na raiz do repo),
no mesmo regime do escrow: da fonte, volume `orgdata` (só o `audit.jsonl` dele), clients próprios
no MAS (`…RG1NTR` de introspecção e `…RGADM1N` admin, segredos throwaway inline no compose).
**Sem porta publicada.**

O `router` (Caddy, mesmo digest da produção, `router/Caddyfile`) é quem publica
`127.0.0.1:${TAYET_ESCROW_PORT:-8090}`. Ele repete o corte por caminho do `Caddyfile` de produção,
sem o prefixo `/escrow` (o proxy do Vite e o harness já o tiram): `/v1/people`, `/v1/people/*`,
`/v1/agents`, `/v1/agents/*` e `/v1/org/*` vão ao `org:8091`; o resto, `/healthz` inclusive, ao
`escrow:8090`. Por isso `TAYET_ESCROW_URL` e a chave `/escrow` de `client/vite.config.ts` não
mudam. Mudou o matcher de um lado, mude o do outro. O agente de custódia segue falando direto com
`escrow:8090`.

**Troca de checkout entre topologias.** Numa branch anterior ao `org`, o escrow publica a 8090
ele mesmo. Ao voltar o checkout principal para ela, `docker rm -f spike-router-1 spike-org-1`
antes do `up`: sem isso o `router` órfão segura a porta e o escrow não sobe.

### Agente de custódia `cofre` (PR-3, ADR-057 dec. 5)
O agente (`agent/` na raiz do repo) é um serviço do compose no mesmo regime do escrow:
roda da fonte com strip-types, volume read-only, store persistente no volume `agentdata`.
Sem porta publicada — o sinal de vida é o container de pé (`status` mostra). O `up`:

- provisiona o usuário `cofre` (senha `custodypass123`, throwaway e ALINHADA ao gate do escrow, que loga o cofre via OIDC headless; fora disso o login por senha nunca
  é usado; a identidade opera só por token). `cofre` fica **fora** do `directory.tsv` e do
  canal da org de propósito: não é gente (F3; a ocultação de UI é PR-4).
- gera `agent.secret.env` (`AGENT_STORAGE_KEY`, cifra o crypto store) uma vez, e minta o
  token `mct_` do cofre **uma vez** em `agent-token.secret` (compat token de CLI não
  expira — S2.5). Ambos gitignored, classe deste README. O token só é re-mintado se o
  existente morreu (ex.: pós-`reset`); re-mint = device novo → o agente loga
  `identity-reset` e segue com store virgem.
- sobe o serviço `agent` por último (fase 2), DEPOIS do mint. Sem `agent/node_modules` no
  host (caso CI), o serviço fica fora do up com aviso — `cd agent && npm install` resolve.

O `stop_grace_period` de 15s é contrato: o shutdown faz flush do Level + checkpoint.
`reset` apaga o `agentdata` (store cripto + checkpoint) junto do resto — o próximo `up`
re-minta se preciso e o agente renasce; a cobertura recomeça dali (janela observável).
O prefixo do crypto store do agente é `tayet-cofre`: um store criado com o prefixo anterior
ao rename NÃO é migrado — rode `./dev-stack.sh reset` antes do próximo `up` depois
do rename (sem isso o agente abre store virgem com o mesmo device e para em `keys-diverged`).

### Tier de E2E em browser (`client/e2e/`, ADR-060)
Usuários do tier: `erin`/`frank`/`gina`/`hana` (um por spec) e os pares `ivo`/`jade`, `kai`/`lia`, `kim`/`lua`, `mel`/`nic` (mais `gho`, convite cancelado, nunca loga) e `rae`/`sam` (`agents.spec.ts`) e `tai`/`ugo` (`agent-sidecar.spec.ts`), e as sondas `fal`/`ada`/`bea` do `mas-login.spec.ts` (`fal` tem email não verificado e nunca entra), só na allowlist do Dex e no `directory.tsv` — nascem no 1º
login pelo Dex, nunca por `register-user`. O Dex lê a allowlist só no boot: depois de editá-la
numa stack já de pé, `docker restart spike-dex-1`. A exceção é `mel` (e `rae`, `tai`), pré-criada pelo `up` porque o flag
`admin` (ADR-083 dec. 7) exige a conta; o `on_conflict: add` do provider liga o 1º login a ela.

**Provider simulado (ADR-083, `people.spec.ts`).** "Google (simulado)" é um segundo provider do MAS sobre o
mesmo Dex, com o mapeamento do Google de produção: `subject` = email, `localpart: ignore`, `email: require`.
`ORG_PEOPLE_PROVIDER_ID` aponta para ele, e é assim que o vínculo pré-criado pelo serviço `org` casa com o login.
Uma stack de pé pega o par assim: `config sync` do MAS e restart dele (é o que o `up` faz), mais
`docker restart spike-dex-1`.

**O `up` não recria o escrow nem o `org`.** Os dois rodam da fonte por bind mount e o container sobrevive ao `up`:
depois de mudar `escrow/src`, `docker restart spike-escrow-1`; depois de mudar `org/src`, `docker restart spike-org-1`.

**O `conversation.spec.ts` assume stack limpa.** Localmente, antes de rodar o tier:

```bash
./dev-stack.sh reset && ./dev-stack.sh up
```

e então, em `client/`, `npm run build && npm run e2e`. Os volumes do dev-stack são throwaway
por desenho (o dogfood vive no VPS). Numa stack reutilizada, o cenário cai em 404 de
`room_keys/keys/…` sobre o histórico da DM de runs anteriores — sintoma do gap de recuperação
registrado em PLANO-RELEASE-PUBLICA §8.9 (achado 2), não do teste. O CI sobe stack efêmera a
cada run e é o gate.

### Namespaces (CI, fase 2)
O projeto compose e as portas de host vêm de env (ADR-071 dec. 2, PLANO-CI-INTEGRACAO §8.R2).
Sem nenhuma var, tudo é a `spike` de sempre (o `config` é byte-idêntico ao de antes).

| Var | Default (`spike`) |
|---|---|
| `TAYET_COMPOSE_PROJECT` | `spike` |
| `TAYET_HS_PORT` / `TAYET_DEX_PORT` / `TAYET_MAS_PORT` / `TAYET_ESCROW_PORT` | `8008` / `5556` / `8080` / `8090` |
| `TAYET_SPA_PORT` (só entra no render: redirect_uri do client) | `5173` |

- **Render.** Projeto ≠ `spike`: o `up` renderiza `mas/` e `dex/` em `.render/<projeto>/`
  (gitignored) trocando os `localhost:<porta>` de host, e o compose monta o render. Um
  `localhost:<porta>` que o render não conhece aborta o `up`. `./dev-stack.sh render-check`
  prova que o render com portas default é a identidade.
- **Token do cofre** por projeto: `agent-token.<projeto>.secret` (a `spike` segue em
  `agent-token.secret`).
- **`ci-reset`** = `down -v` + apaga render e token do projeto, **só** com o projeto
  literalmente `spike-ci` (qualquer outro, inclusive `spike`, sai com erro). O `reset` local
  não muda.
- `test` exporta o namespace inteiro ao harness (`TAYET_HS_URL`, `TAYET_MAS_URL`,
  `TAYET_ESCROW_URL`, `TAYET_MAS_CONTAINER`, `TAYET_AGENT_CONTAINER`, `TAYET_AGENT_VOLUME`).

Exemplo — `spike-ci` ao lado da `spike`, offset +10000:

```bash
export TAYET_COMPOSE_PROJECT=spike-ci TAYET_HS_PORT=18008 TAYET_DEX_PORT=15556 \
  TAYET_MAS_PORT=18080 TAYET_ESCROW_PORT=18090 TAYET_SPA_PORT=15173
./dev-stack.sh up && ./dev-stack.sh test test/integration/acl-synapse.test.ts
./dev-stack.sh ci-reset
```

Subindo as duas do MESMO checkout, o bind `./synapse` (signing key, media_store) é
compartilhado — aceitável na prova local; o CI usa checkout próprio.

## Constraints que NÃO são óbvias (leia antes de mexer)
- **`name: spike` é load-bearing.** O harness (`client/test/support/synapse.ts`) faz
  `docker exec spike-mas-1` por default. O `compose.yaml` tem `name: ${TAYET_COMPOSE_PROJECT:-spike}`
  e o script passa `-p` do mesmo valor (que vence). Mudar o nome exige mudar
  `TAYET_MAS_CONTAINER` no ambiente de teste junto — o `dev-stack.sh test` já exporta.
- **`reset` apaga o Postgres, o `escrowdata`, o `orgdata` e o `agentdata`** (`down -v`). Usuários
  alice/bob, tokens, depósitos do escrow e o store do agente NÃO sobrevivem →
  re-provisionar depois. `up`/`down` preservam. A org key (`escrow.secret.env`), a storage
  key do agente (`agent.secret.env`) e o token do cofre (`agent-token.secret`) persistem no
  host; o token morto pós-`reset` é detectado e re-mintado pelo próximo `up`.
- **Dois `client/`.** O `client/` que o script roda é o **monorepo da raiz do repo**
  (resolvido via `git rev-parse`), não o `spike/client/` hello-world (que ficou na branch
  spike, não foi extraído).
- **Dex fica (por ora).** A emissão de token é Dex-free (`mas-cli manage
  issue-compatibility-token`) e a criação de alice/bob agora também (`register-user` no `up`
  — PF verificado acima); o round-trip OIDC via Dex virou fallback. Dropar Dex + porta 5556 +
  dir `dex/` segue como follow-up rastreado na issue #7 (PR futuro, gatilho próprio).
