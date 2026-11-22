import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Channel, ChannelId, Presence, UserId, UserProfile } from '@tayet/client'
import { Button, Dialog, ScreenHeader } from '../primitives'
import { useMedia } from '../MediaContext'
import { useCoveringScreen } from '../covering-screen'
import { useStackBack } from '../stack'
import { useMounted } from '../use-mounted'
import { Lock } from '../icons'
import { PrivateMarkSpace } from './ChannelLabel'
import { t, GLYPH } from '../i18n'
import { AgentAvatar, agentColorOf } from './AgentAvatar'

// Perfil-de-outro (ADR-043, Slice 2 PR-2; layout ADR-053). A sub-tela de VER o perfil de outro
// usuário: header (avatar em destaque + nome + pronomes), a seção Recado — pronomes e recado só se
// informados — e o CTA de DM. Distinta do ProfileEditor (que EDITA o próprio, MyProfile): aqui não há
// escrita de PERFIL — o UserProfile opaco é carregado lazy e só lido. O DM não é exceção a isso: é
// ação de NAVEGAÇÃO (abre a conversa), não edição do alvo.
//
// Standalone e testável isolado: recebe o userId opaco + o loader (getUserProfile atrás do barrel) e o
// onClose. Carrega no mount (idioma do ProfileEditor.onLoadProfile().then) com estados loading/erro.
//
// Título estático "Perfil" (protótipo é a spec, ADR-033): o nome vive UMA vez, no header ao lado do
// avatar. Na forma mínima do ADR-043 o título carregava o displayName porque não havia header em
// destaque; com o redesign isso duplicaria o nome e faria flicker no load ("Perfil" → nome). Não
// reverter pro dinâmico. As duas metades se pagam juntas: o ariaLabel carrega o nome porque o título
// estático o tiraria do anúncio do leitor de tela (o Dialog usa `ariaLabel ?? title` como nome
// acessível do role="dialog"). Mexer numa sem a outra regride — ou o nome duplica na tela, ou some do
// anúncio. Nome LIMPO, nunca o UserId (P1, §3 do PLANO-PERFIL).
//
// O avatar é BESPOKE em escala de perfil (148px, geometria adjudicada em
// manifesto view-profile §6) — não o primitivo Avatar, cujo `size` é regime de DENSIDADE
// (28px/22px: avatar de LINHA). ADR-041, ratificação ii: a escala de perfil não pertence ao
// primitivo decorativo inline.
//
// P1 (ADR-007/ADR-008): lida só com UserProfile/UserId opacos — nenhum literal de protocolo acima do
// barrel. O userId vive em JS (props/closure), NUNCA num atributo do DOM nem num aria-label (o
// aria-label do header usa o nome limpo). O avatar resolve via useMedia (ref opaco → URL atrás do
// barrel); cai pro monograma sem foto.
//
// Narrow window (`narrow`; manifest view-profile §8, PLANO-MOBILE M8): the same instance as a full screen of
// the stack. "Enviar mensagem" and its failure line go to a fixed footer, which exists only with the verb
// (P3); the back is never held while the verb runs (P4).

// Presença (ADR-056): domínio → DOM. O atributo `data-presence` carrega o vocabulário do protótipo —
// 'away' aterrissa como "ausente" (aliasing de valor do manifesto view-profile,
// §5). O label é a copy plana adjudicada (ADR-056 dec. 5.ii): sem "ativa há…"/"visto…" — o
// último-ativo do protótipo está deferido junto com idle→away.
function presenceAttr(p: Presence): 'online' | 'ausente' | 'offline' {
  return p === 'away' ? 'ausente' : p
}
const presenceLabel = (): Record<Presence, string> => ({
  online: t('profile.presenceOnline'),
  away: t('profile.presenceAway'),
  offline: t('profile.presenceOffline'),
})

// Monograma derivado do nome limpo (P1: nunca um id). Duas letras — primeira de cada uma das duas
// primeiras palavras, ou os dois primeiros caracteres de uma palavra só.
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const raw = parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : name.trim().slice(0, 2)
  return raw.toUpperCase()
}

// Fidelidade do chip (manifesto view-profile §7.5): o prefixo `#` renderiza separado do
// nome (mono/muted via .user-profile__chip-hash). Só apresentação — o textContent visível é o mesmo
// nome limpo de sempre; nome sem `#` renderiza inteiro. Canal privado (manifesto §4 item 6): o
// cadeado, muted, no lugar do `#`, com o nome acessível do rótulo ("Canal privado board",
// PLANO-RELEASE-PUBLICA §8.66); o gap do chip separa os dois.
function chipLabel(channel: Channel) {
  const { name } = channel
  if (channel.kind === 'private') {
    return (
      <>
        <span className="user-profile__chip-lock" role="img" aria-label={t('channel.privateMark')}>
          <Lock />
        </span>
        <PrivateMarkSpace />
        {name.replace(/^#/, '')}
      </>
    )
  }
  return name.startsWith('#') ? (
    <>
      <span className="user-profile__chip-hash">{GLYPH.hash}</span>
      {name.slice(1)}
    </>
  ) : (
    name
  )
}

// One instance per person, wherever it is mounted: what is loaded, pending or late belongs to that person.
export function UserProfileDialog(props: Parameters<typeof UserProfileCard>[0]) {
  return <UserProfileCard key={props.userId} {...props} />
}

function UserProfileCard({
  userId,
  onLoadUserProfile,
  onLoadCommonChannels,
  onSelectChannel,
  onGetPresence,
  onSubscribePresence,
  onOpenDirectMessage,
  onClose,
  onNavigated,
  narrow = false,
  covered = false,
}: {
  userId: UserId
  onLoadUserProfile: (user: UserId) => Promise<UserProfile>
  // ADR-053 dec. 4: carrega os canais em comum, lazy no mount — espelha onLoadUserProfile. Opcional:
  // ausente → a seção não existe (o harness de render-scan a omite). O Dialog não deriva nada; só
  // pede. Falha aqui NÃO derruba o perfil: a seção some, o resto renderiza (P4).
  onLoadCommonChannels?: (user: UserId) => Promise<Channel[]>
  // ADR-053 dec. 4: selecionar o canal a partir do chip. Mesmo formato do CTA de DM — navegação, não
  // escrita. Opcional: ausente → os chips são etiquetas inertes (o render-scan prova os dois).
  onSelectChannel?: (id: ChannelId) => void
  // ADR-056: presença do alvo. onGetPresence é o point read síncrono na abertura (resolve o
  // late-subscriber — o mapa vive na ACL); onSubscribePresence entrega os eventos de presença do
  // stream global já estreitados em (user, presence) — o filtro pelo ALVO é daqui. Opcionais no
  // idioma de onLoadCommonChannels: ausentes → o cluster de presença não existe (harness bare).
  onGetPresence?: (user: UserId) => Presence
  onSubscribePresence?: (handler: (user: UserId, presence: Presence) => void) => () => void
  // ADR-053 dec. 5: o verbo de DM, ou undefined. O Workspace decide (canDm) — este componente é burro:
  // prop presente → CTA; ausente → sem CTA. Ele NUNCA recebe o id do operador; a comparação de
  // identidade não é dele.
  onOpenDirectMessage?: (user: UserId) => Promise<void>
  onClose: () => void
  // G1: the profile, still open, took the person to a conversation (the message or a channel's chip); what
  // is under it closes too. Not called for a verb that settles after the profile was closed (P4).
  onNavigated?: () => void
  // Below the width breakpoint: a full screen; `covered` while another one is over it.
  narrow?: boolean
  covered?: boolean
}) {
  const [profile, setProfile] = useState<UserProfile | null>(null) // null = carregando
  const [loadError, setLoadError] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [dmError, setDmError] = useState(false)
  // ADR-053 dec. 4: os canais em comum. null = não carregou / falhou; [] = nenhum; a seção só renderiza
  // com comprimento > 0 (todos os três colapsam na ausência da seção — sem placeholder). `expanded`
  // revela a lista inteira quando há overflow (>8); não colapsa de volta.
  const [common, setCommon] = useState<Channel[] | null>(null)
  const [expanded, setExpanded] = useState(false)
  // ADR-056: a presença do alvo, VIVA enquanto o Dialog está aberto. null = prop ausente (harness
  // bare) → nenhum cluster renderiza e a raiz não carrega data-presence.
  const [presence, setPresence] = useState<Presence | null>(null)
  // Foto resolvida (mr_*/mxc → URL atrás do barrel; no-op enquanto profile é null). O Avatar cai pro
  // monograma sem foto. P1: o mr_*/mxc fica aqui+ACL, nunca no DOM.
  const avatar = useMedia(profile?.avatar, 'thumbnail').url
  const agent = agentColorOf(profile ?? undefined)
  const mounted = useMounted()
  // The verb settles later: what navigating closes is read then.
  const navigated = useRef(onNavigated)
  navigated.current = onNavigated

  useEffect(() => {
    let active = true
    onLoadUserProfile(userId).then(
      (p) => {
        if (active) setProfile(p)
      },
      () => {
        if (active) setLoadError(true)
      },
    )
    return () => {
      active = false
    }
  }, [onLoadUserProfile, userId])

  // ADR-053 dec. 4: os canais em comum, lazy no mount. Efeito PRÓPRIO, separado do load do perfil — os
  // dois falham independentes, e o loadError do perfil NÃO pode ser acionado por canais. No catch:
  // setCommon(null) — SEM estado de erro, SEM mensagem. A seção some; o silêncio é a degradação (mesmo
  // idioma do `note` ausente), decisão e não esquecimento. Prop ausente → o efeito não roda, common
  // fica null, a seção não existe.
  useEffect(() => {
    if (!onLoadCommonChannels) return
    let active = true
    onLoadCommonChannels(userId).then(
      (cs) => {
        if (active) setCommon(cs)
      },
      () => {
        if (active) setCommon(null)
      },
    )
    return () => {
      active = false
    }
  }, [onLoadCommonChannels, userId])

  // ADR-056: point read na abertura + subscription pelo tempo de vida do Dialog (o idioma do
  // useChat: subscribe no efeito, unsubscribe no cleanup). Ler-uma-vez-e-só não serve — a
  // subscription É o ponto do ADR-056. Eventos de OUTRO usuário são descartados aqui.
  useEffect(() => {
    if (!onGetPresence) return
    setPresence(onGetPresence(userId))
    return onSubscribePresence?.((user, p) => {
      if (user === userId) setPresence(p)
    })
  }, [onGetPresence, onSubscribePresence, userId])

  // await-and-close (idioma do NewConversationDialog): sucesso fecha; o select-on-added do useChat
  // (seam S1) roteia sozinho — NÃO roteamos aqui. Erro → mensagem inline e o Dialog FICA ABERTO.
  async function openDm() {
    if (!onOpenDirectMessage || submitting) return
    setSubmitting(true)
    setDmError(false)
    try {
      await onOpenDirectMessage(userId)
      // R4: a verb closes only the profile it started from, never another one opened meanwhile.
      if (!mounted.current) return
      navigated.current?.()
      onClose()
    } catch {
      if (!mounted.current) return
      setDmError(true)
      setSubmitting(false)
    }
  }

  const dmButton = onOpenDirectMessage && (
    // P1: o rótulo é texto limpo e o userId viaja na closure — nunca num atributo.
    <Button className="user-profile__dm" variant="fill" disabled={submitting} onClick={openDm}>
      {t('profile.sendMessage')}
    </Button>
  )
  const dmFailure = dmError && (
    <p className="user-profile__error" role="alert">
      {t('profile.openFailed')}
    </p>
  )

  return (
    <ProfileShell
      narrow={narrow}
      covered={covered}
      label={profile ? t('profile.viewLabel', { name: profile.displayName }) : undefined}
      onClose={onClose}
      footer={
        !loadError && profile && dmButton ? (
          <>
            {dmFailure}
            {dmButton}
          </>
        ) : undefined
      }
    >
      {/* ADR-056: data-presence na RAIZ, cascateando pros dois dots — fidelidade ao protótipo, que
          seta o atributo na raiz e resolve os estados por seletor descendente. Valores do protótipo
          (online/ausente/offline), nunca os do domínio. Ausente sem prop de presença. */}
      <div
        className="user-profile"
        data-presence={presence && !agent ? presenceAttr(presence) : undefined}
      >
        {loadError ? (
          <p className="user-profile__load-error">{t('profile.loadFailed')}</p>
        ) : profile === null ? (
          <p className="user-profile__loading">{t('profile.loading')}</p>
        ) : (
          <>
            <div className="user-profile__header">
              {/* Fidelidade §7.2 (manifesto view-profile): a borda do avatar muda de
                  regime com foto — o modifier usa o MESMO condicional que já escolhe img/monograma.
                  O wrapper relativo é a âncora do dot de presença (ADR-056) — como no protótipo, o
                  dot é IRMÃO da caixa do avatar, fora do overflow:hidden que recorta a foto. */}
              {agent !== undefined ? (
                // ADR-086: an agent's profile shows the agent avatar (glyph + colour + indicator)
                // at the profile size — no photo, never presence.
                <AgentAvatar color={agent} size="perfil" />
              ) : (
              <span className="user-profile__avatar-wrap" aria-hidden="true">
                <span
                  className={
                    avatar
                      ? 'user-profile__avatar user-profile__avatar--photo'
                      : 'user-profile__avatar'
                  }
                >
                  {avatar ? (
                    <img className="user-profile__avatar-img" src={avatar} alt="" />
                  ) : (
                    <span className="user-profile__avatar-monogram">
                      {initialsOf(profile.displayName)}
                    </span>
                  )}
                </span>
                {/* Decorativo — a presença é anunciada pela linha de texto na pilha do nome. */}
                {presence && <span className="user-profile__presence-badge" />}
              </span>
              )}
              <div className="user-profile__identity">
                {/* Fidelidade §7.2: a pilha nome+pronomes ancora embaixo da coluna esticada; o CTA
                    fica FORA da pilha, direto na coluna. */}
                <div className="user-profile__name-stack">
                  <span className="user-profile__name">{profile.displayName}</span>
                  {profile.pronouns && (
                    <span className="user-profile__pronouns">{profile.pronouns}</span>
                  )}
                  {/* ADR-056: terceira linha da pilha (nome → pronomes → presença), como no
                      protótipo. Label plano (dec. 5.ii); o dot repete o estado por CSS. */}
                  {agent !== undefined && profile.operatorName !== undefined && (
                    <span className="user-profile__pronouns" data-agent-operator="">
                      {t('agent.operatedBy', { name: profile.operatorName })}
                    </span>
                  )}
                  {presence && !agent && (
                    <span className="user-profile__presence">
                      <span className="user-profile__presence-dot" aria-hidden="true" />
                      {presenceLabel()[presence]}
                    </span>
                  )}
                </div>
                {!narrow && dmButton}
              </div>
            </div>
            {!narrow && dmFailure}
            {/* Recado (ADR-053): a seção INTEIRA some quando não há recado — sem rótulo órfão, sem
                espaço morto. Ausente = não informado, não uma promessa vazia. */}
            {profile.note && (
              <section className="user-profile__section" aria-label={t('profile.note')}>
                <h3 className="user-profile__section-label">{t('profile.note')}</h3>
                <p className="user-profile__note">{profile.note}</p>
              </section>
            )}
            {/* Da organização (ADR-054). A camada organizacional do sujeito, lida na MESMA volta do
                perfil estendido (custo zero). Posicionada depois do Recado e antes de Canais em comum:
                identidade organizacional é atributo do sujeito; canais em comum é relação com o
                operador. A seção INTEIRA só existe se houver CONTEÚDO — guarda por presença de campo, não
                por presença do objeto: a ACL só monta `org` com ao menos um campo, mas guardamos por
                conteúdo para nunca render rótulo órfão. Cada campo colapsa sozinho (mesmo idioma do
                Recado ausente): campo ausente não vira linha vazia. `authority` NUNCA vai pro DOM (nem
                texto, nem atributo, nem classe) e a UI NÃO ramifica nele — hoje é sempre 'directory' e
                ramificar seria código morto (PLANO §0.2 dec. 3). É leitura pura: sem input/button/onClick. */}
            {profile.org && (profile.org.fullName || profile.org.jobTitle || profile.org.workEmail) && (
              /* Fidelidade §7.4: a seção org é um CARD com classe própria — a guarda por conteúdo e
                 o colapso por campo ficam como estão. */
              <section className="user-profile__org-card" aria-label={t('profile.org')}>
                <h3 className="user-profile__section-label">{t('profile.org')}</h3>
                {profile.org.fullName && (
                  <div className="user-profile__org-field">
                    <span className="user-profile__org-label">{t('profile.orgName')}</span>
                    <span className="user-profile__org-value">{profile.org.fullName}</span>
                  </div>
                )}
                {profile.org.jobTitle && (
                  <div className="user-profile__org-field">
                    <span className="user-profile__org-label">{t('profile.orgJobTitle')}</span>
                    <span className="user-profile__org-value">{profile.org.jobTitle}</span>
                  </div>
                )}
                {profile.org.workEmail && (
                  <div className="user-profile__org-field">
                    <span className="user-profile__org-label">{t('profile.orgWorkEmail')}</span>
                    <span className="user-profile__org-value">{profile.org.workEmail}</span>
                  </div>
                )}
              </section>
            )}
            {/* Canais em comum (ADR-053 dec. 4). A seção INTEIRA só existe com comprimento > 0: null
                (não carregou / falhou) e [] (nenhum em comum) colapsam igual — sem rótulo órfão, sem
                "Nenhum canal em comum". O contador é sempre o TOTAL, mesmo com overflow. O texto do chip
                é o nome LIMPO (#engineering, sem :server); o ChannelId nunca chega ao DOM (P1) — vive só
                como key de React. Chips inertes aqui; o clique é o commit 3. */}
            {common && common.length > 0 && (
              <section className="user-profile__section" aria-label={t('profile.commonChannels')}>
                <h3 className="user-profile__section-label">{t('profile.commonChannelsCount', { n: common.length })}</h3>
                <div className="user-profile__chips">
                  {/* Prop presente → o chip é um <button> que seleciona o canal e FECHA (mesmo formato
                      do CTA de DM: navegação, não escrita; sem caso especial pro canal já aberto — a
                      seleção é idempotente). Ausente → etiqueta inerte. O ChannelId (c.id) viaja na
                      closure, NUNCA num atributo (P1) — como o UserId do CTA. */}
                  {(expanded ? common : common.slice(0, 8)).map((c) =>
                    onSelectChannel ? (
                      <button
                        key={c.id}
                        type="button"
                        className="user-profile__chip"
                        onClick={() => {
                          onSelectChannel(c.id)
                          onNavigated?.()
                          onClose()
                        }}
                      >
                        {chipLabel(c)}
                      </button>
                    ) : (
                      <span key={c.id} className="user-profile__chip">
                        {chipLabel(c)}
                      </span>
                    ),
                  )}
                  {!expanded && common.length > 8 && (
                    <button
                      type="button"
                      className="user-profile__chip user-profile__chip--more"
                      onClick={() => setExpanded(true)}
                    >
                      {GLYPH.plus}{common.length - 8}
                    </button>
                  )}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </ProfileShell>
  )
}

interface ShellProps {
  label: string | undefined
  onClose: () => void
  children: ReactNode
}

function ProfileShell({
  narrow,
  covered,
  footer,
  ...shell
}: ShellProps & { narrow: boolean; covered: boolean; footer?: ReactNode }) {
  if (narrow) return <ProfileScreen covered={covered} footer={footer} {...shell} />
  return (
    <Dialog
      className="user-profile-dialog"
      title={t('profile.viewTitle')}
      ariaLabel={shell.label}
      onClose={shell.onClose}
      closeLabel={t('dialog.close')}
    >
      {shell.children}
    </Dialog>
  )
}

// §8.1: back and the title, the column that scrolls, the one action in the fixed footer.
function ProfileScreen({
  label,
  covered,
  onClose,
  footer,
  children,
}: ShellProps & { covered: boolean; footer?: ReactNode }) {
  const back = useStackBack(onClose)
  const { backRef, screenProps } = useCoveringScreen(back, covered)
  const title = t('profile.viewTitle')
  return (
    <section className="profile-screen" aria-label={label ?? title} {...screenProps}>
      <ScreenHeader className="profile-screen__header" onBack={back} backRef={backRef} title={title} />
      <div className="profile-screen__body">{children}</div>
      {footer && <div className="profile-screen__footer">{footer}</div>}
    </section>
  )
}
