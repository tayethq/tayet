import { ptBR } from './pt-BR'
import { getLocale, type Locale } from './locale'

// Catálogo de copy da UI (ADR-080 D1). A fonte é pt-BR.ts; o tipo do catálogo deriva dele, e a
// chave é a união dos caminhos até as folhas ('timeline.reply'), então chave ausente é erro de
// typecheck. Folha = string com `{nome}` interpolado, ou plural { one, other } escolhido por
// params.n. Sem React context: t() é uma função pura que lê o locale resolvido no boot (locale.ts).

export interface Plural {
  readonly one: string
  readonly other: string
}
type Leaf = string | Plural
export interface Messages {
  readonly [key: string]: Leaf | Messages
}

// O pt-BR é `as const`: aqui os literais viram string, para que outra língua satisfaça o mesmo tipo.
type Widen<T> = T extends string ? string : T extends Plural ? Plural : { readonly [K in keyof T]: Widen<T[K]> }
export type Catalog = Widen<typeof ptBR>

type Paths<T> = {
  [K in keyof T & string]: T[K] extends Leaf ? K : `${K}.${Paths<T[K]>}`
}[keyof T & string]
export type Key = Paths<Catalog>

export type Params = Readonly<Record<string, string | number>>

const CATALOGS: Record<Locale, Catalog> = { 'pt-BR': ptBR }

const pluralRules = new Map<Locale, Intl.PluralRules>()
function pluralOf(locale: Locale, n: number): 'one' | 'other' {
  // Zero pega `other` em toda língua: o CLDR do pt põe 0 em `one` ("0 acesso"), e a copy do produto
  // diz "0 acessos". Plural além de 1/N é gatilho do ADR-080 (ICU).
  if (n === 0) return 'other'
  let rules = pluralRules.get(locale)
  if (!rules) {
    rules = new Intl.PluralRules(locale)
    pluralRules.set(locale, rules)
  }
  return rules.select(n) === 'one' ? 'one' : 'other'
}

function interpolate(text: string, params: Params | undefined): string {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole))
}

export function t(key: Key, params?: Params): string {
  const locale = getLocale()
  let node: Leaf | Messages | undefined = CATALOGS[locale]
  for (const part of key.split('.')) node = (node as Messages | undefined)?.[part]
  if (typeof node === 'string') return interpolate(node, params)
  if (node && typeof node.one === 'string' && typeof node.other === 'string') {
    const plural = node as Plural
    return interpolate(plural[pluralOf(locale, Number(params?.n))], params)
  }
  throw new Error(`i18n: no copy for ${key}`)
}
