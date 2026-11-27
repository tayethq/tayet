// The ACL invites by a direct call to the server, not by the SDK's `invite` (ADR-057, addendum of
// 24/Nov/2026). Fakes route that call here: `POST /rooms/{roomId}/invite` with `{ user_id }` reaches
// `onInvite(roomId, userId)`. The direct-conversation map is written by a direct call too (issue #421, F1):
// `PUT /user/{userId}/account_data/m.direct` reaches `onDirectMap(content)` when given, and otherwise
// resolves. Any other request is a test bug and throws.
export type DirectInvite = (roomId: string, userId: string) => Promise<unknown> | unknown
export type DirectMapWrite = (content: Record<string, string[]>) => Promise<unknown> | unknown

export interface DirectInviteCall {
  method: string
  path: string
  body: unknown
}

const INVITE_PATH = /^\/rooms\/([^/]+)\/invite$/
const DIRECT_MAP_PATH = /^\/user\/[^/]+\/account_data\/m\.direct$/

export function directInviteHttp(
  onInvite: DirectInvite,
  calls: DirectInviteCall[] = [],
  onDirectMap?: DirectMapWrite,
): { authedRequest: (method: string, path: string, query?: unknown, body?: unknown) => Promise<unknown> } {
  return {
    authedRequest: async (method, path, _query, body) => {
      calls.push({ method, path, body })
      if (method === 'PUT' && DIRECT_MAP_PATH.test(path))
        return onDirectMap ? onDirectMap(body as Record<string, string[]>) : {}
      const match = INVITE_PATH.exec(path)
      const userId = (body as { user_id?: unknown } | undefined)?.user_id
      if (method !== 'POST' || !match || typeof userId !== 'string')
        throw new Error(`unexpected request in fake: ${method} ${path}`)
      return onInvite(decodeURIComponent(match[1]!), userId)
    },
  }
}
