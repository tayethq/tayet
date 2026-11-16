// `node --import` hook for the dist smoke: reports on stderr every distinct URL loaded for the SDK's
// client module and the crypto wasm's Node entry, so a test can count copies (ESM has no
// require.cache). Same probe as the §0 of the S-b (PLANO-AGENTES §0.3.5).
import { registerHooks } from 'node:module'

const seen = new Set()
registerHooks({
  load(url, context, nextLoad) {
    if (/matrix-js-sdk\/lib\/client\.js$/.test(url) || /matrix-sdk-crypto-wasm\/node\.mjs$/.test(url)) {
      if (!seen.has(url)) {
        seen.add(url)
        process.stderr.write(`[sb-load] ${url}\n`)
      }
    }
    return nextLoad(url, context)
  },
})
