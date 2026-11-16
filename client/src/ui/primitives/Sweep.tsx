// Sweep (ADR-036 dec. 3; PLANO-AGENTES §0.3.16 item 19): the indeterminate progress bar — a 2px track and
// a 25% sweep (workspace.md §8 items 7 and 10, §6.7). Promoted from SearchResults at its fourth consumer
// (search, the timeline's jump pill, the account's reset, the reset banner's `pending`). Decorative: the
// status text beside it carries the meaning. Width comes from the surface (block by default).
export function Sweep() {
  return (
    <span className="sweep" aria-hidden="true">
      <span className="sweep__bar" />
    </span>
  )
}
