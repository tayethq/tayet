import { defineConfig, devices } from '@playwright/test'

// Browser E2E tier (ADR-060). Runs against the dev-stack (Synapse/MAS/Dex/escrow up) with the SPA
// served by `vite preview` from `dist/` on the port of the stack namespace (TAYET_SPA_PORT; default
// 5173, the redirect_uri of the MAS client in infra/dev-stack/mas/config.yaml; the 2a render shifts
// it along with the namespace — PLANO-CI-INTEGRACAO §8.R2). `dist/` must be built first with the VITE_* the stack
// expects — CI builds it in its own step; locally `npm run build` reads client/.env.local.
//
// Admission rule (ADR-060 D1): only scenarios that need a real browser live here. Selectors are
// role/text as the user sees them (D3). e2e/ imports only test/support (D4, enforced by eslint).
const CI = !!process.env.CI
const SPA_PORT = process.env.TAYET_SPA_PORT ?? '5173'

export default defineConfig({
  testDir: 'e2e',
  // Flake is registered (issue #7 rule), never masked.
  retries: 0,
  // One shared stack: the scenarios log real users in, so they run one at a time. In CI the E2E runs
  // beside the integration surface against that stack (PLANO-CI-INTEGRACAO §8.R5), still one E2E
  // scenario at a time.
  workers: 1,
  forbidOnly: CI,
  use: {
    baseURL: `http://localhost:${SPA_PORT}`,
    // ADR-060 D5: no trace in CI — it would carry the session blob from localStorage, the
    // Authorization headers and the IdP password POST. Local runs keep it on failure.
    // Exception (ADR-064, Aceito): the nightly soak job (never a PR gate) sets E2E_TRACE_IN_CI=1 and
    // keeps the trace on failure — dev-stack throwaway credentials only, short retention.
    trace: CI && process.env.E2E_TRACE_IN_CI !== '1' ? 'off' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    // The desktop suite. The narrow specs belong to the phone project only, the push specs to the push project.
    { name: 'chromium', testIgnore: [/\.narrow\.spec\.ts$/, /\.push\.spec\.ts$/], use: { ...devices['Desktop Chrome'] } },
    // A phone-sized Chromium with touch, running only the narrow specs (no WebKit, no second full suite).
    {
      name: 'phone',
      testMatch: /\.narrow\.spec\.ts$/,
      testIgnore: /\.push\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 3,
      },
    },
    // ADR-117 (PLANO-MOBILE §0.25 N2): only the push specs, on the full Chromium build — the headless shell above
    // keeps notifications denied, so neither the service worker's notifications nor a push can be seen there.
    { name: 'push', testMatch: /\.push\.spec\.ts$/, use: { ...devices['Desktop Chrome'], channel: 'chromium' } },
  ],
  webServer: {
    command: `npm run preview -- --port ${SPA_PORT} --strictPort`,
    url: `http://localhost:${SPA_PORT}`,
    reuseExistingServer: !CI,
  },
})
