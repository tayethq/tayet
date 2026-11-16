// Mimetype → Matrix msgtype inference. ONE-WAY, ACL-internal, never exposed by the barrel:
// the client only ever expresses intent (OutgoingBody `attachment`); naming the msgtype is the
// ACL's job (P1 / ADR-007). The asymmetry with the inbound MessageBody (image vs file) is
// deliberate (see acl/types.ts OutgoingBody invariant).
export type MatrixMsgtype = 'm.image' | 'm.video' | 'm.audio' | 'm.file'

export function mimetypeToMsgtype(mimetype: string | undefined): MatrixMsgtype {
  const m = (mimetype ?? '').toLowerCase()
  if (m.startsWith('image/')) return 'm.image'
  if (m.startsWith('video/')) return 'm.video'
  if (m.startsWith('audio/')) return 'm.audio'
  return 'm.file'
}
