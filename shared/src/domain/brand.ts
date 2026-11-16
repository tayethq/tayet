// Nominal-typing helper. A `Brand<T, B>` is structurally `T` at runtime but is
// type-incompatible with a bare `T` (or any other brand) at compile time — so a raw
// string that is "really" a protocol id can't be passed where a domain id is expected.
// Branding happens at the ACL boundary (ADR-007 mechanism (a)).
export type Brand<T, B> = T & { readonly __brand: B }
