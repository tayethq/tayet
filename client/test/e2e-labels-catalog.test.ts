import { describe, it, expect } from 'vitest'
import { copy, fill } from './support/copy'
import {
  APP,
  LIST,
  NEW_CONVERSATION,
  GROUP,
  NOTIFICATIONS,
  MANAGE,
  TIMELINE,
  PLACEHOLDER_TEXTS,
  COMPOSER,
  LINK_DIALOG,
  THREAD,
  SEARCH,
  SESSION,
  ACCOUNT,
  DATA_EXPORT,
  PROFILE_EDITOR,
  PROFILE,
  PEOPLE,
  AGENTS,
  APPROVAL,
  PANEL,
  COMMANDS,
  FORMS,
} from '../e2e/support/labels'
import { APP_NAME, GLYPH } from '../src/ui/i18n'

// e2e/support/labels.ts mirrors the catalog (ADR-080 D5). The E2E tier never imports src/ (ADR-060
// D4), so the names stay literal there and this test — which may — pins each one to its catalog value.
// A copy change in the catalog without the same change in labels.ts is red here, before any browser.

describe('e2e labels mirror the catalog (ADR-080 D5)', () => {
  it('shell, list and search', () => {
    expect(APP).toEqual({ title: APP_NAME, account: copy.shell.account })
    expect(LIST.unread(3)).toBe(fill(copy.list.unread.other, { n: 3 }))
    expect(LIST.unread(1)).toBe(fill(copy.list.unread.one, { n: 1 }))
    for (const n of [1, 3]) expect(`cid ${LIST.unread(n)}`).toMatch(LIST.unreadSuffix)
    expect(LIST.mentions(3)).toBe(fill(copy.list.mentions.other, { n: 3 }))
    expect(LIST.mentions(1)).toBe(fill(copy.list.mentions.one, { n: 1 }))
    for (const n of [1, 3]) expect(`cid ${LIST.mentions(n)}`).toMatch(LIST.mentionsSuffix)
    expect({ ...LIST, unread: undefined, unreadSuffix: undefined, mentions: undefined, mentionsSuffix: undefined, orgChannel: undefined }).toEqual({
      unread: undefined,
      unreadSuffix: undefined,
      mentions: undefined,
      mentionsSuffix: undefined,
      orgChannel: undefined, // a channel's name, from the server — not copy
      nav: copy.list.nav,
      channels: copy.list.channels,
      dms: copy.list.dms,
      archived: copy.list.archived,
      newChannel: copy.list.newChannel,
      newDm: copy.list.newDm,
      restore: copy.list.restore,
      restoreFailed: copy.list.restoreFailed,
      enableNotifications: copy.list.enableNotifications,
      privateMark: copy.channel.privateMark,
    })
    expect(SEARCH.nothingFound('x')).toBe(fill(copy.search.nothingFound, { query: 'x' }))
    const { nothingFound: _n, ...search } = SEARCH
    expect(search).toEqual({ field: copy.search.field, results: copy.search.region, partial: copy.search.partial })
  })

  it('notifications', () => {
    expect(NOTIFICATIONS.titleInGroup('Ana')).toBe(fill(copy.notifications.titleInGroup, { author: 'Ana' }))
    expect(Object.keys(NOTIFICATIONS)).toEqual(['titleInGroup'])
  })

  it('data export', () => {
    expect(DATA_EXPORT).toEqual({
      entry: copy.dataExport.entry,
      dialog: copy.dataExport.title,
      prepare: copy.dataExport.prepare,
      ready: copy.dataExport.ready,
      readyWithGaps: copy.dataExport.readyWithGaps,
      download: copy.dataExport.download,
      close: copy.dialog.close,
      readmeFirstLine: copy.dataExport.readme.split('\n')[0],
    })
  })

  it('people', () => {
    expect(PEOPLE.remove('Ana')).toBe(fill(copy.people.removeLabel, { name: 'Ana' }))
    expect(PEOPLE.cancelInviteOf('Ana')).toBe(fill(copy.people.cancelInviteTitle, { name: 'Ana' }))
    const { remove: _r, cancelInviteOf: _c, ...people } = PEOPLE
    expect(people).toEqual({
      section: copy.people.orgSection,
      title: copy.people.title,
      filter: copy.people.filter,
      invite: copy.people.invite,
      kindMember: copy.people.kindMember,
      kindGuest: copy.people.kindGuest,
      pending: copy.people.pending,
      fieldName: copy.people.fieldName,
      fieldEmail: copy.people.fieldEmail,
      fieldKind: copy.people.fieldKind,
      submit: copy.people.submit,
      inviteReady: copy.people.inviteReady,
      copyInstructions: copy.people.copyInstructions,
      removeConfirm: copy.people.remove,
      cancelInvite: copy.people.cancelInvite,
    })
  })

  it('agents', () => {
    expect(AGENTS.operatedBy('Ana')).toBe(fill(copy.agent.operatedBy, { name: 'Ana' }))
    expect(AGENTS.edit('Ana')).toBe(fill(copy.agent.editLabel, { name: 'Ana' }))
    expect(AGENTS.remove('Ana')).toBe(fill(copy.agent.removeLabel, { name: 'Ana' }))
    const { operatedBy: _o, edit: _e, remove: _r, ...agents } = AGENTS
    expect(agents).toEqual({
      mark: copy.agent.label,
      add: copy.agent.add,
      createTitle: copy.agent.createTitle,
      createdTitle: copy.agent.createdTitle,
      editTitle: copy.agent.editTitle,
      reissuedTitle: copy.agent.reissuedTitle,
      fieldName: copy.agent.fieldName,
      fieldColor: copy.agent.fieldColor,
      create: copy.agent.create,
      save: copy.agent.save,
      done: copy.agent.done,
      reissueCredential: copy.agent.reissueCredential,
      reissue: copy.agent.reissue,
      removeConfirm: copy.agent.remove,
      credentialOnce: copy.agent.credentialOnce,
      copyCredentialOnly: copy.agent.copyCredentialOnly,
      colors: copy.agent.colors,
    })
  })

  it('new conversation and channel management', () => {
    expect(NEW_CONVERSATION.remove('Ana')).toBe(fill(copy.newConversation.removePerson, { name: 'Ana' }))
    expect(GROUP.block(3)).toBe(fill(copy.group.blockLabel.other, { n: 3 }))
    expect(GROUP.people(3)).toBe(fill(copy.group.people.other, { n: 3 }))
    expect({ ...GROUP, block: undefined, people: undefined }).toEqual({
      block: undefined,
      people: undefined,
      details: copy.group.details,
      convert: copy.group.convert,
      convertName: copy.group.convertName,
      leave: copy.group.leave,
    })
    expect({ ...NEW_CONVERSATION, remove: undefined }).toEqual({
      remove: undefined,
      dialog: copy.newConversation.title,
      name: copy.newConversation.name,
      public: copy.newConversation.public,
      private: copy.newConversation.private,
      createChannel: copy.newConversation.createChannel,
      startConversation: copy.newConversation.startConversation,
      cancel: copy.newConversation.cancel,
    })
    expect(MANAGE.open('#board')).toBe(fill(copy.channel.manageNamed, { name: '#board' }))
    expect(MANAGE.role('Ana')).toBe(fill(copy.channel.roleFor, { name: 'Ana' }))
    expect(MANAGE.remove('Ana')).toBe(fill(copy.channel.removeNamed, { name: 'Ana' }))
    const { open: _o, role: _r, remove: _m, ...fixed } = MANAGE
    expect(fixed).toEqual({
      addMember: copy.channel.addMember,
      members: copy.channel.members,
      close: copy.channel.closeManage,
      name: copy.channel.name,
      topic: copy.channel.topic,
      saved: copy.channel.saved,
      you: copy.channel.you,
      admin: copy.channel.roleAdmin,
      member: copy.channel.roleMember,
      guest: copy.channel.roleGuest,
      roleRefused: copy.channel.roleFailed,
      awaiting: copy.channel.awaiting,
      confirmRemove: copy.channel.remove,
      leave: copy.channel.leaveTitle,
      confirmLeave: copy.channel.leave,
      archive: copy.channel.archiveTitle,
      confirmArchive: copy.channel.archive,
    })
  })

  it('timeline, thread and composer', () => {
    expect(TIMELINE.replies(1)).toBe(fill(copy.timeline.replies.one, { n: 1 }))
    expect(TIMELINE.replies(4)).toBe(fill(copy.timeline.replies.other, { n: 4 }))
    expect(TIMELINE.react('👍')).toBe(fill(copy.timeline.react, { emoji: '👍' }))
    expect(TIMELINE.fileLink('a.pdf')).toBe(`${GLYPH.file} a.pdf`)
    const { replies: _p, react: _e, fileLink: _f, ...fixed } = TIMELINE
    expect(fixed).toEqual({
      log: copy.timeline.messages,
      dayToday: copy.timeline.dayToday,
      sending: copy.timeline.sending,
      edit: copy.timeline.editMessage,
      edited: copy.timeline.edited,
      delete: copy.timeline.deleteMessage,
      deleteQuestion: copy.timeline.deleteQuestion,
      confirmDelete: copy.timeline.delete,
      reply: copy.timeline.reply,
      replyInThread: copy.timeline.replyInThread,
      reactOpen: copy.timeline.reactOpen,
      mentionsYou: copy.timeline.mentionsYou,
      repliedMessage: copy.timeline.repliedMessage,
      unreadReplies: copy.timeline.unreadReplies,
    })
    expect(APPROVAL.answered('Ana', '09:05')).toBe(fill(copy.approval.answered, { name: 'Ana', time: '09:05' }))
    const { answered: _a, ...approval } = APPROVAL
    expect(approval).toEqual({ title: copy.approval.title, closed: copy.approval.closed, you: copy.timeline.you })
    expect(PANEL.section('Ana')).toBe(fill(copy.panel.section, { agent: 'Ana' }))
    expect(PANEL.updatedAt('09:05')).toBe(fill(copy.panel.updatedAt, { time: '09:05' }))
    expect(COMMANDS.popup).toBe(copy.composer.commands)
    expect(COMMANDS.placeholderFor('Ana')).toBe(fill(copy.composer.commandFor, { agent: 'Ana' }))
    expect(COMMANDS.placeholderHintFor('semana', 'Ana')).toBe(fill(copy.composer.commandHintFor, { hint: 'semana', agent: 'Ana' }))
    expect(COMMANDS.lineFor('Ana')).toBe(fill(copy.timeline.commandFor, { agent: 'Ana' }))
    expect(FORMS.noAnswer('Ana')).toBe(fill(copy.form.noAnswer, { agent: 'Ana' }))
    expect(FORMS.upTo(2)).toBe(fill(copy.form.upTo, { n: 2 }))
    expect(FORMS.replied('Ana', '09:05')).toBe(fill(copy.form.replied, { name: 'Ana', time: '09:05' }))
    expect(FORMS.minLength(3)).toBe(fill(copy.form.issue.minLength, { min: 3 }))
    expect(FORMS.between('1', '9')).toBe(fill(copy.form.issue.between, { min: '1', max: '9' }))
    const { noAnswer: _n, upTo: _u, replied: _r, minLength: _m, between: _b, ...forms } = FORMS
    expect(forms).toEqual({
      cancel: copy.form.cancel,
      close: copy.dialog.close,
      optional: copy.field.optional,
      failed: copy.timeline.failed,
      retry: copy.timeline.retry,
      sending: copy.timeline.sending,
      you: copy.timeline.you,
      required: copy.form.issue.required,
      integer: copy.form.issue.integer,
    })
    expect(PLACEHOLDER_TEXTS).toEqual([copy.timeline.awaited, copy.timeline.unavailable])
    expect(THREAD).toEqual({ panel: copy.thread.title, replies: copy.thread.replies, close: copy.thread.close })
    expect(COMPOSER.placeholderFor('x')).toBe(fill(copy.composer.placeholderFor, { name: 'x' }))
    expect({ ...COMPOSER, placeholderFor: undefined }).toEqual({
      editor: copy.composer.field,
      send: copy.composer.send,
      attach: copy.composer.attach,
      formatting: copy.composer.formatting,
      bold: copy.composer.bold,
      italic: copy.composer.italic,
      bulletedList: copy.composer.bulletList,
      link: copy.composer.link,
      mention: copy.composer.mention,
      save: copy.composer.editSave,
      replyingTo: copy.composer.replyingTo,
      cancelReply: copy.composer.cancelReply,
    })
    expect(LINK_DIALOG).toEqual({
      dialog: copy.composer.linkInsert,
      text: copy.composer.linkText,
      url: copy.composer.linkUrl,
      insert: copy.composer.linkInsertAction,
    })
  })

  it('session, account and profile', () => {
    expect(SESSION).toEqual({
      signOut: copy.account.signOut,
      ended: copy.boot.endedTitle,
      signInAgain: copy.boot.signInAgain,
      notices: copy.account.securityNotices,
      newAccess: copy.account.newAccess.one,
      dismiss: copy.account.dismissMine,
      elsewhere: copy.boot.otherTabTitle,
      useHere: copy.boot.useHere,
      takingOver: copy.boot.takingOver,
      takeoverStuck: copy.boot.takeoverStuck,
    })
    expect(ACCOUNT).toEqual({
      dialog: copy.account.title,
      close: copy.dialog.close,
      edit: copy.account.edit,
      accesses: copy.account.accessTitle,
      resetEntry: copy.account.resetTitle,
      reset: copy.account.reset,
      resetPending: copy.account.resetPending,
      resetDone: copy.account.resetDone,
      resetSignInAgain: copy.account.resetSignInAgain,
      resetNotDone: copy.account.resetNotDone,
      resetTryAgain: copy.account.resetTryAgain,
      resetBannerTitle: copy.account.resetBannerTitle,
    })
    expect(PROFILE_EDITOR).toEqual({
      dialog: copy.profile.editTitle,
      nickname: copy.profile.nickname,
      pronouns: copy.profile.pronouns,
      note: copy.profile.note,
      save: copy.profile.save,
      saved: copy.profile.saved,
      addPhoto: copy.profile.photoAdd,
      changePhoto: copy.profile.photoChange,
      removePhoto: copy.profile.photoRemove,
    })
    expect(PROFILE.open('Ana')).toBe(fill(copy.timeline.viewProfile, { name: 'Ana' }))
    expect(PROFILE.open('Ana')).toBe(fill(copy.channel.viewProfile, { name: 'Ana' }))
    const { open: _o, ...profile } = PROFILE
    expect(profile).toEqual({
      dialog: copy.profile.viewTitle,
      sendMessage: copy.profile.sendMessage,
      note: copy.profile.note,
      org: copy.profile.org,
      orgName: copy.profile.orgName,
      orgJobTitle: copy.profile.orgJobTitle,
      presenceOnline: copy.profile.presenceOnline,
      presenceOffline: copy.profile.presenceOffline,
    })
  })
})
