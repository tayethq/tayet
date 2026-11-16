// An `actions` block → the approval card (ADR-087 dec. 6; ADR-091; PLANO-AGENTES §0.3.16 item 14, §0.3.17;
// A3-4). Pure: the block is read here, the send is the ApprovalFacade's (slack/chat.ts).
//
// - At most ONE `actions` block per call (a second → `invalid_blocks`); it is read even when the call has
//   `text` (the text is then the card's request).
// - Elements: a `button` with no `url` is an option (`text.text` → label, `style` primary|danger → style);
//   a `button` with a `url` is dropped (`blocks_unsupported:button_url`); any other element is dropped
//   (`blocks_unsupported:<type>`); a button's `confirm` is ignored (`blocks_unsupported:confirm`). No button
//   left → no card: an ordinary message, with the warnings.
// - `invalid_blocks`: more than 3 buttons; a label empty or over 75 characters; an `action_id` or a
//   `block_id` over 255; a `value` over 2,000; a repeated `action_id`.
// - More than one `primary`: the first stays, the others become secondary (`approval_primary_demoted`).
// - The option ids (the §0.3.16 item 14 erratum): every button's `action_id` matches the option rule
//   (`[a-z0-9_-]{1,32}`) → the ids are the `action_id`s; one does not match or is missing → ALL become
//   positional (`b1`, `b2`, `b3`). A button with no `action_id` gets a minted one (opaque, kept per card in
//   slack-cards.json), which is what the click returns; a missing `block_id` is minted the same way.
import { randomBytes } from 'node:crypto'
import { APPROVAL_LABEL_MAX, APPROVAL_MAX_OPTIONS, APPROVAL_OPTION_ID } from '../../core/approval-limits'
import { SlackError } from './errors'

export const ACTION_ID_MAX = 255
export const BLOCK_ID_MAX = 255
export const VALUE_MAX = 2_000

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const string = (v: unknown): string => (typeof v === 'string' ? v : '')

// One option of the card, with what the click gives back.
export interface CardButton {
  option: { id: string; label: string; style?: 'primary' | 'danger' }
  action_id: string
  value?: string
}

export interface CardSpec {
  block_id: string
  buttons: CardButton[]
}

export interface ActionsRead {
  // The blocks that are not `actions` (flattened as the request when the call has no `text`).
  rest: unknown[]
  // Whether the call had an `actions` block at all.
  present: boolean
  // The card; absent when no button was left.
  card?: CardSpec
  warnings: string[]
}

// Slack-like opaque ids (hex: no id shape, no word of the deny list can come out of it).
export const mintId = (): string => randomBytes(4).toString('hex')

// A minted action_id unique on the card (never one the agent gave).
function fresh(seen: Set<string>): string {
  let id = mintId()
  while (seen.has(id)) id = mintId()
  seen.add(id)
  return id
}

const invalid = (): never => {
  throw new SlackError('invalid_blocks')
}

export function readActions(blocks: readonly unknown[]): ActionsRead {
  const rest: unknown[] = []
  const found: Obj[] = []
  for (const raw of blocks) {
    const b = obj(raw)
    if (b?.type === 'actions') found.push(b)
    else rest.push(raw)
  }
  const block = found[0]
  if (block === undefined) return { rest, present: false, warnings: [] }
  if (found.length > 1) invalid()
  const warnings: string[] = []
  const warn = (w: string): void => {
    if (!warnings.includes(w)) warnings.push(w)
  }
  const blockId = string(block.block_id)
  if (blockId.length > BLOCK_ID_MAX) invalid()

  interface Raw {
    label: string
    style?: 'primary' | 'danger'
    actionId?: string
    value?: string
  }
  const raws: Raw[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(block.elements) ? block.elements : []) {
    const e = obj(item)
    const type = string(e?.type)
    if (e === undefined || type !== 'button') {
      warn(`blocks_unsupported:${type || 'unknown'}`)
      continue
    }
    if (string(e.url) !== '') {
      warn('blocks_unsupported:button_url')
      continue
    }
    if (e.confirm !== undefined) warn('blocks_unsupported:confirm')
    const label = string(obj(e.text)?.text)
    if (label.trim() === '' || [...label].length > APPROVAL_LABEL_MAX) invalid()
    const actionId = string(e.action_id)
    if (actionId.length > ACTION_ID_MAX) invalid()
    if (actionId !== '') {
      if (seen.has(actionId)) invalid()
      seen.add(actionId)
    }
    const value = typeof e.value === 'string' ? e.value : undefined
    if (value !== undefined && value.length > VALUE_MAX) invalid()
    const style = e.style === 'primary' || e.style === 'danger' ? e.style : undefined
    raws.push({ label, ...(style !== undefined && { style }), ...(actionId !== '' && { actionId }), ...(value !== undefined && { value }) })
  }
  if (raws.length > APPROVAL_MAX_OPTIONS) invalid()
  if (raws.length === 0) return { rest, present: true, warnings }

  let primary = false
  for (const r of raws) {
    if (r.style !== 'primary') continue
    if (!primary) primary = true
    else {
      delete r.style
      warn('approval_primary_demoted')
    }
  }
  const direct = raws.every((r) => r.actionId !== undefined && APPROVAL_OPTION_ID.test(r.actionId))
  const buttons = raws.map((r, i): CardButton => ({
    option: { id: direct ? (r.actionId as string) : `b${i + 1}`, label: r.label, ...(r.style !== undefined && { style: r.style }) },
    action_id: r.actionId ?? fresh(seen),
    ...(r.value !== undefined && { value: r.value }),
  }))
  return { rest, present: true, card: { block_id: blockId !== '' ? blockId : mintId(), buttons }, warnings }
}
