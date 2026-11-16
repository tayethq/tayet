import { registerUser } from './escrow-harness'
import { mintToken } from './synapse'

export interface FreshUser {
  /** Per-run unique MAS localpart: `${prefix}${runSuffix}`. */
  name: string
  /** Freshly minted MAS compatibility token (mct_…), bound to a brand-new device. */
  token: string
}

// Per-run virgin identities for the local integration gate. The shared alice/bob of the dev
// stack accumulate devices and room memberships across runs — the proven root cause of the
// run-to-run drag (#32; see escrow-harness.ts registerUser doc): a reused user inflates to N
// devices and sync crawls. A virgin user per run starts with zero devices and zero prior room
// memberships, so it sidesteps BOTH device inflation AND the per-user room-sync drag — a virgin
// user only ever syncs the rooms it just created. Crucially, it leaves the dev's persistent
// dogfood alice/bob (and the channels they own) untouched: determinism without nuking dogfood.
//
// One call == one logical group sharing a single run suffix, so the members of an invite/
// membership scenario stay grouped (e.g. freshUsers(['snd']) for a single-user suite; or a pair
// for a two-party suite). Mirrors the pattern already proven by the membership/create/reset
// gates; this hoists it to one point of truth.
//
// Async since issue #7 M2: mintToken now probes token activation against the homeserver before
// returning, so every fresh user comes back with a token Synapse already accepts. MXIDs are
// resolved lazily by the caller via whoami(user.token) — most single-user suites never need them,
// and the invite/membership suites already resolve dynamically, so this helper does not pay for
// whoami. Tuple-mapped return so positional destructuring stays type-safe under
// noUncheckedIndexedAccess: `const [snd] = await freshUsers(['snd'])` types `snd` as FreshUser,
// not FreshUser | undefined. A non-literal string[] degrades to FreshUser[] (mapped over an array).
export async function freshUsers<const P extends readonly string[]>(
  prefixes: P,
): Promise<{ [K in keyof P]: FreshUser }> {
  const suffix = `${process.pid}${Math.floor(Math.random() * 1e6)}`
  const users: FreshUser[] = []
  for (const prefix of prefixes) {
    const name = `${prefix}${suffix}`
    registerUser(name)
    users.push({ name, token: await mintToken(name) })
  }
  return users as { [K in keyof P]: FreshUser }
}
