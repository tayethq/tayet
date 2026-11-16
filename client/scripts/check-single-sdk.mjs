// postbuild gate (ADR-088 dec. 4): the built app carries exactly ONE copy of matrix-js-sdk and
// exactly ONE crypto .wasm. @tayet/shared (file:../shared) imports the SDK too; vite's
// resolve.dedupe keeps the client's pinned copy the only one, and without it the build still passes
// with two SDKs and a second, off-pin wasm (§0 S-a, PLANO-AGENTES §0.3.4). This turns that
// convention into a failing build. Runs after every `npm run build` (CI and deploy.sh build).
//
// SDK marker: the MatrixClient method `getHomeserverUrl(){` — a class method name, which the
// minifier keeps, defined once per SDK copy. Zero is a failure too (marker drift or a broken build
// must not pass silently).
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = fileURLToPath(new URL('../dist', import.meta.url))
const SDK_MARKER = 'getHomeserverUrl(){'

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  )
}

const all = files(DIST)
const sdkHits = all
  .filter((f) => f.endsWith('.js'))
  .flatMap((f) => {
    const n = readFileSync(f, 'utf8').split(SDK_MARKER).length - 1
    return n > 0 ? [{ file: relative(DIST, f), n }] : []
  })
const sdkCount = sdkHits.reduce((a, h) => a + h.n, 0)
const wasm = all.filter((f) => f.endsWith('.wasm')).map((f) => relative(DIST, f))

const problems = []
if (sdkCount !== 1) {
  problems.push(
    `expected exactly 1 matrix-js-sdk copy in dist (marker "${SDK_MARKER}"), found ${sdkCount}` +
      (sdkHits.length ? `: ${sdkHits.map((h) => `${h.file} ×${h.n}`).join(', ')}` : ''),
  )
}
if (wasm.length !== 1) {
  problems.push(`expected exactly 1 .wasm in dist, found ${wasm.length}${wasm.length ? `: ${wasm.join(', ')}` : ''}`)
}

if (problems.length) {
  console.error('check-single-sdk: FAIL (ADR-088 dec. 4)')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('  Check resolve.dedupe in vite.config.ts (matrix-js-sdk, @matrix-org/matrix-sdk-crypto-wasm).')
  process.exit(1)
}
console.log(`check-single-sdk: ok — 1 matrix-js-sdk (${sdkHits[0].file}), 1 wasm (${wasm[0]})`)
