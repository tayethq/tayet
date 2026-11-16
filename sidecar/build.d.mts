// Types of build.mjs, for the dist smoke that bundles a probe with the same options.
import type { BuildOptions } from 'esbuild'

export declare const EXTERNAL: string[]
export declare function options(entry: string, outfile: string): BuildOptions
