// ADR-071 dec. 1: on the self-hosted runner the light jobs share the Docker daemon with the owner's
// dev-stack, so every stack probe is pointed at a dead target by job env. This step proves it took:
// it reads the vitest JSON report and fails if any stack-gated test PASSED or FAILED (both mean it
// ran — against the owner's stack, or against nothing). Stack-gated tests may only be skipped.
//
// Stack-gated = every test in a file under test/integration/, plus every test under a describe named
// with --stack-describe (a stack-gated block in a file that also has hermetic tests). A file named
// with --stack-free is excluded, and must not reference a stack probe (else the exclusion would hide
// one). Zero stack-gated tests found is itself a failure: the proof cannot be vacuous.
//
// The client's integration files carry an always-present marker, a top-level describe ending in
// "(availability)" whose test is titled by the probe's verdict: `SYNAPSE ? 'stack reachable…' :
// 'stack down…'`. It runs without the stack by design, so it is read as evidence, not as a ran test:
// a "stack down" marker that passed is counted; a "stack reachable" marker present at all fails the
// proof (the probe saw a stack). Other tests in that describe check the verdict's consistency
// (e.g. ADMIN_SCOPE false when the stack is down) and may pass, never fail.
//
// usage: node assert-stack-skipped.mjs <report.json> <package-dir>
//          [--stack-free <rel path>]... [--stack-describe '<rel path>::<top-level describe>']...
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const [reportPath, pkgDir, ...rest] = process.argv.slice(2)
if (!reportPath || !pkgDir) {
  console.error('usage: assert-stack-skipped.mjs <report.json> <package-dir> [--stack-free f]... [--stack-describe f::title]...')
  process.exit(2)
}
const stackFree = new Set()
const stackDescribes = []
for (let i = 0; i < rest.length; i += 2) {
  const [flag, value] = [rest[i], rest[i + 1]]
  if (flag === '--stack-free' && value) stackFree.add(value)
  else if (flag === '--stack-describe' && value?.includes('::')) {
    const [file, title] = value.split('::')
    stackDescribes.push({ file, title, seen: 0 })
  } else {
    console.error(`unknown or incomplete argument: ${flag} ${value ?? ''}`)
    process.exit(2)
  }
}

const PROBES = /synapseReachable|stackUp|adminScopeReachable/
for (const file of stackFree) {
  if (PROBES.test(readFileSync(resolve(pkgDir, file), 'utf8'))) {
    console.error(`FAIL: ${file} is listed as stack-free but references a stack probe`)
    process.exit(1)
  }
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const root = resolve(pkgDir)
let gated = 0
let markersDown = 0
const ran = []
const perFile = []
for (const file of report.testResults ?? []) {
  const rel = relative(root, file.name)
  if (stackFree.has(rel)) continue
  const wholeFile = rel.startsWith('test/integration/')
  const describes = stackDescribes.filter((d) => d.file === rel)
  if (!wholeFile && describes.length === 0) continue
  // A file that failed to load (collection error) has no assertions but still means the stack
  // probe did something other than skip.
  if (wholeFile && file.status === 'failed' && (file.assertionResults ?? []).length === 0) {
    ran.push(`${rel} (file failed: ${String(file.message ?? '').split('\n')[0]})`)
    continue
  }
  let skipped = 0
  let marker = ''
  for (const a of file.assertionResults ?? []) {
    if (wholeFile && a.ancestorTitles?.[0]?.endsWith('(availability)')) {
      if (a.title.startsWith('stack reachable')) ran.push(`${rel} :: ${a.fullName} [${a.status}] (probe saw a stack)`)
      else if (a.title.startsWith('stack down') && a.status === 'passed') {
        markersDown++
        marker = ' + "stack down" marker'
      } else if (a.status === 'failed') ran.push(`${rel} :: ${a.fullName} [failed]`)
      continue
    }
    if (!wholeFile) {
      const d = describes.find((x) => a.ancestorTitles?.[0] === x.title)
      if (!d) continue
      d.seen++
    }
    gated++
    if (a.status === 'passed' || a.status === 'failed') ran.push(`${rel} :: ${a.fullName} [${a.status}]`)
    else skipped++
  }
  perFile.push(`${String(skipped).padStart(4)} skipped  ${rel}${wholeFile ? marker : ' (stack-gated describe)'}`)
}

console.log(perFile.sort().join('\n'))
for (const d of stackDescribes) {
  if (d.seen === 0) ran.push(`${d.file} :: describe "${d.title}" not found in the report`)
}
if (gated === 0) ran.push('no stack-gated test found in the report (vacuous proof)')
if (ran.length > 0) {
  console.error(`FAIL: stack-gated tests did not skip (${ran.length}):`)
  for (const r of ran) console.error(`  ${r}`)
  process.exit(1)
}
console.log(
  `OK: ${gated} stack-gated tests, all skipped (none passed, none failed); ` +
    `${markersDown} "stack down" availability markers, 0 "stack reachable".`,
)
