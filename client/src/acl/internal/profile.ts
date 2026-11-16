import type { OrgFields } from '@tayet/shared'

// The editable profile layer persisted in account data (ADR-040). Pure helpers — no SDK, no protocol
// object — so they are unit-testable without the live stack. matrix-client wires them to
// getAccountData/setAccountData. The account-data KEY is a protocol detail and NEVER crosses the
// acl/index.ts barrel (asserted by the leak-scan + the boundary unit). Mirrors acknowledged-devices.ts.

// Custom account-data key (per-account, synced across devices). Internal to the ACL. New namespace
// io.tayet.* (the legacy acknowledged-devices key is still read — see acknowledged-devices).
export const PROFILE_KEY = 'io.tayet.profile'

// Chave de PERFIL ESTENDIDO (MSC4133) — NÃO account-data. Sink distinto de PROFILE_KEY: legível por
// outros (mesma visibilidade de displayName/avatar), confinada à ACL como todo detalhe de protocolo.
export const PRONOUNS_KEY = 'io.tayet.pronouns'

// ADR-053: recado auto-autorado ("Recado" na UI). Mesmo sink dos pronomes — perfil estendido,
// classe (c) do ADR-042, NÃO classe nova. Legível por quem compartilha sala (ADR-052). O literal
// fica confinado aqui, como o PRONOUNS_KEY; só o valor string cruza o barrel (8.P5).
export const NOTE_KEY = 'io.tayet.note'

// ADR-054: a camada ORGANIZACIONAL. MESMO sink dos pronomes e do recado — perfil estendido MSC4133,
// classe (c) do ADR-042, NÃO classe de storage nova. O que muda não é o sink, é QUEM escreve: estas
// três chaves são escritas FORA do cliente, pelo sync de diretório out-of-band que roda no `up` do
// provisionador (writer admin efêmero pela client-API). O cliente é READER PURO.
//
// Não existe — e não deve passar a existir — nenhum verbo de escrita para estas chaves na ACL. O
// updateMyProfile não as aceita, e isso é invariante de TIPO (ADR-054 dec. 3), guardado por teste de
// fronteira executável. Ausência da chave no documento = ausência declarada: o sync APAGA a chave
// quando o campo vem vazio no diretório, em vez de gravar '' (provado no read-back do PR-1).
export const ORG_FULL_NAME_KEY = 'io.tayet.full_name'
export const ORG_JOB_TITLE_KEY = 'io.tayet.job_title'
export const ORG_WORK_EMAIL_KEY = 'io.tayet.work_email'

// ADR-054: extrai a camada organizacional de um documento de perfil estendido já buscado — helper
// PURO, sem SDK e sem requisição própria: quem chama já tem o documento em mãos (a mesma volta que
// traz pronomes e recado), então ler a camada org custa zero.
//
// Duas regras, ambas asseridas por teste:
//  1. Cada campo usa a MESMA guarda dos pronomes — não-string ou '' vira ausente, nunca ''.
//  2. O objeto SÓ existe se ao menos um dos três campos sobreviver à guarda. Nenhum → undefined, e
//     nunca um `{ authority: 'directory' }` vazio: um objeto vazio afirmaria que a pessoa está no
//     diretório sem nenhum atributo, que é falso — ela não está.
//
// authority é sempre 'directory' aqui porque o diretório é o único writer; ver o comentário do tipo
// OrgFields sobre por que isso é autoridade pretendida, não prova de origem.
export function readOrgFields(ext: Record<string, unknown>): OrgFields | undefined {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)
  const fullName = str(ext[ORG_FULL_NAME_KEY])
  const jobTitle = str(ext[ORG_JOB_TITLE_KEY])
  const workEmail = str(ext[ORG_WORK_EMAIL_KEY])
  if (fullName === undefined && jobTitle === undefined && workEmail === undefined) return undefined
  // só as chaves presentes entram — o campo ausente não existe no objeto, não é `undefined` explícito
  return {
    authority: 'directory',
    ...(fullName !== undefined && { fullName }),
    ...(jobTitle !== undefined && { jobTitle }),
    ...(workEmail !== undefined && { workEmail }),
  }
}

interface ProfileContent {
  fullName?: unknown
  nickname?: unknown
}

// Read the persisted profile from raw account-data content. Tolerant of absent/malformed content (a
// virgin account has no such event): anything non-string is dropped; an empty nickname is treated as
// absent (the cleared state).
export function readProfile(content: unknown): { fullName?: string; nickname?: string } {
  const c = content as ProfileContent | null | undefined
  const fullName = typeof c?.fullName === 'string' && c.fullName.length > 0 ? c.fullName : undefined
  const nickname = typeof c?.nickname === 'string' && c.nickname.length > 0 ? c.nickname : undefined
  return { fullName, nickname }
}

// Read-union-write (ADR-018 §4 idiom): merge fullName + nickname into the persisted content, preserving
// any unknown/future fields. nickname empty/absent → the key is removed (the cleared state). Account data
// is last-write-wins per key; the single writer (the operator) makes a lost race inert. The caller
// re-reads immediately before writing. NB: pronomes NÃO persiste aqui — vive no perfil estendido
// (MSC4133, PRONOUNS_KEY), sink distinto; este merge preserva campos futuros, mas pronomes não é um deles.
export function writeProfile(
  content: unknown,
  next: { fullName: string; nickname?: string },
): Record<string, unknown> {
  const base: Record<string, unknown> =
    content && typeof content === 'object' ? { ...(content as Record<string, unknown>) } : {}
  base.fullName = next.fullName
  const nick = next.nickname?.trim()
  if (nick && nick.length > 0) base.nickname = nick
  else delete base.nickname
  return base
}
