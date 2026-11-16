import type { AgentColor, AgentCommand, User, UserId } from '@tayet/client'
import type { ComposeResult } from '../compose'
import { RichComposer, type ComposerCommand } from '../composer/RichComposer'

// Composer (ADR-051 PR-5): the WYSIWYG island IS the composer now — the flag and the whole textarea
// path are gone. This is a thin adapter that forwards the app's props to RichComposer, keeping the
// call-sites (Workspace, ThreadPanel) pointed at a stable name. `onSend` emits the rich ComposeResult
// ({ text, rich? }); the ACL owns the protocol translation (ADR-012). `full` is the channel composer
// (with the reply banner); `compact` is the thread panel (same card, icon-only send). The mention picker, formatting toolbar, link dialog, and attachment
// affordance all live in the island (RichComposer).
export function Composer({
  onSend,
  onSendAttachment,
  users,
  commands,
  replyingTo,
  onCancelReply,
  disabled,
  variant = 'full',
  placeholder,
}: {
  onSend: (body: ComposeResult, mentions: UserId[], command?: ComposerCommand) => void
  onSendAttachment?: (file: File) => void
  // The channel's members, for the @-mention picker (ADR-037 M2b). Optional — a mount without it
  // never opens the picker. The UI carries only opaque User/UserId — never an mxid (P1).
  users?: User[]
  // ADR-093 (Proposto): the conversation's `/` commands for the suggestion popup (PLANO-AGENTES §0.3.24 item 1).
  commands?: AgentCommand[]
  // Reply mode (PLANO-FASE-1-REPLY §4 commit 6): a clean-domain indicator of the reply target (display
  // name + excerpt, both protocol-free strings resolved by the parent) plus a cancel affordance.
  // The composer never carries an id — the parent owns the target Message.
  replyingTo?: { author: string; authorAgent?: AgentColor; excerpt: string }
  onCancelReply?: () => void
  disabled?: boolean
  // `compact` is the thread-panel shape: the same card, with an icon-only send.
  variant?: 'full' | 'compact'
  // The empty field's hint; absent = the variant's default (RichComposer).
  placeholder?: string
}) {
  return (
    <RichComposer
      onSend={onSend}
      onSendAttachment={onSendAttachment}
      users={users}
      commands={commands}
      replyingTo={replyingTo}
      onCancelReply={onCancelReply}
      disabled={disabled}
      variant={variant}
      placeholder={placeholder}
    />
  )
}
