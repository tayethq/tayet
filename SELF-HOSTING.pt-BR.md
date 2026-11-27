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

Para que as notificações cheguem aos aparelhos com o Tayet fechado, o servidor também precisa de
saída HTTPS (porta 443) para os serviços de push dos navegadores e dos celulares:
`fcm.googleapis.com`, `*.push.apple.com`, `updates.push.services.mozilla.com` e
`*.notify.windows.com`. O Tayet não envia notificações para nenhum outro host.

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

O servidor de chat e o serviço de push conversam numa rede Docker só deles, na sub-rede
`10.213.77.0/29`. Primeiro veja quais sub-redes as redes Docker do host usam:

```bash
docker network inspect $(docker network ls -q) --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}'
```

Se uma delas se sobrepõe a `10.213.77.0/29`, escolha outra sub-rede e defina-a no shell em que você
roda o `./deploy.sh secrets` abaixo. Ela tem de ser uma /29 IPv4 começando num múltiplo de 8
(a.b.c.N/29), sem uso por nenhuma outra rede Docker do host. Por exemplo:

```bash
export TAYET_PUSH_SUBNET=10.213.77.8/29
```

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
Push /healthz: OK ✅
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

Cinco coisas guardam o estado da sua organização. O `./deploy.sh backup` copia as cinco.

| O quê | Guarda | Se perder |
|---|---|---|
| `secrets/` | A chave da organização e todos os segredos gerados | Histórico cifrado ilegível, para todo mundo |
| Volume `escrowdata` | Depósitos de chaves | As pessoas não recuperam o histórico num dispositivo novo |
| Postgres (bancos `synapse` e `mas`) | Contas, canais, mensagens | Tudo |
| Volume `synapsedata` | Arquivos enviados e a chave de assinatura do servidor | Anexos |
| Volume `orgdata` | A auditoria de convites, remoções e agentes | Essa auditoria |

Regras:

- **Guarde as cópias de `secrets/` e de `escrowdata` em lugares diferentes.** Juntas, elas decifram tudo o que a organização mantém em custódia. É uma exigência, não uma sugestão.
- **Copie o backup para fora do servidor.** Backup no mesmo disco não é backup.
- **Cifrar o disco do servidor e os arquivos de backup é recomendado.** O backup contém chaves e, no banco, mensagens de canal não cifradas. Como cifrar é decisão sua.
- O volume `agentdata` fica de fora de propósito: restaurar uma cópia antiga quebraria a custódia de chaves. Os certificados TLS também ficam de fora: eles são emitidos de novo.
- O `secrets/` também guarda o par de chaves do serviço de push, `secrets/push.env`, então o backup já o leva. Ele é gerado uma vez e nunca trocado: as inscrições de notificação ficam presas à chave pública dele, que o `build` põe no app web.

Rode, em `infra/deploy`, com um usuário que possa rodar Docker, com a stack de pé:

```bash
./deploy.sh backup
```

Ele grava um diretório por backup, com o nome da hora em UTC, em duas metades:

```
$HOME/tayet-backup/<UTC>/keys/   secrets.tgz, MANIFEST
$HOME/tayet-backup/<UTC>/data/   synapse.dump, mas.dump, synapsedata.tgz, escrowdata.tgz, orgdata.tgz, MANIFEST
```

`keys/` guarda o `secrets/`; `data/` guarda os bancos e os três volumes. Cada `MANIFEST` lista o
backup, o commit do código e o tamanho e o checksum de cada arquivo. O `MANIFEST` de `data/` também
é assinado, em `data/MANIFEST.sig`, com uma chave que mora no `secrets/` e por isso viaja em `keys/`:
o `restore` recusa um `data/` que foi alterado ou que vem de outra instalação. A assinatura prova de
onde o `data/` veio; ela não cifra nada. Para gravar em outro lugar, passe o diretório:
`./deploy.sh backup /path/to/dir`. Ele recusa um diretório dentro de `secrets/`.

Depois copie `keys/` para um lugar e `data/` para outro, diferente, e apague o diretório do
servidor. O comando imprime o caminho.

A stack fica de pé durante o backup. O `./deploy.sh up` também faz o dump dos dois bancos em
`secrets/backups/` toda vez que roda e mantém os cinco mais recentes; esses dumps são tão recentes
quanto o seu último `up` e não substituem este backup.

O `./deploy.sh check` imprime um aviso quando nenhum backup foi feito nesta instalação ou quando o
último tem mais de 7 dias. O aviso não muda o status de saída.

**Agende.** Por exemplo, um script que faz o backup e copia cada metade para o seu destino
(troque os dois destinos pelos seus):

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /path/to/tayet/infra/deploy
./deploy.sh backup
B=$(ls -d "$HOME"/tayet-backup/*Z | tail -n 1)
rsync -a "$B/keys/" "keys-host.example:tayet-keys/${B##*/}/"
rsync -a "$B/data/" "data-host.example:tayet-data/${B##*/}/"
rm -rf "$B"
```

e uma linha de crontab que o roda toda noite:

```
30 3 * * * /path/to/tayet-backup.sh >> "$HOME/tayet-backup.log" 2>&1
```

Ensaie o restore uma vez antes de depender dele.

## 12. Restore

Use isto num servidor novo, ou no mesmo servidor depois de perder dados. Você precisa das duas
metades do mesmo backup (`keys/` e `data/`), do servidor preparado como no passo 1, dos registros
DNS apontando para ele e da mesma versão do código que estava rodando quando o backup foi feito
(passo 5).

Se `infra/deploy/secrets/` já existe, pare a stack e mova-o para o lado. Não o apague. O `restore`
recusa rodar enquanto `secrets/` existir ou com a stack de pé.

```bash
./deploy.sh down
mv secrets secrets.before-restore
```

Restaure:

```bash
./deploy.sh restore /path/to/<UTC>/keys /path/to/<UTC>/data
```

Ele confere os dois manifestos antes de tudo e recusa se falta ou mudou um arquivo, ou se as duas
metades são de backups diferentes. Avisa quando o backup foi feito com outro commit do código.
Depois põe o `secrets/` de volta, restaura os dois bancos e os volumes e esvazia o
`agentdata`. Deixa a stack parada. Um backup feito antes de o volume `orgdata` existir não tem
`orgdata.tgz`: o `restore` o aceita e deixa o `orgdata` vazio. Com um backup assim, rode
`./deploy.sh render` antes do `build`.

Compile (num servidor novo) e suba:

```bash
./deploy.sh build
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

**Um restore devolve o estado do backup.** Revise-o antes de as pessoas voltarem a usar o servidor:

- Tudo o que foi escrito depois do backup some: mensagens, arquivos, canais, contas.
- Os logins feitos depois do backup deixam de funcionar. Esses navegadores mostram que o acesso foi
  encerrado, e as pessoas entram de novo; o histórico volta pela custódia de chaves.
- Os logins que existiam quando o backup foi feito voltam a funcionar sem novo login, mesmo os
  encerrados depois dele. As pessoas removidas e os papéis mudados depois do backup também voltam
  como estavam. Encerre esses logins de novo, remova essas pessoas de novo e corrija esses papéis
  antes de liberar o uso do servidor.

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

**Vindo de uma versão sem o serviço de push.** Os mesmos quatro comandos o trazem, sem `down`: o
`render` deixa o servidor de chat alcançar o serviço de push, o `build` gera o par de chaves do push
em `secrets/push.env` e põe a chave pública dele no app web, o `up` cria a rede do push e o contêiner
`push` e recria o `synapse` nas duas redes. Depois o `check` tem de sair com status 0 e imprimir:

```
Push /healthz: OK ✅
```

Se outra rede Docker do host se sobrepõe a `10.213.77.0/29` (o passo 7 mostra como ver), acrescente a
linha `TAYET_PUSH_SUBNET=<subnet>` ao `secrets/deployment.env` antes do `render`, com uma sub-rede que
siga a regra do passo 7.

**Se ninguém consegue administrar a organização.** O app não deixa rebaixar nem remover o último
admin. Se ninguém mais consegue administrar a organização, por exemplo porque o único admin perdeu o
acesso, torne um membro admin de novo, com a stack de pé:

```bash
./deploy.sh promote-admin maria@example.com
```

Ele escreve o username e se a conta foi promovida ou já era admin. Recusa, com status diferente de
zero, um email sem conta, uma conta desativada ou travada, um convidado, uma pessoa removida e um
agente. O `up` só torna admin o admin de bootstrap quando cria a conta, então a próxima atualização
não desfaz um papel mudado no app.

## Para onde ir depois

- Operação do dia a dia, o agente de custódia, rollback e diagnóstico: [`infra/deploy/README.md`](infra/deploy/README.md).
- Reportar uma vulnerabilidade: [`SECURITY.pt-BR.md`](SECURITY.pt-BR.md).
