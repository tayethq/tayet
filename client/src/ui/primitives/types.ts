// Component primitive tier — shared convention vocabulary (ADR-036, the third tier:
// primitivo → semântico → componente).
//
// A primitive consumes ONLY semantic tokens (var(--color-*), --space-*, --font-*, --radius-*,
// --density-*, --motion-*) — never a raw color primitive, never hex (C6 holds inside the tier).
// Token stays one-way (ADR-028): the primitive is a consumer, never a source.
//
// A primitive is app-layer: it never crosses the ACL barrel, never imports acl/internal/**, and
// carries NO protocol vocabulary in any prop or exported name (ADR-036 dec. 4). It is
// protocol-agnostic by construction — e.g. Avatar takes a string `label`, not a `User`.
//
// Convention (ADR-036 dec. 2), fixed once for every primitive present and future:
//   - `variant` = a semantic role, never a loose style. The union is per-primitive and lives with
//     its component (e.g. ButtonVariant, AvatarVariant); the *notion* is shared.
//   - `size`    = maps to an existing density token (--density-{size}-*), never a loose px.
//   - states    = expressed via data-* attributes resolved by token, not ad-hoc per-surface classes.

// Density step a primitive renders at. `cotidiano` is the all-user regime (40px row, 28px avatar);
// `gestao` is the denser management regime (30px row, 22px avatar). Maps to --density-{size}-*.
export type Size = 'cotidiano' | 'gestao'
