import { useState } from 'react'
import type { Acl, MessageId } from '@tayet/client'
import { useChat } from './useChat'
import { useTheme } from './useTheme'
import { useNotificationsPrompt } from './useNotificationsPrompt'
import { useSearch } from './useSearch'
import { Workspace } from './components/Workspace'
import { MediaProvider } from './MediaContext'

// App = state (useChat) + presentation (Workspace). The ACL instance is injected; the UI never
// constructs protocol concepts and imports only the @tayet/client barrel (ADR-007).
export function App({ acl, onSignOut }: { acl: Acl; onSignOut: () => void }) {
  const chat = useChat(acl)
  const { theme, setTheme } = useTheme()
  const notifications = useNotificationsPrompt()
  const search = useSearch(acl, chat.selectedId)
  // The hit last opened stays selected while the results are on screen (manifest workspace.md §8 item 9).
  const [picked, setPicked] = useState<MessageId | undefined>(undefined)
  return (
    <MediaProvider resolve={(ref, variant) => acl.resolveMedia(ref, variant)}>
      <Workspace
        channels={chat.channels}
        archivedChannels={chat.archivedChannels}
        onRestoreChannel={chat.unarchiveChannel}
        selectedChannelId={chat.selectedId}
        messages={chat.messages}
        panels={chat.panels}
        commands={chat.commands}
        usersById={chat.usersById}
        currentUser={chat.currentUser}
        connection={chat.connection}
        threadRoot={chat.threadRoot}
        threadMessages={chat.threadMessages}
        threadUnread={chat.threadUnread}
        threadUnreadByRoot={chat.threadUnreadByRoot}
        replyTarget={chat.replyTarget}
        onSelectChannel={chat.select}
        onSend={chat.send}
        onSendAttachment={chat.sendAttachment}
        onRetry={chat.retry}
        onAnswerApproval={chat.answerApproval}
        onReact={chat.toggleReaction}
        onEdit={chat.edit}
        onDelete={chat.remove}
        onReply={chat.startReply}
        onCancelReply={chat.cancelReply}
        onLoadOlder={chat.canLoadOlder ? chat.loadOlder : undefined}
        onOpenThread={chat.openThread}
        onCloseThread={chat.closeThread}
        onSendThread={chat.sendThread}
        onSendThreadAttachment={chat.sendThreadAttachment}
        managing={chat.managing}
        members={chat.members}
        onManageChannel={chat.manageChannel}
        onCloseManage={chat.closeManage}
        onUpdateChannel={chat.updateChannel}
        onArchiveChannel={chat.archiveChannel}
        onLeaveChannel={chat.leaveChannel}
        onConvertToChannel={chat.convertToChannel}
        onAddMember={chat.addMember}
        onRemoveMember={chat.removeMember}
        onSetRole={chat.setMemberRole}
        loadCandidates={chat.listCandidates}
        onCreateChannel={chat.createChannel}
        onOpenDirectMessage={chat.openDirectMessage}
        onOpenGroupConversation={chat.openGroupConversation}
        loadKnownContacts={chat.listKnownContacts}
        isOwnAgent={chat.isOwnAgent}
        accesses={chat.accesses}
        orgAdmin={chat.orgAdmin}
        people={chat.people}
        onInvitePerson={chat.invitePerson}
        onRemovePerson={chat.removePerson}
        onCreateAgent={chat.createAgent}
        onUpdateAgent={chat.updateAgent}
        onReissueAgent={chat.reissueAgent}
        onRemoveAgent={chat.removeAgent}
        onLoadProfile={chat.loadMyProfile}
        onLoadUserProfile={chat.loadUserProfile}
        onLoadCommonChannels={chat.loadCommonChannels}
        presenceByUser={chat.presenceByUser}
        onGetPresence={chat.getPresence}
        onSubscribePresence={chat.subscribePresence}
        onSaveProfile={chat.saveProfile}
        onSaveAvatar={chat.saveAvatar}
        onClearAvatar={chat.clearAvatar}
        onExportData={chat.exportMyData}
        onReset={chat.requestReset}
        onSignOut={onSignOut}
        theme={theme}
        onThemeChange={setTheme}
        notificationsPrompt={
          notifications.prompt ? { onEnable: notifications.enable, onDismiss: notifications.dismiss } : undefined
        }
        newAccesses={chat.newAccesses}
        onDismissAccess={chat.dismissAccess}
        attentionNeeded={chat.attentionNeeded}
        resetStatus={chat.resetStatus}
        search={{
          query: search.query,
          onQuery: search.setQuery,
          scoped: search.scoped,
          onToggleScope: search.toggleScope,
          onClear: () => {
            setPicked(undefined)
            search.clear()
          },
          active: search.active,
          hits: search.hits,
          searched: search.searched,
          preparing: search.state.preparing,
          partial: search.state.partial,
          selected: picked,
          failed: chat.jump?.failed ? chat.jump.target : undefined,
          onPick: ({ hit }) => {
            setPicked(hit.message.id)
            chat.jumpTo(hit)
          },
        }}
        jump={chat.jump}
        highlight={chat.highlight}
        onHighlightEnd={chat.clearHighlight}
      />
    </MediaProvider>
  )
}
