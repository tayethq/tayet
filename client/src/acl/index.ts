// ── The ONE public surface of the ACL (ADR-007). ───────────────────────────────────────
// Everything above the ACL imports from here and nowhere else. Deep-imports into
// acl/internal/** are forbidden by lint; matrix-js-sdk is importable only inside
// acl/internal/. Protocol ids (Mxid/RoomId/EventId) are intentionally NOT exported — they
// never cross this barrel.
// Vocabulary is neutral too (Leitura B, PR #6): exported NAMES carry no Matrix protocol
// terms — `serverUrl`, not `homeserverUrl`; bootstrap config is not an exception. Enforced
// by the barrel-vocabulary selector in eslint.config.js (conservative deny-list; catches
// top-level exported names, not fields inside exported types).

// Domain vocabulary (clean types — no protocol terminology).
export type {
  Brand,
  ChannelId,
  UserId,
  MessageId,
  DeviceId,
  AccessId,
  MediaRef,
  RichInline,
  RichBlock,
  RichDoc,
  Timestamp,
  Role,
  MemberState,
  Presence, // ADR-056: presença global por-pessoa (online/away/offline), consumida pelo dialog no PR-2.
  User,
  UserKind,
  AgentColor, // ADR-086 (Proposto) dec. 1: a cor do avatar de agente, uma das 10.
  Person, // ADR-083: linha da lista de pessoas da organização, a forma de listPeople.
  MyProfile, // ADR-040: camada de perfil editável (fullName da org + nickname auto-autorado), consumida pela UI de "Editar perfil" no PR-2.
  UserProfile, // ADR-043: forma read-only de VER o perfil de OUTRO (User + pronomes), consumida pela sub-tela de perfil-de-outro na Slice 2 PR-2.
  OrgFields, // ADR-054: camada organizacional (nome/cargo/email afirmados pela org), read-only — o writer é o sync out-of-band, não o cliente.
  UnreadState,
  ThreadUnread, // ADR-067: não-lido por thread booleano, derivado de recibos na ACL (mesma regra cifrada/em claro).
  Channel,
  Reaction,
  UnsupportedShape,
  MessageBody,
  AgentPanel, // ADR-091 dec. 12: o painel fixado de um agente numa conversa, a forma de listPanels.
  AgentCommand, // ADR-093 (Proposto): um comando `/` de um agente numa conversa, a forma de listCommands.
  ThreadSummary, // ADR-066: resumo de thread na raiz (contagem + horário da última resposta), derivado na ACL.
  Message,
  Device,
} from '@tayet/shared'

// ACL surface types.
export type {
  NewChannel, // criação de canal (Track U/U3): input do verbo createChannel, consumido pela UI.
  ChannelPatch, // gestão de canal (Track U/U1): input do verbo updateChannel, consumido pela UI.
  RosterEntry, // ADR-081: entrada do roster (pessoa, papel, estado, `self`), a forma de getMembers.
  NewPerson, // ADR-083: input do verbo invitePerson.
  PersonInvite, // ADR-083: resultado de invitePerson, com os canais que falharam.
  NewAgent, // ADR-086: resultado de createAgent (id + credencial exibida uma vez).
  AgentPatch, // ADR-086: input de updateAgent (nome, cor).
  PageCursor,
  Page,
  SearchHit, // ADR-074: resultado da busca local (Message + canal + trecho), consumido pela UI de busca no PR 2.
  Unsubscribe,
  ConnectionState,
  DomainEvent,
  ResetOutcome,
  OutgoingBody,
  SendOpts,
  Resolve,
  MediaVariant,
  ResolvedMedia,
  DataExportOptions, // ADR-096: input of exportMyData; consumed by the export dialog (PLANO-EXPORT-DADOS §0.3.6).
  DataExportPart, // ADR-096: one part of exportMyData's output, synthetic identifiers only.
  AclMode,
  ConceptKind,
  AclTelemetry,
  AclOptions,
  Acl,
} from './types'
export type { OpaqueSession } from './session'

// D3 fail-closed.
export {
  UntranslatableConceptError,
  SessionExpiredError,
  RateLimitedError,
  ConnectionError,
  PersonExistsError,
  PeopleUnavailableError,
  NameInUseError, // ADR-086 dec. 6: nome de agente em uso (criar/renomear) ou apelido igual a nome de agente.
} from '@tayet/shared'

// ADR-094 (Proposto) dec. 7: o máximo de outros participantes de uma conversa em grupo (quem abre não conta).
export { GROUP_MAX_OTHERS } from '@tayet/shared'

// The factory — the only runtime entry point.
export { createAcl } from './create-acl'

// Web login (ADR-032): the OIDC machinery lives in acl/internal (matrix-js-sdk boundary), exposed
// here as NEUTRAL functions. `buildLoginUrl` returns the authorize URL (the app does the redirect);
// `completeLogin` exchanges the callback code and returns the renewable session already serialized as
// an OpaqueSession (the app never sees token structure). No protocol type or vocabulary crosses here.
export { buildLoginUrl, completeLogin } from './internal/oidc'