// Component primitive tier barrel (ADR-036). Local convenience re-export for the `ui/` layer;
// primitives are app-layer and cross nothing below them. Grows as each primitive lands.
export type { Size } from './types'
export { Avatar, type AvatarVariant } from './Avatar'
export { Field } from './Field'
export { Button, type ButtonVariant } from './Button'
export { Segmented, type SegmentedOption } from './Segmented'
export { Dialog } from './Dialog'
export { Sweep } from './Sweep'
