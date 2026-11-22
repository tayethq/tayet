// Estado de boot na tela — chrome de App sob render-scan. Apresentacional puro. P1: vocabulário de
// produto only (nada de homeserver/MAS/OIDC/token/crypto/store/dispositivo). Fatia 2a: botão SSO no
// no-session (ADR-031 D1) + beats de redirect/preparo (D3/D4). Fatia 2b: variante `revoked` (ADR-031
// D8b / ADR-034) — destino do logout e da sessão encerrada. "Continuar com {label}" usa o label de
// deployment (VITE_SSO_LABEL); o SPA NÃO enumera providers do MAS (§8.L21). PR-B (§8.9): a copy de
// conexão ('error') deixou de ser o default e passou a exigir sinal positivo de rede; o default
// honesto é 'failed' — neutro, com retry e saída self-service. Escopo A′ (PLANO-RELEASE-PUBLICA §8.64):
// toda variante dentro da superfície do manifesto login-onboarding (card, esqueleto, scrim, wordmark) e
// a saída para o chat em overlay inerte — o único efeito do módulo é o timeout de segurança dessa saída.

import { useEffect, useState } from 'react'
import { InstallSheet } from './InstallSheet'
import { t, APP_WORDMARK } from '../i18n'

export type BootPhase =
  | 'connecting'
  | 'ready'
  | 'error'
  | 'no-session'
  | 'redirecting'
  | 'preparing'
  | 'revoked'
  | 'idp-denied'
  | 'failed'
  | 'elsewhere'
  | 'handoff'

type BootContentProps = {
  variant: Exclude<BootPhase, 'ready'>
  ssoLabel?: string
  onRetry?: () => void
  onSignIn?: () => void
  onSignOut?: () => void
  onTakeOver?: () => void
  waitedLong?: boolean
  // The entry's button, for the focus when the install sheet over it closes.
  entryRef?: (el: HTMLButtonElement | null) => void
}

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

// A duração do token lida do CSS vivo (o token é mão-única: nada de ms cru no TS). Sem a folha
// (jsdom sem a variável), 0 — a saída desmonta no próximo tick.
const motionMs = (name: string): number => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const n = parseFloat(raw)
  if (Number.isNaN(n)) return 0
  return raw.endsWith('ms') ? n : n * 1000
}

// A superfície do boot (manifesto login-onboarding §7 itens 1–3): esqueleto neutro da casca, scrim e
// card com o wordmark; a variante entra abaixo do wordmark. `data-phase` é a fase do boot em
// vocabulário de produto — o E2E do aparelho novo grava a sequência por ele. Em `exiting` (§7 item 8)
// o app já está montado embaixo: a superfície fica inerte e escondida da árvore de acessibilidade,
// scrim e card vão a opacidade 0 e ela desmonta no transitionend ou no timeout de segurança.
export function BootMessage({
  exiting = false,
  onExited,
  install,
  ...content
}: BootContentProps & {
  exiting?: boolean
  onExited?: () => void
  // The install sheet over the entry (login-onboarding.md §10.1 item 5). Boot says when it exists.
  install?: { onContinue: () => void; onClose: () => void }
}) {
  const [entry, setEntry] = useState<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!exiting || !onExited) return
    if (prefersReducedMotion()) {
      onExited()
      return
    }
    const timer = setTimeout(onExited, motionMs('--motion-duration-slow'))
    return () => clearTimeout(timer)
  }, [exiting, onExited])

  return (
    <div
      className="boot-surface"
      data-phase={content.variant}
      data-exiting={exiting ? '' : undefined}
      aria-hidden={exiting || undefined}
      inert={exiting}
      onTransitionEnd={exiting && onExited ? (e) => e.propertyName === 'opacity' && onExited() : undefined}
    >
      <div className="boot-surface__skeleton" aria-hidden="true">
        <div className="boot-surface__side" />
        <div className="boot-surface__main" />
      </div>
      <div className="boot-surface__scrim" />
      <div className="boot-surface__card">
        <div className="boot-wordmark">
          <span className="boot-wordmark__dot" aria-hidden="true" />
          <span className="boot-wordmark__name">{APP_WORDMARK}</span>
        </div>
        <BootContent key={content.variant} {...content} entryRef={setEntry} />
      </div>
      {install && content.variant === 'no-session' && !exiting && (
        <InstallSheet
          action="install.continueInBrowser"
          onAction={install.onContinue}
          onClose={install.onClose}
          returnFocus={entry}
        />
      )}
    </div>
  )
}

function BootContent({
  variant,
  ssoLabel,
  onRetry,
  onSignIn,
  onSignOut,
  onTakeOver,
  waitedLong,
  entryRef,
}: BootContentProps) {
  if (variant === 'connecting') {
    return (
      <div className="boot-message" role="status" aria-live="polite">
        <span className="boot-message__detail">{t('boot.connecting')}</span>
      </div>
    )
  }
  if (variant === 'redirecting') {
    return (
      <div className="boot-message boot-message--beat" role="status" aria-live="polite">
        <span className="boot-spinner" aria-hidden="true" />
        <div className="boot-message__text">
          <strong className="boot-message__title">{t('boot.redirectTitle', { provider: ssoLabel ?? t('boot.providerFallback') })}</strong>
          <span className="boot-message__detail">{t('boot.redirectDetail')}</span>
        </div>
      </div>
    )
  }
  if (variant === 'preparing') {
    // Beat P2 (ADR-031 D4). P1 absoluto: "acesso seguro", nunca cripto/chave/escrow.
    return (
      <div className="boot-message boot-message--beat boot-message--preparing" role="status" aria-live="polite">
        <span className="boot-pulse" aria-hidden="true">
          <span className="boot-pulse__core" />
        </span>
        <div className="boot-message__text">
          <strong className="boot-message__title">{t('boot.preparingTitle')}</strong>
          <span className="boot-message__detail">
            {t('boot.preparingDetail')}
          </span>
        </div>
      </div>
    )
  }
  if (variant === 'elsewhere') {
    // ADR-065 D3: outra aba deste navegador já usa o Tayet (lock de aba). Esta não leu a sessão nem
    // criou client. P1: "aba"/"navegador", nunca sessão/dispositivo.
    return (
      <div className="boot-message" role="status">
        <div className="boot-message__text">
          <strong className="boot-message__title">{t('boot.otherTabTitle')}</strong>
          <span className="boot-message__detail">{t('boot.otherTabDetail')}</span>
        </div>
        {onTakeOver ? (
          <button type="button" className="boot-message__sso" onClick={onTakeOver}>
            {t('boot.useHere')}
          </button>
        ) : null}
      </div>
    )
  }
  if (variant === 'handoff') {
    // ADR-065 D4: esperando a outra aba ceder. Depois de WAIT_COPY_DELAY_MS a copy passa à secundária
    // (a outra aba pode estar congelada); a espera continua — nunca toma o lock à força.
    return (
      <div className="boot-message" role="status" aria-live="polite">
        <span className="boot-message__detail">
          {waitedLong
            ? t('boot.takeoverStuck')
            : t('boot.takingOver')}
        </span>
      </div>
    )
  }
  if (variant === 'no-session') {
    return (
      <div className="boot-message boot-message--entry" role="status">
        <div className="boot-message__text">
          <strong className="boot-message__title">{t('boot.signInTitle')}</strong>
          <span className="boot-message__detail">{t('boot.signInDetail')}</span>
        </div>
        {onSignIn ? (
          <button ref={entryRef} type="button" className="boot-message__sso boot-message__sso--provider" onClick={onSignIn}>
            {t('boot.continueWith', { provider: ssoLabel ?? t('boot.accountFallback') })}
          </button>
        ) : null}
      </div>
    )
  }
  if (variant === 'revoked') {
    // ADR-031 D8b / ADR-034: sessão encerrada (logout deste navegador, ou acesso não mais ativo). P1:
    // nunca "sessão"/"token"/"cripto" — só "acesso". Ação reusa o SSO (re-entrar = novo login cold).
    return (
      <div className="boot-message" role="alert">
        <div className="boot-message__text">
          <strong className="boot-message__title">{t('boot.endedTitle')}</strong>
          <span className="boot-message__detail">
            {t('boot.endedDetail')}
          </span>
        </div>
        {onSignIn ? (
          <button type="button" className="boot-message__sso" onClick={onSignIn}>
            {t('boot.signInAgain')}
          </button>
        ) : null}
      </div>
    )
  }
  if (variant === 'idp-denied') {
    // ADR-031 D8c / ADR-034 D4: o provedor não concluiu o acesso (negado/cancelado). App-side — o sinal
    // é o ?error do callback OAuth, NUNCA um errcode Matrix (não cruza a barrel). P1: vocabulário de
    // produto only (nada de OIDC/IdP/OAuth/token). Ação = re-tentar o SSO (cold), como o no-session.
    return (
      <div className="boot-message" role="alert">
        <div className="boot-message__text">
          <strong className="boot-message__title">{t('boot.signInFailedTitle')}</strong>
          <span className="boot-message__detail">
            {t('boot.signInFailedDetail', { provider: ssoLabel ?? t('boot.accountFallback') })}
          </span>
        </div>
        {onSignIn ? (
          <button type="button" className="boot-message__sso" onClick={onSignIn}>
            {t('boot.tryAgain')}
          </button>
        ) : null}
      </div>
    )
  }
  if (variant === 'failed') {
    // §8.9: o estado neutro e honesto de falha de boot — tudo que NÃO é sessão encerrada nem rede
    // comprovadamente falha (o default de antes vestia isso de "confira sua conexão", mentira para
    // falha local permanente). A copy não afirma causa, não culpa o usuário e oferece saída
    // self-service: retry, e — se persistir — entrar de novo neste navegador (o logout, que limpa e
    // aterrissa no login). P1: nada de sessão/dados/armazenamento local — só "entrar de novo".
    return (
      <div className="boot-message" role="alert">
        <div className="boot-message__text">
          <strong className="boot-message__title">{t('boot.startFailedTitle')}</strong>
          <span className="boot-message__detail">
            {t('boot.startFailedDetail')}
          </span>
        </div>
        <div className="boot-message__actions">
          {onRetry ? (
            <button type="button" className="boot-message__retry" onClick={onRetry}>
              {t('boot.retry')}
            </button>
          ) : null}
          {onSignOut ? (
            <button type="button" className="boot-message__secondary" onClick={onSignOut}>
              {t('boot.signInAgain')}
            </button>
          ) : null}
        </div>
      </div>
    )
  }
  // 'error' — a copy de conexão. Reservada ao SINAL POSITIVO de rede (o ConnectionError da ACL): é
  // o caso em que "confira sua conexão" é uma afirmação verdadeira. Falha de connect sem esse sinal
  // cai no 'failed' acima. O exchange OIDC (Boot.run) aplica a mesma classificação desde a S2
  // (PLANO-BOOT-STORE-ORFAO §8 item 11): rede no exchange → aqui; resto → 'failed'.
  return (
    <div className="boot-message" role="alert">
      <div className="boot-message__text">
        <strong className="boot-message__title">{t('boot.connectFailedTitle')}</strong>
        <span className="boot-message__detail">{t('boot.connectFailedDetail')}</span>
      </div>
      {onRetry ? (
        <button type="button" className="boot-message__retry" onClick={onRetry}>
          {t('boot.retry')}
        </button>
      ) : null}
    </div>
  )
}
