// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { t } from '../src/ui/i18n'
import { resolveLocale, applyLocale, getLocale, ACTIVE_LOCALES, DEFAULT_LOCALE } from '../src/ui/i18n/locale'
import type { Messages, Plural } from '../src/ui/i18n/catalog'
import { ptBR } from '../src/ui/i18n/pt-BR'
import { en } from '../src/ui/i18n/en'
import { timeOf, dayLabelOf, relativeTimeOf } from '../src/ui/components/Timeline'
import { whenOf } from '../src/ui/components/SearchResults'
import { manageLabel } from '../src/ui/components/ChannelLabel'
import { formatSize } from '../src/ui/useDataExport'
import { lang } from './support/ui-strings'
import { fill } from './support/copy'

// The English catalog: present in full, typed, and active. The Catalog type already forces the same
// keys and plural shape; this checks what the type cannot (the interpolation names, the language of
// each value), the resolution with English active, and the formatters with English applied.

type Leaf = string | Plural
const isPlural = (v: unknown): v is Plural =>
  typeof v === 'object' && v !== null && typeof (v as Plural).one === 'string' && typeof (v as Plural).other === 'string'

// Every leaf as [key, form, text]; a plural gives one row per form.
function leaves(node: Messages, prefix = ''): Array<[string, string, string]> {
  return Object.entries(node).flatMap(([k, v]: [string, Leaf | Messages]) => {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') return [[key, '', v] as [string, string, string]]
    if (isPlural(v)) return [[key, 'one', v.one] as [string, string, string], [key, 'other', v.other] as [string, string, string]]
    return leaves(v, key)
  })
}

const names = (text: string): string[] => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort()

const PT = new Map(leaves(ptBR).map(([k, f, v]) => [`${k}#${f}`, v]))
const EN = leaves(en)

// Values that are the same in both languages, each with its reason.
const SAME_IN_BOTH: Record<string, string> = {
  'profile.presenceOnline#': 'loanword',
  'profile.presenceOffline#': 'loanword',
  'thread.title#': 'loanword',
  'composer.link#': 'loanword',
  'composer.linkUrl#': 'acronym',
  'channel.roleAdmin#': 'loanword',
  'admin.roleAdmin#': 'loanword',
  'admin.pillAdmins#': 'loanword',
  'people.fieldEmail#': 'loanword',
  'account.languagePt#': "each language is named in its own words, in both catalogs",
  'account.languageEn#': "each language is named in its own words, in both catalogs",
}

// English words the classifier would otherwise count as Portuguese.
const EN_NOT_PT = ['no', 'do', 'com']

// English values the classifier reads as Portuguese on purpose, each with its reason.
const PT_IN_EN: Record<string, string> = {
  'account.languagePt#': 'the name of Portuguese in Portuguese ("Português"), the option a Portuguese speaker looks for',
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  applyLocale('pt-BR')
})

describe('en catalog', () => {
  it('has every pt-BR leaf and nothing else', () => {
    expect(EN.map(([k, f]) => `${k}#${f}`).sort()).toEqual([...PT.keys()].sort())
    console.info(`[i18n-en] ${new Set(EN.map(([k]) => k)).size} keys`)
  })

  it('uses the same {names} as pt-BR in every value', () => {
    const drift = EN.filter(([k, f, v]) => names(v).join() !== names(PT.get(`${k}#${f}`)!).join()).map(([k, f]) => `${k}#${f}`)
    expect(drift).toEqual([])
  })

  it('no value is empty, Portuguese or mixed', () => {
    const of = (v: string) => lang(v, { notPt: EN_NOT_PT })
    const bad = EN.filter(([k, f, v]) => !v.trim() || ((of(v) === 'pt' || of(v) === 'misto') && !(`${k}#${f}` in PT_IN_EN))).map(
      ([k, f, v]) => `${k}#${f} [${of(v)}] ${v}`,
    )
    expect(bad).toEqual([])
    // Each listed exception is still one the classifier flags (a stale entry is a red test).
    const flagged = EN.filter(([k, f]) => `${k}#${f}` in PT_IN_EN).map(([k, f, v]) => [`${k}#${f}`, of(v)])
    expect(flagged).toEqual(Object.keys(PT_IN_EN).map((k) => [k, 'pt']))
  })

  it('a value equal to pt-BR is only one of the listed ones', () => {
    const same = EN.filter(([k, f, v]) => v === PT.get(`${k}#${f}`)).map(([k, f]) => `${k}#${f}`)
    expect(same.sort()).toEqual(Object.keys(SAME_IN_BOTH).sort())
  })

  it('pt-BR managePrivate spells the private mark the way privateMark does', () => {
    expect(ptBR.channel.managePrivate).toContain(ptBR.channel.privateMark)
    expect(manageLabel({ kind: 'private', name: 'board' } as Parameters<typeof manageLabel>[0])).toBe(
      fill(ptBR.channel.managePrivate, { name: 'board' }),
    )
  })
})

describe('resolveLocale with en active', () => {
  const browser = (languages: readonly string[] | undefined, language: string) => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages as readonly string[])
    vi.spyOn(navigator, 'language', 'get').mockReturnValue(language)
  }

  it('pt-BR and en are active; the module still starts in pt-BR', () => {
    expect(ACTIVE_LOCALES).toEqual(['pt-BR', 'en'])
    expect(DEFAULT_LOCALE).toBe('pt-BR')
  })

  it("the device's copy wins over the browser", () => {
    localStorage.setItem('tayet.locale', 'en')
    browser(['pt-BR'], 'pt-BR')
    expect(resolveLocale()).toBe('en')
    localStorage.setItem('tayet.locale', 'pt-BR')
    browser(['en-US', 'en'], 'en-US')
    expect(resolveLocale()).toBe('pt-BR')
  })

  it('an en-US browser gives en', () => {
    browser(['en-US', 'en'], 'en-US')
    expect(resolveLocale()).toBe('en')
  })

  it('reads the whole navigator.languages list in order', () => {
    browser(['es', 'pt-PT', 'en'], 'es')
    expect(resolveLocale()).toBe('pt-BR')
    browser(['es', 'en-GB', 'pt-BR'], 'es')
    expect(resolveLocale()).toBe('en')
  })

  it('falls back to navigator.language when the list is missing', () => {
    browser(undefined, 'pt-PT')
    expect(resolveLocale()).toBe('pt-BR')
  })

  it('a device in languages we do not have gets English', () => {
    browser(['es', 'fr-FR'], 'es')
    expect(resolveLocale()).toBe('en')
  })

  it('a copy that is not an active language is ignored', () => {
    localStorage.setItem('tayet.locale', 'fr')
    browser(['pt-BR'], 'pt-BR')
    expect(resolveLocale()).toBe('pt-BR')
  })
})

describe('with en applied', () => {
  beforeEach(() => applyLocale('en'))

  it('t() reads the en catalog: plain, interpolated, plural with 0, 1 and 2', () => {
    expect(getLocale()).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(t('account.title')).toBe(en.account.title)
    expect(t('profile.viewLabel', { name: 'Ana' })).toBe(fill(en.profile.viewLabel, { name: 'Ana' }))
    expect(t('timeline.replies', { n: 0 })).toBe(fill(en.timeline.replies.other, { n: 0 }))
    expect(t('timeline.replies', { n: 1 })).toBe(fill(en.timeline.replies.one, { n: 1 }))
    expect(t('timeline.replies', { n: 2 })).toBe(fill(en.timeline.replies.other, { n: 2 }))
  })

  const at = (...p: [number, number, number, number?, number?]) => new Date(...(p as [number, number, number, number, number])).getTime()
  const sent = (ms: number) => ms as unknown as Parameters<typeof timeOf>[0]
  const now = at(2026, 9, 23, 12, 0) // a Friday

  it('timeOf stays on the 24-hour clock, midnight included', () => {
    expect(timeOf(sent(at(2026, 9, 23, 16, 40)))).toBe('16:40')
    expect(timeOf(sent(at(2026, 9, 23, 0, 5)))).toBe('00:05')
  })

  it('dayLabelOf', () => {
    expect(dayLabelOf(sent(at(2026, 9, 23, 9, 0)), now)).toBe(en.timeline.dayToday)
    expect(dayLabelOf(sent(at(2026, 9, 22, 9, 0)), now)).toBe(en.timeline.dayYesterday)
    expect(dayLabelOf(sent(at(2026, 9, 20, 9, 0)), now)).toBe('Tuesday, October 20')
    expect(dayLabelOf(sent(at(2025, 11, 3, 9, 0)), now)).toBe('Wednesday, December 3, 2025')
  })

  it('relativeTimeOf', () => {
    expect(relativeTimeOf(sent(now - 30_000), now)).toBe(en.timeline.justNow)
    expect(relativeTimeOf(sent(now - 5 * 60_000), now)).toBe('5 minutes ago')
    expect(relativeTimeOf(sent(now - 3 * 3_600_000), now)).toBe('3 hours ago')
    expect(relativeTimeOf(sent(now - 9 * 86_400_000), now)).toBe('9 days ago')
  })

  it('whenOf: today, this week, this year, another year, midnight', () => {
    expect(whenOf(at(2026, 9, 23, 9, 18), now)).toBe('today 09:18')
    expect(whenOf(at(2026, 9, 20, 16, 40), now)).toBe('Tue 16:40')
    expect(whenOf(at(2026, 9, 12, 10, 0), now)).toBe('Oct 12')
    expect(whenOf(at(2025, 11, 3, 10, 0), now)).toBe('Dec 3, 2025')
    expect(whenOf(at(2026, 9, 23, 0, 5), now)).toBe('today 00:05')
  })

  it('formatSize', () => {
    expect(formatSize(999_600, getLocale())).toBe('1.0 MB')
    expect(formatSize(1_536, getLocale())).toBe('1.5 kB')
    expect(formatSize(214e6, getLocale())).toBe('214 MB')
  })
})

describe('whenOf in pt-BR at midnight', () => {
  it('stays on the 24-hour clock', () => {
    expect(whenOf(new Date(2026, 9, 23, 0, 5).getTime(), new Date(2026, 9, 23, 12, 0).getTime())).toBe(
      fill(ptBR.search.today, { time: '00:05' }),
    )
  })
})
