// Config do agente de custódia — env-only, SEM defaults de produção embutidos (o
// wiring de cada ambiente decide; o dev-stack injeta os seus no compose). Fail-closed
// por construção: QUALQUER item ausente ou malformado derruba o boot antes de tocar
// rede ou disco — em particular AGENT_STORAGE_KEY, sem a qual o crypto store nasceria
// EM CLARO em disco (achado S2.1: `storageKey` é o único knob de cifra do store; a
// identidade do guardião não fica em claro at rest).

export interface AgentConfig {
  hsUrl: string
  tokenFile: string
  escrowUrl: string
  // 32 bytes exatos (contrato do initRustCrypto — S2.1); decodificada aqui para o
  // erro aparecer no boot, não dentro do wasm.
  storageKey: Uint8Array
  storeDir: string
}

function envOrThrow(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]
  if (value === undefined || value === '') throw new Error(`missing env: ${name}`)
  return value
}

export function loadConfig(env: Record<string, string | undefined>): AgentConfig {
  const rawKey = envOrThrow(env, 'AGENT_STORAGE_KEY')
  // Mesma validação de base64 do escrow (parseSecret): Buffer.from é leniente demais
  // para um item fail-closed.
  if (rawKey.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(rawKey)) {
    throw new Error('AGENT_STORAGE_KEY: not valid base64')
  }
  const storageKey = Uint8Array.from(Buffer.from(rawKey, 'base64'))
  if (storageKey.length !== 32) {
    throw new Error(`AGENT_STORAGE_KEY: expected 32 bytes, got ${storageKey.length}`)
  }
  return {
    hsUrl: envOrThrow(env, 'AGENT_HS_URL'),
    tokenFile: envOrThrow(env, 'AGENT_TOKEN_FILE'),
    escrowUrl: envOrThrow(env, 'AGENT_ESCROW_URL'),
    storageKey,
    storeDir: envOrThrow(env, 'AGENT_STORE_DIR'),
  }
}
