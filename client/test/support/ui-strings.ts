import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

// UI string inventory over src/ui via the TypeScript parser — the method of the §0 de idioma
// (29/Out, /tmp/audit/strings.mjs), ported to the test tier as the code half of the ADR-080 D4 gate.
// It extracts JsxText, literals/templates in copy-carrying JSX attributes, literals inside JSX
// expressions and human-shaped literals in plain code; it skips comparisons, `case`, keys, imports,
// types and calls that never carry copy. The language is a lexical heuristic: `pt`, `en`, `misto`,
// `indef` (letters, no known word) or `neutra` (no word at all). Honest limit, as in the §0: a
// lowercase one-word literal in plain code can escape (it does not look human).
//
// Deviations from strings.mjs: the argument of t() is a catalog KEY, not copy (skipped like
// console/Error, and left out of a template's language); a non-copy call is recognised by the
// callee's last name (strings.mjs missed `window.matchMedia?.(…)`); serialized markup is not human
// text; and the letter class leaves out × and ÷ (glyphs inside the Latin-1 range). With these, the
// non-copy lines the §0 dropped by hand fall out by shape, and the gate can fail on `indef` too.

export type Lang = 'pt' | 'en' | 'misto' | 'indef' | 'neutra'
export interface UiString {
  file: string
  line: number
  text: string
  lang: Lang
  kind: string
}

const LETTER = /[A-Za-zÀ-ÖØ-öø-ÿ]/
const UPPER = /^[A-ZÀ-ÖØ-Ý]/

// JSX attributes whose string value is user-visible.
const UI_ATTR = /^(aria-label|aria-description|aria-valuetext|aria-roledescription|aria-placeholder|title|placeholder|alt|label|[a-z]+Label|[a-z]+Text|description|heading|hint|message|subtitle|caption|tooltip|emptyState|confirm|cancel|cta)$/
// JSX attributes that never carry copy.
const NON_UI_ATTR = /^(className|class|key|id|role|type|name|href|src|rel|target|htmlFor|data-[\w-]+|aria-(controls|describedby|labelledby|owns|activedescendant|live|hidden|expanded|selected|checked|pressed|current|haspopup|modal|busy|atomic|relevant|orientation|sort|level|setsize|posinset|invalid|disabled|required|multiline|readonly|autocomplete)|autoComplete|inputMode|enterKeyHint|method|accept|form|style|width|height|viewBox|d|fill|stroke|strokeWidth|xmlns|variant|size|tone|kind|as|mode|dir|lang|tabIndex|value|defaultValue|pattern|spellCheck|draggable|loading|decoding)$/
const PT = /[ãõçáéíóúâêôà]|\b(de|do|da|dos|das|não|nao|para|com|uma|um|em|no|na|nos|nas|sua|seu|suas|seus|você|voce|conversa|conversas|mensagem|mensagens|canal|canais|buscar|busque|nada|aqui|este|esta|isto|ainda|sem|abrir|fechar|salvar|cancelar|entrar|sair|conta|aparelho|acesso|acessos|pessoas|pessoa|novo|nova|nome|tudo|pronto|deixando|privado|público|arquivar|arquivados|resultado|resultados|limpar|enviar|responder|resposta|respostas|ontem|hoje|agora|carregando|tentar|novamente|perfil|editar|tema|claro|escuro|aparência|sobre|recado|cargo|membros|membro|adicionar|remover|convidar|configurações|carregado|dispositivo|mostrando|preparando|abrindo|foi|possível|encontrado|já|também|ou|ao|pelo|pela|seja|são|está|estão|vez|vezes|dia|dias|minutos|horas|semana)\b/i
const EN = /\b(the|to|of|and|your|you|message|messages|channel|channels|new|yet|reply|replies|last|load|older|connected|connecting|manage|members|member|add|remove|invite|save|cancel|close|open|send|edit|delete|archive|archived|unarchive|search|sign|out|settings|account|profile|loading|failed|retry|try|again|please|this|that|with|from|for|is|are|was|be|not|can't|cannot|don't|could|will|now|contacts|available|replies|today|yesterday|ago|days|day|minutes|hours|people|person|name|theme|light|dark|system|appearance|about|private|public|threads|start|conversation|conversations|direct|create|copy|copied|file|image|upload|download|attach|attachment|error|unknown|unread|mention|mentions|more|less|show|hide|back|next|done|ok|yes|nothing|found|recent|online|offline|away|busy|status|leave|join|joined|left|everyone|only|my|all|other|others|someone|typing)\b/i

// `notPt`: words that do not count as Portuguese for this call. English copy passes "no", "do" and
// "com", which are English words too ("No messages yet.").
export function lang(s: string, { notPt = [] }: { notPt?: readonly string[] } = {}): Lang {
  // A template's quoted literals count as its text — except a t() key, which is not copy.
  const t = s.replace(/\$\{[^}]*\}/g, (m) => ' ' + (m.replace(/\bt\('[^']*'/g, 't(').match(/'[^']*'/g) || []).join(' ') + ' ')
  if (!/[A-Za-zÀ-ÖØ-öø-ÿ]{2,}/.test(t)) return 'neutra'
  const forPt = notPt.length ? t.replace(new RegExp(`\\b(${notPt.join('|')})\\b`, 'gi'), ' ') : t
  const pt = PT.test(forPt)
  const en = EN.test(t)
  if (pt && en) return 'misto'
  if (pt) return 'pt'
  if (en) return 'en'
  return 'indef'
}

const looksHuman = (s: string): boolean =>
  (LETTER.test(s) &&
    (/\s/.test(s.trim()) || UPPER.test(s) || /[ãõçáéíóúâêôà]/.test(s) || /[…?!.:]$/.test(s)) &&
    !/^[\w.-]+\/[\w./-]+$/.test(s) && // paths
    !/^(https?:|mailto:|data:|blob:)/.test(s) &&
    !/^<[a-z]/i.test(s) && // serialized markup
    !/--|var\(|rgba?\(|^[.#][\w-]+|px\b|^\d/.test(s) && // css
    !/^[a-z]+(\.[a-z0-9_-]+)+$/i.test(s) && // dotted ids
    !/^(Enter|Escape|Esc|Tab|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Backspace|Delete|Home|End|PageUp|PageDown|Shift|Control|Meta|Alt|K|Space)$/.test(s) &&
    !/^[A-Z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(s)) || // PascalCase identifiers (component/error names)
  (/^[A-ZÀ-Ý][a-zà-ÿ]+$/.test(s) && /[ãõçáéíóúâêôà]/.test(s))

// Calls whose arguments never carry copy. `t` is the catalog: its argument is a key. Matched on the
// callee's last name, so `window.matchMedia?.(…)` and `ref.current?.querySelector(…)` count too.
const NON_COPY_CALLEE = /^(console\.\w+|localStorage\.\w+|sessionStorage\.\w+|\w+\.classList\.\w+)$/
const NON_COPY_NAME = /^(t|require|import|addEventListener|removeEventListener|querySelector|querySelectorAll|closest|matches|getAttribute|setAttribute|removeAttribute|hasAttribute|getItem|setItem|removeItem|toggle|startsWith|endsWith|includes|split|replace|replaceAll|match|test|padStart|join|matchMedia|createElement|Error|TypeError|RangeError|Symbol|describe|it|expect|clsx|cx|classNames|useRef|useState)$/
const JSX_NON_COPY = /__|--|^[a-z0-9]+(-[a-z0-9]+)+( |$)|^(button|submit|reset|text|email|search|off|on|true|false|polite|assertive|dialog|listbox|option|menu|menuitem|radio|presentation|none|auto|smooth|nearest|start|end|center)$/

function walk(dir: string, skip: (p: string) => boolean, out: string[]): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (skip(p)) continue
    if (statSync(p).isDirectory()) walk(p, skip, out)
    else if (/\.(ts|tsx)$/.test(e) && !/\.d\.ts$/.test(e)) out.push(p)
  }
  return out
}

function scanFile(file: string, rel: string): UiString[] {
  const src = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const rows: UiString[] = []
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1

  const attrOf = (n: ts.Node): string | null => {
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isJsxAttribute(p)) return p.name.getText(sf)
      if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxFragment(p)) return null
    }
    return null
  }
  const inJsx = (n: ts.Node): boolean => {
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isJsxExpression(p)) return true
      if (ts.isFunctionLike(p) || ts.isSourceFile(p)) return false
    }
    return false
  }
  const excludedContext = (n: ts.Node): boolean => {
    const p = n.parent
    if (!p) return true
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p) || ts.isExternalModuleReference(p)) return true
    if (ts.isPropertyAssignment(p) && p.name === n) return true
    if (ts.isElementAccessExpression(p)) return true
    if (ts.isCaseClause(p)) return true
    if (
      ts.isBinaryExpression(p) &&
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.InKeyword,
      ].includes(p.operatorToken.kind)
    )
      return true
    for (let q: ts.Node | undefined = p; q && !ts.isSourceFile(q); q = q.parent) {
      if (ts.isCallExpression(q) || ts.isNewExpression(q)) {
        const callee = q.expression.getText(sf).replace(/\?\./g, '.').replace(/<.*>$/, '')
        if (NON_COPY_CALLEE.test(callee) || NON_COPY_NAME.test(callee.split('.').pop() ?? '')) return true
        break
      }
      if (ts.isBlock(q) || ts.isJsxElement(q)) break
    }
    return false
  }
  const push = (n: ts.Node, raw: string, kind: string) => {
    const text = raw.replace(/\s+/g, ' ').trim()
    if (text) rows.push({ file: rel, line: lineOf(n), text, lang: lang(text), kind })
  }

  const visit = (n: ts.Node): void => {
    if (ts.isJsxText(n)) {
      if (n.getText(sf).trim()) push(n, n.getText(sf), 'jsx-text')
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
      const attr = attrOf(n)
      const text = ts.isTemplateExpression(n) ? n.getText(sf).slice(1, -1) : n.text
      if (attr !== null) {
        if (NON_UI_ATTR.test(attr) || excludedContext(n)) return
        if (UI_ATTR.test(attr) || looksHuman(text)) push(n, text, `attr:${attr}`)
        return
      }
      if (excludedContext(n)) return
      if (inJsx(n)) {
        if ((LETTER.test(text) && !JSX_NON_COPY.test(text)) || looksHuman(text)) push(n, text, 'jsx-expr')
        return
      }
      if (looksHuman(text)) push(n, text, 'code')
      if (ts.isTemplateExpression(n)) return
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return rows
}

// Scans every .ts/.tsx under `uiDir`, skipping the paths `skip` names. `files` is the witness: how many
// files the scan actually read.
export function scanUiStrings(clientDir: string, uiDir: string, skip: (p: string) => boolean): { files: number; strings: UiString[] } {
  const files = walk(uiDir, skip, [])
  return { files: files.length, strings: files.flatMap((f) => scanFile(f, relative(clientDir, f))) }
}
