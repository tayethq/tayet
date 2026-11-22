// Usuários do tier E2E (ADR-060 D2). Nascem pelo Dex no 1º login, via `upstream_oauth2` do MAS —
// nunca `register-user`. Entradas espelhadas em infra/dev-stack/dex/config.yaml (allowlist) e
// infra/dev-stack/directory.tsv (atributos org). Senhas throwaway, commitadas como as de
// alice/bob em dev-stack.sh: só valem no dev-stack local/CI.
//
// Regra do tier: um usuário por spec — specs nunca compartilham conta (histórico de um contamina o
// console do outro). erin e frank são do conversation.spec.ts; gina é do login.spec.ts; hana é do new-access.spec.ts;
// ivo e jade são do device-list-staleness.spec.ts, kai e lia do tab-lock.spec.ts, mia e noa do
// timeline.spec.ts, oto e pia do notifications.spec.ts, quim e rita do search.spec.ts, sol e tom do
// delete.spec.ts, una e vic do archive.spec.ts, wal e xan do attachments.spec.ts, yan e zoe do
// compose.spec.ts, ari e bel do channel-lifecycle.spec.ts, cid e deb do account.spec.ts, eli e fay
// do new-device.spec.ts, gus e hal do presence.spec.ts, ian e jon do access-reset.spec.ts, kim e lua do
// org-membership.spec.ts, mel e nic do people.spec.ts, rae e sam do agents.spec.ts, tai e ugo do
// agent-sidecar.spec.ts (a regra vale por PAR: o cenário é entre dois), val, wes e xin do
// group-conversation.spec.ts (por TRIO: a conversa em grupo é entre três) e
// fal, ada e bea do mas-login.spec.ts (sondas, uma por página: fal nunca entra — email não verificado).
// Os specs de agente (agent-*.spec.ts) dividem o par tai/ugo, em série (workers: 1) e com as salas do par
// apagadas no início e no fim; yuri é só do agent-approvers.spec.ts, a terceira pessoa do cartão; zak belongs only to
// login.narrow.spec.ts; lin only to language.spec.ts; nel and oli only to timeline.narrow.spec.ts; pat and ros
// only to copy-text.spec.ts; ted and ula only to actions.narrow.spec.ts; ivy and joe only to composer.narrow.spec.ts; kit and lou only to
// search.narrow.spec.ts; max and ned only to compose.narrow.spec.ts.
export interface E2eUser {
  /** Login no form do Dex (password DB: o campo é o email). */
  email: string
  password: string
}

export const ERIN: E2eUser = { email: 'erin@tayet.local', password: 'erinpass123' }
export const FRANK: E2eUser = { email: 'frank@tayet.local', password: 'frankpass123' }
export const GINA: E2eUser = { email: 'gina@tayet.local', password: 'ginapass123' }
export const HANA: E2eUser = { email: 'hana@tayet.local', password: 'hanapass123' }
export const IVO: E2eUser = { email: 'ivo@tayet.local', password: 'ivopass123' }
export const JADE: E2eUser = { email: 'jade@tayet.local', password: 'jadepass123' }
export const KAI: E2eUser = { email: 'kai@tayet.local', password: 'kaipass123' }
export const LIA: E2eUser = { email: 'lia@tayet.local', password: 'liapass123' }
export const MIA: E2eUser = { email: 'mia@tayet.local', password: 'miapass123' }
export const NOA: E2eUser = { email: 'noa@tayet.local', password: 'noapass123' }
export const OTO: E2eUser = { email: 'oto@tayet.local', password: 'otopass123' }
export const PIA: E2eUser = { email: 'pia@tayet.local', password: 'piapass123' }
export const QUIM: E2eUser = { email: 'quim@tayet.local', password: 'quimpass123' }
export const RITA: E2eUser = { email: 'rita@tayet.local', password: 'ritapass123' }
export const SOL: E2eUser = { email: 'sol@tayet.local', password: 'solpass123' }
export const TOM: E2eUser = { email: 'tom@tayet.local', password: 'tompass123' }
export const UNA: E2eUser = { email: 'una@tayet.local', password: 'unapass123' }
export const VIC: E2eUser = { email: 'vic@tayet.local', password: 'vicpass123' }
export const WAL: E2eUser = { email: 'wal@tayet.local', password: 'walpass123' }
export const XAN: E2eUser = { email: 'xan@tayet.local', password: 'xanpass123' }
export const YAN: E2eUser = { email: 'yan@tayet.local', password: 'yanpass123' }
export const ZOE: E2eUser = { email: 'zoe@tayet.local', password: 'zoepass123' }
export const ARI: E2eUser = { email: 'ari@tayet.local', password: 'aripass123' }
export const BEL: E2eUser = { email: 'bel@tayet.local', password: 'belpass123' }
export const CID: E2eUser = { email: 'cid@tayet.local', password: 'cidpass123' }
export const DEB: E2eUser = { email: 'deb@tayet.local', password: 'debpass123' }
export const ELI: E2eUser = { email: 'eli@tayet.local', password: 'elipass123' }
export const FAY: E2eUser = { email: 'fay@tayet.local', password: 'faypass123' }
export const GUS: E2eUser = { email: 'gus@tayet.local', password: 'guspass123' }
export const HAL: E2eUser = { email: 'hal@tayet.local', password: 'halpass123' }
export const IAN: E2eUser = { email: 'ian@tayet.local', password: 'ianpass123' }
export const JON: E2eUser = { email: 'jon@tayet.local', password: 'jonpass123' }
export const KIM: E2eUser = { email: 'kim@tayet.local', password: 'kimpass123' }
export const LUA: E2eUser = { email: 'lua@tayet.local', password: 'luapass123' }
export const MEL: E2eUser = { email: 'mel@tayet.local', password: 'melpass123' }
export const NIC: E2eUser = { email: 'nic@tayet.local', password: 'nicpass123' }
// Sondas do mas-login.spec.ts (P4-2). fal: email não verificado no Dex, o guard do Google simulado a
// recusa (nunca entra). ada: o spec muda o displayname dela (consentimento comNome/semNome). bea: o
// spec mata as sessões dela (`logged_out`).
export const FAL: E2eUser = { email: 'fal@tayet.local', password: 'falpass123' }
export const ADA: E2eUser = { email: 'ada@tayet.local', password: 'adapass123' }
export const BEA: E2eUser = { email: 'bea@tayet.local', password: 'beapass123' }
// Par do agents.spec.ts (ADR-086, fatia 3). rae: admin da org, pré-criada pelo `up` para o flag (como
// mel); cria, edita, reemite e remove o agente pela UI. sam: a pessoa do par que vê o agente marcado.
export const RAE: E2eUser = { email: 'rae@tayet.local', password: 'raepass123' }
export const SAM: E2eUser = { email: 'sam@tayet.local', password: 'sampass123' }
// Par do agent-sidecar.spec.ts (S-e, PLANO-AGENTES §0.3.9). tai: admin da org, pré-criada pelo `up` para o
// flag (como rae); cria o agente pela UI e roda o comando mostrado. ugo: a pessoa do par que lê o agente.
export const TAI: E2eUser = { email: 'tai@tayet.local', password: 'taipass123' }
export const UGO: E2eUser = { email: 'ugo@tayet.local', password: 'ugopass123' }
// Trio do group-conversation.spec.ts (ADR-094, PR-4). val abre o grupo pela tela (A); wes o vê e lê (B); xin
// completa o conjunto (C) — loga para entrar no canal da organização e no conjunto conhecido dos outros.
export const VAL: E2eUser = { email: 'val@tayet.local', password: 'valpass123' }
export const WES: E2eUser = { email: 'wes@tayet.local', password: 'wespass123' }
export const XIN: E2eUser = { email: 'xin@tayet.local', password: 'xinpass123' }
// Terceira pessoa do agent-approvers.spec.ts (vários aprovadores), ao lado do par tai/ugo.
export const YURI: E2eUser = { email: 'yuri@tayet.local', password: 'yuripass123' }
// Only for login.narrow.spec.ts (phone project): the login with the return from the provider in a new tab.
export const ZAK: E2eUser = { email: 'zak@tayet.local', password: 'zakpass123' }
// Pair of workspace.narrow.spec.ts only (phone project): lev uses the narrow shell, mae writes to lev.
export const LEV: E2eUser = { email: 'lev@tayet.local', password: 'levpass123' }
export const MAE: E2eUser = { email: 'mae@tayet.local', password: 'maepass123' }
// Only for language.spec.ts (desktop project): the device in English, the account's language changed and back.
export const LIN: E2eUser = { email: 'lin@tayet.local', password: 'linpass123' }
// Pair of timeline.narrow.spec.ts only (phone project): nel reads at 390×844 with touch, oli writes on a wide window.
export const NEL: E2eUser = { email: 'nel@tayet.local', password: 'nelpass123' }
export const OLI: E2eUser = { email: 'oli@tayet.local', password: 'olipass123' }
// Pair of copy-text.spec.ts only (desktop project): pat copies from the wide action bar, ros writes to pat.
export const PAT: E2eUser = { email: 'pat@tayet.local', password: 'patpass123' }
export const ROS: E2eUser = { email: 'ros@tayet.local', password: 'rospass123' }
// Pair of actions.narrow.spec.ts only (phone project): ted acts on messages by touch at 390×844, ula writes to ted.
export const TED: E2eUser = { email: 'ted@tayet.local', password: 'tedpass123' }
export const ULA: E2eUser = { email: 'ula@tayet.local', password: 'ulapass123' }
// Pair of viewer.spec.ts only (desktop project): gil opens the image viewer and downloads, hugo sends the media.
export const GIL: E2eUser = { email: 'gil@tayet.local', password: 'gilpass123' }
export const HUGO: E2eUser = { email: 'hugo@tayet.local', password: 'hugopass123' }
// Pair of media.narrow.spec.ts only (phone project): dan opens images and files by touch at 390×844, eva sends them.
export const DAN: E2eUser = { email: 'dan@tayet.local', password: 'danpass123' }
export const EVA: E2eUser = { email: 'eva@tayet.local', password: 'evapass123' }
// Pair of composer.narrow.spec.ts only (phone project): ivy writes from the narrow composer at 390×844, joe writes to ivy.
export const IVY: E2eUser = { email: 'ivy@tayet.local', password: 'ivypass123' }
export const JOE: E2eUser = { email: 'joe@tayet.local', password: 'joepass123' }
// Pair of search.narrow.spec.ts only (phone project): kit searches at 390×844, lou writes to kit.
export const KIT: E2eUser = { email: 'kit@tayet.local', password: 'kitpass123' }
export const LOU: E2eUser = { email: 'lou@tayet.local', password: 'loupass123' }
// Pair of compose.narrow.spec.ts only (phone project): max opens "Nova conversa" at 390×844, ned is the one max picks.
export const MAX: E2eUser = { email: 'max@tayet.local', password: 'maxpass123' }
export const NED: E2eUser = { email: 'ned@tayet.local', password: 'nedpass123' }
