// Design System target `tayet/ds-tokens` (ADR-070 dec. 1). The Claude "Design System" Artifact type
// cannot read DTCG: it reads one `tokens.json` of `{"tokens":[{name,value,usage}]}` lists per family
// and compiles its own tokens.css from them (`--<name>` per token, `--font-<key>` per type family).
// This emits that file FROM client/tokens/*.json, so the DS is one more generated output of the one
// transform (ADR-028 dec. 2), never a second place where tokens are born.
//
// Invariants (gated by test/ds-tokens.test.ts):
//   • Exactly the public names of src/ui/tokens/tokens.css — the private ramps stay private
//     (ADR-028 dec. 3). Family keys are chosen so the type's compiled name IS the client's name:
//     type families `family-sans`/`family-mono` (→ `--font-family-*`), and line-height/size/weight,
//     density and motion as "other" families carrying the full public name. Motion goes in a
//     family called `duration`: the type ignores a family called `motion`.
//   • Values resolved to literals (no var(), no alias), colors and shadow per theme, light first.
//   • Deterministic: source order, no timestamp, no sha. The index `design-system.json` (which
//     carries `lastChange.at`) is NOT generated: the owner writes it when publishing (dec. 2).
//
// Also written here: the latin woff2 files the client self-hosts (copied from node_modules at the
// lockfile version) and a short generated README.md. Icons: scripts/ds-icons.mjs.
import StyleDictionary from 'style-dictionary'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(clientRoot, '..')
const SRC = join(clientRoot, 'tokens')
const MAIN = join(clientRoot, 'src', 'ui', 'main.tsx')
const SOURCES = ['primitives.json', 'theme.light.json', 'theme.dark.json', 'density.json', 'typography.json']

export const DS_PROJECT_DIR = join(repoRoot, 'design', 'system', 'project')

// The DS target is optional: a tree without design/ (the public source) builds the client outputs
// only. Tested on the parent design/system/, not on project/ — that one is output.
export const dsProjectAvailable = () => existsSync(dirname(DS_PROJECT_DIR))

const RAMPS = new Set(['greige', 'petrol', 'indigo'])
const isPrimitiveColor = (t) => t.path[0] === 'color' && RAMPS.has(t.path[1])
const isTextStyle = (t) => t.path[0] === 'font' && t.path[1] === 'style'

// Text styles come from `font.style.*` (typography.json): one composite per style, aliases to the
// public font tokens, ratified by the owner (20/Out/2026). The style's family alias picks its group.
const GROUP_OF_FAMILY = { sans: 'Text', mono: 'Mono' }

// Which DS family a public token lands in. Anything unmapped fails the build (fail-closed: a new
// DTCG group must be placed on purpose, not silently dropped from the DS).
function familyOf(t) {
  const [g, sub] = t.path
  if (g === 'color') return 'color'
  if (g === 'shadow') return 'shadow'
  if (g === 'space') return 'spacing'
  if (g === 'radius') return 'radius'
  if (g === 'font' && sub === 'family') return 'type-family'
  if (g === 'font' && (sub === 'size' || sub === 'weight' || sub === 'line-height')) return 'typography'
  if (g === 'density') return 'density'
  if (g === 'motion') return 'duration'
  throw new Error(`ds-tokens: no DS family for token "${t.path.join('.')}" — place it in familyOf()`)
}

const lowerHex = (v) => v.replace(/#[0-9A-Fa-f]{3,8}/g, (h) => h.toLowerCase())

async function platformTokens(themeFile) {
  const sd = new StyleDictionary({
    source: [join(SRC, 'primitives.json'), join(SRC, themeFile), join(SRC, 'density.json'), join(SRC, 'typography.json')],
    platforms: { ds: { transforms: ['name/kebab'] } },
    log: { verbosity: 'silent' },
  })
  const { allTokens } = await sd.getPlatformTokens('ds')
  return allTokens.filter((t) => !isPrimitiveColor(t) && !isTextStyle(t))
}

// Style Dictionary resolves the aliases inside the composite `$value`; the family is read from the
// ORIGINAL alias (`{font.family.sans}`), which names the type.families key and the group.
function textStyleGroups(styles) {
  const groups = new Map()
  for (const t of styles) {
    const alias = /^\{font\.family\.([a-z]+)\}$/.exec(t.original.$value.fontFamily)?.[1]
    const group = alias && GROUP_OF_FAMILY[alias]
    if (!group) throw new Error(`ds-tokens: text style "${t.path.join('.')}" needs a {font.family.*} alias with a group`)
    const { fontSize, fontWeight, lineHeight } = t.$value
    for (const [k, v] of Object.entries({ fontSize, fontWeight, lineHeight })) {
      if (typeof v !== 'string' || v.includes('{')) throw new Error(`ds-tokens: ${t.path.join('.')}.${k} unresolved`)
    }
    if (!groups.has(group)) groups.set(group, { name: group, family: `family-${alias}`, styles: [] })
    groups.get(group).styles.push({
      name: t.path[2],
      fontSize,
      lineHeight: Number(lineHeight),
      fontWeight: Number(fontWeight),
      usage: t.$description ?? '',
    })
  }
  return [...groups.values()]
}

// ── Fonts: the @fontsource CSS the client imports, latin subset only ─────────────────────────
async function lockedVersion(pkg) {
  const lock = JSON.parse(await readFile(join(clientRoot, 'package-lock.json'), 'utf8'))
  const entry = lock.packages[`node_modules/${pkg}`]
  if (!entry) throw new Error(`ds-tokens: ${pkg} not in package-lock.json`)
  const installed = JSON.parse(await readFile(join(clientRoot, 'node_modules', pkg, 'package.json'), 'utf8'))
  if (installed.version !== entry.version) {
    throw new Error(`ds-tokens: ${pkg} installed ${installed.version} ≠ lockfile ${entry.version} — run npm ci`)
  }
}

async function fontFaces() {
  const main = await readFile(MAIN, 'utf8')
  const imports = [...main.matchAll(/^import '(@fontsource[^']+\.css)'$/gm)].map((m) => m[1])
  if (!imports.length) throw new Error('ds-tokens: no @fontsource import in src/ui/main.tsx')
  const faces = []
  for (const spec of imports) {
    const pkg = spec.split('/').slice(0, 2).join('/')
    await lockedVersion(pkg)
    const cssPath = join(clientRoot, 'node_modules', spec)
    const css = await readFile(cssPath, 'utf8')
    for (const m of css.matchAll(/\/\* ([a-z0-9-]+) \*\/\s*@font-face\s*\{([^}]*)\}/g)) {
      const [, label, body] = m
      // `-latin-` exactly: not latin-ext, cyrillic, vietnamese…
      if (!/-latin-(?!ext)/.test(label)) continue
      const prop = (p) => new RegExp(`${p}:\\s*([^;]+);`).exec(body)?.[1].trim()
      const src = /url\(\.\/files\/([^)]+\.woff2)\)/.exec(body)?.[1]
      if (!src) throw new Error(`ds-tokens: no woff2 in ${spec} block ${label}`)
      faces.push({
        family: prop('font-family').replace(/^'|'$/g, ''),
        file: `fonts/${src}`,
        weight: prop('font-weight'),
        style: prop('font-style'),
        from: join(dirname(cssPath), 'files', src),
      })
    }
  }
  return faces
}

// ── README (generated; short; no brand voice) ─────────────────────────────────────────────────
function readme(ds) {
  const names = (fam) => ds[fam].tokens.map((t) => `\`--${t.name}\``).join(', ')
  const styles = ds.type.groups
    .flatMap((g) => g.styles.map((s) => `| \`${s.name}\` | ${g.family} | ${s.fontSize} | ${s.lineHeight} | ${s.fontWeight} |`))
    .join('\n')
  const fams = Object.entries(ds.type.families).map(([k, v]) => `- \`--font-${k}\`: ${v}`).join('\n')
  return `# Tayet

Este Design System é GERADO de \`client/tokens/*.json\` (DTCG) por \`npm run tokens\` no repositório
do Tayet. Os nomes são os mesmos que o client usa (\`var(--space-20)\`, \`var(--font-family-sans)\`).
Edição feita nesta página é descartada na próxima publicação: mudança de token vai para a fonte DTCG.

## Cor

Só tokens semânticos; as rampas primitivas não são públicas. Dois temas: \`light\` (default) e
\`dark\`. Os nomes são estáveis entre temas. \`--presence-ring\` NÃO é token: é uma indirection de
CSS do client sobre \`--color-surface\`/\`--color-surface-raised\`.

${names('color')}. Sombra: ${names('shadow')} (só flutuantes; também por tema).

## Tipo

Famílias:

${fams}

| estilo | família | tamanho | entrelinha | peso |
| --- | --- | --- | --- | --- |
${styles}

Tokens: ${names('typography')}.

## Espaço e raio

Espaço: ${names('spacing')}. Raio: ${names('radius')}.

## Densidade

Dois regimes, cotidiano e gestão, resolvidos por superfície (sem toggle de runtime).
${names('density')}. O piso de toque vale nos dois.

## Motion

${names('duration')}.

## Ícones

Traço único (single-ink) em \`currentColor\`, que herda a cor do texto (\`--color-text\`); nunca
uma cor literal. Tamanhos 16 e 20. Os SVGs em \`assets/Icons/\` são renderizados dos componentes do
client.
`
}

// ── The target ────────────────────────────────────────────────────────────────────────────────
StyleDictionary.registerFormat({
  name: 'tayet/ds-tokens',
  format: ({ dictionary, options }) => JSON.stringify(options.build(dictionary.allTokens), null, 2) + '\n',
})

/** Builds the DS files into `projectDir` (default: design/system/project). Returns the summary. */
export async function buildDesignSystem(projectDir = DS_PROJECT_DIR) {
  const dark = new Map((await platformTokens('theme.dark.json')).map((t) => [t.name, t]))
  const faces = await fontFaces()
  let summary

  const build = (allTokens) => {
    const light = allTokens.filter((t) => !isPrimitiveColor(t) && !isTextStyle(t))
    const fam = { color: [], shadow: [], spacing: [], radius: [], typography: [], density: [], duration: [] }
    const families = {}
    for (const t of light) {
      const f = familyOf(t)
      const usage = t.$description ?? ''
      if (f === 'type-family') {
        families[`family-${t.path[2]}`] = t.$value
        continue
      }
      let value = t.$value
      if (f === 'color' || f === 'shadow') {
        const d = dark.get(t.name)
        if (!d) throw new Error(`ds-tokens: themed token "${t.name}" missing in dark`)
        value = { light: lowerHex(t.$value), dark: lowerHex(d.$value) }
      }
      fam[f].push({ name: t.name, value, usage })
    }
    const groups = textStyleGroups(allTokens.filter(isTextStyle))
    const ds = {
      name: 'Tayet',
      version: 1,
      color: {
        themes: [
          { id: 'light', name: 'Light' },
          { id: 'dark', name: 'Dark' },
        ],
        tokens: fam.color,
      },
      type: {
        fonts: faces.map(({ family, file, weight, style }) => ({ family, file, weight, style })),
        families,
        groups,
      },
      spacing: { tokens: fam.spacing },
      radius: { tokens: fam.radius },
      shadow: { tokens: fam.shadow },
      typography: { tokens: fam.typography },
      density: { tokens: fam.density },
      duration: { tokens: fam.duration },
      meta: {
        source: 'repo',
        paths: [
          ...SOURCES.map((s) => `client/tokens/${s}`),
          relative(repoRoot, MAIN),
        ],
      },
    }
    summary = { ds }
    return ds
  }

  const sd = new StyleDictionary({
    source: [join(SRC, 'primitives.json'), join(SRC, 'theme.light.json'), join(SRC, 'density.json'), join(SRC, 'typography.json')],
    platforms: {
      ds: {
        transforms: ['name/kebab'],
        buildPath: `${projectDir}/`,
        files: [{ destination: 'tokens.json', format: 'tayet/ds-tokens', options: { build } }],
      },
    },
    log: { verbosity: 'silent' },
  })
  await sd.buildAllPlatforms()

  await mkdir(join(projectDir, 'fonts'), { recursive: true })
  for (const f of faces) await copyFile(f.from, join(projectDir, f.file))
  await writeFile(join(projectDir, 'README.md'), readme(summary.ds))
  return summary
}
