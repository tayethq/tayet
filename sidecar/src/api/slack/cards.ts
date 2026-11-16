// The Slack layer's own file of approval cards (PLANO-AGENTES §0.3.17 item 1; A3-4): `<store>/slack-cards.json`,
// what a card's click must give back to a Slack agent — the `action_id`, `block_id` and `value` it posted —
// which the product's card does not carry (its wire format has no Slack dialect) and the core's
// `approvals.json` does not keep (a card leaves it at the seal, before a socket may open to hear it).
//
// - Shape: `{ cards: [{ conversation, id, block_id, actions: [{ option, action_id, value? }], at }] }`; API
//   tokens only (`C…`/`D…` and the card's `ts`), never a protocol id.
// - Written before the chat.postMessage answers (writeJsonAtomic, chained writes: the ApprovalWatch's mold);
//   only the lock holder runs the API, so only it writes. Unreadable → an empty set and one line.
// - An entry leaves when a socket acks the card's `block_actions`, or when the layer itself closes the card
//   (chat.update / response_url). At most 500: the oldest leaves first, with one line.
// - The chains (`aliases`, a list of its own in the same file): a chat.update with buttons that cannot edit
//   the card in place posts a new card, and the first card's `ts` (the chain's origin) then stands for the
//   newest one (the live card). One row per card the layer posted this way: `{ conversation, origin, live,
//   at }`, API tokens only; the live card of an origin is its newest row. A row never leaves on a click's ack.
//   At most 500: the oldest leaves first, with one line. A file without the list reads as an empty one.
// - Lines carry no id: `slack-cards-unreadable`, `slack-card-evicted`, `slack-alias-evicted`,
//   `slack-cards-file-error`.
import { readFile } from 'node:fs/promises'
import { writeJsonAtomic } from '../../store'

type Log = (line: Record<string, unknown>) => void

export const SLACK_CARDS_MAX = 500
export const SLACK_ALIASES_MAX = 500

export interface CardAction {
  option: string
  action_id: string
  value?: string
}

export interface SlackCard {
  conversation: string
  id: string
  block_id: string
  actions: CardAction[]
  at: number
}

// One card of a chain: `live` is a card the layer posted in place of `origin`'s chain.
export interface CardAlias {
  conversation: string
  origin: string
  live: string
  at: number
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function aliasOf(v: unknown): CardAlias | undefined {
  if (!isRecord(v) || typeof v.conversation !== 'string' || typeof v.origin !== 'string' || typeof v.live !== 'string' || typeof v.at !== 'number') return undefined
  return { conversation: v.conversation, origin: v.origin, live: v.live, at: v.at }
}

function cardOf(v: unknown): SlackCard | undefined {
  if (!isRecord(v) || typeof v.conversation !== 'string' || typeof v.id !== 'string' || typeof v.block_id !== 'string' || typeof v.at !== 'number' || !Array.isArray(v.actions)) return undefined
  const actions: CardAction[] = []
  for (const a of v.actions) {
    if (!isRecord(a) || typeof a.option !== 'string' || typeof a.action_id !== 'string' || (a.value !== undefined && typeof a.value !== 'string')) return undefined
    actions.push({ option: a.option, action_id: a.action_id, ...(typeof a.value === 'string' && { value: a.value }) })
  }
  return { conversation: v.conversation, id: v.id, block_id: v.block_id, actions, at: v.at }
}

const keyOf = (conversation: string, id: string): string => `${conversation} ${id}`

export class SlackCards {
  // Insertion order = age (the oldest first).
  private readonly cards = new Map<string, SlackCard>()
  // Insertion order = age (the oldest first).
  private readonly aliases: CardAlias[] = []
  private saving: Promise<void> = Promise.resolve()
  private loading: Promise<void> | null = null

  // `file` absent → memory only (tests without a store).
  constructor(
    private readonly file: string | undefined,
    private readonly log: Log,
    private readonly max = SLACK_CARDS_MAX,
    private readonly aliasMax = SLACK_ALIASES_MAX,
  ) {}

  // Once; every other call waits for it.
  load(): Promise<void> {
    this.loading ??= this.read()
    return this.loading
  }

  private async read(): Promise<void> {
    if (this.file === undefined) return
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log({ evt: 'slack-cards-unreadable' })
      return
    }
    if (!isRecord(raw) || !Array.isArray(raw.cards)) {
      this.log({ evt: 'slack-cards-unreadable' })
      return
    }
    for (const item of raw.cards) {
      const card = cardOf(item)
      if (card !== undefined) this.cards.set(keyOf(card.conversation, card.id), card)
    }
    // A file written before the chains has no list: an empty one.
    if (Array.isArray(raw.aliases)) {
      for (const item of raw.aliases) {
        const alias = aliasOf(item)
        if (alias !== undefined) this.aliases.push(alias)
      }
    }
  }

  get size(): number {
    return this.cards.size
  }

  get(conversation: string, id: string): SlackCard | undefined {
    return this.cards.get(keyOf(conversation, id))
  }

  // On disk before it resolves (the post answers after it).
  async add(card: SlackCard): Promise<void> {
    await this.load()
    this.cards.set(keyOf(card.conversation, card.id), card)
    while (this.cards.size > this.max) {
      const oldest = this.cards.keys().next().value as string
      this.cards.delete(oldest)
      this.log({ evt: 'slack-card-evicted' })
    }
    await this.persist()
  }

  async remove(conversation: string, id: string): Promise<void> {
    await this.load()
    if (!this.cards.delete(keyOf(conversation, id))) return
    await this.persist()
  }

  get aliasCount(): number {
    return this.aliases.length
  }

  // The origin of the chain a card belongs to; a card in no chain is its own origin. Call after load().
  originOf(conversation: string, ts: string): string {
    for (let i = this.aliases.length - 1; i >= 0; i--) {
      const a = this.aliases[i] as CardAlias
      if (a.conversation === conversation && a.live === ts) return a.origin
    }
    return ts
  }

  // The live card of the chain `ts` belongs to (the origin or any card of the chain); `ts` itself otherwise.
  liveOf(conversation: string, ts: string): string {
    const origin = this.originOf(conversation, ts)
    for (let i = this.aliases.length - 1; i >= 0; i--) {
      const a = this.aliases[i] as CardAlias
      if (a.conversation === conversation && a.origin === origin) return a.live
    }
    return ts
  }

  // On disk before it resolves (the update answers after it).
  async alias(alias: CardAlias): Promise<void> {
    await this.load()
    this.aliases.push({ ...alias })
    while (this.aliases.length > this.aliasMax) {
      this.aliases.shift()
      this.log({ evt: 'slack-alias-evicted' })
    }
    await this.persist()
  }

  saved(): Promise<void> {
    return this.saving
  }

  private persist(): Promise<void> {
    const file = this.file
    if (file === undefined) return this.saving
    this.saving = this.saving.then(() => writeJsonAtomic(file, { cards: [...this.cards.values()], aliases: [...this.aliases] })).catch(() => this.log({ evt: 'slack-cards-file-error' }))
    return this.saving
  }
}
