// Operator logs (§0.3.5 adj. 8). stdout carries only the sidecar's own JSON lines, one per signal
// (`evt`), written synchronously (fs.writeSync) so a line right before process.exit is never lost on
// a pipe. The SDK and the crypto wasm log through `console`: silenced by default, sent to stderr with
// --debug. Credential and storage key never reach either stream: every secret registered here is
// replaced in every line, the sidecar's and the SDK's, as defence in depth over the discipline of
// never putting them in a log line in the first place.
import { writeSync } from 'node:fs'
import { format } from 'node:util'

const secrets = new Set<string>()

export function registerSecret(secret: string): void {
  if (secret.length >= 8) secrets.add(secret)
}

export function redact(text: string): string {
  let out = text
  for (const secret of secrets) out = out.split(secret).join('[redacted]')
  return out
}

export function log(line: Record<string, unknown>): void {
  writeSync(1, redact(JSON.stringify(line)) + '\n')
}

// Must run before the SDK is imported: loglevel binds the console methods when its loggers are
// created, so a later override would not reach them (the SDK is imported dynamically by the boot).
export function routeConsole(debug: boolean): void {
  const sink = debug
    ? (...args: unknown[]): void => {
        writeSync(2, redact(format(...args)) + '\n')
      }
    : (): void => {}
  console.log = sink
  console.info = sink
  console.debug = sink
  console.warn = sink
  console.error = sink
  console.trace = sink
}
