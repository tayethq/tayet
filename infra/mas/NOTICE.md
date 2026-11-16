# Licensing of `infra/mas/`

This directory holds two things under different licenses.

## `templates/` — AGPL-3.0-only

The files under `templates/` come from the Matrix Authentication Service (MAS), version v1.27.0,
copyright Element Creations Ltd., New Vector Ltd. and The Matrix.org Foundation C.I.C., as stated in
each file. Upstream offers them under `AGPL-3.0-only OR LicenseRef-Element-Commercial`; Tayet takes and
redistributes them under **AGPL-3.0-only**. The license text is in [`LICENSE`](LICENSE). The copyright
and license headers of every file are preserved.

`templates/UPSTREAM.md` records the upstream version, the image digest, and the sha256 of every file
that is unmodified.

### Files modified by Tayet

These files were changed from the upstream version. Each carries a notice in its header. The changes
are licensed under AGPL-3.0-only.

| File | First modified | Last modified |
|---|---|---|
| `templates/base.html` | 2026-11-03 | 2026-11-15 |
| `templates/pages/login.html` | 2026-11-03 | 2026-11-15 |
| `templates/components/idp_brand.html` | 2026-11-03 | 2026-11-15 |
| `templates/pages/consent.html` | 2026-11-04 | 2026-11-15 |
| `templates/pages/error.html` | 2026-11-04 | 2026-11-15 |
| `templates/pages/account/logged_out.html` | 2026-11-04 | 2026-11-15 |

### Files that are not part of MAS

- `templates/_assets/google-g.svg` is the Google "G" from Google's sign-in branding guidelines,
  unmodified. It is a Google brand asset, used under those guidelines; it is not licensed under
  AGPL-3.0 or under the Business Source License.
- `templates/_generated/` is created at install time by `prepare.sh` and is not in the repository.
  It holds a copy of `client/src/ui/tokens/tokens.css`, a copy of the Google asset above, and the
  Hanken Grotesk font file (SIL Open Font License 1.1).

### Additional grant for the design tokens

`client/src/ui/tokens/tokens.css` is part of the Licensed Work under the Business Source License 1.1
at the root of this repository. The Licensor additionally licenses that file under AGPL-3.0-only for
use as part of these templates, so that the pages MAS serves are available under one license.

### If you serve modified templates

If you change these templates and run MAS with them for users who reach it over a network, section 13
of the AGPL applies to you: offer those users the source of your modified version.

## `prepare.sh` — Business Source License 1.1

`prepare.sh` is part of Tayet's deploy artifacts and is covered by the Business Source License 1.1 at
the root of this repository.
