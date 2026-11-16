// Bundle of the sidecar (ADR-087 dec. 11, §0.3.5 adj. 1). @tayet/shared is bundled in; the SDK,
// the crypto wasm, node-indexeddb, classic-level, ws, the MCP server and client SDKs and zod stay external: they are pinned `dependencies`,
// resolved at runtime from the package's own node_modules (one copy of each, and `npm audit` sees
// them). No alias: the shared imports are Node-resolvable at the source (adj. 2).
//
// The product bundle is split (ESM chunks under dist/chunks/): the daemon's modules are imported
// dynamically by cli.ts, and without splitting esbuild hoists every external import of the bundle to
// the top of dist/cli.js — `tayet-agent mcp` (the stdio bridge, §0.3.13 item 7) would load the SDK and
// classic-level just to start. `options()` stays single-file (the shared probe of boot.test.ts).
import { rm } from 'node:fs/promises'
import { build, context } from 'esbuild'

export const EXTERNAL = [
  'matrix-js-sdk',
  'matrix-js-sdk/*',
  '@matrix-org/matrix-sdk-crypto-wasm',
  'node-indexeddb',
  'node-indexeddb/*',
  'classic-level',
  'ws',
  // The MCP server (S-g1, PLANO-AGENTES §0.3.13): its `core` comes with it from node_modules.
  '@modelcontextprotocol/server',
  '@modelcontextprotocol/server/*',
  // The stdio bridge's side of the daemon (S-g2, §0.3.13 item 3).
  '@modelcontextprotocol/client',
  '@modelcontextprotocol/client/*',
  'zod',
  'zod/*',
]

export function options(entry, outfile) {
  return {
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: EXTERNAL,
    banner: { js: '#!/usr/bin/env node' },
    logLevel: 'warning',
  }
}

// dist/cli.js (the bin) + dist/chunks/*.js. The chunks directory is emptied first: hashed names would
// otherwise pile up across builds.
export function productOptions() {
  const single = options('src/cli.ts', undefined)
  delete single.outfile
  return { ...single, outdir: 'dist', splitting: true, entryNames: '[name]', chunkNames: 'chunks/[name]-[hash]' }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = productOptions()
  await rm('dist/chunks', { recursive: true, force: true })
  if (process.argv.includes('--watch')) {
    const ctx = await context(opts)
    await ctx.watch()
    console.log('esbuild: watching src/ → dist/cli.js (run: node dist/cli.js --server … --token …)')
  } else {
    await build(opts)
  }
}
