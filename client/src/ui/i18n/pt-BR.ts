import type { Messages } from './catalog'

// Copy pt-BR da UI — a fonte (ADR-080 D1). Agrupada pelas famílias do §0 de idioma (29/Out). Copy
// fixada por manifesto (login-onboarding §7, workspace §8–§9, view-profile §7) é spec: muda no
// manifesto primeiro. Copy de artboard é verbatim (addendum ao ADR-055); o que a tela tem e o artboard
// não vai marcado `// sem artboard — fidelidade pendente`: a fatia de fidelidade da superfície resolve.
export const ptBR = {
  boot: {
    connecting: 'Conectando…',
    redirectTitle: 'Levando você ao {provider}…',
    providerFallback: 'provedor',
    redirectDetail: 'Você volta para o Tayet automaticamente.',
    preparingTitle: 'Preparando seu acesso seguro',
    preparingDetail: 'Deixando tudo pronto para você. Leva só um instante.',
    otherTabTitle: 'O Tayet já está aberto em outra aba deste navegador',
    otherTabDetail: 'Continue por lá ou traga o Tayet para esta aba.',
    useHere: 'Usar aqui',
    takeoverStuck: 'A outra aba não respondeu. Feche-a ou volte a ela por um instante.',
    takingOver: 'Trazendo o Tayet para esta aba…',
    signInTitle: 'Entre no Tayet',
    signInDetail: 'Converse com sua equipe, com segurança.',
    continueWith: 'Continuar com {provider}',
    // O provedor quando VITE_SSO_LABEL não vem (main.tsx).
    accountFallback: 'sua conta',
    endedTitle: 'Seu acesso foi encerrado',
    endedDetail: 'Este acesso não está mais ativo. Entre de novo para voltar às suas conversas.',
    signInAgain: 'Entrar de novo',
    signInFailedTitle: 'Não foi possível entrar',
    signInFailedDetail: 'O acesso com {provider} não foi concluído. Tente de novo.',
    tryAgain: 'Tentar de novo',
    startFailedTitle: 'Não foi possível iniciar',
    startFailedDetail: 'Tente novamente. Se o problema continuar, entre de novo neste navegador.',
    retry: 'Tentar novamente',
    connectFailedTitle: 'Não foi possível conectar',
    connectFailedDetail: 'Confira sua conexão e tente novamente.',
  },
  account: {
    title: 'Sua conta',
    edit: 'Editar',
    signOut: 'Sair deste navegador',
    appearance: 'Aparência',
    appearanceFlavor: 'Mesmo cômodo, outro horário',
    themeLight: 'Claro',
    themeDark: 'Escuro',
    accessSection: 'Acesso',
    accessTitle: 'Acessos à sua conta',
    accessSubtitle: 'Onde sua conta está sendo acessada.',
    accessUnknown: 'Acesso desconhecido',
    thisBrowser: 'Este navegador',
    now: 'agora',
    activeSince: 'Ativo {when}',
    accessCount: { one: '{n} acesso', other: '{n} acessos' },
    unknownCount: { one: '{n} desconhecido', other: '{n} desconhecidos' },
    resetTitle: 'Redefinir o acesso da conta',
    resetDesc: 'Recomeça do zero. Você entra de novo aqui e em qualquer outro acesso.',
    resetWarning:
      'Você vai precisar entrar de novo — aqui e em qualquer outro acesso à sua conta. Os acessos desta lista deixam de valer.',
    resetCaveat: 'Conteúdos antigos podem se perder.',
    reset: 'Redefinir o acesso',
    cancel: 'Cancelar',
    // sem artboard — fidelidade pendente
    resetPending: 'Confirme na janela que abriu. Esta tela segue sozinha depois.',
    // sem artboard — fidelidade pendente
    resetDone: 'Acesso redefinido. Entre de novo para continuar.',
    // sem artboard — fidelidade pendente
    resetSignInAgain: 'Entrar de novo',
    // sem artboard — fidelidade pendente
    resetNotDone: 'O acesso não foi redefinido. Você pode tentar de novo.',
    // sem artboard — fidelidade pendente
    resetTryAgain: 'Tentar de novo',
    newAccess: { one: 'Novo acesso à sua conta', other: '{n} novos acessos à sua conta' },
    wasItYou: 'Foi você?',
    accessedFrom: 'Sua conta foi acessada a partir de {device}. Foi você?',
    accessedRecently: 'Sua conta foi acessada recentemente. Foi você?',
    securityNotices: 'Avisos de segurança da conta',
    dismissMine: 'Fui eu, dispensar',
    resetBannerLabel: 'Ação necessária na conta',
    resetBannerTitle: 'Esta sessão precisa de você',
    resetBannerDetail: 'Para voltar a acessar o histórico desta conta, redefina o acesso.',
  },
  profile: {
    editTitle: 'Editar perfil',
    save: 'Salvar',
    saving: 'Salvando…',
    saved: '✓ Salvo',
    saveFailed: 'Não foi possível salvar',
    loading: 'Carregando…',
    loadOwnFailed: 'Não foi possível carregar seu perfil.',
    nickname: 'Apelido',
    nicknamePlaceholder: 'Como você quer ser chamado',
    nicknameHint: 'É assim que as pessoas te veem nas conversas. Sem isto, mostramos seu nome.',
    pronouns: 'Pronomes',
    pronounsPlaceholder: 'ex.: ela/dela, ele/dele, elu/delu',
    note: 'Recado',
    notePlaceholder: 'ex.: em foco até quinta, respondo com calma',
    noteHint: 'No que você está. Visível para a sua organização.',
    yourOrg: 'Da sua organização',
    orgName: 'Nome',
    orgJobTitle: 'Cargo',
    orgWorkEmail: 'Email de trabalho',
    orgManaged: 'Gerenciado pela sua organização',
    photo: 'Foto de perfil',
    photoUploading: 'Enviando…',
    photoChange: 'Trocar',
    photoAdd: 'Adicionar foto',
    photoRemove: 'Remover',
    photoFailed: 'Não foi possível atualizar a foto.',
    viewTitle: 'Perfil',
    viewLabel: 'Perfil de {name}',
    loadFailed: 'Não foi possível carregar este perfil.',
    sendMessage: 'Enviar mensagem',
    openFailed: 'Não foi possível abrir a conversa. Tente de novo.',
    org: 'Da organização',
    commonChannels: 'Canais em comum',
    commonChannelsCount: 'Canais em comum · {n}',
    // Labels planos fixados pelo manifesto view-profile §4 item 5 (ADR-056 dec. 5.ii).
    presenceOnline: 'Online',
    presenceAway: 'Ausente',
    presenceOffline: 'Offline',
  },
  search: {
    field: 'Buscar mensagens',
    placeholder: 'buscar',
    scopeAll: 'Buscar em todas as conversas',
    scopeHere: 'Buscar só nesta conversa',
    scopedOn: 'nesta conversa ✓',
    scoped: 'nesta conversa',
    clear: 'Limpar busca',
    clearTitle: 'Limpar (Esc)',
    hint: 'Busque em todas as suas conversas',
    region: 'Resultados da busca',
    results: { one: '{n} resultado', other: '{n} resultados' },
    clearShort: 'limpar',
    preparing: 'Preparando a busca…',
    nothingFound: 'Nada encontrado para “{query}”',
    partial: 'Mostrando o que já foi carregado neste dispositivo',
    today: 'hoje {time}',
    inThread: 'em thread',
    openFailed: 'Não foi possível abrir esta mensagem',
    unknownAuthor: 'Alguém',
  },
  timeline: {
    messages: 'Mensagens',
    empty: 'Nenhuma mensagem ainda.',
    loadOlder: 'Carregar mensagens anteriores',
    opening: 'Abrindo a mensagem…',
    someone: 'Alguém',
    viewProfile: 'Ver perfil de {name}',
    image: 'Imagem',
    imageAlt: 'imagem',
    unsupported: 'Conteúdo não exibível',
    awaited: 'Aguardando a mensagem…',
    unavailable: 'Mensagem indisponível',
    retry: 'Tentar de novo',
    downloadFailed: 'Não foi possível baixar',
    downloading: 'Baixando…',
    repliedMessage: 'Mensagem respondida',
    earlierMessage: 'Mensagem anterior',
    edited: '(editado)',
    editMessage: 'Editar mensagem',
    deleteMessage: 'Apagar mensagem',
    deleteQuestion: 'Apagar mensagem?',
    delete: 'Apagar',
    cancel: 'Cancelar',
    sending: 'Enviando…',
    failed: 'Não enviado',
    dayToday: 'hoje',
    dayYesterday: 'ontem',
    reply: 'Responder',
    replyInThread: 'Responder na thread',
    replies: { one: '{n} resposta', other: '{n} respostas' },
    lastReplyAt: 'última às {time}',
    lastReplyOn: 'última em {date}',
    justNow: 'agora há pouco',
    unreadReplies: 'Respostas não lidas',
    react: 'Reagir com {emoji}',
    reactOpen: 'Reagir',
    mentionsYou: 'menção a você',
    // ADR-093 (Proposto), workspace.md §21.1 item 8: a linha sob a mensagem de comando.
    commandFor: 'comando para {agent}',
    you: 'Você',
  },
  thread: {
    title: 'Thread',
    unreadReplies: 'Respostas não lidas',
    close: 'Fechar thread',
    replies: 'Respostas da thread',
    empty: 'Nenhuma resposta ainda.',
    someone: 'Alguém',
  },
  // ADR-091 (Proposto): o cartão de aprovação (workspace.md §17.4 e §18). "Enviando…", "Não enviado",
  // "Tentar de novo" e "Você" são as chaves de `timeline`.
  approval: {
    title: 'Pedido de aprovação',
    answered: '{name} às {time}',
    answeredNoOption: '{name} respondeu às {time}',
    closed: 'Pedido encerrado',
    // The counter of a card that asks for several answers, while it still takes answers.
    needs: 'Pede {n} respostas',
    progress: '{k} de {n} respostas',
  },
  // ADR-103 (Proposto): o formulário do agente (workspace.md §25.5, §25.8, §26, §27). "Enviando…", "Não
  // enviado", "Tentar de novo" e "Você" são as chaves de `timeline`; "Fechar" é a de `dialog`. Título,
  // rótulos, dicas, opções, textos de contexto, erros do agente e o rótulo do envio são do agente.
  form: {
    cancel: 'Cancelar',
    noAnswer: '{agent} não respondeu',
    upTo: 'Até {n}',
    // workspace.md §26 item 8 (I5): no rodapé do cartão e sob a mensagem do comando; {name} é "Você" para
    // a própria pessoa.
    replied: '{name} respondeu às {time}',
    // Os códigos de validação do ACL (FormIssue), forks I1 de 17/Nov/2026.
    issue: {
      required: 'Campo obrigatório',
      minLength: 'Use pelo menos {min} caracteres',
      maxLength: 'Use no máximo {max} caracteres',
      email: 'Use um email válido',
      url: 'Use um endereço completo, como https://exemplo.com',
      number: 'Use um número',
      integer: 'Use um número inteiro',
      between: 'Use um valor entre {min} e {max}',
      atLeast: 'Use um valor de {min} ou mais',
      atMost: 'Use um valor de até {max}',
      date: 'Use uma data válida',
      option: 'Escolha uma das opções',
    },
  },
  // ADR-091 (Proposto) dec. 12 (A3-5): o painel fixado de um agente (manifesto workspace.md §17.4, §19.3).
  panel: {
    section: 'Painel de {agent}',
    updatedAt: 'atualizado às {time}',
    updatedOn: 'atualizado em {date}',
    more: 'mais {n}',
    others: 'Outros painéis',
  },
  composer: {
    placeholder: 'Mensagem',
    placeholderFor: 'Mensagem para {name}',
    placeholderThread: 'Responder na thread',
    field: 'Mensagem',
    mention: 'Mencionar',
    // ADR-093 (Proposto), workspace.md §21.3: nome acessível do popup no modo comando e o placeholder
    // depois da escolha (com ou sem a dica do manifesto).
    commands: 'Comandos',
    commandFor: 'para {agent}',
    commandHintFor: '{hint} · para {agent}',
    formatting: 'Formatação',
    bold: 'Negrito',
    italic: 'Itálico',
    strike: 'Tachado',
    link: 'Link',
    bulletList: 'Lista',
    code: 'Código',
    attach: 'Anexar',
    send: 'Enviar',
    editCancel: 'Cancelar',
    editSave: 'Salvar',
    linkEdit: 'Editar link',
    linkInsert: 'Inserir link',
    linkRemove: 'Remover',
    linkCancel: 'Cancelar',
    linkSave: 'Salvar',
    linkInsertAction: 'Inserir',
    linkText: 'Texto',
    linkUrl: 'URL',
    linkInvalid: 'URL inválida — use http, https ou mailto',
    replyingTo: 'Respondendo a',
    cancelReply: 'Cancelar resposta',
  },
  channel: {
    privateMark: 'Canal privado',
    manageNamed: 'Gerenciar {name}', // sem artboard — fidelidade pendente
    managePrivate: 'Gerenciar {mark} {name}', // sem artboard — fidelidade pendente
    manage: 'Gerenciar canal', // sem artboard — fidelidade pendente
    closeManage: 'Fechar gerenciamento do canal', // sem artboard — fidelidade pendente
    name: 'Nome',
    topic: 'Tópico',
    saving: 'Salvando…', // sem artboard — fidelidade pendente
    saved: 'Salvo', // sem artboard — fidelidade pendente
    saveFailed: 'Não foi possível salvar. Tente de novo.', // sem artboard — fidelidade pendente
    members: 'Pessoas',
    membersCount: 'Pessoas · {n}',
    add: '+ Adicionar',
    addMember: 'Adicionar pessoa', // sem artboard — fidelidade pendente
    you: '· você',
    roleAdmin: 'Admin',
    roleMember: 'Membro',
    roleGuest: 'Convidado', // sem artboard — fidelidade pendente
    roleFor: 'Papel de {name}', // sem artboard — fidelidade pendente
    roleFailed: 'Não foi possível mudar o papel. Tente de novo.', // sem artboard — fidelidade pendente
    awaiting: 'Aguardando a primeira conexão', // sem artboard — fidelidade pendente
    viewProfile: 'Ver perfil de {name}',
    removeNamed: 'Remover {name}', // sem artboard — fidelidade pendente
    remove: 'Remover', // sem artboard — fidelidade pendente
    removeTitle: 'Remover pessoa',
    removeBody: '{name} vai sair deste canal. Você pode adicionar de novo depois.',
    archiveTitle: 'Arquivar canal',
    archiveBody: 'Este canal será arquivado e sairá da sua lista. Você pode restaurá-lo na seção Arquivados.',
    archive: 'Arquivar',
    leaveTitle: 'Sair do canal',
    leaveBody: 'Você vai sair deste canal e ele vai desaparecer da sua lista.',
    leave: 'Sair',
    cancel: 'Cancelar',
    working: 'Aguarde…',
    close: 'Fechar', // sem artboard — fidelidade pendente
    failed: 'Não foi possível concluir. Tente de novo.',
    loading: 'Carregando…', // sem artboard — fidelidade pendente
    noCandidates: 'Nenhuma pessoa disponível para adicionar', // sem artboard — fidelidade pendente
    rateLimited: 'Você está adicionando pessoas rápido demais. Espere alguns segundos antes de adicionar mais.', // sem artboard — fidelidade pendente
  },
  newConversation: {
    title: 'Nova conversa',
    close: 'Fechar nova conversa', // sem artboard — fidelidade pendente
    type: 'Tipo de conversa', // sem artboard — fidelidade pendente
    channel: 'Canal',
    dm: 'Mensagem direta',
    name: 'Nome do canal',
    visibility: 'Visibilidade',
    visibilityLabel: 'Visibilidade do canal', // sem artboard — fidelidade pendente
    public: 'Público',
    private: 'Privado',
    topic: 'Descrição (opcional)',
    topicPlaceholder: 'Para quê é este canal?',
    addPeople: 'Adicionar pessoas',
    addPeopleHint: 'da sua equipe',
    filterPeople: 'Filtrar por nome',
    removePerson: 'Remover {name}',
    suggestPerson: 'Adicionar {name}', // sem artboard — fidelidade pendente
    to: 'Sua equipe',
    loading: 'Carregando…', // sem artboard — fidelidade pendente
    contactsFailed: 'Não foi possível carregar as pessoas. Tente de novo.', // sem artboard — fidelidade pendente
    noContacts: 'Nenhuma pessoa disponível', // sem artboard — fidelidade pendente
    failed: 'Não foi possível concluir. Tente de novo.', // sem artboard — fidelidade pendente
    cancel: 'Cancelar',
    createChannel: 'Criar canal',
    creating: 'Criando…', // sem artboard — fidelidade pendente
    startConversation: 'Abrir conversa',
    opening: 'Abrindo…', // sem artboard — fidelidade pendente
  },
  list: {
    nav: 'Conversas',
    channels: 'Canais',
    newChannel: 'Novo canal',
    dms: 'Mensagens diretas',
    newDm: 'Nova mensagem direta',
    empty: 'Nenhuma conversa ainda',
    unread: { one: '{n} não lida', other: '{n} não lidas' },
    mentions: { one: '{n} menção', other: '{n} menções' },
    notifyPrompt: 'Receba avisos de mensagens diretas e menções',
    enableNotifications: 'Ativar notificações',
    dismiss: 'Dispensar',
    archived: 'Arquivados',
    archivedCount: 'Arquivados · {n}',
    restore: 'Restaurar',
    restoreNamed: 'Restaurar {name}',
    restoring: 'Restaurando…',
    restoreFailed: 'Não foi possível restaurar',
  },
  shell: {
    connecting: 'Conectando…',
    reconnecting: 'Reconectando…',
    offline: 'Sem conexão',
    account: 'Sua conta',
    someone: 'Alguém',
    selectChannel: 'Selecione um canal',
    privateHint: 'Só quem foi adicionado vê este canal',
  },
  notifications: {
    generic: 'Nova mensagem',
    image: 'Enviou uma imagem',
    file: 'Enviou um arquivo',
    unsupported: 'Enviou uma mensagem',
    titleIn: '{author} em {channel}',
    // ADR-086: a notificação do SO não tem avatar — a identificação de agente vai no texto (§15.3).
    titleInAgent: '{author} (agente) em {channel}',
    titleDmAgent: '{name} (agente)',
    // ADR-094 dec. 10 (PLANO-CONVERSAS §0.3.4 item 2): o nome do grupo inclui o autor, então não entra.
    titleInGroup: '{author} em conversa em grupo',
    titleInGroupAgent: '{author} (agente) em conversa em grupo',
    // ADR-091: o corpo da notificação de um cartão de aprovação, com a primeira linha do pedido
    // (workspace.md §18 item 6).
    approvalRequest: 'Pede aprovação: {text}',
  },
  // ADR-094: a conversa em grupo na lista e no cabeçalho (workspace.md §22.3), o limite da criação
  // (new-conversation.md §10.3) e o painel do grupo com converter e sair (channel-management.md §10.3).
  group: {
    alone: 'Só você',
    people: { one: '{n} pessoa', other: '{n} pessoas' },
    agents: { one: '{n} agente', other: '{n} agentes' },
    blockLabel: { one: 'Conversa em grupo, só você', other: 'Conversa em grupo, {n} participantes' },
    limit: 'Até 8 pessoas além de você. Para mais gente, crie um canal.',
    details: 'Detalhes da conversa',
    participants: 'Participantes',
    convert: 'Converter em canal',
    convertBody: 'Esta conversa vira um canal privado, com as mesmas pessoas e todo o histórico. Não dá para desfazer.',
    convertName: 'Nome do canal',
    leave: 'Sair da conversa',
    leaveBody:
      'Você deixa de receber as mensagens desta conversa. Não dá para voltar: ninguém pode adicionar pessoas a uma conversa em grupo.',
  },
  // ADR-086 (Proposto): a marca de agente (workspace.md §15, account-access.md §11). Sem selo de texto
  // visível: `label` é o nome acessível do avatar de agente (role="img").
  agent: {
    label: 'Agente',
    operatedBy: 'operado por {name}',
    // Pessoas + AgentDialog (account-access.md §11.2): copy ratificada verbatim onde há artboard.
    add: 'Adicionar agente',
    edit: 'Editar',
    editLabel: 'Editar {name}',
    remove: 'Remover',
    removeLabel: 'Remover {name}',
    createTitle: 'Adicionar agente',
    createdTitle: 'Agente criado',
    editTitle: 'Editar agente',
    reissuedTitle: 'Credencial reemitida',
    reissueTitle: 'Reemitir credencial de {name}',
    removeTitle: 'Remover {name}',
    intro: 'Um agente é identificado como agente em toda conversa. Você fica registrado como quem o opera.',
    fieldName: 'Nome',
    fieldColor: 'Cor',
    nameInUse: 'Já existe alguém com esse nome no workspace. Escolha outro.',
    // criado / reemitido: o comando inteiro (§11.5).
    command: 'Comando',
    copy: 'Copiar',
    copyCredentialOnly: 'Copiar só a credencial',
    nodeRequirement: 'Precisa do Node.js 22 ou mais recente.',
    createdIntro: 'Rode este comando na máquina em que o agente vai trabalhar. Depois, adicione-o às conversas em que ele deve atuar.',
    reissuedIntro: 'A credencial anterior já não funciona. Reinicie o agente com este comando.',
    credentialOnce: 'A credencial não será mostrada de novo.',
    cancel: 'Cancelar',
    create: 'Criar agente',
    save: 'Salvar',
    done: 'Concluir',
    reissueCredential: 'Reemitir credencial',
    reissue: 'Reemitir',
    reissueBody: 'A credencial atual para de funcionar agora. O agente só volta a trabalhar com a nova credencial.',
    removeBody: '{name} sai de todas as conversas e a credencial para de funcionar. As mensagens que enviou continuam visíveis.',
    failed: 'Não deu para concluir agora. Tente de novo.', // sem artboard — fidelidade pendente
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
  },
  // Manifesto account-access.md §9.5. Sem artboard: a ação do convite pendente (§9.2 g) e a falha parcial.
  people: {
    orgSection: 'Organização',
    title: 'Pessoas',
    summaryPeople: { one: '{n} pessoa', other: '{n} pessoas' },
    summaryGuests: { one: '{n} convidado', other: '{n} convidados' },
    subtitle: 'Quem faz parte da organização, quem foi convidado de fora e os agentes que trabalham com vocês.', // §11.2
    filter: 'Filtrar por nome ou email',
    clearFilter: 'Limpar',
    invite: 'Convidar pessoa',
    onlyYou: 'Só você por enquanto.',
    noResults: 'Ninguém encontrado para “{term}”.',
    kindMember: 'Da organização',
    kindGuest: 'Convidado',
    pending: 'Aguardando a primeira conexão',
    remove: 'Remover',
    removeLabel: 'Remover {name}',
    fieldName: 'Nome',
    fieldEmail: 'Email',
    fieldKind: 'Tipo',
    fieldChannels: 'Canais',
    emailTaken: 'Esse email já está na organização.',
    helpMember: 'Entra em #all e vê todas as pessoas da organização.',
    helpGuest: 'Só vê os canais em que você colocar. Não entra em #all.',
    removeChannel: 'Tirar {channel}',
    inviteError: 'Não deu para convidar agora. Tente de novo.',
    submit: 'Convidar',
    submitting: 'Convidando…',
    inviteReady: 'Convite pronto',
    instructions: 'Peça para {name} entrar em {address} com a conta Google {email}.',
    copyInstructions: 'Copiar instruções',
    channelsFailed: 'Não deu para adicionar em: {channels}.', // sem artboard — fidelidade pendente
    removeTitle: 'Remover {name}',
    removeBody: '{name} perde o acesso a todos os canais e sai da organização. As mensagens que enviou continuam visíveis.',
    cancelInvite: 'Cancelar convite', // sem artboard — fidelidade pendente
    cancelInviteTitle: 'Cancelar convite de {name}', // sem artboard — fidelidade pendente
    cancelInviteBody: '{name} ainda não entrou. Você pode convidar de novo depois.', // sem artboard — fidelidade pendente
  },
  // Manifesto account-access.md §12.2 (ADR-096): copy do artboard DataExport, verbatim; o estado `falha` é o
  // §12.1 item 7. Os plurais saem do artboard (que só desenha o N) pelo §0.3.6 item 7 do PLANO-EXPORT-DADOS.
  dataExport: {
    section: 'Seus dados',
    entry: 'Exportar seus dados',
    entrySummary: 'Uma cópia do que você enviou',
    title: 'Exportar seus dados',
    intro: 'Uma cópia do que é seu, montada neste navegador e baixada em um arquivo .zip.',
    includesLabel: 'Entra na cópia',
    includes: {
      profile: 'Seu perfil',
      messages: 'As mensagens e os arquivos que você enviou',
      conversations: 'A lista das suas conversas',
      approvals: 'Suas respostas a pedidos de aprovação',
      accesses: 'Os acessos à sua conta',
      agents: 'Os agentes que você opera',
    },
    othersExcluded: 'Mensagens de outras pessoas não entram.',
    prepare: 'Preparar cópia',
    failed: 'Não deu para preparar a cópia. Tente de novo.',
    preparing: 'Preparando a cópia…',
    preparingLabel: 'Preparando a cópia',
    progress: { one: '{done} de {n} conversa', other: '{done} de {n} conversas' },
    keepOpen: 'Mantenha esta janela aberta até terminar.',
    ready: 'Cópia pronta',
    readyWithGaps: 'Cópia pronta, com lacunas',
    conversations: { one: '{n} conversa', other: '{n} conversas' },
    gapsIntro: {
      one: 'Não deu para ler algumas mensagens em {n} conversa. O arquivo marca onde elas ficariam.',
      other: 'Não deu para ler algumas mensagens em {n} conversas. O arquivo marca onde elas ficariam.',
    },
    gapMessages: { one: '{n} mensagem', other: '{n} mensagens' },
    warning: 'O arquivo traz mensagens de conversas privadas em texto legível. Guarde em um lugar seguro.',
    download: 'Baixar arquivo',
    // O README.txt do arquivo (PLANO-EXPORT-DADOS §0.3.3 "README", mais a linha do endereço de rede do
    // §0.3.6 item 4). Texto fixo: nome, data e contagens estão no manifest.json.
    readme: `Esta pasta é uma cópia dos seus dados no Tayet.

O QUE ESTÁ AQUI

- Seu perfil, os acessos à sua conta e os agentes que você opera: account.json
- A lista das suas conversas, com nome, tipo e a data em que você entrou: manifest.json
- As mensagens que você enviou, na versão final, suas respostas a pedidos
  de aprovação e os formulários que você enviou: um arquivo por conversa,
  na pasta conversations
- Os arquivos que você enviou e a sua foto de perfil: pasta attachments

O QUE NÃO ESTÁ AQUI

- Mensagens de outras pessoas, inclusive as que mencionam você
- Mensagens escritas pelos agentes que você opera
- Reações
- Conversas das quais você saiu
- O registro de auditoria do servidor
- O endereço de rede de cada acesso à sua conta

COMO LER

Os arquivos .json são texto e abrem em qualquer editor. Pessoas e conversas
aparecem pelo nome; os códigos como p1, c1 e m1 só valem dentro desta pasta
e servem para ligar uma coisa à outra.

Uma mensagem que você apagou aparece como "deleted": só a data, sem o
conteúdo. Uma mensagem que este dispositivo não conseguiu ler aparece como
"unreadable", e um arquivo que não pôde ser obtido aparece com
"missing": true. O manifest.json conta essas lacunas por conversa, no
campo "gaps".

CUIDADO

Esta pasta traz em texto legível mensagens de conversas privadas. Guarde em
um lugar seguro.

Esta cópia serve para leitura e para levar seus dados a outro lugar. Ela não
é um backup e não pode ser importada de volta.`,
  },
  dialog: {
    back: 'Voltar',
    close: 'Fechar',
  },
  // O primitivo Field (workspace.md §25.8, §26 item 4): depois do rótulo de um campo opcional.
  field: {
    optional: '(opcional)',
  },
} as const satisfies Messages
