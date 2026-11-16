import { HOMESERVER, invite, mintToken, whoami } from './synapse'
import { liftMessageRatelimit, mintAdminToken, PROBE_USER } from './synapse-admin'

// Admission to the organization (ADR-083), test side. A fresh user is a guest: it is not on the Dex
// allowlist that `up` reconciles, so a suite that needs the organization channel or a Role other than
// 'guest' admits it here, doing what the provisioner does: the event first, then the invite.

const ORG_ALIAS_LOCALPART = 'all'

export const ORG_MEMBER_EVENT = 'io.tayet.member'

// The state_key of the event: the mxid without the sigil (ADR-083 dec. 3).
export const orgMemberKey = (mxid: string): string => mxid.slice(1)

let system: Promise<{ token: string; roomId: string }> | undefined

async function systemSession(): Promise<{ token: string; roomId: string }> {
  const token = await mintToken('system')
  const mxid = await whoami(token)
  // All writes of every suite come from this one account, and rc_message is keyed on the sender.
  await liftMessageRatelimit(mintAdminToken(PROBE_USER), mxid)
  const alias = `#${ORG_ALIAS_LOCALPART}:${mxid.slice(mxid.indexOf(':') + 1)}`
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`)
  if (!res.ok) throw new Error(`org channel alias -> ${res.status} ${await res.text()}`)
  const { room_id: roomId } = (await res.json()) as { room_id: string }
  return { token, roomId }
}

export async function orgSystemSession(): Promise<{ token: string; roomId: string }> {
  system ??= systemSession()
  return system
}

// PUT of the organization event as `token`. The status is the point: the negative tests assert it.
export async function putOrgMember(token: string, roomId: string, mxid: string): Promise<number> {
  const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${ORG_MEMBER_EVENT}/${encodeURIComponent(orgMemberKey(mxid))}`
  const res = await fetch(`${HOMESERVER}${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'member' }),
  })
  return res.status
}

export async function admitToOrg(...tokens: string[]): Promise<void> {
  const { token, roomId } = await orgSystemSession()
  for (const userToken of tokens) {
    const mxid = await whoami(userToken)
    const status = await putOrgMember(token, roomId, mxid)
    if (status !== 200) throw new Error(`${ORG_MEMBER_EVENT} -> ${status}`)
    await invite(token, roomId, mxid)
  }
}
