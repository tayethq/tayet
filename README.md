**English** · [Português (Brasil)](README.pt-BR.md)

# Tayet

Tayet is corporate chat for organizations that want to own their communication. People get
channels, direct messages and history that follows them to a new device, with nothing to
configure beyond signing in and no encryption ceremony to perform. Under the hood it runs on
Matrix, with end-to-end encryption that stays transparent to users and organization-held key
custody. You host the whole stack yourself.

## What's in this repo

- `client/` — the web client: a React SPA that reaches the server only through an Anti-Corruption Layer.
- `escrow/` — the per-organization custody service: holds key-backup deposits and writes an append-only audit log.
- `agent/` — the custody agent `cofre`: a member of every encrypted room that deposits room session keys with escrow.
- `shared/` — the shared library: domain types, the translation from protocol to domain, and the protocol-leak scanner. The client and the agent sidecar consume it as `@tayet/shared`.
- `sidecar/` — the agent sidecar `tayet-agent`: runs an agent on the operator's machine and serves it a local API; published to npm and as a container image.
- `infra/deploy/` — the production deployment: Compose stack, Caddy, configuration templates and `deploy.sh`.
- `infra/dev-stack/` — the local development stack that the packages run integrated against.

## Self-hosting

The reference deployment runs on one server as a Compose stack and answers on five hostnames:

| Host | Role |
|---|---|
| apex | `.well-known` discovery, plus the static site (opt-in) |
| `chat.` | The client SPA, with `/escrow` on the same origin |
| `matrix.` | Synapse, the homeserver |
| `auth.` | Matrix Authentication Service, the OIDC issuer |
| `login.` | Upstream identity provider (Dex in the reference deployment) |

Caddy, with automatic TLS, is the only public entry point: it takes ports 80 and 443 and routes by
host. Every other service stays on the internal Compose network. Secrets are generated fresh by
`deploy.sh`, outside version control, and never reuse values from the dev stack.

The step-by-step guide, from DNS and the Google OAuth client to backup and restore, is
[`SELF-HOSTING.md`](SELF-HOSTING.md). Operating a running deployment is covered in
[`infra/deploy/README.md`](infra/deploy/README.md).

## Development

You need Node 22+. Run `npm ci` inside `client/`, `escrow/`, `agent/`, `shared/` or `sidecar/`.
`escrow/` and `agent/` are standalone; `client/` and `sidecar/` link `shared/` from the same checkout
(`file:../shared`), so clone the whole tree. `infra/dev-stack/` brings up the local stack for
integration work; without it, integration suites skip.

Package details are in [`client/README.md`](client/README.md),
[`escrow/README.md`](escrow/README.md), [`agent/README.md`](agent/README.md) and
[`sidecar/README.md`](sidecar/README.md).

## Decisions

[`DECISIONS.md`](DECISIONS.md) lists the architecture decisions and plans cited in the code; the
full documents live in the private development repository.

## License

Tayet is licensed under the [Business Source License 1.1](LICENSE), with Apache-2.0 as the Change
License. Contributions require signing the [CLA](CLA.md).

The login page templates under [`infra/mas/templates/`](infra/mas/templates/) come from the Matrix
Authentication Service and are licensed under AGPL-3.0-only, not under the Business Source License;
see [`infra/mas/NOTICE.md`](infra/mas/NOTICE.md).

In plain terms: you may copy, modify, redistribute and create derivative works of Tayet, and also
use it in production, including inside your company. What the license does not allow is offering
Tayet, or a service whose value derives substantially from it, as a hosted or managed service to
third parties. Each version becomes available under the Apache License 2.0 four years after it is
published. The text that governs is the [`LICENSE`](LICENSE).

## Security

See [`SECURITY.md`](SECURITY.md).
