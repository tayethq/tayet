[English](README.md) · **Português (Brasil)**

# Tayet

Tayet é um chat corporativo para organizações que querem ser donas da própria comunicação. As
pessoas têm canais, mensagens diretas e um histórico que as acompanha num dispositivo novo, sem
nada para configurar além de entrar e sem nenhuma cerimônia de criptografia. Por baixo, ele roda
sobre Matrix, com criptografia de ponta a ponta transparente para quem usa e custódia de chaves
mantida pela organização. Você hospeda o stack inteiro.

## O que há neste repositório

- `client/` — o cliente web: uma SPA React que só alcança o servidor através de uma Anti-Corruption Layer.
- `escrow/` — o serviço de custódia por organização: guarda os depósitos de backup de chaves e as chaves de sessão depositadas pelo agente de custódia, e escreve um log de auditoria append-only. Guarda a chave da organização e nada além disso.
- `org/` — o serviço de organização: convida e remove pessoas e cria e gerencia agentes, junto ao provedor de identidade e ao canal da organização. Não guarda a chave da organização.
- `agent/` — o agente de custódia `cofre`: membro de toda sala criptografada, deposita as chaves de sessão da sala no escrow.
- `shared/` — a biblioteca compartilhada: tipos de domínio, a tradução de protocolo para domínio e o scanner de vazamento de protocolo. O cliente e o sidecar de agente a consomem como `@tayet/shared`.
- `sidecar/` — o sidecar de agente `tayet-agent`: roda um agente na máquina do operador e serve a ele uma API local; publicado no npm e como imagem de container.
- `push/` — o gateway de push: transforma os avisos de push do homeserver em Web Push para os serviços de push dos navegadores.
- `infra/deploy/` — o deploy de produção: stack Compose, Caddy, templates de configuração e `deploy.sh`.
- `infra/dev-stack/` — o stack local de desenvolvimento contra o qual os pacotes rodam integrados.

## Auto-hospedagem

O deploy de referência roda num servidor só, como um stack Compose, e responde em cinco hostnames:

| Host | Papel |
|---|---|
| apex | Descoberta `.well-known`, mais o site estático (opcional) |
| `chat.` | A SPA do cliente, com `/escrow` na mesma origem |
| `matrix.` | Synapse, o homeserver |
| `auth.` | Matrix Authentication Service, o emissor OIDC |
| `login.` | Provedor de identidade upstream (Dex no deploy de referência) |

O Caddy, com TLS automático, é o único ponto de entrada público: ele ocupa as portas 80 e 443 e
roteia por host. Todos os outros serviços ficam na rede interna do Compose. Os segredos são gerados
do zero pelo `deploy.sh`, fora do controle de versão, e nunca reaproveitam valores do dev stack.

O passo a passo, do DNS e do OAuth client do Google até o backup e o restore, está em
[`SELF-HOSTING.pt-BR.md`](SELF-HOSTING.pt-BR.md). A operação de um deployment no ar está em
[`infra/deploy/README.md`](infra/deploy/README.md) (em inglês).

## Desenvolvimento

Você precisa de Node 22+. Rode `npm ci` dentro de `client/`, `escrow/`, `agent/`, `shared/`,
`sidecar/`, `push/` ou `org/`. `escrow/`, `agent/`, `push/` e `org/` são independentes; `client/` e `sidecar/` ligam `shared/` do mesmo
checkout (`file:../shared`), então clone a árvore inteira. `infra/dev-stack/` sobe o stack local
para o trabalho de integração; sem ele, as suítes de integração são puladas.

Os detalhes de cada pacote estão em [`client/README.md`](client/README.md),
[`escrow/README.md`](escrow/README.md), [`agent/README.md`](agent/README.md),
[`sidecar/README.md`](sidecar/README.md), [`push/README.md`](push/README.md) e [`org/README.md`](org/README.md), em inglês.

## Decisões

[`DECISIONS.md`](DECISIONS.md) lista as decisões de arquitetura e os planos citados no código; os
documentos completos ficam no repositório privado de desenvolvimento.

## Licença

O Tayet é licenciado sob a [Business Source License 1.1](LICENSE), com a Apache-2.0 como Change
License. Contribuições exigem a assinatura do [CLA](CLA.pt-BR.md).

Os templates da página de login em [`infra/mas/templates/`](infra/mas/templates/) vêm do Matrix
Authentication Service e são licenciados sob a AGPL-3.0-only, não sob a Business Source License; veja
[`infra/mas/NOTICE.md`](infra/mas/NOTICE.md).

Em termos simples: você pode copiar, modificar, redistribuir e criar obras derivadas do Tayet, e
também usá-lo em produção, inclusive dentro da sua empresa. O que a licença não permite é oferecer
o Tayet, ou um serviço cujo valor venha substancialmente dele, como serviço hospedado ou gerenciado
para terceiros. Cada versão passa a valer sob a Apache License 2.0 quatro anos depois de publicada.

O texto que vale é o [`LICENSE`](LICENSE), em inglês.

## Segurança

Veja [`SECURITY.pt-BR.md`](SECURITY.pt-BR.md).
