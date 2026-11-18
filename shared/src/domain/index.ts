// Domain barrel — the clean vocabulary every module above the ACL operates on.
// Pure types, no runtime, no protocol terminology. Re-exported by acl/index.ts so
// consumers have a single import surface.
export type { Brand } from './brand'
export type { ChannelId, UserId, MessageId, DeviceId, MediaRef, AccessId, FormId } from './ids'
export type { RichInline, RichBlock, RichDoc } from './rich'
export type {
  Timestamp,
  Role,
  MemberState,
  Presence,
  User,
  UserKind,
  AgentColor,
  Person,
  MyProfile,
  UserProfile,
  OrgFields,
  UnreadState,
  ThreadUnread,
  Channel,
  Reaction,
  UnsupportedShape,
  MessageBody,
  ApprovalOption,
  ApprovalState,
  AgentForm,
  FormChoices,
  FormField,
  FormIssue,
  FormOption,
  FormOptionGroup,
  FormState,
  FormValues,
  AgentCommand,
  AgentPanel,
  ThreadSummary,
  Message,
  Device,
} from './entities'
