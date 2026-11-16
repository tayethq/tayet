import { defineConfig } from 'vitest/config'

// §0.3.5 adj. 1: unit tests run on the source. `dedupe` keeps one SDK when shared/ has its own
// node_modules (measured: without it, "Multiple matrix-js-sdk entrypoints detected!"). Pool forks:
// the store code chdirs (node-indexeddb resolves `${cwd}/indexeddb`), and workers refuse chdir.
// Tests that spawn the sidecar run dist/cli.js, built by `pretest`.
export default defineConfig({
  resolve: { dedupe: ['matrix-js-sdk', '@matrix-org/matrix-sdk-crypto-wasm'] },
  test: {
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
