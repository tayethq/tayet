// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { Workspace } from '../../src/ui/components/Workspace'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import { roomToChannel } from '@tayet/shared/internal'
import type { AclTelemetry, Channel, ChannelId, Message, User } from '../../src/acl'
import type { Room } from 'matrix-js-sdk'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy } from '../support/copy'

// Render-scan da identidade estrutural de custódia (ADR-057 dec. 2 — PR-4 do track
// CRIPTO-COBERTURA). P1 estendido a "infra invisível": o cofre é membro de TODA sala cifrada e o
// produto não tem vocabulário para explicá-lo, então o localpart não pode alcançar o DOM por via
// nenhuma.
//
// DIFERENÇA DELIBERADA para os outros render-scans deste diretório: aqui as fixtures NÃO são
// objetos de domínio escritos à mão. Elas são produzidas pela tradução REAL da ACL (getMembers +
// roomToChannel) a partir de salas fake que TÊM o cofre dentro. Um render-scan alimentado por
// fixture já-filtrada seria vacuoso — provaria só que quem escreveu a fixture não digitou "cofre".
// Assim o teste exercita de ponta a ponta a corrente que importa: sala com cofre → filtro da ACL →
// props da UI → DOM.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:tayet.local'
const PEER = '@peer:tayet.local'
const ANA = '@ana:tayet.local'
const COFRE = '@cofre:tayet.local'
const CHANNEL_ROOM = '!eng:tayet.local'
const DM_ROOM = '!dm:tayet.local'

afterEach(cleanup)

function member(userId: string, displayName: string, powerLevel = 0) {
  return { userId, rawDisplayName: displayName, powerLevel, membership: 'join', getMxcAvatarUrl: () => null }
}

// O cofre vem PRIMEIRO nos dois rosters de propósito: é a ordem que quebraria o `find` do nome do
// DM se o filtro não existisse, e é a ordem que o store do SDK não garante estável.
const channelRoster = [member(COFRE, 'cofre'), member(ME, 'Eu', 100), member(ANA, 'Ana Lima')]
const dmRoster = [member(COFRE, 'cofre'), member(ME, 'Eu', 100), member(PEER, 'Bruno Sato')]

// `authored` espelha o produto: canal criado pela ACL TEM m.room.name (createChannel exige nome);
// DM não autora nome (vive do m.direct). A distinção importa desde o fecho da PR-4: nome calculado
// (sem m.room.name) com o cofre na sala é recomputado só dos humanos (displayNameSource).
function fakeRoom(
  roomId: string,
  name: string,
  roster: ReturnType<typeof member>[],
  authored = true,
): unknown {
  return {
    roomId,
    name,
    myUserId: ME,
    getJoinRule: () => 'invite',
    getCanonicalAlias: () => null,
    getMembers: () => roster,
    getJoinedMembers: () => roster,
    getMember: (uid: string) => roster.find((m) => m.userId === uid) ?? null,
    getJoinedMemberCount: () => roster.length,
    hasEncryptionStateEvent: () => false,
    currentState: {
      getStateEvents: (type: string) =>
        authored && type === 'm.room.name' ? { getContent: () => ({ name }) } : null,
    },
  }
}

const rooms: Record<string, unknown> = {
  [CHANNEL_ROOM]: fakeRoom(CHANNEL_ROOM, 'engineering', channelRoster),
  // DM: nome NÃO autorado + room.name CALCULADO pelo SDK já contaminado pelo cofre — o cenário
  // que o render-scan sobre dados reais pegou vivo. O caminho do nome não pode usar essa string.
  [DM_ROOM]: fakeRoom(DM_ROOM, 'Bruno Sato and cofre', dmRoster, false),
}

// Gateway real sobre as salas fake. m.direct mapeia o DM ao PAR HUMANO (o cofre nunca entra lá —
// addDirectRoom só escreve o par), que é o que sustenta isDm/dmPeerOf.
function gateway(): MatrixGateway {
  const fakeClient = {
    getUserId: () => ME,
    getRooms: () => [],
    getRoom: (id: string) => rooms[id] ?? null,
    getAccountData: () => ({ getContent: () => ({ [PEER]: [DM_ROOM] }) }),
  }
  const gw = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gw as unknown as { client: unknown }).client = fakeClient
  return gw
}

// ctx() é privado; roomToChannel é chamado pelo MESMO caminho que o gateway usa internamente.
function channelOf(gw: MatrixGateway, roomId: string): Channel {
  const ctx = (gw as unknown as { ctx: (r?: unknown) => never }).ctx(rooms[roomId])
  return roomToChannel(rooms[roomId] as Room, ctx)
}

const noopVerb = () => Promise.resolve()

describe('render-scan (P1) — a identidade de custódia não alcança o DOM (ADR-057 dec. 2)', () => {
  it('timeline, lista de canais, manage panel e picker: humanos presentes, cofre ausente', async () => {
    const gw = gateway()

    const channel = channelOf(gw, CHANNEL_ROOM)
    const dm = channelOf(gw, DM_ROOM)
    // The fake has no #all, so the reader translates as a guest; the picker (the fourth surface) is offered
    // only to an admin (channel-management.md §13.1 item 5), so only the reader's role is lifted here. The
    // custody filter under test stays the real translation.
    const members = gw.getMembers(CHANNEL_ROOM as ChannelId).map((m) => (m.self ? { ...m, role: 'admin' as const } : m))

    // Sanidade do insumo: as salas REALMENTE têm o cofre dentro — senão o teste passaria por
    // vacuidade e ninguém notaria.
    expect(channelRoster.some((m) => m.userId === COFRE)).toBe(true)
    expect(dmRoster.some((m) => m.userId === COFRE)).toBe(true)

    // Picker: a mesma união de getMembers que `listKnownContacts` monta (useChat compõe, não
    // reimplementa) — então o filtro do choke point é o que o picker herda.
    const candidates: User[] = gw.getMembers(DM_ROOM as ChannelId).map((m) => m.user)

    const usersById = Object.fromEntries(members.map((m) => [String(m.user.id), m.user]))
    const messages: Message[] = [
      {
        id: 'm1' as unknown as Message['id'],
        channelId: channel.id,
        author: members[1]!.user.id,
        body: { kind: 'text', text: 'primeira mensagem da sala' },
        sentAt: 0 as unknown as Message['sentAt'],
        reactions: [],
        mine: false,
        mentionsMe: false,
      },
    ]

    const { container, getByRole, findByRole } = render(
      <Workspace
        channels={[channel, dm]}
        selectedChannelId={channel.id}
        messages={messages}
        usersById={usersById}
        connection="connected"
        managing={channel}
        members={members}
        channelAbilities={{ rename: true, editTopic: true, addPeople: true, removePeople: true, setRoles: true, archive: true }}
        onManageChannel={() => {}}
        onCloseManage={() => {}}
        onUpdateChannel={noopVerb}
        onArchiveChannel={noopVerb}
        onLeaveChannel={noopVerb}
        onAddMember={noopVerb}
        onRemoveMember={noopVerb}
        onSetRole={noopVerb}
        loadCandidates={() => Promise.resolve(candidates)}
        onSelectChannel={() => {}}
        onSend={() => {}}
      />,
    )

    // ── Controle positivo: o conteúdo humano ESTÁ na tela (senão a ausência do cofre não vale nada).
    const text = () => container.textContent ?? ''
    // A sala fake não tem join_rule público → canal privado: o cadeado ocupa o lugar do '#' (§8.35).
    expect(text()).toContain('engineering')
    expect(getByRole('heading', { level: 2, name: 'Canal privado engineering' })).toBeTruthy()
    expect(text()).toContain('Ana Lima')
    expect(text()).toContain('primeira mensagem da sala')
    // O DM se chama pelo humano — o ripple de 3 membros, visto do DOM.
    expect(text()).toContain('Bruno Sato')

    // ── Abre o picker (a quarta superfície), para que o scan cubra os candidatos renderizados.
    fireEvent.click(getByRole('button', { name: copy.channel.addMember }))
    await findByRole('dialog', { name: copy.channel.addMember })

    // ── O scan: innerHTML cobre texto E atributos, nas quatro superfícies de uma vez.
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
    expect(container.innerHTML).not.toMatch(/cofre/i)
  })

  it('negativo do scanner: o padrão custody-identity REALMENTE pega o localpart', () => {
    // Sem este controle, um scanner quebrado passaria despercebido e os asserts acima virariam
    // decoração.
    const leaks = findProtocolLeaksInText('<span>cofre</span>')
    expect(leaks.map((l) => l.pattern)).toContain('custody-identity')
  })
})
