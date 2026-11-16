// An edit applies only when it comes from the author of the message it targets (PLANO-AGENTES §8.30;
// §0 da A3, blocker 0.2). The protocol lets any member of a conversation send a replacement for any
// event; honouring it unchecked let a member rewrite, on everyone's screen, a message of another
// person or of an agent (P6). This is the ONE place that decides it, for the client and the sidecar,
// on every path: the live stream, the pages, the server's bundled edit and the SDK's own replacements.
//
// Pure: it compares the two senders and nothing else. An unknown sender on either side — the caller
// could not establish the target's author — is never a match: an edit is not applied unchecked.
export function editAppliesTo(editSender: string | null | undefined, targetSender: string | null | undefined): boolean {
  return typeof editSender === 'string' && editSender !== '' && editSender === targetSender
}
