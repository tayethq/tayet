import type { Acl, AclOptions } from './types'
import { MatrixGateway } from './internal/matrix-client'

// D3 is a constructive property of the ACL, injected at construction — not try/catch
// scattered around. `mode` and `telemetry` are threaded to the (stubbed) translators:
// `strict` makes an untranslatable concept throw UntranslatableConceptError (red test
// before shipping); `lenient` degrades by nature (content-carrying → visible 'unsupported';
// noise → silent discard). The type invariant guarantees only branded domain ever escapes.
//
// Stub: methods throw 'not impl'; the real translators land in the next slice.
const notImpl = (): never => {
  throw new Error('not impl')
}

export function createAcl(opts: AclOptions): Acl {
  const gateway = new MatrixGateway(opts)

  return {
    // Outbound reads — the gateway returns clean domain types; no SDK object reaches here.
    getChannels: async () => gateway.getChannels(),
    getArchivedChannels: async () => gateway.getArchivedChannels(),
    getChannel: async (id) => gateway.getChannel(id),
    getTimeline: (id, opts) => gateway.getTimeline(id, opts),
    getMembers: async (id) => gateway.getMembers(id),
    // ADR-083: lista do state de #all e flag de admin da org.
    listPeople: async () => gateway.listPeople(),
    // ADR-090: os agentes que a sessão opera, do state de #all — síncrono.
    listOwnAgents: () => gateway.listOwnAgents(),
    isOrgAdmin: () => gateway.isOrgAdmin(),
    // ADR-056: synchronous point read off the ACL-side presence map — pass-through.
    getPresence: (user) => gateway.getPresence(user),
    // ADR-114: synchronous point read of the last reported connection state — pass-through.
    getConnectionState: () => gateway.getConnectionState(),
    // ADR-115: synchronous point read of what the session may do in a channel — pass-through.
    getChannelAbilities: (id) => gateway.getChannelAbilities(id),
    getDevices: async () => gateway.getDevices(),
    currentUser: () => gateway.currentUser(),
    // ADR-040 → ADR-042: leitura + patch editável (account-data + setDisplayName + extended profile) —
    // pass-through direto pro gateway.
    getMyProfile: () => gateway.getMyProfile(),
    updateMyProfile: (patch) => gateway.updateMyProfile(patch),
    // ADR-043: leitura de perfil de OUTRO usuário (extended profile MSC4133, fail-soft) — pass-through.
    getUserProfile: (user) => gateway.getUserProfile(user),
    // ADR-041: verbos de mídia de perfil — upload cleartext + gravação do avatar no gateway, pass-through.
    setAvatar: (file) => gateway.setAvatar(file),
    removeAvatar: () => gateway.removeAvatar(),
    // Account preferences (language): straight server read and write — pass-through.
    getAccountPreferences: (opts) => gateway.getAccountPreferences(opts),
    setAccountPreferences: (patch) => gateway.setAccountPreferences(patch),
    getThreadUnread: async (id, root) => gateway.getThreadUnread(id, root),
    // ADR-074: busca no índice local e leitura pontual — pass-through.
    searchMessages: (query, opts) => gateway.searchMessages(query, opts),
    getMessage: (channelId, messageId) => gateway.getMessage(channelId, messageId),
    // ADR-091 dec. 12 (A3-5): os painéis fixados da conversa, já filtrados e ordenados — pass-through.
    listPanels: (channelId) => gateway.listPanels(channelId),
    // ADR-093 (Proposto): os comandos `/` da conversa, lista plana já filtrada e ordenada — pass-through.
    listCommands: (channelId) => gateway.listCommands(channelId),

    // ADR-099: the observed read of the cards awaiting the person — pass-through.
    watchAwaitingApprovals: () => gateway.watchAwaitingApprovals(),

    // Stream (multicast; reconciliation happens in the gateway, never in the UI).
    subscribe: (handler) => gateway.subscribe(handler),
    subscribeChannel: (id, handler) => gateway.subscribeChannel(id, handler),

    // Inbound
    sendMessage: (channelId, body, opts) => gateway.sendMessage(channelId, body, opts),
    editMessage: (messageId, body) => gateway.editMessage(messageId, body),
    answerApproval: (messageId, option) => gateway.answerApproval(messageId, option),
    submitForm: (formId, values) => gateway.submitForm(formId, values),
    closeForm: (formId) => gateway.closeForm(formId),
    deleteMessage: (messageId) => gateway.deleteMessage(messageId),
    react: (messageId, emoji) => gateway.react(messageId, emoji),
    removeReaction: (messageId, emoji) => gateway.removeReaction(messageId, emoji),
    markRead: (id, upToMessageId) => gateway.markRead(id, upToMessageId),

    // Canais, membership, papel e DM (PLANO-MEMBERSHIP-CANAIS §0.2). unarchiveChannel é o sibling
    // de archiveChannel (ADR-076).
    createChannel: (input) => gateway.createChannel(input),
    archiveChannel: (id) => gateway.archiveChannel(id),
    unarchiveChannel: (id) => gateway.unarchiveChannel(id),
    updateChannel: (id, patch) => gateway.updateChannel(id, patch),
    leaveChannel: (id) => gateway.leaveChannel(id),
    addMember: (channelId, user) => gateway.addMember(channelId, user),
    removeMember: (channelId, user) => gateway.removeMember(channelId, user),
    invitePerson: (person) => gateway.invitePerson(person),
    removePerson: (user) => gateway.removePerson(user),
    createAgent: (name, color) => gateway.createAgent(name, color),
    updateAgent: (user, patch) => gateway.updateAgent(user, patch),
    reissueAgent: (user) => gateway.reissueAgent(user),
    removeAgent: (user) => gateway.removeAgent(user),
    getOrgAccess: () => gateway.getOrgAccess(),
    setOrgAdmin: (user, admin) => gateway.setOrgAdmin(user, admin),
    setRole: (channelId, user, role) => gateway.setRole(channelId, user, role),
    openDirectMessage: (user) => gateway.openDirectMessage(user),
    openGroupConversation: (users) => gateway.openGroupConversation(users),
    convertToChannel: (id, name) => gateway.convertToChannel(id, name),
    acknowledgeAccess: (access) => gateway.acknowledgeAccess(access),
    resetAccess: () => gateway.resetAccess(),
    // ADR-117 dec. 6: this device's notifications with the app closed — pass-through.
    enableDeviceNotifications: (subscription) => gateway.enableDeviceNotifications(subscription),
    disableDeviceNotifications: () => gateway.disableDeviceNotifications(),
    resolveNotificationTarget: (target) => gateway.resolveNotificationTarget(target),
    resolveMedia: (ref, variant) => gateway.resolveMedia(ref, variant),
    // ADR-096: the person's data export, as parts — pass-through.
    exportMyData: (opts) => gateway.exportMyData(opts),
    resolveChannel: (_raw) => notImpl(),
    resolveUser: (_raw) => notImpl(),

    // Lifecycle (delegates to the SDK-owning internal gateway)
    connect: (session) => gateway.connect(session),
    disconnect: () => gateway.disconnect(),
    signOut: () => gateway.signOut(),
  }
}
