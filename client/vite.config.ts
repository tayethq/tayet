import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath, URL } from 'node:url'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Agent discovery in dev and `vite preview` only (PLANO-AGENTES §0.3.9 item 1; ADR-087 dec. 2): the
// sidecar is started with the product URL and asks it for `/.well-known/tayet/agent`. Production
// answers it in the Caddyfile (`handle /.well-known/tayet/agent`); here the same document is served
// with the homeserver of the stack namespace (TAYET_HS_URL, the harness's variable — default the
// `spike`), and `account` is the same-origin `/escrow` the proxy below answers, as in the Caddyfile.
// Serve/preview hooks only: nothing of it reaches `vite build` or dist/.
export const AGENT_DISCOVERY_PATH = '/.well-known/tayet/agent'

export function agentDiscoveryMiddleware(server: string) {
  const body = JSON.stringify({ server, account: '/escrow' })
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if (req.url?.split('?')[0] !== AGENT_DISCOVERY_PATH) return next()
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json')
    res.end(body)
  }
}

function agentDiscovery(): Plugin {
  const middleware = agentDiscoveryMiddleware(process.env.TAYET_HS_URL ?? 'http://localhost:8008')
  return {
    name: 'tayet-agent-discovery',
    configureServer: (s) => void s.middlewares.use(middleware),
    configurePreviewServer: (s) => void s.middlewares.use(middleware),
  }
}

// Single config for both the app (Vite dev/build) and the tests (Vitest). The React plugin
// gives the automatic JSX runtime (React 19) to both. Boundary lint still governs src/** — the
// UI can only import the acl barrel, never matrix-js-sdk (ADR-007).
export default defineConfig({
  plugins: [react(), agentDiscovery()],
  // Proxy de DEV apenas (ADR-021): o app de browser alcança o escrow same-origin via
  // /escrow, sem CORS no serviço. CORS = origem permitida = ❓2 (modelo de hosting),
  // deferida. Consumo real no app é fatia à parte. Aponta para o escrow do compose,
  // publicado no loopback do host (8090). Vitest ignora `server`.
  // Fase 2 (PLANO-CI-INTEGRACAO §8.R2): porta e alvo do proxy vêm do namespace da stack por env,
  // com os defaults da `spike`; o `preview` herda os dois. O CI aponta para a `spike-ci`.
  server: {
    // Porta fixa: estabiliza o redirect_uri OIDC registrado no MAS (#55 / ADR-032 D5). strictPort
    // falha cedo se a 5173 estiver ocupada, em vez de migrar de porta e quebrar o callback.
    port: Number(process.env.TAYET_SPA_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/escrow': {
        target: process.env.TAYET_ESCROW_URL ?? 'http://localhost:8090',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/escrow/, ''),
      },
    },
  },
  // The rust-crypto wasm package resolves its .wasm asset via `new URL(..., import.meta.url)`
  // (lazy initAsync, no top-level await — PLANO-FASE-2 §9 PF-1). Vite's build handles that
  // natively (the asset is emitted), but the dev server's esbuild pre-bundle would inline the
  // module and break the URL resolution — so it is excluded from optimizeDeps.
  optimizeDeps: {
    exclude: ['@matrix-org/matrix-sdk-crypto-wasm'],
  },
  resolve: {
    // ADR-088 dec. 1: @tayet/shared (file:../shared) imports the SDK and the crypto binding too. One
    // copy of each, always the client's pinned one — without dedupe a shared/node_modules (its own CI
    // job installs one) puts a second SDK and a second, off-pin wasm in the bundle and the build still
    // passes. scripts/check-single-sdk.mjs (postbuild) is the gate that this holds.
    dedupe: ['matrix-js-sdk', '@matrix-org/matrix-sdk-crypto-wasm'],
    // The UI consumes the domain barrel under this name; mirrors tsconfig `paths`.
    alias: {
      '@tayet/client': fileURLToPath(new URL('./src/acl/index.ts', import.meta.url)),
    },
  },
  test: {
    // Default environment is `node` — the ACL↔Synapse integration tests need execSync/fetch/SDK.
    // The DOM render-scan (P1 on screen) opts into jsdom via a `// @vitest-environment jsdom`
    // docblock at the top of its file.
    include: ['test/**/*.test.{ts,tsx}'],
    // Runs once per test file, inside its environment. Shims jsdom's missing layout engine so the
    // real TipTap editor (rich-composer) doesn't emit unhandled getClientRects errors. Inert in
    // the node-environment integration files (guarded by `typeof Element`). See test/setup.ts.
    // integration-setup.ts: inert outside test/integration/ — there it waits for the file's fetches
    // in flight before the worker is released (PLANO-RELEASE-PUBLICA §8.36).
    setupFiles: ['./test/setup.ts', './test/integration-setup.ts'],
    // Test FILES run serially by default: the integration tests share ONE live Synapse, and many
    // syncing clients + sends in parallel trip the server's rate limiter (M_LIMIT_EXCEEDED), so
    // any run that may reach a stack stays serial. TAYET_TEST_PARALLEL=1 is for runs with no stack
    // in play (the CI `client` job, whose stack probes point at a dead target — ADR-071 dec. 1):
    // the integration files skip there and the unit files run in parallel.
    fileParallelism: process.env.TAYET_TEST_PARALLEL === '1',
    // Generous timeouts: against a default-configured Synapse, the integration suite waits out
    // per-user rate-limit backoff (honoured via retry_after). CI skips these (no homeserver), so
    // this only affects the local gate. Unit tests finish in milliseconds regardless.
    testTimeout: 200_000,
    hookTimeout: 200_000,
  },
})
