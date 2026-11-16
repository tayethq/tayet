import type { Brand } from '@tayet/shared'

// Opaque session handle. Two shapes, both opaque to the app: (1) a bare MAS `mct_…` token (Fase 0 /
// dogfood legacy), or (2) a serialized renewable OIDC blob (access+refresh+device+issuer+clientId+
// homeserver — ADR-032 D2). The ACL never sees raw credentials; the domain never sees the token. The
// app obtains it from the auth flow (env legacy OR OIDC) and hands it to the ACL — the only layer
// that interprets/deserializes it. Refresh lives in the ACL; persistence in the app (onSessionRenewed).
export type OpaqueSession = Brand<string, 'OpaqueSession'>
