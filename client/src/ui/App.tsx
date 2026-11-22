import { useEffect, useRef, useState } from 'react'
import type { Acl, MessageId } from '@tayet/client'
import { useChat } from './useChat'
import { useTheme } from './useTheme'
import { useLanguage } from './useLanguage'
import { useNotificationsPrompt } from './useNotificationsPrompt'
import { useSearch } from './useSearch'
import { useAgentForm } from './useAgentForm'
import { Workspace } from './components/Workspace'
import { MediaProvider } from './MediaContext'
import { useNarrowWindow } from './narrow'
import { StackProvider, useStackPopTo, useStackScreens } from './stack'

// App = state (useChat) + presentation (Workspace). The ACL instance is injected; the UI never
// constructs protocol concepts and imports only the @tayet/client barrel (ADR-007).
export function App({ acl, onSignOut }: { acl: Acl; onSignOut: () => void }) {
  return (
    <StackProvider>
      <Shell acl={acl} onSignOut={onSignOut} />
    </StackProvider>
  )
}

function Shell({ acl, onSignOut }: { acl: Acl; onSignOut: () => void }) {
  // Below the width breakpoint the shell is a stack, kept in step with the browser history.
  const narrow = useNarrowWindow()
  const chat = useChat(acl, { narrow })
  const search = useSearch(acl, chat.selectedId, narrow)
  // The hit last opened stays selected while the results are on screen (manifest workspace.md §8 item 9).
  const [picked, setPicked] = useState<MessageId | undefined>(undefined)
  const clearSearch = (): void => {
    setPicked(undefined)
    search.clear()
  }
  // The narrow window's full-screen search (PLANO-MOBILE M6 B1 to B3): a screen between the list and the
  // conversation. Going back from it clears the query; narrowing with a query open opens it with the query;
  // widening keeps the query in the column.
  const [searchOpen, setSearchOpen] = useState(false)
  const wasNarrow = useRef(narrow)
  useEffect(() => {
    if (narrow && !wasNarrow.current) setSearchOpen(search.active)
    if (!narrow) setSearchOpen(false)
    wasNarrow.current = narrow
  }, [narrow, search.active])
  useStackScreens({
    narrow,
    search: searchOpen,
    chat: chat.selectedId !== undefined,
    thread: chat.threadRoot !== undefined && chat.threadRoot.channelId === chat.selectedId,
    onPopSearch: () => {
      setSearchOpen(false)
      clearSearch()
      chat.dismissJump()
    },
    onPopChat: chat.deselect,
    onPopThread: chat.closeThread,
  })
  // B2: a jump that fails on the narrow window comes back to the search by itself, through the history;
  // the failure line shows on its hit.
  const popTo = useStackPopTo()
  const jumpFailed = chat.jump?.failed === true
  useEffect(() => {
    if (narrow && searchOpen && jumpFailed) popTo('search')
  }, [narrow, searchOpen, jumpFailed, popTo])
  const { theme, setTheme } = useTheme()
  const language = useLanguage(acl)
  const notifications = useNotificationsPrompt()
  const agentForm = useAgentForm(acl)
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
        language={language}
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
          onClear: clearSearch,
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
          open: searchOpen,
          // ⌘K from a conversation trades it for the search (the order is list, search, conversation).
          onOpen: () => {
            if (chat.selectedId !== undefined) chat.deselect()
            setSearchOpen(true)
          },
        }}
        jump={chat.jump}
        agentForm={agentForm}
        highlight={chat.highlight}
        onHighlightEnd={chat.clearHighlight}
        narrow={narrow}
        onBackToList={chat.deselect}
      />
    </MediaProvider>
  )
}
