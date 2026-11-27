# @tayet/push

The push gateway of an installation (ADR-117). The homeserver posts each push notification to it
(Push Gateway API, `POST /_matrix/push/v1/notify`); it keeps only what the app would show (the
per-conversation mark, a mention highlight, or an invite to a direct conversation or group), and
sends that as Web Push (RFC 8030), encrypted for the subscription (RFC 8291, `aes128gcm`) and signed
with the installation's VAPID key (RFC 8292). It has no runtime dependency and no state on disk.

## Running

Requires Node 22+ (it runs from source with native type stripping; there is no build step).

```bash
npm ci
node --experimental-strip-types src/server.ts
```

When ready it prints one JSON line, `{"listening": <port>}`. `npm run check` runs typecheck, lint
and unit tests; `npm test -- test/integration/` runs the proof against `infra/dev-stack/`.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `PUSH_VAPID_PRIVATE_KEY` | yes | P-256 private scalar, 32 bytes base64url — never commit it |
| `PUSH_VAPID_PUBLIC_KEY` | yes | Matching uncompressed public point, 65 bytes base64url |
| `PUSH_VAPID_SUBJECT` | yes | VAPID `sub`: an `https:` or `mailto:` URL |
| `PUSH_ALLOWED_ENDPOINTS` | no | Comma-separated push service hosts; `*.` matches subdomains; `http://<host>` allows a local test receiver. Default: `fcm.googleapis.com`, `*.push.apple.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com` |
| `PUSH_PORT` | no | Listen port (default `0`, ephemeral) |
| `PUSH_BIND` | no | Bind address (default `127.0.0.1`) |

## Pusher

The client registers an `http` pusher whose `pushkey` is the subscription's `p256dh` key
(base64url) and whose `data` carries `url` (this service), `endpoint` and `auth`.

## Answers

A dropped notification is `200 {"rejected": []}`. A subscription the push service reports gone
(404, 410), or one that is malformed or points outside the allowed list, comes back in `rejected`,
and the homeserver deletes it. 429, 5xx, a network error or the 10 s timeout is a 502, which the
homeserver retries with backoff. Any other status is logged with the host and answered 200.
