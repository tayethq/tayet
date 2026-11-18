// @tayet/shared — domain types + ACL contract types + product errors (vocabulary-clean surface).
// Exports BY NAME (ADR-088 dec. 2): the barrel-vocabulary selector matches export specifiers, and an
// `export *` has none — it would make the gate inert. eslint.config.js forbids `export *` here.

export type {
  AccessId,
  AgentCommand,
  AgentForm,
  AgentPanel,
  AgentColor,
  ApprovalOption,
  ApprovalState,
  Brand,
  Channel,
  ChannelId,
  Device,
  DeviceId,
  FormChoices,
  FormField,
  FormId,
  FormIssue,
  FormOption,
  FormOptionGroup,
  FormState,
  FormValues,
  MediaRef,
  MemberState,
  Message,
  MessageBody,
  MessageId,
  MyProfile,
  OrgFields,
  Person,
  Presence,
  Reaction,
  RichBlock,
  RichDoc,
  RichInline,
  Role,
  ThreadSummary,
  ThreadUnread,
  Timestamp,
  UnreadState,
  UnsupportedShape,
  User,
  UserId,
  UserKind,
  UserProfile,
} from './domain'

export type { AclMode, AclTelemetry, ConceptKind, RosterEntry } from './acl-types'

// Presentation (ADR-088 addendum 2026-11-09): markdown → RichDoc, used by the sidecar for agent text
// and by the client's composer parity tests; and the href predicate shared with the translator.
export { parseCompose } from './markdown'
export type { ComposeResult } from './markdown'
export { safeHref } from './href'

// ADR-094 (Proposto) dec. 7: the most others a group conversation can hold (the opener not counted).
export { GROUP_MAX_OTHERS } from './conversation'

// ADR-096 (Proposto) dec. 2: the open data export format, v1 — types, the incremental builder, the
// manifest reader and the attachment file-name rule. Public description: EXPORT-FORMAT.md.
export {
  createExportBuilder,
  EXPORT_ACCOUNT_PATH,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  EXPORT_MANIFEST_PATH,
  EXPORT_README_PATH,
  InvalidExportError,
  readExportManifest,
  sanitizeExportFileName,
  UnsupportedExportVersionError,
} from './export'
export type {
  ExportAccess,
  ExportAccessInput,
  ExportAccount,
  ExportApprovalResponseInput,
  ExportApprovalResponseItem,
  ExportAttachment,
  ExportAttachmentInput,
  ExportBuilder,
  ExportConversationEntry,
  ExportConversationFile,
  ExportConversationInput,
  ExportConversationKind,
  ExportConversationWriter,
  ExportCounts,
  ExportDeletedItem,
  ExportFile,
  ExportFormField,
  ExportFormSubmissionInput,
  ExportFormSubmissionItem,
  ExportItem,
  ExportItemInput,
  ExportManifest,
  ExportMarkerInput,
  ExportMessageInput,
  ExportMessageItem,
  ExportPersonEntry,
  ExportPersonInput,
  ExportPersonKind,
  ExportProfile,
  ExportProfileInput,
  ExportScope,
  ExportStartInput,
  ExportTotals,
  ExportUnreadableItem,
  ExportUnsupportedItem,
} from './export'

export {
  ConnectionError,
  NameInUseError,
  PeopleUnavailableError,
  PersonExistsError,
  RateLimitedError,
  SessionExpiredError,
  UntranslatableConceptError,
} from './errors'
