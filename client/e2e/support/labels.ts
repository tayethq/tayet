// Accessible names the browser E2E tier locates the app by (ADR-060 D3: role + name as the user
// sees them), in one place, grouped by surface. Derivado do catálogo (ADR-080 D5): each value mirrors
// a key of src/ui/i18n/pt-BR.ts. The E2E never imports src/ (ADR-060 D4), so the values stay literal
// here and test/e2e-labels-catalog.test.ts pins every one to its catalog value — a copy change lands
// in the catalog and here in the same PR, or that unit test is red. The `<component:line>` sources
// below are as of when each entry was written. One language per name: never a PT|EN alternation — a
// name that changes is a red test, not a tolerant one.
//
// Scope: support/ and every spec (the older ones migrated in PLANO-RELEASE-PUBLICA §8.69). What stays
// inline is third-party copy (the IdP's pages) and the SSO button, whose name carries the provider's.

// The app shell. Fonte: Workspace.tsx:299 (h1), Workspace.tsx:354.
export const APP = {
  title: 'Tayet',
  account: 'Sua conta',
} as const

// The sidebar. Fonte: ChannelList.tsx:33-37 (sections, add buttons), :73 (nav), :192 (archived),
// :275 (dot, pill); ChannelLabel.tsx:13 (private mark — the list's and the channel header's).
export const LIST = {
  unread: (n: number) => (n === 1 ? '1 não lida' : `${n} não lidas`),
  unreadSuffix: /\s(\d+) não lidas?$/, // the dot's label at the end of a row's accessible name
  mentions: (n: number) => (n === 1 ? '1 menção' : `${n} menções`),
  mentionsSuffix: /\s(\d+) menç(?:ão|ões)$/, // the pill's label, in the same place
  nav: 'Conversas',
  channels: 'Canais',
  dms: 'Mensagens diretas',
  archived: 'Arquivados',
  newChannel: 'Novo canal',
  newDm: 'Nova mensagem direta',
  restore: 'Restaurar',
  restoreFailed: 'Não foi possível restaurar',
  enableNotifications: 'Ativar notificações',
  privateMark: 'Canal privado',
  orgChannel: '#all',
} as const

// The new-conversation dialog. Fonte: NewConversationDialog.tsx:128-134 (submits, title), :153
// (Name), :172-173 (Public/Private), :240 (Cancel).
export const NEW_CONVERSATION = {
  dialog: 'Nova conversa',
  name: 'Nome do canal',
  public: 'Público',
  private: 'Privado',
  createChannel: 'Criar canal',
  startConversation: 'Abrir conversa',
  cancel: 'Cancelar',
  // The ✕ of the narrow screen's header (new-conversation.md §11.1 item 1).
  close: 'Fechar nova conversa',
  dm: 'Mensagem direta',
  // The ✕ of a picked person's chip (NewConversationDialog PersonChip; ADR-094, PR-4).
  remove: (name: string) => `Remover ${name}`,
} as const

// The group conversation (ADR-094). Fonte: GroupBlock.tsx (block's accessible name, group.blockLabel
// `other`), Workspace.tsx (header count line, group.people `other`). Plural forms only: a group the
// tier opens has three people (two once one leaves). The details panel (GroupDetailsPanel.tsx, PR-5):
// the header button and the panel's title (group.details), its two verbs, the convert field; the
// leave confirm's action is MANAGE.confirmLeave (channel.leave).
export const GROUP = {
  block: (n: number) => `Conversa em grupo, ${n} participantes`,
  people: (n: number) => `${n} pessoas`,
  details: 'Detalhes da conversa',
  convert: 'Converter em canal',
  convertName: 'Nome do canal',
  leave: 'Sair da conversa',
} as const

// The system notification's text, as the tier's stub receives it (support/notifications.ts). Fonte:
// notifier.ts (notifications.titleInGroup, ADR-073 addendum of 12/Nov/2026).
export const NOTIFICATIONS = {
  titleInGroup: (author: string) => `${author} em conversa em grupo`,
} as const

// Channel management. Fonte: ChannelLabel.tsx:57 (manageLabel — `Manage #name`, `Manage Canal privado name`;
// used at Workspace.tsx:369 and ChannelManagementPanel.tsx:277), ChannelManagementPanel.tsx:266-267
// (Add member, close), :372 (Members roster); :320/:334 (Name/Topic), :352 (save), :359 (saved), :43-44
// (role labels), :481 and :57 (leave and its confirmation), :68 (remove confirmation), :565 (role
// control), :578 (remove), :585 (role refused).
export const MANAGE = {
  open: (channelName: string) => `Gerenciar ${channelName}`,
  addMember: 'Adicionar pessoa',
  members: 'Pessoas',
  close: 'Fechar gerenciamento do canal',
  name: 'Nome',
  topic: 'Tópico',
  saved: 'Salvo',
  you: '· você',
  role: (memberName: string) => `Papel de ${memberName}`,
  admin: 'Admin',
  member: 'Membro',
  guest: 'Convidado',
  roleRefused: 'Não foi possível mudar o papel. Tente de novo.',
  awaiting: 'Aguardando a primeira conexão', // the roster chip of an invited member (ChannelManagementPanel.tsx)
  remove: (memberName: string) => `Remover ${memberName}`,
  confirmRemove: 'Remover',
  leave: 'Sair do canal',
  confirmLeave: 'Sair',
  archive: 'Arquivar canal',
  confirmArchive: 'Arquivar',
} as const


// The timeline and a message row. Fonte: Timeline.tsx:676 (log), :304 (quote), :338 (edited), :341
// (edit), :352 (delete), :364 (pending), :386 (reply), :393 (thread), :408 (summary), :411 (unread
// dot), :125 (file link prefix), dayLabelOf (day divider); Reactions.tsx (quick react).
export const TIMELINE = {
  log: 'Mensagens',
  dayToday: 'hoje',
  sending: 'Enviando…',
  edit: 'Editar mensagem',
  edited: '(editado)',
  delete: 'Apagar mensagem',
  deleteQuestion: 'Apagar mensagem?',
  confirmDelete: 'Apagar',
  reply: 'Responder',
  replyInThread: 'Responder na thread',
  repliedMessage: 'Mensagem respondida',
  replies: (n: number) => (n === 1 ? '1 resposta' : `${n} respostas`),
  unreadReplies: 'Respostas não lidas',
  react: (emoji: string) => `Reagir com ${emoji}`,
  reactOpen: 'Reagir',
  mentionsYou: 'menção a você', // the mention block under a row that mentions the viewer (Timeline.tsx:442)
  fileLink: (name: string) => `📎 ${name}`,
  loadOlder: 'Carregar mensagens anteriores',
  failed: 'Não enviado',
  retry: 'Tentar de novo',
  copyText: 'Copiar texto',
  copied: 'Copiado',
  actionsSheet: 'Ações da mensagem',
  moreActions: 'Mais ações',
  cancel: 'Cancelar',
} as const

// The image viewer and the file states (workspace.md §25.2, §23.3 items 12 and 13; PLANO-MOBILE §0.14). Fonte:
// ImageViewer.tsx (dialog, header, toggle, states), Timeline.tsx ImageBody (thumbnail) and FileBody (states).
export const VIEWER = {
  open: (name: string) => `Abrir imagem ${name}`,
  dialog: (name: string) => `Imagem ${name}`,
  actualSize: 'Ver no tamanho real',
  fit: 'Ajustar à janela',
  loading: 'Carregando…',
  failed: 'Não foi possível carregar a imagem',
  download: 'Baixar',
  close: 'Fechar',
  downloading: 'Baixando…',
  downloadFailed: 'Não foi possível baixar',
} as const

// The approval card (ADR-091, Proposto). Fonte: Timeline.tsx ApprovalCard (group name, footer lines);
// "Você" is the timeline's key.
export const APPROVAL = {
  title: 'Pedido de aprovação',
  answered: (name: string, time: string) => `${name} às ${time}`,
  closed: 'Pedido encerrado',
  you: 'Você',
  // A card that asks for several answers: the counter while it still takes answers.
  needs: (n: number) => `Pede ${n} respostas`,
  progress: (k: number, n: number) => `${k} de ${n} respostas`,
} as const

// "Aguardando você" on the narrow window (workspace.md §23.2 item 5, §23.4). Fonte: AwaitingScreen.tsx.
export const AWAITING = {
  title: 'Aguardando você',
  summary: (n: number, agents: string) => (n === 1 ? `1 pedido de ${agents}` : `${n} pedidos de ${agents}`),
  inChannel: (channel: string) => `em ${channel}`,
} as const

// The pinned panel (ADR-091, Proposto, dec. 12). Fonte: PinnedPanel.tsx:103 (section name), Timeline.tsx
// updatedOf ("atualizado às" on the same day).
export const PANEL = {
  section: (agent: string) => `Painel de ${agent}`,
  updatedAt: (time: string) => `atualizado às ${time}`,
} as const

// `/` commands (ADR-093, Proposto; A4-4). Fonte: RichComposer.tsx (the popup's name in commands mode, the
// placeholder after the pick), Timeline.tsx (the line under a command message). "Mencionar" is COMPOSER's.
export const COMMANDS = {
  popup: 'Comandos',
  placeholderFor: (agent: string) => `para ${agent}`,
  placeholderHintFor: (hint: string, agent: string) => `${hint} · para ${agent}`,
  lineFor: (agent: string) => `comando para ${agent}`,
} as const

// The agent's form (ADR-103, Proposto; Formulários 1b). Fonte: AgentFormDialog.tsx (footer, status, the
// checkbox list's ceiling, the copy of the validation codes), Field.tsx ("(opcional)"), Timeline.tsx
// formReplyLine. "Enviando…", "Não enviado", "Tentar de novo", "Você" and "Fechar" are other surfaces' keys.
export const FORMS = {
  cancel: 'Cancelar',
  close: 'Fechar',
  optional: '(opcional)',
  failed: 'Não enviado',
  retry: 'Tentar de novo',
  sending: 'Enviando…',
  noAnswer: (agent: string) => `${agent} não respondeu`,
  upTo: (n: number) => `Até ${n}`,
  replied: (name: string, time: string) => `${name} respondeu às ${time}`,
  you: 'Você',
  required: 'Campo obrigatório',
  minLength: (min: number) => `Use pelo menos ${min} caracteres`,
  between: (min: string, max: string) => `Use um valor entre ${min} e ${max}`,
  integer: 'Use um número inteiro',
} as const

// What a row shows while a message is not decrypted yet / could not be. Fonte: Timeline.tsx:178.
export const PLACEHOLDER_TEXTS = ['Aguardando a mensagem…', 'Mensagem indisponível'] as const

// The composer (main and thread) and its link dialog. Fonte: RichComposer.tsx:240 (editor), :341
// (mention listbox), :372-427 (toolbar), :445 (attach), :465-467 (send), :481-483 (edit footer),
// :495-530 (link dialog), :553-563 (reply banner).
export const COMPOSER = {
  editor: 'Mensagem',
  placeholderFor: (name: string) => `Mensagem para ${name}`,
  send: 'Enviar',
  attach: 'Anexar',
  formatting: 'Formatação',
  bold: 'Negrito',
  italic: 'Itálico',
  bulletedList: 'Lista',
  link: 'Link',
  mention: 'Mencionar',
  save: 'Salvar',
  replyingTo: 'Respondendo a',
  cancelReply: 'Cancelar resposta',
  editing: 'Editando mensagem',
  cancelEdit: 'Cancelar edição',
  commands: 'Comandos',
} as const

export const LINK_DIALOG = {
  dialog: 'Inserir link',
  text: 'Texto',
  url: 'URL',
  insert: 'Inserir',
  cancel: 'Cancelar',
  invalid: 'URL inválida — use http, https ou mailto',
} as const

// The thread panel. Fonte: ThreadPanel.tsx:54 (aside), :58 (close), :81 (replies log).
export const THREAD = {
  panel: 'Thread',
  replies: 'Respostas da thread',
  close: 'Fechar thread',
} as const

// Search. Fonte: SearchField.tsx:57, SearchResults.tsx:68.
export const SEARCH = {
  field: 'Buscar mensagens',
  results: 'Resultados da busca',
  partial: 'Mostrando o que já foi carregado neste dispositivo',
  nothingFound: (query: string) => `Nada encontrado para “${query}”`,
} as const

// Session surfaces. Fonte: AccountSettings.tsx:204 (sign-out), BootMessage.tsx:120 (access ended),
// :127 (re-login), NewAccessBanner.tsx:36 (notices region), :29 (one new access), :47 (dismiss), the
// neutral screen of a tab without the lock (ADR-065 D3).
export const SESSION = {
  signOut: 'Sair deste navegador',
  ended: 'Seu acesso foi encerrado',
  signInAgain: 'Entrar de novo',
  notices: 'Avisos de segurança da conta',
  newAccess: 'Novo acesso à sua conta',
  dismiss: 'Fui eu, dispensar',
  elsewhere: 'O Tayet já está aberto em outra aba deste navegador',
  useHere: 'Usar aqui',
  takingOver: 'Trazendo o Tayet para esta aba…',
  takeoverStuck: 'A outra aba não respondeu. Feche-a ou volte a ela por um instante.',
} as const

// The account dialog and the profile editor. Fonte: AccountSettings.tsx:199 (dialog), :201 (Fechar,
// also the editor's — ProfileEditor.tsx:122), :215 (Editar);
// ProfileEditor.tsx:118 (dialog), :152/:167/:180 (fields), :133 (Salvar), :111 (saved);
// ProfilePhoto.tsx:98 (add/change), :102 (remove).
export const ACCOUNT = {
  dialog: 'Sua conta',
  close: 'Fechar',
  edit: 'Editar',
  accesses: 'Acessos à sua conta',
  resetEntry: 'Redefinir o acesso da conta',
  reset: 'Redefinir o acesso',
  resetPending: 'Confirme na janela que abriu. Esta tela segue sozinha depois.',
  resetDone: 'Acesso redefinido. Entre de novo para continuar.',
  resetSignInAgain: 'Entrar de novo',
  resetNotDone: 'O acesso não foi redefinido. Você pode tentar de novo.',
  resetTryAgain: 'Tentar de novo',
  resetBannerTitle: 'Esta sessão precisa de você',
} as const

// "Sua conta" on the narrow window and "Abrir no celular" (account-access.md §13). Fonte: AccountSettings.tsx,
// AccountScreen.tsx (back), ResetSheet.tsx (cancel), OpenOnPhoneDialog.tsx, InstallSheet.tsx.
export const ACCOUNT_PHONE = {
  back: 'Voltar',
  cancel: 'Cancelar',
  exportDesktopOnly: 'Disponível no computador',
  openOnPhone: 'Abrir no celular',
  code: 'Código para abrir o Tayet no celular',
  installSheet: 'Instalar o Tayet',
  installRow: 'Instalar na Tela de Início',
  continueInBrowser: 'Continuar no navegador',
  notNow: 'Agora não',
} as const

// "Seus dados" → "Exportar seus dados" (manifesto account-access.md §12). Fonte: AccountSettings.tsx (entry),
// DataExportDialog.tsx (dialog, actions, end titles). `readmeFirstLine` is the first line of the README.txt
// inside the zip (the catalog's dataExport.readme).
export const DATA_EXPORT = {
  entry: 'Exportar seus dados',
  dialog: 'Exportar seus dados',
  prepare: 'Preparar cópia',
  ready: 'Cópia pronta',
  readyWithGaps: 'Cópia pronta, com lacunas',
  download: 'Baixar arquivo',
  close: 'Fechar',
  readmeFirstLine: 'Esta pasta é uma cópia dos seus dados no Tayet.',
} as const

export const PROFILE_EDITOR = {
  dialog: 'Editar perfil',
  nickname: 'Apelido',
  pronouns: 'Pronomes',
  note: 'Recado',
  save: 'Salvar',
  saved: '✓ Salvo',
  addPhoto: 'Adicionar foto',
  changePhoto: 'Trocar',
  removePhoto: 'Remover',
} as const

// Someone else's profile. Fonte: Timeline.tsx:498/:514 and ChannelManagementPanel.tsx:552 (open),
// UserProfileDialog.tsx:180 (dialog), :260 (note section), :294-304 (organization card), :43-46 (presence line),
// :277 (DM CTA).
export const PROFILE = {
  open: (name: string) => `Ver perfil de ${name}`,
  dialog: 'Perfil',
  // The narrow screen's name, once the profile loaded (view-profile.md §8).
  screen: (name: string) => `Perfil de ${name}`,
  sendMessage: 'Enviar mensagem',
  note: 'Recado',
  org: 'Da organização',
  orgName: 'Nome',
  orgJobTitle: 'Cargo',
  presenceOnline: 'Online',
  presenceOffline: 'Offline',
} as const

// "Pessoas" (manifesto account-access.md §9). Fonte: AccountSettings.tsx (section, rows),
// InvitePersonDialog.tsx (form, success).
export const PEOPLE = {
  section: 'Organização',
  title: 'Pessoas',
  filter: 'Filtrar por nome ou email',
  invite: 'Convidar pessoa',
  kindMember: 'Da organização',
  kindGuest: 'Convidado',
  pending: 'Aguardando a primeira conexão',
  remove: (name: string) => `Remover ${name}`,
  fieldName: 'Nome',
  fieldEmail: 'Email',
  fieldKind: 'Tipo',
  submit: 'Convidar',
  inviteReady: 'Convite pronto',
  copyInstructions: 'Copiar instruções',
  removeConfirm: 'Remover',
  cancelInvite: 'Cancelar convite',
  cancelInviteOf: (name: string) => `Cancelar convite de ${name}`,
} as const

// Agentes (manifesto account-access.md §11; ADR-086 Proposto). Fonte: AgentAvatar.tsx (rótulo
// acessível), PeoplePanel.tsx (ações da linha) e AgentDialog.tsx (estados). A marca é o avatar
// (`[data-agent-avatar]` + `[data-agent-mark]`), nunca um selo de texto.
export const AGENTS = {
  mark: 'Agente',
  operatedBy: (name: string) => `operado por ${name}`,
  add: 'Adicionar agente',
  edit: (name: string) => `Editar ${name}`,
  remove: (name: string) => `Remover ${name}`,
  createTitle: 'Adicionar agente',
  createdTitle: 'Agente criado',
  editTitle: 'Editar agente',
  reissuedTitle: 'Credencial reemitida',
  fieldName: 'Nome',
  fieldColor: 'Cor',
  create: 'Criar agente',
  save: 'Salvar',
  done: 'Concluir',
  reissueCredential: 'Reemitir credencial',
  reissue: 'Reemitir',
  removeConfirm: 'Remover',
  credentialOnce: 'A credencial não será mostrada de novo.',
  copyCredentialOnly: 'Copiar só a credencial',
  colors: {
    areia: 'Areia',
    petroleo: 'Petróleo',
    turquesa: 'Turquesa',
    salvia: 'Sálvia',
    ocre: 'Ocre',
    argila: 'Argila',
    barro: 'Barro',
    malva: 'Malva',
    ardosia: 'Ardósia',
    grafite: 'Grafite',
  },
} as const

// The language row of "Sua conta" (manifesto account-access.md §14), and the English names the language
// spec drives once the app is in English. Fonte: AccountSettings.tsx (row, select, subtitle),
// Workspace.tsx (account footer), BootMessage.tsx (sign-in and access-ended screens), SearchField.tsx
// (field, scope chip). `en` mirrors src/ui/i18n/en.ts the way the rest of this file mirrors pt-BR.ts.
export const LANGUAGE = {
  pt: {
    control: 'Idioma',
    auto: 'Automático',
    portuguese: 'Português',
    everywhere: 'Em todos os seus aparelhos',
  },
  en: {
    signInTitle: 'Sign in to Tayet',
    account: 'Your account',
    close: 'Close',
    control: 'Language',
    auto: 'Automatic',
    portuguese: 'Português',
    device: (language: string) => `This device's language: ${language}`,
    english: 'English',
    signOut: 'Sign out of this browser',
    ended: 'Your access has ended',
    signInAgain: 'Sign in again',
    searchField: 'Search messages',
    scoped: 'here',
  },
} as const
