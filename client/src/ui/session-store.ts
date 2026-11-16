import type { OpaqueSession } from '@tayet/client'

// ── Persistência de sessão app-side (ADR-030; revisada por ADR-032 D2). ───────────────────────────
// A sessão é trabalho de APP (acl/session.ts): o app a obtém (env legado OU fluxo OIDC) e a entrega à
// ACL, que é a única a interpretá-la. Persistida entre reloads. localStorage (ADR-030); chave neutra.
//
// ADR-032 D2: a OpaqueSession deixou de ser só o token de compat (string longa-viva) — agora carrega
// o blob renovável OIDC (access+refresh+device+issuer+clientId+homeserver) serializado. Continua
// OPACA pro app: aqui só serializa/desserializa string↔string; quem interpreta é o connect. O caminho
// legado (string crua mct_, env/dogfood) segue válido — connect aceita os dois (ADR-032: env sai num
// cleanup posterior, não nesta fatia).

const SESSION_KEY = 'tayet.session'
// Chave anterior ao rename. Lida UMA vez como migração: se a nova está ausente e a legada
// presente, move (grava a nova, apaga a legada) e segue. Escrita e remoção só na nova.
const LEGACY_SESSION_KEY = 'aurora.session'

export function loadSession(): OpaqueSession | null {
  try {
    let raw = localStorage.getItem(SESSION_KEY)
    if (raw === null) {
      const legacy = localStorage.getItem(LEGACY_SESSION_KEY)
      if (legacy !== null) {
        localStorage.setItem(SESSION_KEY, legacy)
        localStorage.removeItem(LEGACY_SESSION_KEY)
        raw = legacy
      }
    }
    return raw ? (raw as OpaqueSession) : null
  } catch {
    return null
  }
}

export function saveSession(session: OpaqueSession): void {
  try {
    localStorage.setItem(SESSION_KEY, session as string)
  } catch {
    // best-effort
  }
}

export function clearSession(): void {
  // Callers: Boot.tsx — o signOut (logout deste navegador, ADR-034) e o handler de sessão perdida
  // (ADR-035/ADR-059), que limpa a sessão antes de mostrar a tela de acesso encerrado.
  try {
    localStorage.removeItem(SESSION_KEY)
  } catch {
    // best-effort
  }
}

// Precedência (ADR-030): env autoritativa (override do operador; dogfood) e persistida; senão a
// persistida (blob OIDC ou string legada); senão null (no-session → botão SSO, fatia 2a).
export function resolveBootSession(envToken: string | undefined): OpaqueSession | null {
  if (envToken) {
    const session = envToken as OpaqueSession
    saveSession(session)
    return session
  }
  return loadSession()
}
