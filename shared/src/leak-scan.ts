// Shared protocol-leak scanner. Used by BOTH P1 gates of this slice:
//  1. the ACL↔Synapse integration test (scan domain objects crossing the barrel), and
//  2. the DOM render-scan (scan the rendered UI text — P1 on the user's screen).
//
// ADR-008 subtlety (load-bearing): the runtime value of a domain id (ChannelId/UserId/
// MessageId) IS the protocol id, branded — that is the *accepted residual*, defended by
// opacity (the id is never parsed and never shown). So an id field carrying `!room:server`
// is NOT a leak. The scanner therefore SKIPS the opaque-id keys and asserts everything else
// (names, topics, display names, message text, device names…) is free of protocol shapes.
// The DOM render-scan closes the loop: it proves those opaque ids never reach the screen.
//
// Lives in @tayet/shared (`@tayet/shared/leak-scan`, ADR-088): the client's gates import it, and the
// sidecar runs it over its API output (ADR-087 dec. 4).

export interface ProtocolPattern {
  name: string
  re: RegExp
}

export const PROTOCOL_PATTERNS: ProtocolPattern[] = [
  { name: 'mxid', re: /@[A-Za-z0-9._=/+-]+:[A-Za-z0-9.-]+/ }, // @user:server
  { name: 'room-id', re: /![A-Za-z0-9._=/+-]+:[A-Za-z0-9.-]+/ }, // !room:server
  { name: 'mxc-uri', re: /mxc:\/\// }, // unresolved media URI
  { name: 'state-event', re: /\bm\.room\.[a-z_.]+/ }, // m.room.* protocol event type
  // Thread relation vocabulary (PLANO-FASE-1-THREADS §5): a leaked `m.thread` or `rel_type`
  // means the relation envelope crossed the barrel instead of being translated to threadParent.
  // The opaque threadParent id (a `$event`/`!room` shape) is skipped by OPAQUE_ID_KEYS, so these
  // patterns only fire on genuine protocol-relation leakage.
  { name: 'thread-rel', re: /\bm\.thread\b/ },
  { name: 'rel-type', re: /\brel_type\b/ },
  // Rich-content envelope vocabulary (PLANO-FASE-1-EDICAO-RICA §5.1): a leaked `formatted_body`
  // or the `org.matrix.custom.html` format literal means the HTML envelope crossed the barrel
  // instead of being translated to the structured RichDoc. RichDoc nodes carry only product
  // vocabulary (t/text/children/href/items/lang), so these only fire on genuine protocol leakage.
  { name: 'formatted-body', re: /\bformatted_body\b/ },
  { name: 'matrix-html-format', re: /org\.matrix\.custom\.html/ },
  // Reply vocabulary (PLANO-FASE-1-REPLY §5.1): a leaked `m.in_reply_to` means the reply envelope
  // crossed the barrel instead of being translated to replyTo; a leaked `mx-reply` means the
  // legacy fallback wrapper survived the HARD_DROP into the domain or the rendered DOM.
  { name: 'in-reply-to', re: /\bm\.in_reply_to\b/ },
  { name: 'mx-reply', re: /mx-reply/ },
  // Crypto vocabulary (Fase 2 — ADR-015 item 3 / PLANO-FASE-2 §4.6): none of this may reach a
  // domain object or the DOM — the `unavailable` placeholder is the prime target. Note
  // `m.room.encrypted` is already covered by the m.room.* pattern above. Word-bounded so that
  // ordinary prose (e.g. "Stockholm") cannot false-positive.
  { name: 'unverified', re: /\bunverified\b/i },
  // Stem, not the bare verb (PLANO-FASE-2-MEDIA §3.4): catches verified/verifying/verification
  // too. Under P1/ADR-014 no verification copy is legitimate, so the stem cannot false-positive
  // on the product surface.
  { name: 'verify', re: /\bverif\w*\b/i },
  { name: 'session-key', re: /\bsession key\b/i },
  { name: 'megolm', re: /\bmegolm\b/i },
  { name: 'olm', re: /\bolm\b/i },
  // Custody/recovery vocabulary (fatia C2 — PLANO-FASE-2-ESCROW-C2 §3.5): the automatic
  // bootstrap/recovery is invisible by construction (ADR-013/014) — none of its vocabulary may
  // reach a domain object or the DOM. The bootstrap creates NO UI element, so the scan proves
  // absence, not copy. Word-bounded, same trade as the crypto set above.
  { name: 'escrow', re: /\bescrow\b/i },
  { name: 'key-backup', re: /\bkey backup\b/i },
  { name: 'secret-storage', re: /\bsecret storage\b/i },
  // Presence vocabulary (ADR-056 norm 3): the protocol event type and the sync knob are the
  // only two presence strings that are protocol, not product — `presence`/`away`/`Ausente` are
  // legitimate product vocabulary (data-presence in the DOM, plain labels) and MUST NOT match.
  // The dotted/underscored forms are unambiguous, so no false-positive trade exists here.
  { name: 'm-presence', re: /\bm\.presence\b/ },
  { name: 'set-presence', re: /\bset_presence\b/ },
  // Decryption-failure vocabulary (ADR-057 dec. 7/8 — PR-1 do track CRIPTO-COBERTURA): the ACL
  // now READS the SDK's decryption-failure reason instead of discarding it, so the failure-code
  // literals (MEGOLM_* / OLM_* / HISTORICAL_MESSAGE_* / sender-trust codes / UNKNOWN_ERROR) and
  // the decrypt* stem become live leak targets. What legitimately crosses the barrel is the
  // graduated product field `arrival` ('awaited'/'stalled') — product words that must NOT match
  // (negative test in decrypt-cycle). The stem takes the same trade as `verif*` above: under
  // P1 no decryption copy is ever legitimate on the product surface.
  { name: 'decrypt', re: /\bdecrypt\w*\b/i },
  {
    name: 'decryption-failure-code',
    re: /\b(?:MEGOLM_|OLM_|HISTORICAL_MESSAGE_|SENDER_IDENTITY_|UNSIGNED_SENDER_|UNKNOWN_SENDER_)[A-Z_]+\b|\bUNKNOWN_ERROR\b/,
  },
  // Identidade estrutural de custódia (ADR-057 dec. 2 — PR-4 do track CRIPTO-COBERTURA): o P1 se
  // estende a "infra invisível". O cofre é membro de TODA sala cifrada, então o localpart tem
  // caminho para a tela por várias vias (roster, nome de DM, contador, autor de timeline) — e o
  // produto não tem vocabulário para explicá-lo. A ocultação é feita nos choke points da ACL
  // (getMembers / member.changed / roomToChannel); este padrão é a rede que prova que funcionou.
  //
  // Nota de falso positivo (aceita, NÃO afrouxada): `cofre` é palavra comum em PT e um usuário pode
  // legitimamente escrever "cofre" numa mensagem ou tópico. O padrão fica word-bounded e o teste que
  // o exercita controla o conteúdo. Zero ocorrências em client/src e client/test hoje (verificado
  // por grep antes de introduzir), então o padrão nasce sem dívida. Se um dia uma cópia de produto
  // precisar da palavra, a saída é renomear a identidade — nunca relaxar o padrão.
  { name: 'custody-identity', re: /\bcofre\b/i },
  // Sessão perdida (ADR-059 D1): a ACL escuta o evento de logout do SDK e o traduz no onSessionLost
  // payload-free. O nome do enum e o literal do evento são vocabulário de SDK; nenhum dos dois pode
  // chegar a um objeto de domínio ou ao DOM.
  { name: 'http-api-event', re: /\bHttpApiEvent\b/ },
  { name: 'session-logged-out', re: /\bSession\.logged_out\b/ },
  // Localpart opaco (ADR-083 dec. 1): `u-` + 12 de base32 minúsculo, o alfabeto de randomLocalpart
  // em escrow/src/people.ts. É id, e o nome que a pessoa vê é sempre o displayname.
  { name: 'opaque-localpart', re: /\bu-[a-z2-7]{12}\b/ },
  // Localpart reservado de agente (ADR-086, Proposto, dec. 1/2): `a-` + 12 de base32 minúsculo,
  // irmão do `u-`. Também é id; o nome exibido é o displayname.
  { name: 'agent-localpart', re: /\ba-[a-z2-7]{12}\b/ },
  // Id de evento (ADR-087 dec. 4, ADR-089 dec. 2): `$` + 43 de base64url, o hash de referência das
  // salas v4+. Sem continuação, para não casar um prefixo de algo maior. Os ids de evento de domínio
  // (`id`, `messageId`, `threadParent`, `replyTo`) ficam sob OPAQUE_ID_KEYS (residual do ADR-008);
  // na borda do sidecar os ids saem tokenizados, então um `$…` ali só pode ser vazamento.
  { name: 'event-id', re: /\$[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/ },
]

// Object KEYS that would only appear if a protocol envelope (not the translated RichDoc) crossed
// the barrel. Checked structurally during the walk, so they fire even when the VALUE is innocuous
// (e.g. an empty `format` string). The domain/RichDoc shape uses none of these.
// NOTE: `msgtype` is deliberately NOT here — the branded `unsupported` body legitimately carries a
// `shape.msgtype` descriptor (ADR-007 §3, shape-only, no payload). These keys appear in NO domain
// object, only in a raw Matrix content envelope.
export const ENVELOPE_KEYS = new Set([
  'format',
  'formatted_body',
  'm.relates_to',
  'm.new_content',
  'm.in_reply_to',
])

// Keys whose values are opaque domain ids (ADR-008 residual) — allowed to be protocol-shaped.
// `user` appears as a UserId on stream events (member.changed); when it instead holds a User
// OBJECT (getMembers), the walker recurses into it regardless, so display names are still scanned.
export const OPAQUE_ID_KEYS = new Set([
  'id',
  'channelId',
  'messageId',
  'author',
  'threadParent',
  'user',
  // ADR-018: `access` on account.newAccess is an AccessId — a branded DeviceId, so its runtime
  // value carries protocol shape (ADR-008 residual), exactly like `threadParent`/`user`. The UI
  // returns it opaque to acknowledgeAccess and never renders it (proven by the DOM render-scan).
  'access',
  // PLANO-PRESENCA §8.4 item 9: `peer` on a DM Channel is a UserId — mxid-shaped at runtime
  // (ADR-008 residual), exactly like `user`/`author`. Opaque by contract: never parsed, never
  // rendered (the DM line shows Channel.name; the scanner keeps covering name/topic/displayName).
  'peer',
  // ADR-089 dec. 2: `replyTo` on a Message is a MessageId — at runtime the target's event id (or
  // the txn of an own send), the exact mirror of `threadParent`. Opaque by contract, never rendered.
  'replyTo',
  // ADR-089 dec. 3: `mentions` on a Message is a UserId[] — mxid-shaped at runtime, like `author`.
  // Every STRING element of an array inherits its array's key (walker below), so the elements are
  // opaque; an object inside the array is still scanned with no key.
  'mentions',
  // PLANO-AGENTES §0.3.23 item 10: `agent` on an AgentPanel, an AgentCommand and a Message's `command` is a
  // UserId — mxid-shaped at runtime, like `author`. No domain object carries free text under `agent` (the
  // portrait's `authorAt.agent` is a boolean, never walked as a string).
  'agent',
  // ADR-094 (Proposto) dec. 1: `participants` on a group Channel is a UserId[] — mxid-shaped at runtime, like
  // `peer`. Every string element inherits the array's key (walker below), so the ids are opaque; the group's
  // display text lives in `name`, which the scanner keeps covering. Opaque by contract: never parsed, never
  // rendered.
  'participants',
])

// EncryptedFile-envelope keys (PLANO-FASE-2-MEDIA §2/§3.4 — ADR-016): the envelope
// (key JWK/iv/hashes/v) is ACL-internal and never crosses the barrel nor reaches the DOM.
// `key_ops` (the WebCrypto JWK field) is unambiguous and fires ALONE; `iv`/`hashes`/`v` are
// individually plausible product words, so they fire only by CO-OCCURRENCE (2+ together =
// the envelope shape). Same conservative zero-false-positive trade as the base rules.
const ENVELOPE_ANCHOR_KEY = 'key_ops'
const ENVELOPE_COOCCURRING_KEYS = ['iv', 'hashes', 'v'] as const

function envelopeKeyHits(keys: readonly string[]): string[] {
  const generic = ENVELOPE_COOCCURRING_KEYS.filter((k) => keys.includes(k))
  if (keys.includes(ENVELOPE_ANCHOR_KEY)) return [ENVELOPE_ANCHOR_KEY, ...generic]
  return generic.length >= 2 ? generic : []
}

export interface Leak {
  path: string
  pattern: string
  value: string
}

// The id shapes of the protocol (ADR-089 dec. 1): what the sidecar's edge still scans in the user's
// content (`text`, `rich`, file name), where the vocabulary patterns would fire on ordinary prose.
const ID_SHAPE_NAMES = new Set(['mxid', 'room-id', 'event-id', 'mxc-uri'])
export const ID_SHAPE_PATTERNS: readonly ProtocolPattern[] = PROTOCOL_PATTERNS.filter((p) => ID_SHAPE_NAMES.has(p.name))

// `patterns` defaults to the full set; the envelope-key checks (structural) always run.
export function findProtocolLeaks(
  root: unknown,
  opaqueKeys: ReadonlySet<string> = OPAQUE_ID_KEYS,
  patterns: readonly ProtocolPattern[] = PROTOCOL_PATTERNS,
): Leak[] {
  const leaks: Leak[] = []
  const walk = (v: unknown, path: string, key: string | undefined): void => {
    if (typeof v === 'string') {
      if (key !== undefined && opaqueKeys.has(key)) return // ADR-008 residual: allowed
      for (const { name, re } of patterns) {
        if (re.test(v)) leaks.push({ path, pattern: name, value: v })
      }
    } else if (Array.isArray(v)) {
      // ADR-089 dec. 3: a string element inherits the array's key (an opaque key covers its id
      // list); an object/array element is walked with no key, so nothing inside it is exempt.
      v.forEach((x, i) => walk(x, `${path}[${i}]`, typeof x === 'string' ? key : undefined))
    } else if (v && typeof v === 'object') {
      const keys = Object.keys(v)
      // EncryptedFile-envelope shape on a single object (anchor key, or 2+ co-occurring keys).
      const envHits = envelopeKeyHits(keys)
      if (envHits.length > 0) {
        leaks.push({ path, pattern: 'encrypted-file-envelope', value: envHits.join('+') })
      }
      for (const [k, val] of Object.entries(v)) {
        // A protocol-envelope KEY is itself a leak — the structured domain/RichDoc shape uses none.
        if (ENVELOPE_KEYS.has(k)) leaks.push({ path: `${path}.${k}`, pattern: 'envelope-key', value: k })
        walk(val, `${path}.${k}`, k)
      }
    }
  }
  walk(root, '$', undefined)
  return leaks
}

// Scan free text (e.g. rendered DOM text content) where there are no id keys to skip.
export function findProtocolLeaksInText(text: string): Leak[] {
  const leaks: Leak[] = []
  for (const { name, re } of PROTOCOL_PATTERNS) {
    const m = re.exec(text)
    if (m) leaks.push({ path: '$', pattern: name, value: m[0] })
  }
  // EncryptedFile-envelope vocabulary in rendered text — same anchor/co-occurrence rule as the
  // structural walk (a serialized envelope leaking into the DOM carries the tokens as words).
  // Case-sensitive on purpose: the JSON keys are lowercase, and `IV`/`V` (roman numerals,
  // initialisms) must not false-positive.
  const tokens = [ENVELOPE_ANCHOR_KEY, ...ENVELOPE_COOCCURRING_KEYS].filter((k) =>
    new RegExp(String.raw`\b${k}\b`).test(text),
  )
  const envHits = envelopeKeyHits(tokens)
  if (envHits.length > 0) leaks.push({ path: '$', pattern: 'encrypted-file-envelope', value: envHits.join('+') })
  return leaks
}
