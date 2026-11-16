# Templates do MAS — origem vendored (ADR-084)

Árvore stock de `/usr/local/share/mas-cli/templates/` da imagem fixada, copiada verbatim
(`docker create` + `docker cp`). `templates.path` substitui o diretório inteiro e o MAS recusa o
load se faltar algum dos 39 templates obrigatórios (PLANO-PESSOAS §0.4), por isso a árvore vem
toda.

- **Versão:** `v1.27.0` (`mas-cli --version`; label `org.opencontainers.image.revision`
  `f7917acea9ebd1050610f5efbb0e13ff4b88c697` = tag `v1.27.0`).
- **Imagem:** `ghcr.io/element-hq/matrix-authentication-service@sha256:085e37263957b3b79be85de9cfda1980b97e9653f284fba0c902445e06c200b8`
  (o mesmo digest de `infra/deploy/compose.yaml`, `infra/dev-stack/compose.yaml` e `deploy.sh`).

## Possuídos pelo Tayet (editados)

| Arquivo | Fatia |
|---|---|
| `base.html` | P4-1 |
| `pages/login.html` | P4-1 |
| `components/idp_brand.html` | P4-1 |
| `pages/consent.html` | P4-2 |
| `pages/error.html` | P4-2 |
| `pages/account/logged_out.html` | P4-2 |

Todo o resto é **stock, não editar**. Mudança num stock é re-vendor (procedimento do operador no bump da imagem do MAS), nunca
edição à mão.

## Fora da árvore stock

| Caminho | O que é |
|---|---|
| `UPSTREAM.md` | este arquivo (o MAS só carrega `.html`/`.txt`/`.subject`) |
| `_assets/google-g.svg` | asset oficial do Google, verbatim (abaixo) |
| `_generated/` | gerado por `infra/mas/prepare.sh`, gitignored: `tokens.html` (cópia de `client/src/ui/tokens/tokens.css`), `google-g.html` (cópia do asset, para o `include`), `fonts/` |

### `_assets/google-g.svg`

- **Origem:** o snippet "Generate HTML Button Element" de `https://developers.google.com/identity/branding-guidelines`,
  servido pelo frame `https://developers.google.com/frame/identity/branding-guidelines_7b8d9bf3a7d73f9b941566f079fb45ddb35b7a565bb9f11edee13272ffc9922a.frame`
  (frame sha256 `d2c7146e34671cbdea24ad8c2235947297ba6bc3d3ba764869510eca33b257c4`), obtido em 03/Nov/2026. O
  `<svg>` do `gsi-material-button-icon` foi extraído do template JS do frame, verbatim (paths, `viewBox 0 0 48 48`,
  atributos e o retângulo transparente `M0 0h48v48H0z`).
- **sha256:** `de561328d24893466c7f9d2dd0cad481e461594e76a2f073022e1abdcc5abc34`.
- Os paths **não** coincidem com os do zip: são desenhos distintos (G de 4 cores sólidas × "super G" com gradiente),
  zero `d` em comum; tabela de diff no PR do `fix/mas-google-g`. Sem recorte: o `idp_brand.html` põe o SVG inteiro no
  slot de 20 px (ADR-085).
- **Origem anterior (até ADR-085):** `https://developers.google.com/static/identity/images/signin-assets.zip`
  (zip sha256 `ba884069e12093b06bcfd776915081254a7c95094b80d50be2c5dc6bac1c1da1`), arquivo
  `Android + Web/SVG/Light/Theme=Light, Show text=No, Shape=Square, Platform=Android+Web.svg`, sha256 anterior
  `6587b180203a99da15c0a041018e15c94ffd9556c4b9855bdc69806081a93791`. Era o botão de 40 px inteiro, recortado a 20 px
  por CSS; o fundo branco do botão vazava atrás do G.

## sha256 stock (v1.27.0)

Os possuídos aparecem com o sha **stock** — a base do diff num bump.

| Arquivo | sha256 |
|---|---|
| `app.html` | `40db2c18ac47f390e51ddeb0d1f40e7087b08492b0607443b87f17e8a4d606f7` |
| `base.html` | `496feee9b5035ed33c82dea6b4e497ef7aae060a18122033c12ad5805d8df1a0` |
| `components/back_to_client.html` | `d3a1e9f1e78144d12d0e2d787561566ebf92c74f00d9a483d6a756f7f0b0685f` |
| `components/button.html` | `5b53300e1ba7d13041ae286cb0d5518a039d9a8320b4cb3ded0c3d64c705a241` |
| `components/captcha.html` | `ce6f665a5ffbdb7f45406f92beecbd63fa91d87c564f4d5c5482897e82f60c34` |
| `components/errors.html` | `b38598bee4b9b13de17ee4e290ef933a663524b89fea4c0987fb9e0389884e3c` |
| `components/field.html` | `2c5ed6e28386940b65eb41cd875611114f8c17db0a228afbc33fca6aa2230a14` |
| `components/footer.html` | `8faae5e052d1b2478ef63c348ff1bccd16d6bf152124bf37c88413ff9f5ebb0a` |
| `components/icon.html` | `794c9a4ef3ffdcbcec6e68768e3a962e4df362c9237a46f45eb8a6e33d9a422e` |
| `components/idp_brand.html` | `62ac3b71be2fddc0524257ab758fffe175b55941082da94df54f89aa3cbcd4fe` |
| `components/logout.html` | `a12effef26d9b780296615044ec3666e0631f4579b767ee5ccd0bb6c799da1be` |
| `components/scope.html` | `09da440eefb6ed25547fadb36efc82e2b9841915c50f956ef0546d3441a4c38a` |
| `device_name.txt` | `e2dfd6bec89e8d0dfcd594041c565a8b6a8b7d5819646f14e0a66b3e34705437` |
| `emails/recovery.html` | `8b3457cd13e7f6975944932eb61db26d189e84433a1106d408d2ef509acb5f97` |
| `emails/recovery.subject` | `ecb40308771422f29ff38a9c60f3948a09390e65b5f2ed68e937037b455918b9` |
| `emails/recovery.txt` | `7a830d85c10ca2cdbb85fcd617fbc17e05590443bfb5a28c0a7ae056f327058f` |
| `emails/verification.html` | `d36c4b81fea364b1047d532b8d8e4e9bf361335428e0d95274050fcb1f09f76d` |
| `emails/verification.subject` | `d508a144c54fe3bb638664a5f6c323d58268aa1f4d9eae425d72532ae311900f` |
| `emails/verification.txt` | `8dc82c87da5d3f4a94892fc13fd406c905d4b5d365a77959d5354a6ce147d2bd` |
| `form_post.html` | `39b932683b0138d6e8828646c3f6e1575edbcdf6d6f31a0b1f3595c4073e177f` |
| `pages/404.html` | `b2a6cc7042bf5452fe17978d4d10b9c688352ebb8b4d52e0cd46901f5f013ebf` |
| `pages/account/deactivated.html` | `10e82d26f2ae3196a1e64a2093814c300de5bf601e4191f6d9d84651450c64cd` |
| `pages/account/locked.html` | `27b6639f23f1e12a0200a938dca3233d581de21e12352f600f99f7eaa0177cd8` |
| `pages/account/logged_out.html` | `b06ede912160bd7587f0b127a0f7cee5b792aff461c7987fe79a543ce68f5742` |
| `pages/compat_login_policy_violation.html` | `cd75aa1767a16c946e4cefe6a4013f9663a4d28e6162f2590f56d3622d84fb20` |
| `pages/consent.html` | `2a349d08617a39303f78a547496c4b529f3771e0d4636f540dffd0f632b2a767` |
| `pages/device_consent.html` | `81b5cd913ab235cb3f6c81d16e69e6d0f01e895df1ce72588cd2cb7980519e4d` |
| `pages/device_link.html` | `d8215d0911018032e21b2badae0c4d7507cf36c11f29371167a1929a0c9c7afa` |
| `pages/error.html` | `22e2eb6e13d07867334dad0ea2a608791a4c548233222d520e67903e309cf761` |
| `pages/index.html` | `0fd403fb251bfa6a4e2fe0b41e2a2e58b8f2fd118fd22901ab3cd9a69bccb130` |
| `pages/login.html` | `97cbaad47978f8b91946c905ff70a7d96a77813641fa9de63a13cf8cb6ef99b5` |
| `pages/policy_violation.html` | `de63d91a324499ee3cf721b63d7dc028ac7062b655dd77c5716eac16beddb53e` |
| `pages/reauth.html` | `6a6403b16feaa91135db42e5030e2fa5ee5dd082ef8449fc704ff12009a2cea0` |
| `pages/recovery/consumed.html` | `313b8d5a6e6f83623cddb1dd8f48c1ce4902a8dfa896e3b4390996617a5c0056` |
| `pages/recovery/disabled.html` | `800c53bc7d86429c6bf9637538eafadad8fe334d78430127f397a0c83c6e7699` |
| `pages/recovery/expired.html` | `ab30c6fa32a8a1b75f58d4790d38de64acf503f55c42e790165456b95119b9a3` |
| `pages/recovery/finish.html` | `4e1505bd92abc285eb8f24499f7003da31fa0fb351cb46c67ad0934ca5934368` |
| `pages/recovery/progress.html` | `2e88cd21b4c2f2569f07c7fa2f46e72ace650305b4b91b177b095a0bba39d2fc` |
| `pages/recovery/start.html` | `a129f360dbd84408c4c0b0c1565430c2ee62a143f37eb8b1eec1ff616452697d` |
| `pages/register/index.html` | `de74b3620e5e361aa7dffd72a44c54e4652296fe4366193c42703f4cb6942aae` |
| `pages/register/password.html` | `c1d0ea810d3bb0abf8f89657e60ed8bdd1aa336914b752a993b1341d980cc0a7` |
| `pages/register/steps/display_name.html` | `a354287b584db9fe3266a4d839d4a4e71a6d9b30c7481f61d5b64b7a2ea54a69` |
| `pages/register/steps/email_in_use.html` | `d9bb03ecc0122a1744a12abde838629badfce597d000fae27b1485c1063bf371` |
| `pages/register/steps/registration_token.html` | `5780eaa38075f6d9f79b9e327661224518e13b3b28fae922d1300d70551ee10e` |
| `pages/register/steps/verify_email.html` | `e84a89a180465ad8024727b32b31f922ba006c1e12fee47837e1757e00743092` |
| `pages/sso.html` | `a292586a223cd54f7d5074a654c98f604b35733168a5bda418caff4be8e5be5f` |
| `pages/upstream_oauth2/do_register.html` | `5b9656e9a7f6d84f392b1fc3bdb883643d3a4d6a633afd92ff33923a53ba46da` |
| `pages/upstream_oauth2/link_mismatch.html` | `a4af87a96ff7f94c0f9e73252f2804b7804c974347a96a6fea422314cad86f81` |
| `pages/upstream_oauth2/suggest_link.html` | `59774f9e855f2b88ad0d0abb4d71b60a6b203aa38c54eeef3220b005e14f5807` |
| `swagger/doc.html` | `3d98793d79a68844d19d7def0dfd3b55068abd8563b721c777463f08b6ef0bf5` |
| `swagger/oauth2-redirect.html` | `1655dbf51297620ebb270ab061b22ec20b918554d2f37cb35cac5f9ed4609921` |
