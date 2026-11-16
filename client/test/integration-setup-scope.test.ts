import { it, expect } from 'vitest'

// Outside test/integration/ the integration setup is inert: fetch is the platform's own.
it('integration setup does not wrap fetch outside test/integration/', () => {
  expect((globalThis.fetch as unknown as Record<symbol, unknown>)[Symbol.for('aurora.integration.fetchTracked')]).toBeUndefined()
})
