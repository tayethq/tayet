[English](SELF-HOSTING.md) · **Português (Brasil)**

# Hospedando o Tayet

Este guia leva um servidor do zero até o Tayet rodando para a sua organização e depois cobre
backup, restore e atualizações. Ele foi escrito para ser executado: os passos trazem os comandos a
rodar e, na maioria deles, o que você deve ver e um jeito de conferir. A instalação termina quando
`./deploy.sh check` sai com status 0.

Os passos marcados **[humano]** precisam de uma pessoa: escolher o domínio, criar os registros DNS,
criar o OAuth client do Google, o primeiro login e o primeiro convite. Todo o resto pode ser rodado
por um operador ou por um agente de código com shell no servidor.

Duas regras para quem roda os comandos, pessoa ou agente:

- `./deploy.sh secrets` roda **uma vez** por deployment. Ele se recusa a rodar de novo.
- Nunca apague `infra/deploy/secrets/`. Ele guarda a chave da organização. Sem ela, o histórico
  cifrado da organização inteira não pode mais ser lido.

## Antes de começar: limites desta versão

- **O domínio base é permanente.** Ele passa a fazer parte de toda conta. Trocá-lo depois não é suportado.
- **Quem você convida entra com uma conta Google.** Não há outro provedor de login para pessoas convidadas nesta versão.
- **O primeiro administrador entra com uma senha** gerada na instalação.
- **Sem envio de email.** O Tayet não envia convites; você mesmo passa as instruções para a pessoa.
- **Sem federação.** O servidor não conversa com outros servidores Matrix.
- **A interface do produto e as páginas de login estão em inglês e em português do Brasil.**
- **Testado só com Chromium.** Os outros navegadores não foram testados.
- **Um servidor, uma stack Compose.** Não há configuração de alta disponibilidade.

## 1. Requisitos

Um servidor Linux com IP público e as portas 80 e 443 alcançáveis pela internet. Os certificados
TLS são emitidos automaticamente.

No servidor:

- `git`
- Docker Engine com o plugin Compose
- `htpasswd` (Debian/Ubuntu: `apt-get install apache2-utils`)
- Node.js 22 ou mais novo, com `npm` (o client web é compilado no servidor)
- `openssl`, `curl`, `sha256sum`

Confira:

```bash
docker compose version
htpasswd -nbBC 12 "" test | cut -d: -f2 | cut -c1-4
node --version
openssl version
```

Esperado: uma linha com a versão do Compose, `$2y$`, `v22` ou maior, uma linha com a versão do
OpenSSL.

## 2. Escolha o domínio base **[humano]**

Escolha o domínio sob o qual o Tayet vai morar. Pode ser um domínio seu (`example.com`) ou um
subdomínio dedicado ao Tayet (`tayet.example.com`). Se o domínio já serve o seu site, use um
subdomínio dedicado.

O Tayet responde em cinco hostnames derivados dele:

| Host | O que serve |
|---|---|
| `<domain>` | Descoberta do servidor (`/.well-known/matrix/*`) |
| `chat.<domain>` | O app web. É o endereço que as pessoas usam. |
| `matrix.<domain>` | O servidor de chat |
| `auth.<domain>` | Login |
| `login.<domain>` | Login do primeiro administrador |

Esta escolha não pode ser mudada depois do passo 7.

## 3. Crie os registros DNS **[humano]**

Crie cinco registros A (ou AAAA) apontando para o servidor: o domínio base e os quatro subdomínios
acima.

Confira, com o seu domínio em `D`:

```bash
D=example.com
for h in "$D" "chat.$D" "matrix.$D" "auth.$D" "login.$D"; do
  printf '%s -> ' "$h"; getent hosts "$h" | awk '{print $1}'
done
```

Esperado: cinco linhas, cada uma terminando com o IP do servidor.

## 4. Crie o OAuth client do Google **[humano]**

No console do Google Cloud:

1. Crie um projeto para este deployment. A tela de consentimento é por projeto, então não reuse o projeto de outro app.
2. Google Auth Platform: defina o nome do app e o email de suporte, público **Externo**.
3. Branding: adicione o seu domínio como domínio autorizado. Não envie logo: o logo dispara o processo de verificação do Google.
4. Clientes → Criar cliente, tipo **Aplicativo da Web**. URI de redirecionamento autorizado, com o seu domínio base:
   `https://auth.<domain>/upstream/callback/01M6EV4GP9QK3T7YH2ZD8NXGG1`
5. Acesso a dados: só `openid`, `userinfo.email` e `userinfo.profile`. Qualquer outro escopo dispara a verificação.
6. Público-alvo → **Publicar app** (Em produção). No modo Testing só os usuários de teste listados conseguem entrar, e eles têm de entrar de novo a cada 7 dias.

Guarde o client ID e o client secret para o passo 6.

## 5. Pegue o código

```bash
git clone https://github.com/tayethq/tayet.git
cd tayet
git tag --list 'v*'
git checkout <tag>
cd infra/deploy
```

Use a tag mais nova da lista. Todos os comandos daqui em diante rodam em `infra/deploy`.

## 6. Grave as credenciais do Google

```bash
mkdir -p secrets
( umask 077; printf 'GOOGLE_CLIENT_ID=%s\nGOOGLE_CLIENT_SECRET=%s\n' '<client id>' '<client secret>' > secrets/google-oauth.env )
```

Confira:

```bash
grep -c '^GOOGLE_CLIENT_' secrets/google-oauth.env
```

Esperado: `2`.

## 7. Gere os segredos (uma vez)

Defina o domínio base e o primeiro administrador e gere:

```bash
export TAYET_DOMAIN=example.com
export BOOTSTRAP_ADMIN_USERNAME=ana BOOTSTRAP_ADMIN_EMAIL=ana@example.com
export BOOTSTRAP_ADMIN_FULL_NAME="Ana Lima" BOOTSTRAP_ADMIN_JOB_TITLE=""
./deploy.sh secrets
```

O username aceita letras minúsculas, dígitos e `. _ = -`. O cargo pode ser vazio, mas precisa estar
definido.

Esperado: uma linha começando com `Secrets generated in`, seguida de um lembrete de backup.

Deste ponto em diante o domínio base está fixo, e `secrets/` nunca pode ser apagado.

## 8. Compile e suba

```bash
./deploy.sh build
./deploy.sh up
./deploy.sh check
```

O `up` imprime uma linha por etapa. As últimas são:

```
Custody agent (cofre) up ✅
Sessions of system revoked ✅
```

O `check` tem de sair com status 0. A saída dele inclui:

```
Renders up to date ✅
Synapse config = host render ✅
MAS config = render ✅
Org channel #all: OK ✅
Escrow /healthz: OK ✅
cofre token: whoami OK ✅
Encrypted rooms without the cofre: none ✅
```

No primeiro minuto depois do primeiro `up`, o `check` também pode imprimir
`WARNING: agent has no checkpoint (never synced healthy in this store).` Rode-o de novo.

Confira de fora:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "https://chat.$TAYET_DOMAIN/"
curl -sS "https://$TAYET_DOMAIN/.well-known/matrix/client"
```

Esperado: `200` e depois um objeto JSON cujo `base_url` é `https://matrix.<domain>`.

## 9. Primeiro login **[humano]**

A interface segue o idioma do navegador, português do Brasil ou inglês. Os rótulos dos passos 9 e 10 são os em português.

1. Abra `https://chat.<domain>` e escolha **Continuar com sua conta**.
2. Na página de login escolha **Continuar com a conta da empresa**.
3. Email: o valor de `BOOTSTRAP_ADMIN_EMAIL`. Senha: o conteúdo de `secrets/bootstrap-admin.password`.

Você cai no app, no canal `#all`. Você é o administrador da organização.

## 10. Primeiro convite **[humano]**

1. Abra **Sua conta**, depois **Organização**, depois **Pessoas**, e escolha **Convidar pessoa**.
2. Preencha o nome da pessoa e o email da conta Google dela e escolha o tipo: **Da organização** entra no `#all`; **Convidado** vê só os canais em que você o colocar.
3. Quando o diálogo mostrar **Convite pronto**, escolha **Copiar instruções** e envie você mesmo para a pessoa. O Tayet não envia email.
4. A pessoa abre `https://chat.<domain>` e escolhe **Continuar com Google**, com aquela conta Google.

## 11. Backup

Quatro coisas guardam o estado da sua organização. Faça backup das quatro.

| O quê | Guarda | Se perder |
|---|---|---|
| `secrets/` | A chave da organização e todos os segredos gerados | Histórico cifrado ilegível, para todo mundo |
| Volume `escrowdata` | Depósitos de chaves | As pessoas não recuperam o histórico num dispositivo novo |
| Postgres (bancos `synapse` e `mas`) | Contas, canais, mensagens | Tudo |
| Volume `synapsedata` | Arquivos enviados e a chave de assinatura do servidor | Anexos |

Regras:

- **Guarde as cópias de `secrets/` e de `escrowdata` em lugares diferentes.** Juntas, elas decifram tudo o que a organização mantém em custódia. É uma exigência, não uma sugestão.
- **Copie o backup para fora do servidor.** Backup no mesmo disco não é backup.
- **Cifrar o disco do servidor e os arquivos de backup é recomendado.** O backup contém chaves e, no banco, mensagens de canal não cifradas. Como cifrar é decisão sua.
- O volume `agentdata` fica de fora de propósito: restaurar uma cópia antiga quebraria a custódia de chaves. Os certificados TLS também ficam de fora: eles são emitidos de novo.

Rode, em `infra/deploy`, com um usuário que possa rodar Docker:

```bash
P=$(sed -n 's/^TAYET_COMPOSE_PROJECT=//p' secrets/deployment.env); P=${P:-tayet}
DC="docker compose -p $P --env-file secrets/deployment.env -f compose.yaml"
IMG=$(sed -n 's/^AGENT_IMAGE="\(.*\)"$/\1/p' deploy.sh)
OUT=$HOME/tayet-backup/$(date -u +%Y%m%dT%H%M%SZ)
( umask 077; mkdir -p "$OUT" )
```

Primeiro o banco, depois os volumes, nesta ordem:

```bash
for db in synapse mas; do
  $DC exec -T postgres pg_dump -U synapse -Fc "$db" > "$OUT/$db.dump"
done
for v in synapsedata escrowdata; do
  docker run --rm -v "${P}_$v:/data:ro" -v "$OUT:/out" "$IMG" \
    tar czf "/out/$v.tgz" --numeric-owner -C /data .
done
tar czf "$OUT/secrets.tgz" --exclude=secrets/backups secrets
ls -l "$OUT"
```

Esperado: cinco arquivos, nenhum vazio: `synapse.dump`, `mas.dump`, `synapsedata.tgz`,
`escrowdata.tgz`, `secrets.tgz`.

Depois copie `secrets.tgz` para um lugar e `escrowdata.tgz` para outro, diferente, copie os outros
três arquivos para qualquer um dos dois e apague o diretório do servidor:

```bash
rm -rf "$OUT"
```

A stack pode ficar de pé durante o backup. O `./deploy.sh up` também faz o dump dos dois bancos em
`secrets/backups/` toda vez que roda e mantém os cinco mais recentes; esses dumps são tão recentes
quanto o seu último `up`.

Ensaie o restore uma vez antes de depender dele.

## 12. Restore

Use isto num servidor novo, ou no mesmo servidor depois de perder dados. Você precisa dos cinco
arquivos de backup num diretório, do servidor preparado como no passo 1, dos registros DNS
apontando para ele e da mesma versão do código que estava rodando quando o backup foi feito
(passo 5).

Se `infra/deploy/secrets/` já existe, pare a stack e mova-o para o lado. Não o apague.

```bash
./deploy.sh down
mv secrets secrets.before-restore
```

Restaure os segredos e compile:

```bash
IN=/path/to/backup
tar xzf "$IN/secrets.tgz"
P=$(sed -n 's/^TAYET_COMPOSE_PROJECT=//p' secrets/deployment.env); P=${P:-tayet}
DC="docker compose -p $P --env-file secrets/deployment.env -f compose.yaml"
IMG=$(sed -n 's/^AGENT_IMAGE="\(.*\)"$/\1/p' deploy.sh)
./deploy.sh build
```

Restaure os bancos:

```bash
$DC up -d --wait postgres
for db in synapse mas; do
  $DC exec -T postgres pg_restore -U synapse -d "$db" --clean --if-exists < "$IN/$db.dump"
done
```

Restaure os dois volumes:

```bash
$DC up --no-start synapse escrow
for v in synapsedata escrowdata; do
  docker run --rm -v "${P}_$v:/data" -v "$IN:/in:ro" "$IMG" \
    sh -c "find /data -mindepth 1 -delete && tar xzf /in/$v.tgz --numeric-owner -C /data"
done
```

Suba e confira:

```bash
./deploy.sh up
./deploy.sh check
```

Durante este `up` você vai ver:

```
Agent store missing with a live token (no identity marker) — F8: stop → kill-sessions → mint → up.
cofre token minted ✅
```

É o esperado: o agente de custódia recomeça com uma identidade nova, e o que ele já tinha
depositado está no `escrowdata`.

O `check` tem de sair com status 0. Depois entre e confirme que os canais e as mensagens estão lá.

O que um restore não traz de volta: tudo o que foi escrito depois que o backup foi feito.

## 13. Atualização

Se `secrets/postgres.password` não existe, a sua instalação é anterior à senha de banco por
instalação: rode `./deploy.sh db-password` uma vez, com a stack de pé, logo depois de trocar para o
código novo e antes do `render`, do `build` e do `up`.

```bash
git fetch --tags
git checkout <tag>
./deploy.sh render
./deploy.sh build
./deploy.sh up
./deploy.sh check
```

Rode o `check` só depois do `up`: entre o `render` e o `up` ele acusa diferenças de configuração
que o `up` aplica em seguida.

O `render` mostra o que mudou na configuração gerada. Para `dex-config.yaml` ele sempre mostra uma
linha `hash:` mudada; isso não é mudança. Se ele mostrar qualquer outra diferença nesse arquivo,
rode o comando de restart do `dex` que o `render` imprime.

O `up` faz o dump dos dois bancos antes de aplicar qualquer coisa.

## Para onde ir depois

- Operação do dia a dia, o agente de custódia, rollback e diagnóstico: [`infra/deploy/README.md`](infra/deploy/README.md).
- Reportar uma vulnerabilidade: [`SECURITY.pt-BR.md`](SECURITY.pt-BR.md).
