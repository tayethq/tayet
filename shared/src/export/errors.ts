// Errors of the export reader. Their messages never carry file content.

/** The text is not a format-v1-compatible manifest: not JSON, wrong `format`, or a malformed field. */
export class InvalidExportError extends Error {
  override readonly name = 'InvalidExportError'
}

/** The manifest declares a `formatVersion` newer than this code knows. */
export class UnsupportedExportVersionError extends Error {
  override readonly name = 'UnsupportedExportVersionError'
  constructor(
    readonly version: number,
    readonly supported: number,
  ) {
    super(`export: format version ${version} is newer than the supported ${supported}`)
  }
}
