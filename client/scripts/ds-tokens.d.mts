// Types for scripts/ds-tokens.mjs (consumed by test/ds-tokens.test.ts).
export const DS_PROJECT_DIR: string
export function dsProjectAvailable(): boolean
export function buildDesignSystem(projectDir?: string): Promise<{ ds: unknown }>
