// ensureKeyRecovery — the ONE bootstrap/recovery path of ADR-013 (PLANO-FASE-2-ESCROW-C2 §3.2).
// Warm start, cold start and the first-login race loser all flow through this single function;
// the branches differ only in how much is already materialized. Idempotent by construction:
// a second call on an already-bootstrapped device is a cheap local no-op (observable anchor:
// zero PUT/GET on the escrow audit — gate assert 3).
//
// NEVER on the login critical path (§0.2 item 1): the gateway fires it AFTER the first sync
// (bootstrapSecretStorage requires the account-data echo — PF-2 item 1) and never awaits it in
// connect(). Failure of any kind folds into 'retry' — the RecoveryRunner below re-runs it with
// capped exponential backoff until it settles, and is cancelled on disconnect (§3.3).
//
// Race sequencing (PF-2 item 3, flagged for the owner): deposit() is the FIRST mutating act of
// the first-login branch. The escrow's write-once is the single arbiter — exactly one device
// wins the 201 and is the only one that ever creates identity/4S/backup; the 409 loser adopts
// the winning secret through the SAME recovery branch as a cold start. Bootstrapping before the
// PUT would instead make two virgin devices collide on the cross-signing upload (MSC3967 demands
// UIA for the second, different upload) before either reaches the escrow — the §5.2 assert 6
// outcome (one 201 + one 409) would be unfalsifiable.
//
// The secret exists only in bootstrap memory: set into the holder for the SDK callbacks to read
// (PF-1 item 2), cleared in `finally` on every pass. Never logged, never persisted here.

import { CUSTODY_RECONSULT_DELAYS_MS, CUSTODY_RECONSULT_MAX } from './custody'
import type { EscrowClient } from './escrow-client'
import type { StoredIdentity } from './key-reset'

// 'needs-user' (D3 / ADR-019 §1): the recovery path hit the MSC3967 wall — reconciling would need
// to REPLACE an existing cross-signing identity, which requires interactive UIA the fire-and-forget
// background cannot drive. Distinct from 'retry' (transient): a deterministic terminal state the
// RecoveryRunner answers by emitting the actionable device.attention, not by backing off forever.
export type RecoveryOutcome = 'noop' | 'done' | 'retry' | 'needs-user'

// PF-2 (verified live against matrix-js-sdk 41.6.0 + the pinned MAS): the device-signing-keys
// upload that REPLACES an existing identity rejects with HTTP 401 whose body carries the UIA
// `flows` (m.oauth / org.matrix.cross_signing_reset → the MAS account page). A transient error
// (HTTP blip, mid-flight disconnect) never carries `data.flows`, so this discriminant is
// deterministic — folding the UIA wall into 'retry' would pin the device in honest retry forever.
function isUiaRequired(err: unknown): boolean {
  const e = err as { httpStatus?: number; data?: { flows?: unknown } } | null | undefined
  return e?.httpStatus === 401 && Array.isArray(e?.data?.flows)
}

// Structural subset of the SDK's CryptoApi (PF-1) — ports keep the unit regime SDK-free.
export interface RecoveryCrypto {
  getCrossSigningStatus(): Promise<{
    privateKeysCachedLocally: { masterKey: boolean; selfSigningKey: boolean; userSigningKey: boolean }
  }>
  getSessionBackupPrivateKey(): Promise<Uint8Array | null>
  checkKeyBackupAndEnable(): Promise<unknown>
  bootstrapCrossSigning(opts: Record<string, never>): Promise<void>
  bootstrapSecretStorage(opts: {
    createSecretStorageKey: () => Promise<{ privateKey: Uint8Array<ArrayBuffer> }>
    setupNewKeyBackup: boolean
  }): Promise<void>
  loadSessionBackupPrivateKeyFromSecretStorage(): Promise<void>
  restoreKeyBackup(): Promise<unknown>
  // ADR-061 D2: cria uma versão de backup nova e guarda a chave dela no 4S EXISTENTE (sem UIA,
  // sem tocar a chave do 4S). Apaga TODAS as versões existentes antes — só roda com ausência
  // provada (probeBackup) e depois do teto do claim.
  resetKeyBackup(): Promise<void>
  // Import do delta da custódia de sessão (ADR-057 dec. 6): entries de export Megolm, como
  // string JSON — o MESMO formato do restoreKeyBackup por baixo. O shield GREY do material
  // importado é aceito por decisão (o produto não exibe shields).
  importRoomKeysAsJson(keys: string): Promise<void>
}

// Passo de backup best-effort (ADR-061 D1): falha reportada pela porta, nunca engolida em
// silêncio e nunca pré-condição da consulta à custódia.
export type BackupStep = 'load' | 'enable' | 'restore'

// Sinal de telemetria do passo de backup que falhou (sufixado pelo passo). Payload-free: diz O QUE
// falhou, nunca o material — o mesmo padrão dos sinais da custódia.
export const RECOVERY_SIGNAL_BACKUP_STEP_FAILED = 'io.tayet.recovery.backup-step-failed'

// Desfecho da consulta à custódia de sessão (dec. 6/7), reportado ao gateway via porta:
// 'consulted' SÓ quando o GET respondeu E o import assentou — é a base do veredito definitivo
// (`lost`) da dec. 7; os ids importados são o conjunto contra o qual o translate discrimina.
// 'unavailable' = sem consulta nesta sessão de uso → sem veredito (o grau fica em 'stalled').
export type CustodyConsult =
  | { kind: 'consulted'; sessionIds: string[] }
  | { kind: 'unavailable' }

export interface RecoveryPorts {
  crypto: RecoveryCrypto
  // m.secret_storage.default_key probe — decides, inside the recovery branch, whether the 4S
  // world has materialized yet (the race winner may still be mid-bootstrap; PF-2 item 3).
  getDefaultKeyId(): Promise<string | null>
  // ADR-061 D2 — "backup ausente" exige PROVA: 'absent' só com o segredo m.megolm_backup.v1 fora
  // do 4S ou M_NOT_FOUND do servidor na versão corrente. Qualquer outro erro LANÇA (→ 'retry'):
  // um erro transitório jamais vira ausência, porque a ausência autoriza o resetKeyBackup que
  // apaga versões.
  probeBackup(): Promise<'present' | 'absent'>
  // ADR-061 D1: um passo de backup falhou (best-effort); a recuperação segue para a custódia.
  onBackupStepFailed(step: BackupStep): void
  // Forces our own public identity into the crypto store (a /keys/query the OlmMachine ingests).
  // Without it, importing the private cross-signing keys from 4S fails on a cold device — the
  // machine only learns identities when something queries them, and an idle device never does
  // (found on the real gate; gateway impl: userHasCrossSigningKeys(ownUserId, true)).
  ensureOwnIdentity(): Promise<void>
  // ADR-082 dec. 2: the master in 4S against the server identity, with the secret in the holder.
  storedIdentity(): Promise<StoredIdentity>
  escrow: EscrowClient
  // Bootstrap-memory secret holder: the createClient cryptoCallbacks read from it (PF-1 item 2).
  setSecret(secret: Uint8Array<ArrayBuffer>): void
  clearSecret(): void
  // ADR-057 dec. 6 / ADR-061 D1: recebe o desfecho da consulta à custódia de sessão (uma por
  // pass que materializa acesso — cold, claim, vencedor — ou re-passada warm sob demanda). O gateway materializa daqui o conjunto que habilita o `lost` (dec. 7)
  // e o sinal de telemetria da falha. Obrigatória de propósito: o tsc enumera os sites de
  // construção — nenhum caminho de recovery fica sem decidir o que faz com o veredito.
  onCustodySessions(outcome: CustodyConsult): void
}

// Custody linearization invariant (§8 do PLANO): the escrow LINEARIZES — write-once is the one
// arbiter of who creates the world. Waiting is the DEFAULT answer to "winner in flight" (4S
// absent while another device bootstraps); claim-after-timeout covers the DEAD winner: after
// this many attempts of the existing backoff still observing "secret present + 4S absent", the
// device adopts the winnership and bootstraps WITH the deposited secret. Bootstrap always
// converges to the deposited secret — no path past the 404→PUT ever generates a new one.
// With the runner's backoff (1s base, ×2) the claim fires after ~15s of orphan state.
export const CLAIM_AFTER_ATTEMPTS = 4

export async function ensureKeyRecovery(ports: RecoveryPorts, attempt = 0): Promise<RecoveryOutcome> {
  try {
    // Warm branch — local store reads only (PF-2 item 2). A device that already completed a
    // pass has the cross-signing private keys and the backup decryption key cached.
    const cs = await ports.crypto.getCrossSigningStatus()
    const cached = cs.privateKeysCachedLocally
    if (cached.masterKey && cached.selfSigningKey && cached.userSigningKey) {
      if ((await ports.crypto.getSessionBackupPrivateKey()) !== null) {
        // "Garantir backup ativo" (§3.2): idempotent re-check the SDK already knows how to do.
        await ports.crypto.checkKeyBackupAndEnable()
        return 'noop'
      }
    }

    const retrieved = await ports.escrow.retrieve()
    if (retrieved.kind === 'unavailable') return 'retry'
    if (retrieved.kind === 'secret') return await recover(ports, retrieved.secret, attempt)

    // 404 — first login. Generate and DEPOSIT before any server-mutating bootstrap (PF-2
    // item 3): the write-once decides who bootstraps; everyone else adopts.
    const generated = crypto.getRandomValues(new Uint8Array(32))
    const deposited = await ports.escrow.deposit(generated)
    if (deposited.kind === 'deposited') return await bootstrapWorld(ports, generated)
    if (deposited.kind === 'exists') {
      // Lost the race (§0.2 item 2): discard the own, never-used secret and adopt the winner's.
      const winner = await ports.escrow.retrieve()
      if (winner.kind === 'secret') return await recover(ports, winner.secret, attempt)
    }
    return 'retry'
  } catch (e) {
    // Total by construction: an SDK throw (transient HTTP, mid-flight disconnect freeing the
    // wasm machine…) is a retry, never an exception loose on a fire-and-forget path. The ONE
    // exception is the MSC3967 UIA wall (PF-2): replacing an existing identity needs interactive
    // auth — a deterministic 'needs-user', classified by error shape, not folded into retry.
    return isUiaRequired(e) ? 'needs-user' : 'retry'
  } finally {
    ports.clearSecret()
  }
}

// World creation: the 201 winner of the deposit race — or, past the claim timeout, the device
// that adopted a dead winner's winnership (the `secret` is then the DEPOSITED one, never a new
// one; mini-PF da §8 prova que criar o 4S a partir de chave injetada é o mesmo code path).
// bootstrapCrossSigning first (creates + uploads identity — initial upload is non-interactive,
// MSC3967/PF-1 item 3), then bootstrapSecretStorage exports those keys into the 4S it creates
// from the given bytes and sets up the key backup in the same call (PF-1 item 1).
async function bootstrapWorld(ports: RecoveryPorts, secret: Uint8Array<ArrayBuffer>): Promise<RecoveryOutcome> {
  ports.setSecret(secret)
  await ports.crypto.bootstrapCrossSigning({})
  await ports.crypto.bootstrapSecretStorage({
    createSecretStorageKey: () => Promise.resolve({ privateKey: secret }),
    setupNewKeyBackup: true,
  })
  // ADR-061 D1: o vencedor e o claim também consultam a custódia — um vencedor morto pode ter
  // deixado sessões endereçadas ao usuário que só o cofre recebeu.
  await consultCustody(ports)
  return 'done'
}

// Recovery: cold start, warm device missing the backup key, or race-loser adoption — one branch.
// 4S absent server-side: waiting is the FIRST answer (winner in flight — eventual consistency,
// fatia A pattern), but not the last: past CLAIM_AFTER_ATTEMPTS the winner is presumed dead and
// this device claims the winnership, creating the world FROM the deposited secret (orphan-secret
// window closed; invariante de linearização, §8). A simultaneous double-claim converges: both
// use the SAME deposited secret, and the identity-upload race resolves like the first-login one
// (MSC3967 — the loser's retry lands on the unlock branch once 4S materializes).
async function recover(
  ports: RecoveryPorts,
  secret: Uint8Array<ArrayBuffer>,
  attempt: number,
): Promise<RecoveryOutcome> {
  if ((await ports.getDefaultKeyId()) === null) {
    if (attempt < CLAIM_AFTER_ATTEMPTS) return 'retry'
    return await bootstrapWorld(ports, secret)
  }
  ports.setSecret(secret)
  // Import cross-signing private keys from 4S + self-sign this device (no UIA on this path —
  // PF-1 item 2). Idempotent if already imported. The import needs the PUBLIC identity in the
  // local store first — force the /keys/query ingest (see ensureOwnIdentity).
  await ports.ensureOwnIdentity()
  // ADR-082 dec. 2: half-state (identity in 4S ≠ server, or unreadable). Importing would fail forever
  // ("public key … doesn't match"); only the reset converges. Below the claim ceiling it may still
  // be a device in the middle of materializing the world, so it waits like the claim above.
  if ((await ports.storedIdentity()) !== 'same') {
    return attempt < CLAIM_AFTER_ATTEMPTS ? 'retry' : 'needs-user'
  }
  await ports.crypto.bootstrapCrossSigning({})
  // ADR-061 D2 — terceira janela de vencedor morto: 4S presente, backup ausente (o device morreu
  // entre o 4S e o resetKeyBackup do SDK). Abaixo do teto, espera como o claim existente — mas
  // consulta a custódia já (D1: o histórico decifra antes do backup existir). No teto, este
  // device cria o backup a partir do 4S custodiado (o holder tem o segredo depositado).
  if ((await ports.probeBackup()) === 'absent') {
    if (attempt < CLAIM_AFTER_ATTEMPTS) {
      await consultCustody(ports)
      return 'retry'
    }
    await ports.crypto.resetKeyBackup()
    await consultCustody(ports)
    return 'done'
  }
  // Backup: cache the decryption key from 4S, enable the engine for future uploads, then
  // restore history. The restore promise is the deterministic completion signal (PF-3); the
  // visible upgrade of `unavailable` placeholders flows through the EXISTING Decrypted →
  // message.edited machine (ADR-015 item 1) — zero new mechanism. ADR-061 D1: each step is
  // best-effort (failure goes out through the port) and none of them gates the custody consult.
  await bestEffort(ports, 'load', () => ports.crypto.loadSessionBackupPrivateKeyFromSecretStorage())
  await bestEffort(ports, 'enable', () => ports.crypto.checkKeyBackupAndEnable())
  await bestEffort(ports, 'restore', () => ports.crypto.restoreKeyBackup())
  // ADR-057 dec. 6 — recovery estendida: depois do restore (ordem de custo, não pré-condição —
  // ADR-061 D1), consultar a custódia de sessão e importar o delta (as sessões cujo device são do
  // usuário nunca recebeu — a janela que o backup não alcança). Falha da consulta NÃO falha a
  // recovery; o desfecho vai pela porta (telemetria + veredito indisponível nesta sessão de uso).
  await consultCustody(ports)
  return 'done'
}

async function bestEffort(ports: RecoveryPorts, step: BackupStep, run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
  } catch {
    ports.onBackupStepFailed(step)
  }
}

// O que a consulta à custódia lê das portas — o recorte que a re-consulta (ADR-077) usa sem o pass.
export type CustodyConsultPorts = Pick<RecoveryPorts, 'crypto' | 'escrow' | 'onCustodySessions'>

// Total como todo o resto do arquivo: nenhum throw escapa (a recovery já assentou quando isto
// roda — um erro aqui não pode regredi-la a 'retry'). 'consulted' SÓ com GET + import completos.
// Exportada para a re-consulta do ADR-077: "consulta só", sem atravessar o pass (nem o ramo warm
// com o seu checkKeyBackupAndEnable, nem um cold ainda em retry no runner).
export async function consultCustody(ports: CustodyConsultPorts): Promise<void> {
  let outcome: CustodyConsult = { kind: 'unavailable' }
  try {
    const res = await ports.escrow.retrieveSessions()
    if (res.kind === 'sessions') {
      await ports.crypto.importRoomKeysAsJson(JSON.stringify(res.sessions))
      outcome = { kind: 'consulted', sessionIds: sessionIdsOf(res.sessions) }
    }
  } catch {
    // import lançou (payload que o SDK rejeitou, wasm liberado no disconnect…) → sem veredito.
  }
  ports.onCustodySessions(outcome)
}

// session_id das entries de export Megolm — o ÚNICO campo que o client lê do payload (o resto
// segue opaco até o SDK). Entry sem o campo é ignorada: nunca entra no conjunto do veredito.
function sessionIdsOf(sessions: unknown[]): string[] {
  const ids: string[] = []
  for (const s of sessions) {
    const id = (s as { session_id?: unknown } | null | undefined)?.session_id
    if (typeof id === 'string' && id !== '') ids.push(id)
  }
  return ids
}

// Backstop teto (ADR-019 §1): if the pass stays stuck in 'retry' for a NON-classified reason past
// this many attempts, the runner offers the reset anyway (fail-toward-offering-it). The
// deterministic 'needs-user' is the PRIMARY signal; this only catches what the error-shape classifier
// missed. High enough that a slow network (the backoff caps at 30s ≈ minutes of retries) does not
// trip it spuriously before transients clear.
export const NEEDS_USER_BACKSTOP_ATTEMPTS = 12

// Per-session background retry (§3.3): capped exponential backoff, single in-flight pass,
// cancellation by generation bump — the same hygiene class as fatia A's check drain. start()
// returns synchronously (the login path never waits); cancel() makes any in-flight result
// inert and clears the pending timer. D3: on the UIA wall ('needs-user', or the backstop) it
// STOPS the backoff and raises the actionable signal through the injected onNeedsUser emitter.
export class RecoveryRunner {
  private gen = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    // Receives the attempt ordinal (0-based) — ensureKeyRecovery uses it for claim-after-timeout.
    private readonly run: (attempt: number) => Promise<RecoveryOutcome>,
    private readonly baseDelayMs = 1_000,
    private readonly maxDelayMs = 30_000,
    // Raised once when the recovery hits the UIA wall (deterministic 'needs-user' or the backstop).
    // The gateway wires it to emit device.attention; default no-op keeps the C2 unit regime intact.
    private readonly onNeedsUser: () => void = () => {},
    private readonly backstopAttempts = NEEDS_USER_BACKSTOP_ATTEMPTS,
  ) {}

  start(): void {
    const gen = ++this.gen
    void this.attempt(gen, 0)
  }

  cancel(): void {
    this.gen++
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private async attempt(gen: number, n: number): Promise<void> {
    if (gen !== this.gen) return
    let outcome: RecoveryOutcome
    try {
      outcome = await this.run(n)
    } catch {
      outcome = 'retry' // ensureKeyRecovery is total; belt-and-braces for the fire-and-forget path
    }
    if (gen !== this.gen) return
    // Deterministic wall: stop the loop and raise the actionable signal (ADR-019 §1).
    if (outcome === 'needs-user') {
      this.onNeedsUser()
      return
    }
    if (outcome !== 'retry') return // 'noop'/'done' — settled
    // Still retrying. Defensive backstop: stuck past the cap → offer the reset anyway, then stop.
    if (n + 1 >= this.backstopAttempts) {
      this.onNeedsUser()
      return
    }
    const delay = Math.min(this.baseDelayMs * 2 ** n, this.maxDelayMs)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.attempt(gen, n + 1)
    }, delay)
  }
}

// ── ADR-077: re-consulta à custódia por sessão Megolm desconhecida ──────────────────────────
// O gateway avisa (`note`) cada sessão de um evento não decifrável; esta classe decide QUANDO
// consultar. Uma sessão fora do import ganha até CUSTODY_RECONSULT_MAX voltas, com os atrasos de
// CUSTODY_RECONSULT_DELAYS_MS (dec. 2), mesmo depois de um pass cold. Um timer só: sessões que
// chegam durante a espera entram na volta armada (coalescência), e o atraso da próxima volta é o
// da sessão com menos tentativas. Cada volta = uma consulta + re-decifragem das sessões da volta
// (dec. 3, que refaz o GET ao backup). Antes de consultar, a volta descarta a sessão que já veio
// no import ou que não tem mais evento pendente (o key share comum chega ms depois do UTD) — sem
// evento pendente, nenhuma GET (dec. 5). `exhausted` é o elo do teto no veredito `lost` (dec. 4).
export interface CustodyReconsultPorts {
  consult(): Promise<void>
  imported(sessionId: string): boolean
  // Ainda há evento entregue à UI, não decifrado, desta sessão?
  pending(sessionId: string): boolean
  retryDecryption(sessionIds: readonly string[]): void
}

export class CustodyReconsult {
  private readonly attempts = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private cancelled = false

  constructor(
    private readonly ports: CustodyReconsultPorts,
    private readonly delays: readonly number[] = CUSTODY_RECONSULT_DELAYS_MS,
    private readonly max: number = CUSTODY_RECONSULT_MAX,
  ) {}

  note(sessionId: string): void {
    if (this.cancelled || this.attempts.has(sessionId) || this.ports.imported(sessionId)) return
    this.attempts.set(sessionId, 0)
    this.arm()
  }

  exhausted(sessionId: string): boolean {
    return (this.attempts.get(sessionId) ?? 0) >= this.max
  }

  // Teardown (disconnect/signOut/sessão perdida): nenhuma volta nova, a em voo não re-arma.
  cancel(): void {
    this.cancelled = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private live(): string[] {
    return [...this.attempts].filter(([, n]) => n < this.max).map(([id]) => id)
  }

  private arm(): void {
    if (this.cancelled || this.running || this.timer !== undefined) return
    const live = this.live()
    if (live.length === 0) return
    const fewest = Math.min(...live.map((id) => this.attempts.get(id) ?? 0))
    const delay = this.delays[Math.min(fewest, this.delays.length - 1)] ?? 0
    this.timer = setTimeout(() => void this.round(), delay)
  }

  private async round(): Promise<void> {
    this.timer = undefined
    this.running = true
    try {
      const batch: string[] = []
      for (const id of this.live()) {
        // Resolvida (import ou decifrada por outro canal): sai do rastreio — um UTD futuro da
        // mesma sessão recomeça do zero.
        if (this.ports.imported(id) || !this.ports.pending(id)) this.attempts.delete(id)
        else batch.push(id)
      }
      if (batch.length === 0) return
      // Total como o resto do arquivo (a volta roda solta num timer): uma consulta que lançasse
      // conta como tentativa, nunca re-arma a mesma volta para sempre.
      await this.ports.consult().catch(() => undefined)
      if (this.cancelled) return
      for (const id of batch) this.attempts.set(id, (this.attempts.get(id) ?? 0) + 1)
      // Depois do incremento: a re-falha da última volta já assenta com o teto esgotado ('lost').
      try {
        this.ports.retryDecryption(batch)
      } catch {
        // best-effort: a próxima volta (ou o próximo evento) re-tenta.
      }
    } finally {
      this.running = false
      this.arm()
    }
  }
}
