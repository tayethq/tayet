import type { Brand } from './brand'
import type { ChannelId, UserId, MessageId, DeviceId, MediaRef, FormId } from './ids'
import type { RichDoc } from './rich'

// Domain entities — zero protocol terminology (PLANO-FASE-1 §1.2). Power levels, mxids,
// room ids, state events and SDK device sessions never appear here.

export type Timestamp = Brand<number, 'EpochMillis'>

// Never a numeric power level. PL→Role mapping is a lossy translation that lives in the
// ACL (see acl/internal/role-mapping.ts).
export type Role = 'admin' | 'member' | 'guest'

// A roster member's lifecycle state (PLANO-MEMBERSHIP-CANAIS §8.CONVITE). 'active' = a full member;
// 'invited' = added but not yet a member — they become one when they first CONNECT (ADR-044 auto-joins
// on their next /sync), NOT when they log in. The domain word for the Matrix `invite` membership; the
// protocol string stays confined to acl/internal (P1).
export type MemberState = 'active' | 'invited'

// ADR-056: a user's global presence — a per-person fact, not a per-membership one. Three
// states mapping 1:1 to the protocol; unknown collapses to 'offline' (the SDK cannot tell
// them apart and the ratified prototype has exactly three states). The protocol strings
// stay confined to acl/internal (P1).
export type Presence = 'online' | 'away' | 'offline'

// ADR-083: whether a person belongs to the organization. A server fact, never self-authored: 'guest'
// is everyone the organization has not marked. A guest session cannot tell who is who (see kindOf in
// the ACL): it knows it is a guest and reads everyone else as 'member', except agents, recognized by
// the identifier. ADR-086 (Proposto) dec. 2: 'agent' derives from the reserved identifier, below the
// barrel, so every observer sees it, with or without the organization channel.
export type UserKind = 'member' | 'guest' | 'agent'

// ADR-086 (Proposto) dec. 1: the colour of an agent's avatar, chosen by the admin among these ten at
// creation and changed only by the admin (account-access.md §11.1). Each one names a semantic token
// trio (color-agent-<colour>-bg|border|fg); the colour is a product fact, never a protocol value.
export type AgentColor =
  | 'areia'
  | 'petroleo'
  | 'turquesa'
  | 'salvia'
  | 'ocre'
  | 'argila'
  | 'barro'
  | 'malva'
  | 'ardosia'
  | 'grafite'

export interface User {
  id: UserId
  displayName: string
  kind: UserKind
  // ADR-086 (Proposto) dec. 1/3 — present only when kind === 'agent' (convention, the `peer` idiom of
  // Channel: flat and optional so every non-agent User stays byte-identical). The colour is read from
  // the organization channel when it is readable; without it (a guest's session) it falls back to
  // 'areia' — the mark itself never depends on it (it comes from the identifier). `operatorName` is the
  // name of the person who operates the agent, absent when the organization channel is not readable
  // (accepted delta, PLANO-AGENTES §0.1 item 5).
  agentColor?: AgentColor
  operatorName?: string
  // ADR-009: an opaque MediaRef, never a raw mxc:// or an eagerly-resolved URL. Resolve lazily
  // via the barrel's resolveMedia() (e.g. through the useMedia hook).
  avatar?: MediaRef
}

// ADR-083: a line of the organization's people list, read by listPeople. `pending` = invited and not
// connected yet. `kind` is on the user. `self`, like RosterEntry (ADR-081): only the boolean crosses.
export interface Person {
  user: User
  email?: string
  pending: boolean
  self: boolean
}

// ADR-043: a forma de VER o perfil de OUTRO usuário (a sub-tela de perfil-de-outro, Slice 2). Distinto de
// User (identidade enxuta de roster/autor) e de MyProfile (a forma de EDIÇÃO do próprio): UserProfile é
// read-only e enriquece User com o perfil estendido (MSC4133) — pronomes e recado. Resolvido lazy
// por getUserProfile(userId) só quando a tela abre — o estendido NÃO entra em User (não se busca por linha de
// roster). Campo ausente = não informado.
// ADR-054: a camada ORGANIZACIONAL do perfil — os campos que a organização afirma sobre a pessoa
// (nome, cargo, email de trabalho), distintos dos campos auto-autorados (pronomes, recado). Presente
// só quando ao menos um dos três campos existe; ausência do objeto inteiro = a pessoa não está no
// diretório. Campo ausente dentro do objeto = ausência declarada, nunca ''.
//
// `authority` diz de QUEM é a afirmação. Hoje o único writer é o sync de diretório out-of-band, então
// o valor é sempre 'directory'; 'self' existe no tipo porque a forjabilidade está MEDIDA, não suposta:
// a própria pessoa consegue sobrescrever os campos com credencial comum, e o sink não oferece controle
// de acesso por campo. Logo 'directory' é afirmação de AUTORIDADE PRETENDIDA, não prova de origem —
// quem consome não deve tratá-la como verificada. READ-ONLY no cliente: não há verbo de escrita para
// esta camada, e updateMyProfile não a aceita (invariante de tipo, ADR-054 dec. 3).
export interface OrgFields {
  authority: 'self' | 'directory'
  fullName?: string
  jobTitle?: string
  workEmail?: string
}

export interface UserProfile extends User {
  pronouns?: string
  // ADR-053: o recado de OUTRA pessoa ("Recado" na UI), como ela o declarou. Mesmo sink dos pronomes
  // (perfil estendido, classe (c) do ADR-042): legível por quem compartilha sala (ADR-052) — é o que
  // torna o recado de outro visível sem classe de storage nova. Ausente = não informado. Aqui é
  // READ-ONLY: a escrita é do ProfileEditor sobre o MyProfile (self), nunca desta forma.
  note?: string
  // ADR-054: camada organizacional de OUTRA pessoa, lida na MESMA volta dos pronomes/recado (custo
  // zero, nenhuma requisição nova). Ausente = a pessoa não tem linha no diretório.
  org?: OrgFields
}

// ADR-040: a camada de perfil editável do operador. fullName = nome gerido-pela-org (read-only pro
// usuário, snapshot do displayName semeado pelo IdP); nickname = apelido auto-autorado. displayName
// efetivo = nickname || fullName. Distinto de User (que é a identidade enxuta usada em roster/autor):
// MyProfile só serve à sub-tela de edição.
export interface MyProfile {
  fullName: string
  nickname?: string
  // ADR-041: a foto de perfil atual (avatar_url → MediaRef opaco, mesmo mapeador de selfToUser).
  // Opcional: ausente = sem foto (o render cai pro monograma, PR-2). Editável via setAvatar/removeAvatar.
  avatar?: MediaRef
  // ADR-042: pronomes auto-autorados. Distinto de fullName/nickname (account-data): vive no PERFIL
  // ESTENDIDO (MSC4133), globalmente legível por quem compartilha sala — a propriedade que account-data
  // (self-private) não dá. A chave de protocolo fica confinada à ACL (espelha o sink do nickname).
  // Ausente = não informado. Editável via updateMyProfile({ pronouns }); '' limpa. Slice 2 leva ao
  // User de outro; aqui é só self.
  pronouns?: string
  // ADR-053: recado auto-autorado ("Recado" na UI) — o que a pessoa está fazendo, declarado por ela.
  // Mesmo sink dos pronomes (perfil estendido, classe (c) do ADR-042): legível por quem compartilha
  // sala (ADR-052), NÃO é classe de storage nova. Distinto de presença, que é palpite de máquina e
  // está fora deste track por sequenciamento (ADR-053 dec. 6) — recado é complemento, não substituto.
  // Ausente = não informado. Editável via updateMyProfile({ note }); '' limpa. Slice 2 leva ao
  // UserProfile de outro; aqui é só self.
  note?: string
  // ADR-054: a camada organizacional do PRÓPRIO perfil. Presente aqui apesar de esta forma ser a de
  // EDIÇÃO porque é justamente o que NÃO se edita: Cargo e Email aparecem read-only no ProfileEditor,
  // e sem este campo a tela teria que alcançar a ACL por outro caminho. Ler não é escrever —
  // updateMyProfile não aceita nenhum campo de OrgFields (ADR-054 dec. 3). Ausente = sem linha no
  // diretório.
  org?: OrgFields
}

export type UnreadState = { count: number; mentions: number }

// ADR-067: whether a thread has a reply the user has not read, derived in the ACL from receipts with
// the same rule in encrypted and cleartext rooms. A boolean, not a count: the SDK's per-thread count
// stays 0 in an encrypted room until the user has sent a threaded receipt there. An object so it can
// grow additively.
export type ThreadUnread = { unread: boolean }

export interface Channel {
  id: ChannelId
  name: string // "#engineering" without :server, or a DM name
  // ADR-094 (Proposto): 'group' is a conversation of 3 to 9 people with no authored name, marked by a state
  // event of its own; in the list it sits with the direct messages.
  kind: 'public' | 'private' | 'dm' | 'group'
  topic?: string
  memberCount: number
  unread: UnreadState
  // ADR-026: estado de arquivamento (mapeamento interno: state event custom reversível, gated por
  // PL — não destrói a sala nem força leave+forget; alternativas destrutivas rejeitadas no ADR-026).
  // AUSENTE = ativo (não `false` obrigatório): preserva o contrato byte-a-byte para todo canal ativo
  // e todo consumidor que ignore o campo. getChannels() é só-ativos (filtra arquivados);
  // getChannel()/channel.added carregam o campo quando presente.
  archived?: boolean
  // ADR-083: o canal da organização. Entra-se nele só pelo convite de `system`, nunca por addMember.
  org?: boolean
  // PLANO-PRESENCA §8.4 item 9: o interlocutor da DM, traduzido na ACL do inverso do mapa de DMs.
  // Invariantes por convenção + contrato de integração (o idioma do `archived`, não uma união
  // discriminada): `peer` presente sse kind === 'dm'; `peerAvatar` presente ⇒ `peer` presente.
  // Flat e opcionais de propósito — aditivo puro: canal não-dm permanece byte-idêntico e todo
  // literal de teste existente compila intacto. UserId é o residual opaco ADR-008 (nunca parseado,
  // nunca renderizado); MediaRef é o token opaco de mídia (ADR-009).
  peer?: UserId
  peerAvatar?: MediaRef
  // ADR-086 (Proposto): the DM peer is an agent — present only then (`peerAgent` present ⇒ `peer`
  // present). A DM carries no User, so the agent mark of the header, the sidebar row and the
  // notification title travels here (PLANO-AGENTES §0 F1, the DM structural exception). Same
  // colour/operator rule as User.agentColor/operatorName.
  peerAgent?: { color: AgentColor; operatorName?: string }
  // ADR-094 (Proposto) dec. 1 and 4: the people of a group conversation — present if and only if
  // kind === 'group' (possibly empty: a group with nobody else), never the session itself, never the
  // custody or system account. The same list, in display-name order, makes the group's `name`. Omitted (not
  // undefined) on every other kind, in the `archived` idiom. UserId is the opaque ADR-008 residual: never
  // parsed, never rendered. `peer` stays exclusive to a DM.
  participants?: UserId[]
  // PLANO-CONVERSAS §0.3.4 item 1: how many of `participants` are agents — present if and only if
  // kind === 'group' (possibly 0), omitted otherwise, in the `participants` idiom. The list does not
  // hold the members of a conversation that is not selected, so the agent mark of the group's block
  // (workspace.md §22.1 item 3) and the header's count travel here, as the DM's travel in `peerAgent`.
  participantAgents?: number
}

export interface Reaction {
  emoji: string
  count: number
  mine: boolean
}

// Descriptor of an untranslatable concept — shape only, NEVER a payload (no PII, no
// protocol ids). Used by the D3 'unsupported' degradation and by telemetry.
export type UnsupportedShape = { msgtype?: string; eventType: string }

// D3 lives here: content that can't be translated becomes a branded variant, NEVER a raw
// SDK object. The 'unsupported' placeholder is visible in prod (ADR-007 §3: content-carrying
// degradation is never a silent drop).
// ADR-009: image/file carry an opaque MediaRef + safe synchronous metadata (dims/blurhash for
// layout-without-fetch, name/size/mimetype) — never the bytes, never a raw mxc://. Resolution is
// lazy via resolveMedia(). The inbound split (image vs file) is "what to render" — deliberately
// asymmetric with OutgoingBody's single `attachment` (which is "intent"; see acl/types.ts).
// ADR-012: `rich` is an ADDITIVE optional field on the text variant — the post-sanitization
// structured document. `text` stays the plain fallback (the Matrix `body`); the renderer prefers
// `rich` when present and falls back to `text`. Without `rich`, this is byte-for-byte the prior
// text contract — the closed union and its compile-time guard only GAIN an optional field.
// ADR-015: `unavailable` is content whose key is not (yet) available — TRANSIENT by
// contract, distinct from `unsupported` (terminal). NO payload: no protocol error, no session id,
// nothing crosses (P1). It renders as a neutral product placeholder and never blocks the timeline
// (P4). When the content later resolves, the ACL re-emits the real Message via the SAME
// message.edited machine — the message "becomes" its true content; zero new mechanism.
// ADR-057 dec. 7 (PR-1 do track CRIPTO-COBERTURA): `unavailable` gains the graduated product
// discriminador `arrival` — 'awaited' = the content may still arrive by itself ("pode ainda
// chegar"); 'stalled' = it will not arrive through this channel ("não chega por este canal").
// STILL no payload (P1): no protocol error, no session id — `arrival` is a translated product
// grade, never the SDK failure code (that vocabulary dies in acl/internal, dec. 8). 'stalled'
// is NOT a loss verdict: the custody channel (ADR-057 dec. 5/6) may yet deliver. Copy stays
// neutral and transitory. Required (no implicit third state): tsc enumerates every construction
// site.
// PR-5 (ADR-057 dec. 6/7): 'lost' is the DEFINITIVE verdict, and it only exists with proof —
// custody consulted successfully in THIS session of use, the event still undecryptable with a
// 'stalled'-family reason, and its session absent from the import. Without a consult (failure,
// or a boot that never recovers) the grade stays 'stalled'; 'awaited' never turns 'lost'
// directly. Registered trade: a late deposit (residual F11/A5 window) can make a 'lost'
// true-later — the next consult (next access/boot) corrects it via import.
// ADR-091: an approval card — a request an agent puts to the people of a conversation. `text`
// is the plain fallback, `request` the formatted request (the same RichDoc as a text message), `options`
// the card's ORIGINAL choices (an edit never changes them; 1 to 25, at most one 'primary'), `state` what
// the product aggregated from the people's answers (never text the agent wrote — P6). The answer itself
// is never a Message: it folds into the card.
export type MessageBody =
  | { kind: 'text'; text: string; rich?: RichDoc }
  | { kind: 'approval'; text: string; request?: RichDoc; options: ApprovalOption[]; state: ApprovalState }
  | { kind: 'image'; media: MediaRef; alt?: string; width?: number; height?: number; blurhash?: string }
  | { kind: 'file'; media: MediaRef; name: string; size: number; mimetype: string }
  | { kind: 'unsupported'; shape: UnsupportedShape }
  | { kind: 'unavailable'; arrival: 'awaited' | 'stalled' | 'lost' }

// ADR-091: one choice of an approval card. `id` is the agent's own key for the choice (it is
// what the answer carries back); `label` is what the person reads; `style` absent = secondary.
export interface ApprovalOption {
  id: string
  label: string
  style?: 'primary' | 'danger'
}

// ADR-091 dec. 3/6/7/9: the card's state, filled by the ACL. 'open' = no valid answer yet (and
// not closed); 'answered' = the first valid answer in the server's order — `by`/`at` are its author and
// instant, `option` absent while that answer cannot be read yet (it arrives on decrypt); 'closed' = the
// author closed it with no valid answer before. 'sending'/'failed' (A3-2) = the viewer's own answer in
// flight or not sent, folded on a card that is still open — the aggregated state wins over it
// (answered/closed hide it). Every consumer switches on `kind` with no `default`.
export type ApprovalState =
  | { kind: 'open' }
  | { kind: 'sending'; option: string }
  | { kind: 'failed'; option: string }
  | { kind: 'answered'; by: UserId; at: Timestamp; option?: string }
  | { kind: 'closed' }
  // A card that declares how many answers it asks for. `answers` are the answers that count, in the
  // server's order: one per person (that person's first answer that counts), cut at `needed`; `option` is
  // absent while an answer cannot be read yet. The card is complete with `needed` answers; `closed` = its
  // author closed it (a complete card that is then closed stays complete). `own` = the viewer's own answer
  // in flight or not sent, folded in only while the card still takes the viewer's answer.
  | {
      kind: 'multi'
      needed: number
      answers: Array<{ by: UserId; at: Timestamp; option?: string }>
      closed: boolean
      own?: { status: 'sending' | 'failed'; option: string }
    }

// ADR-091 dec. 12 (A3-5): an agent's pinned panel in a conversation — the board the agent keeps
// up to date, shown above the timeline and never a line of it. `agent` is the author, in the idiom of
// Message.author (an opaque UserId; the UI resolves name and colour from the members it holds). `title`
// is optional plain text; `text` is the plain fallback and `rich` the formatted content (the same RichDoc
// as a text message); `updatedAt` is the server instant of the content shown (the author's latest edit,
// else the original). The ACL hands the list filtered (agents that are members, not cleared) and ordered;
// the UI never aggregates.
export interface AgentPanel {
  agent: UserId
  title?: string
  text: string
  rich?: RichDoc
  updatedAt: Timestamp
}

// ADR-093 (Proposto): one `/` command an agent declares in a conversation — the shape of listCommands. `agent`
// is the agent that declares it, in the idiom of Message.author (an opaque UserId; the UI resolves name and
// colour from the members it holds). `name` is the command without the slash (`[a-z0-9][a-z0-9_-]{0,31}`);
// `description` one line of 1 to 100 characters; `hint` the optional argument hint, one line of up to 60.
// The ACL hands the conversation's list flat (only agents that are members, not cleared), ordered by the
// command's name and then the agent's name; the UI never aggregates. The same name under two agents is two
// items.
export interface AgentCommand {
  agent: UserId
  name: string
  description: string
  hint?: string
}

// A choice of a form field. `value` is what the submission carries back; `label` what the person reads.
export interface FormOption {
  value: string
  label: string
  description?: string
}

export interface FormOptionGroup {
  label: string
  options: FormOption[]
}

// A list of choices: flat, or in labelled groups (never both).
export type FormChoices = { options: FormOption[] } | { groups: FormOptionGroup[] }

// What every input field carries. `optional` false = required.
interface FormFieldBase {
  id: string
  label: string
  hint?: string
  optional: boolean
}

// One field of an agent's form. `context` is read-only text (the same formatted subset as a card's body),
// with no value. Number values, bounds and initial travel as decimal text.
export type FormField =
  | (FormFieldBase & { kind: 'text' | 'longText'; placeholder?: string; minLength: number; maxLength: number; initial?: string })
  | (FormFieldBase & { kind: 'email' | 'url'; placeholder?: string; initial?: string })
  | (FormFieldBase & { kind: 'number'; placeholder?: string; decimal: boolean; min?: string; max?: string; initial?: string })
  | (FormFieldBase & { kind: 'date'; placeholder?: string; initial?: string })
  | (FormFieldBase & { kind: 'select'; placeholder?: string; choices: FormChoices; initial?: string })
  | (FormFieldBase & { kind: 'multiSelect'; placeholder?: string; choices: FormChoices; maxSelected?: number; initial?: string[] })
  | (FormFieldBase & { kind: 'radio'; options: FormOption[]; initial?: string })
  | (FormFieldBase & { kind: 'checkboxes'; options: FormOption[]; initial?: string[] })
  | { kind: 'context'; text: string; rich?: RichDoc }

// The values a person submits, by field id: a list only for multiSelect and checkboxes.
export type FormValues = Record<string, string | string[]>

// Why a value was refused before sending, per field. The bounds travel with their codes.
export type FormIssue =
  | { code: 'required' }
  | { code: 'minLength'; min: number }
  | { code: 'maxLength'; max: number }
  | { code: 'email' }
  | { code: 'url' }
  | { code: 'number' }
  | { code: 'range'; min?: string; max?: string }
  | { code: 'date' }
  | { code: 'option' }

// The form's state in this session. 'errors' carries the agent's messages per field id.
export type FormState =
  | { kind: 'open' }
  | { kind: 'sending' }
  | { kind: 'failed' }
  | { kind: 'noAnswer' }
  | { kind: 'errors'; errors: Record<string, string> }
  | { kind: 'done' }

// A form an agent opened for this session: only the session that clicked the card or sent the command
// gets it. `anchor` is the card or the command message; `agent` the author (P6: always identified).
export interface AgentForm {
  id: FormId
  channelId: ChannelId
  agent: UserId
  anchor: MessageId
  title: string
  submitLabel: string
  fields: FormField[]
  state: FormState
}

// ADR-066: reply count + when the latest reply was sent. replyCount ≥ 1 whenever present.
export interface ThreadSummary {
  replyCount: number
  latestReplyAt: Timestamp
}

export interface Message {
  id: MessageId
  channelId: ChannelId
  author: UserId
  body: MessageBody
  sentAt: Timestamp
  editedAt?: Timestamp
  reactions: Reaction[]
  threadParent?: MessageId
  // Reply target — minted by the ACL from the protocol reply relation, the exact mirror of
  // threadParent (PLANO-FASE-1-REPLY §2.2): an optional additive field carrying the target's STABLE
  // opaque MessageId (ADR-010 — for one's own reconciled sends the ACL resolves to the stable id,
  // the txn). Absent = not a reply. The UI only READS this field (ADR-007); it never decides what
  // is a reply.
  replyTo?: MessageId
  // ADR-066: the thread under this message, as a summary — derived in the ACL (the SDK's Thread
  // when it has one, else the server's aggregation on the root), like `reactions`. Absent = no
  // thread. Carries no event id, mxid or relation vocabulary (P1); the per-thread unread marker
  // comes from getThreadUnread, not from here. Updates arrive as message.edited of the root.
  threadSummary?: ThreadSummary
  // ADR-007-clean: computed in the ACL as (sender === session id); a boolean, NOT an identity —
  // it does not cross the barrel and does not touch the ❓2 identity residual. Mirrors Reaction.mine.
  // The UI uses it to scope the edit affordance to one's own messages. Required (not optional) so
  // there is no third "unknown" state: tsc enumerates every construction site.
  mine: boolean
  // ADR-037 (addendum, PR #103): espelha `mine` — booleano derivado na ACL do `m.mentions.user_ids`
  // do próprio evento (na edição, o de `m.new_content`), não do highlight da push-rule.
  // NUNCA carrega mxid/`m.mentions` (P1). Required (sem terceiro estado "desconhecido"): o tsc enumera
  // todo site de construção. `false` para mensagens próprias (sem auto-highlight) e não-menções.
  mentionsMe: boolean
  // ADR-089 dec. 3: the people the message mentions — the same source as `mentionsMe` (the event's
  // `m.mentions.user_ids`; on an edit, `m.new_content`'s), absent when empty and on an unreadable
  // message. P1: UserIds are opaque (ADR-008 residual, mxid-shaped at runtime), never parsed and
  // never rendered — the leak-scan treats every string of this array as opaque (OPAQUE_ID_KEYS).
  // Optional: no client surface reads it; the sidecar's local API hands it out tokenized.
  mentions?: UserId[]
  // ADR-093 (Proposto): the `/` command this message invokes — `agent` (an opaque UserId, also in
  // `mentions`) and `name` (without the slash). Derived in the ACL from the original content (the encrypted
  // command marker names an agent that is in the mentions) and the text shown (it starts with "/name").
  // Absent = not a command. Never checked against the agent's manifest: it records the intent, and the
  // manifest may change later.
  command?: { agent: UserId; name: string }
  // The person who answered a form an agent opened from this message (an approval card, or the person's
  // own command message): the first accepted submission's author and instant. Absent = no accepted
  // answer. Updates arrive as message.edited. Never carries the values.
  formReply?: { by: UserId; at: Timestamp }
  // P6 / ADR-086 dec. 2: a portrait of the author AT THE EVENT — read by the UI only when the author is no
  // longer in the conversation's member map (left, removed). `name` is the explicit display name of the
  // sender's member event at that point (never the SDK's computed name, which falls back to the id — P1);
  // absent when there is none. `agent` comes from kindOf (the reserved prefix, ADR-086 dec. 2); `color` is
  // the agent's colour at translation time, absent for a person or when unreadable.
  authorAt?: { name?: string; agent: boolean; color?: AgentColor }
  // Send lifecycle under optimistic local echo (ADR-010). Absent (or 'sent') for received
  // messages. The id is STABLE across pending→sent — the ACL owns the txn↔event reconciliation,
  // so the UI never re-keys and the bubble never flickers.
  status?: 'pending' | 'sent' | 'failed'
}

export interface Device {
  id: DeviceId
  friendlyName: string
  lastSeen?: Timestamp
  // É ESTE navegador? Booleano self-relativo derivado DENTRO da ACL (device_id === myDeviceId),
  // espelha Message.mine — o device_id cru nunca cruza. Default false fora da lista de getDevices
  // (event-payloads de newAccess/attention são acessos OUTROS). §8.A3 / P1.
  current: boolean
  // trust / cross-signing state → Fase 2; the slot exists from the start.
}
