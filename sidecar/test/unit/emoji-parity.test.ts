import { describe, it, expect } from 'vitest'
import { isEmojiChar } from '../../src/api/slack/emoji'
import { isEmojiArgument } from '../../src/api/emoji'

// The two emoji checkers side by side (PLANO-AGENTES §0.3.16 item 14; A3-4, §8.35): `isEmojiChar` (the
// Slack layer's: is a reaction's `name` the character itself?) and `isEmojiArgument` (the native API's and
// the MCP's: is the argument acceptable?). They are two checkers by design, not a copy; this table pins
// where they agree and where they differ, and the differences are INTENTIONAL:
// - one emoji grapheme (Slack) × a free argument (native): text, a letter, two emoji pass natively only — the
//   native API reacts with what it is given; the Slack layer only takes the character as an alternative to
//   a name;
// - `:name:` is the Slack layer's, through its name table (emojiOf), outside isEmojiChar; the native API
//   refuses it; neither checker takes it;
// - the limits are counted differently — 32 UTF-16 units (Slack) × 64 bytes (native) — and neither bites a
//   real single emoji: the longest one in the table (a kiss with two skin tones, 35 bytes) passes both; 33
//   ASCII bytes differ only by the grapheme rule; 65 bytes fail both.
// A row that moves is a decision, not a fix: change the table and the §8 record together.

const ROWS: ReadonlyArray<[what: string, input: string, slack: boolean, native: boolean]> = [
  ['simple emoji', '👍', true, true],
  ['emoji with VS16', '❤️', true, true],
  ['emoji with a skin tone', '👍🏽', true, true],
  ['flag', '🇧🇷', true, true],
  ['keycap', '1️⃣', true, true],
  ['ZWJ sequence', '👩‍💻', true, true],
  ['longest single emoji (35 bytes)', '👩🏻‍❤️‍💋‍👨🏼', true, true],
  [':name:', ':thumbsup:', false, false],
  ['text', 'ok', false, true],
  ['one letter', 'a', false, true],
  ['two emoji', '👍👍', false, true],
  ['empty', '', false, false],
  ['space', ' ', false, false],
  ['emoji + space', '👍 ', false, false],
  ['control character', '\u0007', false, false],
  ['33 bytes', 'x'.repeat(33), false, true],
  ['65 bytes', 'x'.repeat(65), false, false],
]

describe('emoji parity — isEmojiChar × isEmojiArgument', () => {
  it.each(ROWS)('%s', (_what, input, slack, native) => {
    expect([isEmojiChar(input), isEmojiArgument(input)]).toEqual([slack, native])
  })

  it('the divergences are exactly the intentional ones (grapheme × free argument)', () => {
    const differ = ROWS.filter(([, input]) => isEmojiChar(input) !== isEmojiArgument(input)).map(([what]) => what)
    expect(differ).toEqual(['text', 'one letter', 'two emoji', '33 bytes'])
    // Every divergence goes one way: what the Slack layer takes, the native API takes too.
    for (const [, input] of ROWS) if (isEmojiChar(input)) expect(isEmojiArgument(input)).toBe(true)
  })

  it('the longest single emoji is over 32 bytes and still one grapheme under 32 UTF-16 units', () => {
    const kiss = '👩🏻‍❤️‍💋‍👨🏼'
    expect(Buffer.byteLength(kiss, 'utf8')).toBe(35)
    expect(kiss.length).toBeLessThanOrEqual(32)
  })
})
