# @tayet/client

The Tayet web client: a React SPA that speaks to the server only through an Anti-Corruption
Layer (ADR-007). The ACL barrel (`src/acl/index.ts`) is the single boundary to the protocol SDK;
nothing raw crosses it, and that is enforced by lint and negative tests, not by convention.

## Layout

- `src/acl/` — the ACL: the barrel plus `internal/`, the only place in the client where the protocol SDK is imported.
  The domain model, the read translator and the leak-scanner come from `@tayet/shared` (`../shared`, ADR-088),
  which the barrel re-exports; the UI imports only the barrel.
- `src/ui/` — React components, hooks, styles and the generated design tokens.
- `tokens/` — DTCG token source (ADR-028); `npm run tokens` generates the CSS/TS outputs.
- `scripts/` — build-time generators used by `npm run tokens`.
- `test/` — unit and integration tests (Vitest); integration suites skip without a running stack.
- `e2e/` — end-to-end tests (Playwright, against `vite preview` of the built `dist/`).

## Scripts

Requires Node 22+. Install with `npm ci` (needs `../shared` in the same checkout).

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck, then production build to `dist/`; `postbuild` checks the bundle holds exactly one protocol SDK and one `.wasm` |
| `npm run tokens` | Regenerate design tokens from `tokens/*.json` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` / `npm run lint:css` | ESLint (incl. the boundary rules) / Stylelint |
| `npm test` | Vitest |
| `npm run e2e` | Playwright |
| `npm run check` | typecheck + lint + test |

## Configuration

Build-time env (all optional): `VITE_SERVER_URL`, `VITE_OIDC_CLIENT_ID`, `VITE_SSO_LABEL`,
`VITE_ESCROW_URL` (unset = key recovery inactive) and `VITE_SESSION_TOKEN` (dev only).
