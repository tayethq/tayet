// node:http ↔ Web Request/Response for the MCP handler (PLANO-AGENTES §0.3.13 item 2): the SDK's transport
// speaks Web `Request`/`Response`; the `@modelcontextprotocol/node` adapter would bring a framework, so
// this one is ours. The body was already read by the listener (with its limit); it goes in as bytes and,
// when it is JSON, as `parsedBody` too (the SDK then classifies from the value and reads nothing).
import type { IncomingMessage, ServerResponse } from 'node:http'

export function toWebRequest(req: IncomingMessage, body: Buffer, signal: AbortSignal): Request {
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one)
  }
  // The URL is only the SDK's view of the request; the Host was checked by the listener.
  return new Request(`http://local${req.url ?? '/'}`, { method: req.method ?? 'POST', headers, body: new Uint8Array(body), signal })
}

export function parsedBodyOf(body: Buffer): { parsedBody: unknown } | Record<string, never> {
  try {
    return { parsedBody: JSON.parse(body.toString('utf8')) as unknown }
  } catch {
    // Not JSON: the SDK reads the bytes and answers its own parse error.
    return {}
  }
}

// Status, headers, then the body piped as it comes (a JSON body, or an SSE stream that ends with the
// exchange). The client going away cancels the stream.
export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {}
  response.headers.forEach((v, k) => {
    headers[k] = v
  })
  res.writeHead(response.status, headers)
  if (response.body === null) {
    res.end()
    return
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader()
  const cancel = (): void => void reader.cancel().catch(() => {})
  res.once('close', cancel)
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!res.write(chunk.value)) {
        await new Promise<void>((r) => {
          res.once('drain', r)
          res.once('close', r)
        })
      }
    }
    res.end()
  } catch {
    res.destroy()
  } finally {
    res.off('close', cancel)
  }
}
