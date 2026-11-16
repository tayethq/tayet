// Slack emoji names ↔ characters (ADR-087 dec. 6; PLANO-AGENTES §0.3.12). The table is generated from
// the iamcal set (slack/emoji-table.ts, scripts/gen-emoji.mjs); this module holds the rules of code:
// - `name::skin-tone-N` (N 2–6) = the base character (its U+FE0F dropped) + the Fitzpatrick modifier;
// - a name may come wrapped in colons (`:thumbsup:`), as people paste it;
// - the reverse (a reaction read back) is the first name of the character in the preset (👍 → `+1`),
//   U+FE0F ignored on both sides; base + modifier → `base::skin-tone-N`. A character with no name (a
//   multi-person skin sequence, an emoji newer than the table) stays the character.
import { EMOJI_ALIASES, EMOJI_TABLE } from './emoji-table'

const VS16 = /️/g
const SKIN = /^(.+)::skin-tone-([2-6])$/
// U+1F3FB … U+1F3FF, as skin-tone-2 … skin-tone-6.
const MODIFIERS = ['\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}'] as const

const bare = (s: string): string => s.replace(VS16, '')

const REVERSE: ReadonlyMap<string, string> = (() => {
  const out = new Map<string, string>()
  for (const [name, char] of Object.entries(EMOJI_TABLE)) {
    if (!EMOJI_ALIASES.has(name)) out.set(bare(char), name)
  }
  return out
})()

const lookup = (name: string): string | undefined => (Object.hasOwn(EMOJI_TABLE, name) ? EMOJI_TABLE[name] : undefined)

// A Slack name → the character, or undefined (unknown).
export function emojiOf(raw: string): string | undefined {
  const name = raw.length > 2 && raw.startsWith(':') && raw.endsWith(':') ? raw.slice(1, -1) : raw
  const skin = SKIN.exec(name)
  if (skin !== null) {
    const base = lookup(skin[1] as string)
    if (base === undefined) return undefined
    return bare(base) + MODIFIERS[Number(skin[2]) - 2]
  }
  return lookup(name)
}

// A character → its Slack name; a character with no name stays itself.
export function nameOf(char: string): string {
  const key = bare(char)
  const direct = REVERSE.get(key)
  if (direct !== undefined) return direct
  const last = String.fromCodePoint(key.codePointAt(key.length - 2) ?? 0)
  const tone = MODIFIERS.indexOf(last as (typeof MODIFIERS)[number])
  if (tone >= 0 && key.length > 2) {
    const base = REVERSE.get(key.slice(0, -2))
    if (base !== undefined) return `${base}::skin-tone-${tone + 2}`
  }
  return char
}

// What a reaction's `name` may also be: the character itself (one grapheme, an emoji).
const EMOJI_CHAR = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?⃣)/u
export function isEmojiChar(s: string): boolean {
  if (s.length === 0 || s.length > 32 || /[\s:]/.test(s)) return false
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)]
  return graphemes.length === 1 && EMOJI_CHAR.test(s)
}
