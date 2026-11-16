// The "acknowledged accesses" set persisted in account data (ADR-018 §4). Pure helpers — no
// SDK, no protocol object — so they are unit-testable without the live stack. matrix-client reads
// the set with them; it writes its in-memory set (ADR-063, adendo). The account-data KEY is a protocol detail and
// NEVER crosses the acl/index.ts barrel (asserted by the leak-scan + a surface unit).

// Custom account-data key (per-account, synced across devices). Internal to the ACL.
export const ACKNOWLEDGED_DEVICES_KEY = 'io.tayet.acknowledged_devices'
// Legacy key of the same set (pre-io.tayet.* namespace). Still READ — the recognized set is
// the union of both keys — but never written nor deleted, so accesses acknowledged before the
// rename stay silent. Internal to the ACL, like the current key.
export const LEGACY_ACKNOWLEDGED_DEVICES_KEY = 'io.aurora.acknowledged_devices'

interface AcknowledgedContent {
  devices?: unknown
}

// Read the persisted set from raw account-data content. Tolerant of absent/malformed content
// (a virgin account has no such event) — anything non-string is dropped. `legacyContent` is the
// content under LEGACY_ACKNOWLEDGED_DEVICES_KEY; the result is the union of both.
export function readAcknowledged(content: unknown, legacyContent?: unknown): Set<string> {
  const set = new Set<string>()
  for (const c of [content, legacyContent]) {
    const devices = (c as AcknowledgedContent | null | undefined)?.devices
    if (!Array.isArray(devices)) continue
    for (const d of devices) if (typeof d === 'string') set.add(d)
  }
  return set
}
