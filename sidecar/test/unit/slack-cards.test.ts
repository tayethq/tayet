import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SlackCards, type SlackCard } from '../../src/api/slack/cards'

// The Slack layer's own file of approval cards (A3-4; PLANO-AGENTES §0.3.17 item 1): `<store>/slack-cards.json`.

let dir: string
let file: string
let logs: Array<Record<string, unknown>>
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'slack-cards-'))
  file = join(dir, 'slack-cards.json')
  logs = []
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const log = (l: Record<string, unknown>): void => void logs.push(l)
const card = (id: string, over: Partial<SlackCard> = {}): SlackCard => ({
  conversation: 'CGENERALAAA',
  id,
  block_id: 'release',
  actions: [
    { option: 'approve', action_id: 'approve', value: 'v-1' },
    { option: 'reject', action_id: 'reject' },
  ],
  at: 1_732_000_000_000,
  ...over,
})
const onDisk = async (): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'))

describe('SlackCards', () => {
  it('add writes the file (0600, API tokens only) before it resolves; a new instance loads it', async () => {
    const cards = new SlackCards(file, log)
    await cards.add(card('1732000001.000100'))
    expect(await onDisk()).toEqual({ cards: [card('1732000001.000100')] })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const again = new SlackCards(file, log)
    await again.load()
    expect(again.get('CGENERALAAA', '1732000001.000100')).toEqual(card('1732000001.000100'))
    expect(again.get('CGENERALAAA', '1.000000')).toBeUndefined()
    expect(logs).toEqual([])
  })

  it('no file → empty, no line; an unreadable file → empty and one slack-cards-unreadable line', async () => {
    const none = new SlackCards(file, log)
    await none.load()
    expect(none.size).toBe(0)
    expect(logs).toEqual([])
    await writeFile(file, '{ not json')
    const broken = new SlackCards(file, log)
    await broken.load()
    expect(broken.size).toBe(0)
    await writeFile(file, '{"cards": 3}')
    await new SlackCards(file, log).load()
    expect(logs).toEqual([{ evt: 'slack-cards-unreadable' }, { evt: 'slack-cards-unreadable' }])
  })

  it('a malformed entry is skipped; the good ones load', async () => {
    await writeFile(file, JSON.stringify({ cards: [card('1.000001'), { conversation: 'C', id: 2 }, card('1.000003', { actions: [{ option: 'x' }] as never })] }))
    const cards = new SlackCards(file, log)
    await cards.load()
    expect(cards.size).toBe(1)
  })

  it('remove takes the entry out of the file (the ack, the layer’s own close); an unknown one writes nothing', async () => {
    const cards = new SlackCards(file, log)
    await cards.add(card('1.000001'))
    await cards.add(card('1.000002'))
    await cards.remove('CGENERALAAA', '1.000001')
    expect(await onDisk()).toEqual({ cards: [card('1.000002')] })
    await cards.remove('CGENERALAAA', '9.000009')
    expect(await onDisk()).toEqual({ cards: [card('1.000002')] })
  })

  it('at most 500 (here 3): the oldest leaves first, with one slack-card-evicted line (no id)', async () => {
    const cards = new SlackCards(file, log, 3)
    for (const id of ['1.000001', '1.000002', '1.000003', '1.000004']) await cards.add(card(id))
    expect(((await onDisk()) as { cards: SlackCard[] }).cards.map((c) => c.id)).toEqual(['1.000002', '1.000003', '1.000004'])
    expect(logs).toEqual([{ evt: 'slack-card-evicted' }])
  })

  it('without a file: memory only', async () => {
    const cards = new SlackCards(undefined, log)
    await cards.add(card('1.000001'))
    expect(cards.get('CGENERALAAA', '1.000001')).toBeDefined()
    await expect(stat(file)).rejects.toThrow()
  })
})
