# AGENTS.md

Instructions for coding agents working in this repository. People should start at
[`README.md`](README.md).

## What this is

Tayet is corporate chat that an organization hosts on its own server, as one Docker Compose stack.
The packages are `client/`, `escrow/`, `agent/`, `shared/` and `sidecar/`. The deployment is
`infra/deploy/`. `infra/dev-stack/` is the local development stack.

## If you are installing Tayet

Follow [`SELF-HOSTING.md`](SELF-HOSTING.md) from the top, in order. The steps give the commands to
run and, for most of them, what you should see and a way to check it.

- `./deploy.sh secrets` runs once per deployment. It refuses to run again.
- Never delete `infra/deploy/secrets/`. It holds the organization key. Without it, the encrypted
  history of the whole organization cannot be read again.
- Steps marked **[human]** need a person: choosing the domain, creating the DNS records, creating the
  Google OAuth client, the first sign-in and the first invitation. Stop and ask.
- The installation is done when `./deploy.sh check` exits with status 0.

Operating a running deployment is covered in [`infra/deploy/README.md`](infra/deploy/README.md).

## If you are changing the code

- You need Node 22 or newer. Run `npm ci` inside the package you are changing. `client/` and
  `sidecar/` link `shared/` from the same checkout, so work in a full clone.
- The checks of a package, run inside it: `npm run typecheck`, `npm run lint` and `npm test`.
  `client/` also has `npm run lint:css` and `npm run build`; `sidecar/` also has `npm run build`.
- Integration suites need the local stack of `infra/dev-stack/` and skip without it.
- The client reaches the server only through `client/src/acl/`. No protocol identifier crosses that
  boundary into the interface or into exported names. Lint and tests enforce it: fix the code, never
  weaken the check.
- Commits are in English, and so are new comments. The product interface is in English and Brazilian Portuguese: a new text key goes into both catalogs (`client/src/ui/i18n/en.ts` and `pt-BR.ts`) in the same change.
- Never commit a secret. `infra/deploy/secrets/` stays outside version control.
- [`DECISIONS.md`](DECISIONS.md) lists the architecture decisions cited in the code.

## License and contributions

Tayet is under the Business Source License 1.1 ([`LICENSE`](LICENSE)). The templates in
`infra/mas/templates/` are under AGPL-3.0-only ([`infra/mas/NOTICE.md`](infra/mas/NOTICE.md)).
Contributions require the CLA ([`CONTRIBUTING.md`](CONTRIBUTING.md)).
