import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  createAcl,
  ConnectionError,
  SessionExpiredError,
  type Acl,
  type AclTelemetry,
  type OpaqueSession,
} from '@tayet/client'
import { App } from '../App'
import { resolveBootSession, saveSession, clearSession } from '../session-store'
import { beginLogin, isCallback, isErrorCallback, completeLogin, scrubCallback } from '../oidc'
import { BootMessage, type BootPhase } from './BootMessage'
import { createTabLock, WAIT_COPY_DELAY_MS, type TabLock } from '../tab-lock'
import { watchSearchState } from '../search-state'

// Controlador de boot. Trilha 1: connect-como-estado (issue #1). Fatia 2a: detecta o callback OIDC,
// inicia o login no no-session, mostra os beats. Fatia 2b: logout (ADR-034) — signOut na ACL (para o
// cliente + apaga cripto) + clearSession no app, aterrissando na tela de revogação (D8b). Persistência
// via session-store; refresh via ACL (onSessionRenewed re-persiste o blob). Os seams (makeAcl/resolve/
// renderReady) são injetáveis para teste; o fluxo OIDC é mockado pelo módulo ../oidc nos testes.

export interface BootProps {
  serverUrl: string
  envToken: string | undefined
  clientId: string
  ssoLabel: string
  telemetry: AclTelemetry
  makeAcl?: (serverUrl: string, telemetry: AclTelemetry, onRenewed: (s: OpaqueSession) => void, onLost: () => void) => Acl
  resolve?: (envToken: string | undefined) => OpaqueSession | null
  renderReady?: (acl: Acl, onSignOut: () => void) => ReactNode
  // ADR-065: o lock de aba. Seam como o makeAcl; o default é o navigator.locks do browser.
  tabLock?: TabLock
}

const defaultMakeAcl = (
  serverUrl: string,
  telemetry: AclTelemetry,
  onSessionRenewed: (s: OpaqueSession) => void,
  onSessionLost: () => void,
): Acl => createAcl({ mode: 'lenient', telemetry, serverUrl, onSessionRenewed, onSessionLost })

export function Boot({
  serverUrl,
  envToken,
  clientId,
  ssoLabel,
  telemetry,
  makeAcl = defaultMakeAcl,
  resolve = resolveBootSession,
  renderReady = (acl, onSignOut) => <App acl={acl} onSignOut={onSignOut} />,
  tabLock,
}: BootProps) {
  // ADR-031 addendum Out/2026: a volta do provedor nasce no D4 — o primeiro paint do callback já é
  // `preparing`, sem "Conectando…" entre a página do provedor e o beat.
  const [phase, setPhase] = useState<BootPhase>(() => (isCallback() ? 'preparing' : 'connecting'))
  // Manifesto login-onboarding §7 item 8: o beat que estava na tela quando o connect assentou fica por
  // cima do app em saída (inerte) até o fade terminar. null = sem overlay (sob reduced-motion, ou já saiu).
  const [exitFrom, setExitFrom] = useState<'preparing' | 'connecting' | null>(null)
  const endExit = useCallback(() => setExitFrom(null), [])
  const [lock] = useState<TabLock>(() => tabLock ?? createTabLock())
  // ADR-065 D4: a espera do "Usar aqui" passou de WAIT_COPY_DELAY_MS → copy secundária.
  const [waitedLong, setWaitedLong] = useState(false)
  // ADR-065 D2: fases que NÃO seguram o lock — nada nelas usa token nem o store. O retry readquire.
  // `revoked` também solta, mas só depois do wipe (ver os três pontos que a alcançam).
  const settle = useCallback(
    (p: 'no-session' | 'idp-denied' | 'error') => {
      lock.release()
      setPhase(p)
    },
    [lock],
  )
  const aclRef = useRef<Acl | null>(null)
  const didInit = useRef(false)
  // ADR-035 D3: guard de idempotência — o TokenRefreshLogoutError dispara em CADA caminho autenticado
  // (sync/keys/turnServer/createRoom); o 1º sinal arma o teardown, o resto é no-op até a próxima conexão.
  const sessionLostRef = useRef(false)
  // Indireção estável: o seam makeAcl é chamado em ensureAcl (antes de signOut existir no escopo);
  // passamos um wrapper sem-deps que lê o handler real, atribuído abaixo após signOut.
  const onSessionLostRef = useRef<() => void>(() => {})

  const ensureAcl = useCallback((): Acl => {
    const acl = aclRef.current ?? makeAcl(serverUrl, telemetry, (s) => saveSession(s), () => onSessionLostRef.current())
    aclRef.current = acl
    return acl
  }, [makeAcl, serverUrl, telemetry])

  const connectWith = useCallback(
    async (session: OpaqueSession, beat: 'preparing' | 'connecting') => {
      const acl = ensureAcl()
      // ADR-074 dec. 4: the first search.state goes out during connect — watch it from before.
      watchSearchState(acl)
      try {
        await acl.connect(session)
        sessionLostRef.current = false // re-armado: a nova sessão pode perder de novo (ADR-035 D3)
        setExitFrom(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? null : beat)
        setPhase('ready')
      } catch (e) {
        console.error('[boot]', e)
        // P1: o motivo real fica no console (console ≠ DOM). Classificamos sobre o TIPO de domínio que
        // a ACL traduz (nunca sobre o código de protocolo do SDK — L19). A regra é por SINAL POSITIVO,
        // não por default (§8.9): sessão expirada → revogação (re-login SSO); rede comprovadamente
        // falha → 'error' (a ÚNICA copy que manda conferir a conexão); todo o resto → 'failed', o
        // estado neutro e honesto — "não deu pra iniciar", com retry e saída self-service. Vestir
        // falha local de problema de rede mandava o usuário procurar defeito onde não havia.
        // ADR-065 D2: 'failed' segura o lock (o escape dele faz wipe); 'error' solta; 'revoked' solta
        // já — o wipe do boot (sessão morta, identidade divergente) assentou dentro do connect.
        if (e instanceof SessionExpiredError) {
          lock.release()
          setPhase('revoked')
        } else if (e instanceof ConnectionError) settle('error')
        else setPhase('failed')
      }
    },
    [ensureAcl, lock, settle],
  )

  const run = useCallback(async () => {
    // ADR-065 D4: esta aba acabou de ceder (flag + reload) → tela neutra direto, sem tentar o lock.
    if (lock.consumeYielded()) {
      setPhase('elsewhere')
      return
    }
    // ADR-065 D1: o lock vem ANTES de tudo que toca estado compartilhado — o exchange do callback, a
    // leitura da sessão persistida (e a escrita do modo env), o refresh do boot. Sem o lock: tela
    // neutra, URL preservada (um callback não troca o código aqui). Sem a API: o caminho de antes.
    if ((await lock.acquire()) === 'busy') {
      setPhase('elsewhere')
      return
    }
    // Volta do OP (D3/D4): troca o código, persiste, conecta — com o beat de preparo visível.
    if (isCallback()) {
      setPhase('preparing')
      try {
        const session = await completeLogin()
        scrubCallback() // sucesso: completeLogin é puro agora (§8.L31) — o app limpa ?code&state
        saveSession(session)
        await connectWith(session, 'preparing')
      } catch (e) {
        console.error('[boot]', e)
        scrubCallback() // fail: o code é de uso único — limpa a URL pra "Tentar novamente"/bfcache não re-trocar (§8.L33)
        // Mesmo idioma do connectWith (§8 item 11 do PLANO-BOOT-STORE-ORFAO): classificação por TIPO
        // de domínio, por SINAL POSITIVO — rede comprovadamente falha (ConnectionError, nascido na
        // ACL) → 'error'; todo o resto → 'failed'. Sem braço de revogação: o exchange não tem sessão
        // pra expirar (connectWith trata a dele no próprio catch, que não relança).
        if (e instanceof ConnectionError) settle('error')
        else setPhase('failed')
      }
      return
    }
    // Negação do OP (ADR-031 D8c / ADR-034 D4): volta como ?error&state (sem code). App-side, fora da
    // barrel (vocabulário OAuth, não Matrix). Scrub antes da tela pra retry/bfcache não reprocessar.
    if (isErrorCallback()) {
      scrubCallback()
      settle('idp-denied')
      return
    }
    // Sessão existente (env legado ou persistida) → connect.
    const existing = resolve(envToken)
    if (existing) {
      setPhase('connecting')
      await connectWith(existing, 'connecting')
      return
    }
    // Nada → no-session (botão SSO).
    settle('no-session')
  }, [lock, settle, resolve, envToken, connectWith])

  const signIn = useCallback(async () => {
    setPhase('redirecting')
    try {
      await beginLogin({ serverUrl, clientId })
      // beginLogin redireciona; se retornar sem navegar, algo falhou.
    } catch (e) {
      console.error('[boot]', e)
      setPhase('error')
    }
  }, [serverUrl, clientId])

  // Logout (ADR-034 D1; ADR-062 D1): a ACL revoga esta sessão no emissor (best-effort, com bound), para
  // o cliente E apaga o store de cripto (signOut); o app limpa a sessão persistida (clearSession). Aterrissa na tela de revogação (D8b). Best-effort no
  // wipe: mesmo que o signOut rejeite, limpamos a sessão do app e mostramos a revogação — não deixamos
  // o usuário preso "meio-deslogado". O invariante "limpa sessão E cripto" é dogfood-verificado (o wipe
  // de IndexedDB não tem superfície em Node).
  const signOut = useCallback(async () => {
    try {
      await aclRef.current?.signOut()
    } catch (e) {
      console.error('[boot]', e)
    } finally {
      aclRef.current = null
      clearSession()
      // ADR-065 D2: o signOut da ACL assenta quando o wipe assenta ou quando o STORE_WIPE_BOUND_MS
      // estoura (matrix-client.ts, bounded) — só então o lock é solto.
      lock.release()
      setPhase('revoked')
    }
  }, [lock])

  // ADR-065 D4/D5: "Usar aqui" — pede ao dono que ceda e espera na fila, sem prazo de correção (dono
  // congelado = espera; nunca à força). Adquiriu → o boot normal (inclusive o callback preservado na
  // URL). Outra aba adquiriu antes → volta à tela neutra com o botão; sem re-envio automático.
  const takeOver = useCallback(async () => {
    setWaitedLong(false)
    setPhase('handoff')
    const timer = setTimeout(() => setWaitedLong(true), WAIT_COPY_DELAY_MS)
    const granted = await lock.takeOver().granted
    clearTimeout(timer)
    if (granted) void run()
    else setPhase('elsewhere')
  }, [lock, run])

  // ADR-065 D4/D6: enquanto montado, o dono cede a um `release-request` (flag + reload) e um pageshow
  // vindo do BFCache recarrega (passa de novo pelo lock).
  useEffect(() => lock.watch(), [lock])

  useEffect(() => {
    if (didInit.current) return
    didInit.current = true
    void run()
  }, [run])

  // ADR-035 D3: handler real do onSessionLost — idempotente. O 1º TokenRefreshLogoutError arma o guard
  // e dispara o teardown (signOut → revoked, que de quebra mata o retry storm); os subsequentes da
  // tempestade caem no return acima. Atribuído via ref (a indireção de §3.3) porque ensureAcl o
  // referencia antes de signOut existir no escopo.
  //
  // ADR-059 D2: na sessão perdida a tela NUNCA depende do teardown. A sessão do app some e a fase vai
  // para revoked JÁ; o signOut da ACL (para o cliente + wipe com bound) corre depois, sem ser
  // aguardado. O logout voluntário (botão "Sair") segue pelo signOut acima, que aguarda a ACL.
  onSessionLostRef.current = () => {
    if (sessionLostRef.current) return
    sessionLostRef.current = true
    const acl = aclRef.current
    aclRef.current = null
    clearSession()
    setPhase('revoked')
    // ADR-065 D2: a tela vem já; o lock só é solto quando o teardown da ACL assenta — wipe concluído
    // ou STORE_WIPE_BOUND_MS estourado (o bound vive no signOut da ACL). Soltar antes deixaria outra
    // aba abrir o store antes do deleteDatabase, que então apagaria o store DELA ao fechar.
    if (!acl) lock.release()
    else
      void acl
        .signOut()
        .catch((e: unknown) => console.error('[boot]', e))
        .finally(() => lock.release())
  }

  // O app monta uma vez (ready) e a superfície do boot fica na MESMA posição da árvore, em saída: o
  // elemento é preservado e o fade de scrim/card corre sobre o app. O `ready` não espera a transição.
  const readyAcl = phase === 'ready' ? aclRef.current : null
  const boot = readyAcl ? exitFrom : phase === 'ready' ? 'connecting' : phase
  return (
    <>
      {readyAcl ? renderReady(readyAcl, () => void signOut()) : null}
      {boot ? (
        <BootMessage
          variant={boot}
          ssoLabel={ssoLabel}
          waitedLong={waitedLong}
          onRetry={() => void run()}
          onSignIn={() => void signIn()}
          onSignOut={() => void signOut()}
          onTakeOver={() => void takeOver()}
          exiting={readyAcl !== null}
          onExited={endExit}
        />
      ) : null}
    </>
  )
}
