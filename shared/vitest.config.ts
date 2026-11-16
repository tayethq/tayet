import { defineConfig } from 'vitest/config'

// Pure unit tests (node environment): no homeserver, no DOM. The crypto wasm loads only in the
// attachment cipher's test (its Node entry initializes at import).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
