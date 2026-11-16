import { EventType } from 'matrix-js-sdk'

// ── Nascimento de sala cifrada com cobertura estrutural (ADR-057 dec. 2/3; PR-4) ───────────
// Tudo aqui é vocabulário de PROTOCOLO e de INFRA: fica confinado a acl/internal e nada disso
// atravessa o barrel (P1, estendido pela ADR-057 dec. 2 a "infra invisível" — o usuário não sabe
// que existe um destinatário estrutural, do mesmo jeito que não sabe que existe Megolm).

// F3 (ratificado, owner Jul/2026): UM usuário org único, localpart `cofre` — o mesmo default do
// wiring do escrow (`ESCROW_CUSTODY_USERNAME`, PR-2). Nunca vira config do cliente: derivar o mxid
// do domínio do próprio usuário conectado mantém zero superfície de configuração nova (e zero
// chance de o app apontar a custódia para outro servidor).
export const CUSTODY_LOCALPART = 'cofre'

// ADR-083 dec. 5: a conta de sistema, dona do canal da org (ADR-045 dec. 3), também não é gente e
// sai das mesmas superfícies que o cofre. Mesma derivação pelo domínio do usuário conectado.
export const SYSTEM_LOCALPART = 'system'

// `@alice:tayet.local` → `@cofre:tayet.local`. null quando o mxid não tem domínio (só acontece
// com id malformado; o chamador trata como falha de cobertura e sinaliza, nunca inventa domínio).
export function custodyMxidFor(myUserId: string): string | null {
  const colon = myUserId.indexOf(':')
  if (colon < 0) return null
  return `@${CUSTODY_LOCALPART}:${myUserId.slice(colon + 1)}`
}

export function systemMxidFor(myUserId: string): string | null {
  const colon = myUserId.indexOf(':')
  if (colon < 0) return null
  return `@${SYSTEM_LOCALPART}:${myUserId.slice(colon + 1)}`
}

// Espera limitada pela membership local do cofre antes de o verbo resolver. Calibrado pela medição
// do §0.4 da PR-4: o estado LOCAL do criador refletiu a membership 24 ms e 28 ms depois de o invite
// resolver (n=2 — a stack caiu antes da terceira execução; ver §8.4). 2000 ms dá ~70x de folga
// sobre o pior caso medido. O teto existe porque expirar é FAIL-OPEN (F1): a sala nasce cifrada de
// qualquer jeito, só sem cobertura, e com sinal.
export const CUSTODY_WAIT_MS = 2_000
export const CUSTODY_POLL_MS = 20

// Sinais nomeados de perda de cobertura, emitidos pela telemetria que a ACL JÁ tem (AclTelemetry.
// untranslated — o canal existente, nenhum mecanismo novo). Dois nomes, não um: "o convite foi
// recusado" e "o convite foi aceito mas a membership não apareceu a tempo" são modos de falha
// distintos, e colapsá-los num rótulo só cega o diagnóstico exatamente como o A1 mostrou.
export const CUSTODY_SIGNAL_INVITE_FAILED = 'io.tayet.custody.invite-failed'
export const CUSTODY_SIGNAL_WAIT_TIMEOUT = 'io.tayet.custody.wait-timeout'

// ── F11 (ratificado, PR-3.1): convite estrutural sob 429 do rc_message do CRIADOR ──────────
// Medido na PR-4 (§8.4): o /invite do cofre consome o orçamento rc_message do próprio criador
// (default 0.2/s, burst 10), que uma rajada de createRoom esgota — 6/12 salas da rajada
// nasceram SEM cofre. Fail-open sistemático ≠ excepcional; daí a fila: M_LIMIT_EXCEEDED no
// convite imediato enfileira {roomId, nextAttemptTs} honrando o retry_after_ms, o VERBO
// resolve normalmente com sinal DISTINTO (`deferred`, não `failed` — colapsá-los cegaria o
// diagnóstico, lição do A1), e um drain serializado fora do caminho do verbo re-tenta.
// Sucesso tardio dispensa a espera de membership (o verbo já resolveu; sessões pré-invite
// descobertas são ACEITAS — cobertas pelo backup no caso normal; gap composto de três
// raridades, registrado). Teto de tentativas → aí sim o fail-open do F1 (invite-failed) e a
// sala sai da fila.
export const CUSTODY_SIGNAL_INVITE_DEFERRED = 'io.tayet.custody.invite-deferred'

// ── PR-5 (ADR-057 dec. 6): consulta à custódia de sessão na recovery ───────────────────────
// Emitido quando o GET /v1/sessions (ou o import do payload) falha após um restore bem-sucedido.
// A recovery NÃO falha por isso (o backup já restaurou o que tinha) — mas o veredito definitivo
// da dec. 7 fica indisponível na sessão de uso, e ISSO é um evento de observabilidade: sem o
// sinal, "nenhum lost emitido" e "consulta nunca aconteceu" seriam indistinguíveis — a classe
// de silêncio que este track existe para matar.
export const CUSTODY_SIGNAL_SESSIONS_UNAVAILABLE = 'io.tayet.custody.sessions-unavailable'
export const CUSTODY_INVITE_MAX_ATTEMPTS = 5
export const CUSTODY_DRAIN_TICK_MS = 1_000
// Margem sobre o retry_after_ms: o Ratelimiter conta attempts REJEITADOS (medido na PR-4) —
// chegar 1 ms cedo re-trava o balde e escala o próprio retry_after.
export const CUSTODY_RETRY_MARGIN_MS = 250
// 429 sem retry_after_ms no corpo (defesa; o Synapse sempre o manda): espera fixa.
export const CUSTODY_RETRY_DEFAULT_MS = 5_000

// ADR-077 dec. 2: re-consulta à custódia por sessão Megolm desconhecida, com backoff e teto. A
// soma (30 s) cobre o depósito mais lento medido do agente (+21 s, §0 de 26/Out); a volta também
// re-decifra, o que refaz o GET por sessão ao backup (irmão vivo, 0–10 s do SDK). Só depois da
// última tentativa uma sessão ausente do import gradua `lost` (dec. 4).
export const CUSTODY_RECONSULT_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000]
export const CUSTODY_RECONSULT_MAX = 4

// ── initial_state de toda sala cifrada nascida pela ACL ───────────────────────────────────
// ADR-057 dec. 3 + sub-decisão do F7: os três valores abaixo eram HERDADOS (do preset, no caso do
// history_visibility; dos defaults do SDK/servidor, no caso da rotação) e passam a ser DECIDIDOS.
// A pinagem não muda o comportamento observado hoje — ela o torna imune a drift:
//
//  - `history_visibility: shared` é a pré-condição do C1 (o fan-out Megolm inclui membros `invite`
//    sempre que history_visibility !== 'joined'). Sem ela, o cofre convidado-e-não-joinado deixaria
//    de receber a chave, e a cobertura morreria em silêncio.
//  - `rotation_period_msgs` / `rotation_period_ms` são os defaults do SDK, pinados porque a norma 1
//    da ADR-057 (mensagens pós-entrada de um membro são decriptáveis por acesso futuro dele) depende
//    de a sessão rotacionar quando o membership cresce. O gate da PR-3 mediu que o SDK pinado JÁ
//    rotaciona no join; pinar promove o comportamento herdado a decidido e dá tripwire de upgrade.
export const MEGOLM_ROTATION_PERIOD_MSGS = 100
export const MEGOLM_ROTATION_PERIOD_MS = 604_800_000 // 7 dias

export interface InitialStateEvent {
  type: string
  state_key: string
  content: Record<string, unknown>
}

export function encryptedBirthState(): InitialStateEvent[] {
  return [
    {
      type: EventType.RoomEncryption,
      state_key: '',
      content: {
        algorithm: 'm.megolm.v1.aes-sha2',
        rotation_period_msgs: MEGOLM_ROTATION_PERIOD_MSGS,
        rotation_period_ms: MEGOLM_ROTATION_PERIOD_MS,
      },
    },
    {
      type: EventType.RoomHistoryVisibility,
      state_key: '',
      content: { history_visibility: 'shared' },
    },
  ]
}
