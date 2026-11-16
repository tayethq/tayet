// Icon primitive family (ADR-036 tier — dec. 3: adding a leaf primitive is in-tier work, no ADR).
//
// Convention (fixed here for the family):
//   • SVG inline, one component per icon in `ui/icons/<Name>.tsx`; this file is the barrel.
//   • `stroke="currentColor"` (inherits the wrapping button's text colour → token-driven; NEVER a
//     hex literal in the SVG — C6 applies here). `fill="none"`, `stroke-width` 1.75,
//     `stroke-linecap`/`stroke-linejoin` "round".
//   • Prop `size` (default 16 for the action bar) drives width/height.
//   • `aria-hidden="true"` on the `<svg>` — the accessible name lives on the wrapping button's
//     `aria-label`, never on the glyph.
//   • App-layer: never crosses the ACL barrel; no protocol vocabulary.
export type IconProps = {
  /** Square edge in px for width/height. Defaults to 16 (action-bar size). */
  size?: number
}

export { Reply } from './Reply'
export { Thread } from './Thread'
export { Edit } from './Edit'
export { Retry } from './Retry'
export { PaperPlane } from './PaperPlane'
export { Plus } from './Plus'
export { At } from './At'
export { Settings } from './Settings'
export { More } from './More'
export { List } from './List'
export { Link } from './Link'
export { Lock } from './Lock'
export { Search } from './Search'
export { Trash } from './Trash'
export { Chevron } from './Chevron'
export { Close } from './Close'
