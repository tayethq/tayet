// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { OrgAdmin } from '../../src/ui/components/OrgAdmin'
import { LastAdminError, NotMemberError, OrgAccessDeniedError, PeopleUnavailableError } from '../../src/acl'
import type { OrgAccess, Person, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'

// A Admin da organização, fatias 1c e 1d (organization-admin.md §2.1–§2.3; ADR-118 dec. 4 a 6; PLANO-ADMIN §8.6,
// forks C1–C9 e as emendas ao C1 e ao C5; §8.8, forks V1–V6). Os ids de fixture têm shape de protocolo de propósito: cruzam como key e
// alvo de verbo e nunca chegam ao DOM.

const uid = (s: string): UserId => s as unknown as UserId
const id = (name: string): UserId => uid(`@u-abc234def567-${name.split(' ')[0]!.toLowerCase()}:tayet.local`)
const person = (
  name: string,
  over: Partial<Pick<Person, 'email' | 'pending' | 'self'>> & { kind?: 'member' | 'guest' | 'agent'; operator?: string } = {},
): Person => ({
  user: {
    id: over.kind === 'agent' ? uid('@a-abcdefghijkl:tayet.local') : id(name),
    displayName: name,
    kind: over.kind ?? 'member',
    ...(over.kind === 'agent' ? { agentColor: 'malva' as const, operatorName: over.operator } : {}),
  },
  email: over.email,
  pending: over.pending ?? false,
  self: over.self ?? false,
})

const MARINA = person('Marina Alves', { email: 'marina@vega.com', self: true })
const BRUNA = person('Bruna Lima', { email: 'bruna@vega.com' })
const DIEGO = person('Diego Martins', { email: 'diego@vega.com' })
const IGOR = person('Igor Lemos', { email: 'igor@vega.com' })
const LUCIA = person('Lúcia Ferraz', { email: 'lucia@vega.com', pending: true })
const VERA = person('Vera Campos', { email: 'vera@campos.com', kind: 'guest' })
const REL = person('Relatório diário', { kind: 'agent', operator: 'Marina Alves' })
const everyone = [VERA, REL, IGOR, LUCIA, DIEGO, BRUNA, MARINA]

const access = (over: Partial<OrgAccess> = {}): OrgAccess => ({
  admins: [MARINA.user.id],
  // Lúcia (pending) and an id outside the list are in the set: neither gets a mark (C4).
  withoutAccess: [IGOR.user.id, LUCIA.user.id, uid('@u-zzzzzzzzzzzz:tayet.local')],
  ...over,
})

// The shell opens on the Visão geral (V3); the 1c tests start from "Pessoas", by the navigation.
function mount(props: Partial<ComponentProps<typeof OrgAdmin>> = {}, at: 'people' | 'overview' = 'people') {
  const onGetOrgAccess = vi.fn(async () => access())
  const onSetOrgAdmin = vi.fn(async () => {})
  const ui = render(
    <OrgAdmin
      people={everyone}
      inviteChannels={[]}
      onBack={() => {}}
      onGetOrgAccess={onGetOrgAccess}
      onSetOrgAdmin={onSetOrgAdmin}
      onInvitePerson={async () => ({ user: BRUNA.user, failedChannels: [] })}
      onRemovePerson={async () => {}}
      onCreateAgent={async () => ({ userId: REL.user.id, token: 'x' })}
      onUpdateAgent={async () => {}}
      onReissueAgent={async () => ({ token: 'x' })}
      onRemoveAgent={async () => {}}
      {...props}
    />,
  )
  if (at === 'people') {
    const nav = ui.getByRole('navigation', { name: copy.admin.nav })
    fireEvent.click(within(nav).getByRole('button', { name: copy.people.title }))
  }
  return { ui, onGetOrgAccess: props.onGetOrgAccess ?? onGetOrgAccess, onSetOrgAdmin: props.onSetOrgAdmin ?? onSetOrgAdmin }
}

afterEach(cleanup)

const table = (ui: ReturnType<typeof render>) => ui.getByRole('table', { name: copy.people.title })
const rowOf = (ui: ReturnType<typeof render>, name: string) =>
  within(table(ui))
    .getAllByRole('row')
    .find((r) => r.querySelector('.admin-people__name')?.textContent?.startsWith(name))!
const names = (ui: ReturnType<typeof render>) =>
  [...table(ui).querySelectorAll('.admin-people__name')].map((n) => n.textContent)
const more = (ui: ReturnType<typeof render>, name: string) =>
  ui.getByRole('button', { name: fill(copy.admin.actionsFor, { name }) })
const ready = async (ui: ReturnType<typeof render>) =>
  waitFor(() => expect(within(rowOf(ui, 'Marina Alves')).queryByText(copy.admin.roleAdmin)).toBeTruthy())
const menuItems = (ui: ReturnType<typeof render>) =>
  within(ui.getByRole('menu')).getAllByRole('menuitem').map((i) => i.firstElementChild?.textContent)

describe('casca (§2.1, C1, V3)', () => {
  it('topo, navegação "Visão geral" e "Pessoas" (aria-current), coluna; "Voltar às conversas" chama onBack', async () => {
    const onBack = vi.fn()
    const { ui } = mount({ onBack })
    const nav = ui.getByRole('navigation', { name: copy.admin.nav })
    expect(within(nav).getByRole('heading', { level: 1 }).textContent).toBe(copy.admin.title)
    const items = within(nav).getAllByRole('button')
    expect(items.map((b) => b.textContent)).toEqual([copy.admin.overview, copy.people.title])
    expect(items.map((b) => b.getAttribute('aria-current'))).toEqual([null, 'page'])
    expect(ui.container.querySelector('.org-admin__main .org-admin__column')).toBeTruthy()
    fireEvent.click(ui.getByRole('button', { name: copy.admin.back }))
    expect(onBack).toHaveBeenCalled()
    await ready(ui)
    expect(findProtocolLeaksInText(ui.container.innerHTML)).toEqual([])
  })

  it('R6: relê o papel na abertura', async () => {
    const { ui, onGetOrgAccess } = mount()
    await ready(ui)
    expect(onGetOrgAccess).toHaveBeenCalledTimes(1)
  })
})

describe('tabela (§2.3 item 4) e o cruzamento do C4', () => {
  it('ordem por nome; situação; "operado por" no agente; selo Admin; "—" sem papel', async () => {
    const { ui } = mount()
    await ready(ui)
    expect(names(ui)).toEqual([
      'Bruna Lima',
      'Diego Martins',
      'Igor Lemos',
      'Lúcia Ferraz',
      fill(copy.admin.self, { name: 'Marina Alves' }),
      'Relatório diário',
      'Vera Campos',
    ])
    expect(rowOf(ui, 'Bruna').textContent).toContain(copy.people.kindMember)
    expect(rowOf(ui, 'Lúcia').textContent).toContain(copy.people.pending)
    expect(rowOf(ui, 'Vera').textContent).toContain(copy.people.kindGuest)
    expect(rowOf(ui, 'Relatório').textContent).toContain(copy.admin.situationAgent)
    expect(rowOf(ui, 'Relatório').textContent).toContain(fill(copy.agent.operatedBy, { name: 'Marina Alves' }))
    expect(rowOf(ui, 'Relatório').querySelector('[data-agent-avatar]')).toBeTruthy()
    expect(rowOf(ui, 'Lúcia').querySelector('.people__mono-pending')).toBeTruthy()
    expect(within(rowOf(ui, 'Bruna')).queryByText(copy.admin.roleAdmin)).toBeNull()
    expect(within(rowOf(ui, 'Bruna')).getByText(copy.admin.noRole)).toBeTruthy()
  })

  it('C4: a marca só em quem está na lista; o pendente não ganha; id fora da lista é ignorado', async () => {
    const { ui } = mount()
    await ready(ui)
    const flagged = [...table(ui).querySelectorAll('.admin-people__flag')].map((f) => f.closest('[role="row"]')!)
    expect(flagged.map((r) => r.querySelector('.admin-people__name')?.textContent)).toEqual(['Igor Lemos'])
    expect(flagged[0]!.textContent).toContain(copy.admin.withoutAccess)
    expect(within(table(ui)).getAllByRole('row')).toHaveLength(everyone.length + 1)
  })

  it('selo Admin de quem está na lista; admin de fora da lista não vira linha', async () => {
    const { ui } = mount({
      onGetOrgAccess: async () => access({ admins: [MARINA.user.id, LUCIA.user.id, uid('@u-yyyyyyyyyyyy:tayet.local')] }),
    })
    await ready(ui)
    expect(within(rowOf(ui, 'Lúcia')).getByText(copy.admin.roleAdmin)).toBeTruthy()
    expect(within(table(ui)).getAllByRole('row')).toHaveLength(everyone.length + 1)
  })
})

describe('pílulas e texto (§2.3 item 3, C8)', () => {
  it.each([
    ['pillAll', ['Bruna Lima', 'Diego Martins', 'Igor Lemos', 'Lúcia Ferraz', 'Marina Alves (você)', 'Relatório diário', 'Vera Campos']],
    ['pillOrganization', ['Bruna Lima', 'Diego Martins', 'Igor Lemos', 'Marina Alves (você)']],
    ['pillGuests', ['Vera Campos']],
    ['pillPending', ['Lúcia Ferraz']],
    ['pillAgents', ['Relatório diário']],
    ['pillAdmins', ['Marina Alves (você)']],
    ['withoutAccess', ['Igor Lemos']],
  ] as const)('%s', async (key, expected) => {
    const { ui } = mount()
    await ready(ui)
    const pill = within(ui.getByRole('group', { name: copy.admin.show })).getByRole('button', { name: copy.admin[key] })
    fireEvent.click(pill)
    expect(pill.getAttribute('aria-pressed')).toBe('true')
    expect(
      within(ui.getByRole('group', { name: copy.admin.show }))
        .getAllByRole('button')
        .filter((b) => b.getAttribute('aria-pressed') === 'true'),
    ).toHaveLength(1)
    expect(names(ui)).toEqual(expected)
  })

  it('a pílula combina com o texto; sem resultado com texto mostra o termo', async () => {
    const { ui } = mount()
    await ready(ui)
    fireEvent.click(ui.getByRole('button', { name: copy.admin.pillOrganization }))
    fireEvent.change(ui.getByRole('textbox', { name: copy.people.filter }), { target: { value: 'VEGA.com' } })
    expect(names(ui)).toEqual(['Bruna Lima', 'Diego Martins', 'Igor Lemos', 'Marina Alves (você)'])
    fireEvent.change(ui.getByRole('textbox', { name: copy.people.filter }), { target: { value: 'vera' } })
    expect(names(ui)).toEqual([])
    expect(table(ui).textContent).toContain(fill(copy.people.noResults, { term: 'vera' }))
  })

  it('pílula sem resultado e sem texto: a tabela vazia com a frase sem termo', async () => {
    const { ui } = mount({ people: [MARINA, BRUNA] })
    await ready(ui)
    fireEvent.click(ui.getByRole('button', { name: copy.admin.pillGuests }))
    expect(names(ui)).toEqual([])
    expect(table(ui).querySelector('.admin-people__empty')?.textContent).toBe(copy.admin.empty)
    expect(table(ui).textContent).not.toContain('“')
  })
})

describe('menu ⋯ por tipo de linha (§2.3 item 5) e o teclado do C9', () => {
  it.each([
    ['Bruna Lima', [copy.admin.makeAdmin, copy.admin.removeFromOrg]],
    ['Lúcia Ferraz', [copy.people.cancelInvite]],
    ['Relatório diário', [copy.agent.edit, copy.agent.remove]],
    ['Vera Campos', [copy.admin.removeFromOrg]],
    ['Marina Alves', [copy.admin.dropAdmin]],
  ])('%s', async (name, items) => {
    const { ui } = mount()
    await ready(ui)
    fireEvent.click(more(ui, name))
    expect(more(ui, name).getAttribute('aria-haspopup')).toBe('menu')
    expect(more(ui, name).getAttribute('aria-expanded')).toBe('true')
    expect(menuItems(ui)).toEqual(items)
    expect(ui.getByRole('menu').getAttribute('aria-label')).toBe(fill(copy.admin.actionsFor, { name }))
  })

  it('admin que não é você: "Deixar de ser admin" com separador antes de remover', async () => {
    const { ui } = mount({ onGetOrgAccess: async () => access({ admins: [MARINA.user.id, DIEGO.user.id] }) })
    await waitFor(() => expect(within(rowOf(ui, 'Diego')).queryByText(copy.admin.roleAdmin)).toBeTruthy())
    fireEvent.click(more(ui, 'Diego Martins'))
    expect(menuItems(ui)).toEqual([copy.admin.dropAdmin, copy.admin.removeFromOrg])
    expect(ui.getByRole('menu').querySelectorAll('[role="separator"]')).toHaveLength(1)
    expect(ui.getByRole('menu').querySelector('.admin-people__menu-item--danger')?.textContent).toBe(copy.admin.removeFromOrg)
  })

  it('antes da leitura do papel, nenhum item de admin; a própria linha não tem ⋯', () => {
    const { ui } = mount({ onGetOrgAccess: () => new Promise(() => {}) })
    expect(ui.queryByRole('button', { name: fill(copy.admin.actionsFor, { name: 'Marina Alves' }) })).toBeNull()
    fireEvent.click(more(ui, 'Bruna Lima'))
    expect(menuItems(ui)).toEqual([copy.admin.removeFromOrg])
  })

  it('setas, Home/End, Esc devolve o foco ao ⋯; Tab fecha', async () => {
    const { ui } = mount({ onGetOrgAccess: async () => access({ admins: [MARINA.user.id, DIEGO.user.id] }) })
    await waitFor(() => expect(within(rowOf(ui, 'Diego')).queryByText(copy.admin.roleAdmin)).toBeTruthy())
    more(ui, 'Bruna Lima').focus()
    fireEvent.keyDown(more(ui, 'Bruna Lima'), { key: 'ArrowDown' })
    const menu = ui.getByRole('menu')
    const [first, last] = within(menu).getAllByRole('menuitem')
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(menu, { key: 'End' })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(ui.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(more(ui, 'Bruna Lima'))
    fireEvent.click(more(ui, 'Bruna Lima'))
    fireEvent.keyDown(ui.getByRole('menu'), { key: 'Tab' })
    expect(ui.queryByRole('menu')).toBeNull()
  })

  it('clicar fora fecha o menu', async () => {
    const { ui } = mount()
    await ready(ui)
    fireEvent.click(more(ui, 'Bruna Lima'))
    fireEvent.pointerDown(document.body)
    expect(ui.queryByRole('menu')).toBeNull()
  })
})

describe('último admin (D6)', () => {
  it('admin único: o item fica desativado, focável, com a dica como descrição, e não abre confirm', async () => {
    const { ui, onSetOrgAdmin } = mount()
    await ready(ui)
    fireEvent.click(more(ui, 'Marina Alves'))
    const item = within(ui.getByRole('menu')).getByRole('menuitem')
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect(item.hasAttribute('disabled')).toBe(false)
    expect(document.activeElement).toBe(item)
    const hint = document.getElementById(item.getAttribute('aria-describedby')!)
    expect(hint?.textContent).toBe(copy.admin.onlyAdmin)
    fireEvent.click(item)
    expect(ui.queryByRole('alertdialog')).toBeNull()
    expect(onSetOrgAdmin).not.toHaveBeenCalled()
  })

  it('com outro admin, o item vale e abre o tirarVoce', async () => {
    const { ui } = mount({ onGetOrgAccess: async () => access({ admins: [MARINA.user.id, DIEGO.user.id] }) })
    await waitFor(() => expect(within(rowOf(ui, 'Diego')).queryByText(copy.admin.roleAdmin)).toBeTruthy())
    fireEvent.click(more(ui, 'Marina Alves'))
    const item = within(ui.getByRole('menu')).getByRole('menuitem')
    expect(item.hasAttribute('aria-disabled')).toBe(false)
    fireEvent.click(item)
    expect(ui.getByRole('alertdialog', { name: copy.admin.demoteSelfTitle })).toBeTruthy()
  })
})

describe('confirms (§2.3 item 6), C5 com a emenda, C6', () => {
  it('promover: copy, ponto accent, botão principal; o 200 relê e o confirm fecha quando a releitura volta', async () => {
    let resolveRead: (a: OrgAccess) => void = () => {}
    const reads = vi
      .fn<() => Promise<OrgAccess>>()
      .mockResolvedValueOnce(access())
      .mockImplementationOnce(() => new Promise((r) => (resolveRead = r)))
    const { ui, onSetOrgAdmin } = mount({ onGetOrgAccess: reads })
    await ready(ui)
    fireEvent.click(more(ui, 'Bruna Lima'))
    fireEvent.click(ui.getByRole('menuitem', { name: copy.admin.makeAdmin }))
    const dialog = ui.getByRole('alertdialog', { name: fill(copy.admin.promoteTitle, { name: 'Bruna Lima' }) })
    expect(dialog.textContent).toContain(fill(copy.admin.promoteBody, { first: 'Bruna' }))
    expect(dialog.querySelector('.agent-dialog__dot--primary')).toBeTruthy()
    const action = within(dialog).getByRole('button', { name: copy.admin.makeAdmin })
    expect(action.getAttribute('data-variant')).toBe('fill')
    fireEvent.click(action)
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(2))
    expect(onSetOrgAdmin).toHaveBeenCalledWith(BRUNA.user.id, true)
    expect(ui.getByRole('alertdialog')).toBeTruthy()
    resolveRead(access({ admins: [MARINA.user.id, BRUNA.user.id] }))
    await waitFor(() => expect(ui.queryByRole('alertdialog')).toBeNull())
    expect(within(rowOf(ui, 'Bruna')).getByText(copy.admin.roleAdmin)).toBeTruthy()
  })

  it('tirar: copy com o primeiro nome, ponto accent, botão principal, rebaixa', async () => {
    const { ui, onSetOrgAdmin } = mount({ onGetOrgAccess: async () => access({ admins: [MARINA.user.id, DIEGO.user.id] }) })
    await waitFor(() => expect(within(rowOf(ui, 'Diego')).queryByText(copy.admin.roleAdmin)).toBeTruthy())
    fireEvent.click(more(ui, 'Diego Martins'))
    fireEvent.click(ui.getByRole('menuitem', { name: copy.admin.dropAdmin }))
    const dialog = ui.getByRole('alertdialog', { name: fill(copy.admin.demoteTitle, { name: 'Diego Martins' }) })
    expect(dialog.textContent).toContain(fill(copy.admin.demoteBody, { first: 'Diego' }))
    expect(dialog.querySelector('.agent-dialog__dot--primary')).toBeTruthy()
    const action = within(dialog).getByRole('button', { name: copy.admin.dropAdmin })
    expect(action.getAttribute('data-variant')).toBe('fill')
    fireEvent.click(action)
    await waitFor(() => expect(ui.queryByRole('alertdialog')).toBeNull())
    expect(onSetOrgAdmin).toHaveBeenCalledWith(DIEGO.user.id, false)
  })

  it('emenda ao C5: a releitura falha → o confirm fica com o erro; repetir chama o verbo e relê; Cancelar fecha sem mudar a lista', async () => {
    const reads = vi
      .fn<() => Promise<OrgAccess>>()
      .mockResolvedValueOnce(access())
      .mockRejectedValue(new PeopleUnavailableError())
    const { ui, onSetOrgAdmin } = mount({ onGetOrgAccess: reads })
    await ready(ui)
    fireEvent.click(more(ui, 'Bruna Lima'))
    fireEvent.click(ui.getByRole('menuitem', { name: copy.admin.makeAdmin }))
    const action = () => within(ui.getByRole('alertdialog')).getByRole('button', { name: copy.admin.makeAdmin })
    fireEvent.click(action())
    await waitFor(() => expect(within(ui.getByRole('alertdialog')).getByRole('alert').textContent).toBe(copy.newConversation.failed))
    expect((action() as HTMLButtonElement).disabled).toBe(false)
    expect(within(rowOf(ui, 'Bruna')).queryByText(copy.admin.roleAdmin)).toBeNull()
    fireEvent.click(action())
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(3))
    expect(onSetOrgAdmin).toHaveBeenCalledTimes(2)
    await waitFor(() => expect((action() as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(within(ui.getByRole('alertdialog')).getByRole('button', { name: copy.account.cancel }))
    expect(ui.queryByRole('alertdialog')).toBeNull()
    expect(within(rowOf(ui, 'Bruna')).queryByText(copy.admin.roleAdmin)).toBeNull()
  })

  it('falha do próprio verbo: o mesmo tratamento, sem releitura', async () => {
    const { ui, onGetOrgAccess } = mount({ onSetOrgAdmin: vi.fn().mockRejectedValue(new PeopleUnavailableError()) })
    await ready(ui)
    fireEvent.click(more(ui, 'Bruna Lima'))
    fireEvent.click(ui.getByRole('menuitem', { name: copy.admin.makeAdmin }))
    fireEvent.click(within(ui.getByRole('alertdialog')).getByRole('button', { name: copy.admin.makeAdmin }))
    await waitFor(() => expect(within(ui.getByRole('alertdialog')).getByRole('alert')).toBeTruthy())
    expect(
      (within(ui.getByRole('alertdialog')).getByRole('button', { name: copy.admin.makeAdmin }) as HTMLButtonElement).disabled,
    ).toBe(false)
    expect(onGetOrgAccess).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['último admin', new LastAdminError()],
    ['não membro', new NotMemberError()],
  ])('409 (%s): erro no confirm, a ação para, e o papel é relido', async (_label, err) => {
    const { ui, onGetOrgAccess } = mount({ onSetOrgAdmin: vi.fn().mockRejectedValue(err) })
    await ready(ui)
    fireEvent.click(more(ui, 'Bruna Lima'))
    fireEvent.click(ui.getByRole('menuitem', { name: copy.admin.makeAdmin }))
    fireEvent.click(within(ui.getByRole('alertdialog')).getByRole('button', { name: copy.admin.makeAdmin }))
    await waitFor(() => expect(onGetOrgAccess).toHaveBeenCalledTimes(2))
    expect(within(ui.getByRole('alertdialog')).getByRole('alert').textContent).toBe(copy.newConversation.failed)
    expect(
      (within(ui.getByRole('alertdialog')).getByRole('button', { name: copy.admin.makeAdmin }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('C6: tirarVoce usa danger-fill e ponto danger; no 200 não relê', async () => {
    const { ui, onSetOrgAdmin, onGetOrgAccess } = mount({
      onGetOrgAccess: vi.fn(async () => access({ admins: [MARINA.user.id, DIEGO.user.id] })),
    })
    await waitFor(() => expect(within(rowOf(ui, 'Diego')).queryByText(copy.admin.roleAdmin)).toBeTruthy())
    fireEvent.click(more(ui, 'Marina Alves'))
    fireEvent.click(ui.getByRole('menuitem', { name: copy.admin.dropAdmin }))
    const dialog = ui.getByRole('alertdialog', { name: copy.admin.demoteSelfTitle })
    expect(dialog.textContent).toContain(copy.admin.demoteSelfBody)
    expect(dialog.querySelector('.account-settings__confirm-dot:not(.agent-dialog__dot--primary)')).toBeTruthy()
    const action = within(dialog).getByRole('button', { name: copy.admin.dropAdmin })
    expect(action.getAttribute('data-variant')).toBe('danger-fill')
    fireEvent.click(action)
    await waitFor(() => expect(onSetOrgAdmin).toHaveBeenCalledWith(MARINA.user.id, false))
    await new Promise((r) => setTimeout(r, 0))
    expect(onGetOrgAccess).toHaveBeenCalledTimes(1)
  })

  it('R6 no verbo: o 403 não mostra erro nem relê (a superfície fecha acima)', async () => {
    const { ui, onGetOrgAccess } = mount({ onSetOrgAdmin: vi.fn().mockRejectedValue(new OrgAccessDeniedError()) })
    await ready(ui)
    fireEvent.click(more(ui, 'Bruna Lima'))
    fireEvent.click(ui.getByRole('menuitem', { name: copy.admin.makeAdmin }))
    fireEvent.click(within(ui.getByRole('alertdialog')).getByRole('button', { name: copy.admin.makeAdmin }))
    await new Promise((r) => setTimeout(r, 0))
    expect(within(ui.getByRole('alertdialog')).queryByRole('alert')).toBeNull()
    expect(onGetOrgAccess).toHaveBeenCalledTimes(1)
  })

  it('leitura que falha (não 403): a lista fica sem papel e sem itens de admin', async () => {
    const { ui } = mount({ onGetOrgAccess: async () => Promise.reject(new PeopleUnavailableError()) })
    await waitFor(() => expect(ui.queryByRole('button', { name: fill(copy.admin.actionsFor, { name: 'Marina Alves' }) })).toBeNull())
    fireEvent.click(more(ui, 'Bruna Lima'))
    expect(menuItems(ui)).toEqual([copy.admin.removeFromOrg])
  })
})

describe('diálogos movidos de "Sua conta"', () => {
  it('"Adicionar agente" e "Editar" abrem o AgentDialog; "Remover" do agente abre o remove dele', async () => {
    const { ui } = mount()
    await ready(ui)
    fireEvent.click(ui.getByRole('button', { name: copy.agent.add }))
    expect(ui.getByRole('dialog', { name: copy.agent.createTitle })).toBeTruthy()
    fireEvent.click(ui.getByRole('button', { name: copy.account.cancel }))
    fireEvent.click(more(ui, 'Relatório diário'))
    fireEvent.click(ui.getByRole('menuitem', { name: copy.agent.edit }))
    expect(ui.getByRole('dialog', { name: copy.agent.editTitle })).toBeTruthy()
  })
})

// ── Fatia 1d: a Visão geral (§2.2; PLANO-ADMIN §8.8, V1–V6) ──
const NIC = person('Nic Souza', { email: 'nic@campos.com', kind: 'guest', pending: true })
const overview = () => mount({ people: [...everyone, NIC] }, 'overview')
const cards = (ui: ReturnType<typeof render>) =>
  [...ui.container.querySelectorAll<HTMLButtonElement>('.admin-overview__card')]
const card = (ui: ReturnType<typeof render>, label: string) => cards(ui).find((c) => c.textContent?.endsWith(label))!
const pressed = (ui: ReturnType<typeof render>) =>
  within(ui.getByRole('group', { name: copy.admin.show }))
    .getAllByRole('button')
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.textContent)
const adminsList = (ui: ReturnType<typeof render>) =>
  [...ui.container.querySelectorAll('.admin-overview__admin-text')].map((r) => r.textContent)
const overviewReady = async (ui: ReturnType<typeof render>) =>
  waitFor(() => expect(ui.container.querySelector('.admin-overview__admins')).toBeTruthy())

describe('Visão geral: abertura e navegação (V3)', () => {
  it('abre na Visão geral, com o foco no primeiro título; a navegação troca a página e o foco', async () => {
    const { ui } = overview()
    const nav = ui.getByRole('navigation', { name: copy.admin.nav })
    const [toOverview, toPeople] = within(nav).getAllByRole('button')
    expect(toOverview!.getAttribute('aria-current')).toBe('page')
    expect(toPeople!.getAttribute('aria-current')).toBeNull()
    const title = ui.getByRole('heading', { level: 2, name: copy.admin.peopleAndAgents })
    expect(document.activeElement).toBe(title)
    expect(title.getAttribute('tabindex')).toBe('-1')
    expect(ui.queryByRole('table')).toBeNull()

    fireEvent.click(toPeople!)
    expect(toPeople!.getAttribute('aria-current')).toBe('page')
    expect(document.activeElement).toBe(ui.getByRole('heading', { level: 2, name: copy.people.title }))
    expect(pressed(ui)).toEqual([copy.admin.pillAll])

    fireEvent.click(toOverview!)
    expect(document.activeElement).toBe(ui.getByRole('heading', { level: 2, name: copy.admin.peopleAndAgents }))
    await overviewReady(ui)
    expect(findProtocolLeaksInText(ui.container.innerHTML)).toEqual([])
  })

  it('sem o bloco de saúde (O4): a coluna começa pelos números, e "Administradores" vem depois', () => {
    const { ui } = overview()
    const titles = [...ui.container.querySelectorAll('.org-admin__column h2')].map((h) => h.textContent)
    expect(titles).toEqual([copy.admin.peopleAndAgents, copy.admin.admins])
  })
})

describe('Visão geral: os cartões (V1, V2, V6)', () => {
  it('contagens disjuntas: o pendente (membro ou convidado) só conta como pendente; a soma é o total', async () => {
    const { ui } = overview()
    await overviewReady(ui)
    const n = (c: HTMLElement) => Number(c.querySelector('.admin-overview__count')!.textContent)
    expect(cards(ui).map((c) => [n(c), c.querySelector('.admin-overview__count-label')!.textContent])).toEqual([
      [4, copy.admin.countOrganization.other],
      [1, copy.admin.countGuests.one],
      [2, copy.admin.countPending.other],
      [1, copy.admin.countAgents.one],
    ])
    expect(cards(ui).reduce((sum, c) => sum + n(c), 0)).toBe(everyone.length + 1)
    expect(card(ui, copy.admin.countGuests.one).getAttribute('aria-label')).toBe(
      fill(copy.admin.countSeeList, { n: 1, label: copy.admin.countGuests.one }),
    )
  })

  it.each([
    [copy.admin.countOrganization.other, copy.admin.pillOrganization, ['Bruna Lima', 'Diego Martins', 'Igor Lemos', 'Marina Alves (você)']],
    [copy.admin.countGuests.one, copy.admin.pillGuests, ['Vera Campos']],
    [copy.admin.countPending.other, copy.admin.pillPending, ['Lúcia Ferraz', 'Nic Souza']],
    [copy.admin.countAgents.one, copy.admin.pillAgents, ['Relatório diário']],
  ])('o cartão "%s" abre Pessoas na pílula "%s", sem texto, com tantas linhas quanto o número', async (label, pill, rows) => {
    const { ui } = overview()
    await overviewReady(ui)
    const count = Number(card(ui, label).querySelector('.admin-overview__count')!.textContent)
    fireEvent.click(card(ui, label))
    expect(pressed(ui)).toEqual([pill])
    expect((ui.getByRole('textbox', { name: copy.people.filter }) as HTMLInputElement).value).toBe('')
    expect(names(ui)).toEqual(rows)
    expect(rows).toHaveLength(count)
  })

  it('a pílula "Convidados" não traz o convidado pendente', async () => {
    const { ui } = mount({ people: [...everyone, NIC] })
    await ready(ui)
    fireEvent.click(ui.getByRole('button', { name: copy.admin.pillGuests }))
    expect(names(ui)).toEqual(['Vera Campos'])
  })

  it('cartão com zero aparece, no plural, e leva ao vazio do C8', async () => {
    const { ui } = mount({ people: [MARINA, BRUNA] }, 'overview')
    await overviewReady(ui)
    const guests = card(ui, copy.admin.countGuests.other)
    expect(guests.querySelector('.admin-overview__count')!.textContent).toBe('0')
    fireEvent.click(guests)
    expect(names(ui)).toEqual([])
    expect(table(ui).querySelector('.admin-people__empty')?.textContent).toBe(copy.admin.empty)
  })

  it('"Gerenciar em Pessoas" abre a pílula Admins; "Adicionar admin" abre Da organização, sem confirm', async () => {
    const { ui } = overview()
    await overviewReady(ui)
    fireEvent.click(ui.getByRole('button', { name: copy.admin.manageInPeople }))
    expect(pressed(ui)).toEqual([copy.admin.pillAdmins])
    fireEvent.click(within(ui.getByRole('navigation', { name: copy.admin.nav })).getByRole('button', { name: copy.admin.overview }))
    fireEvent.click(ui.getByRole('button', { name: copy.admin.addAdmin }))
    expect(pressed(ui)).toEqual([copy.admin.pillOrganization])
    expect(ui.queryByRole('alertdialog')).toBeNull()
  })
})

describe('Visão geral: "Administradores" (V4, V5)', () => {
  it('admin único (adminCount 1): o aviso com "Adicionar admin" acima da lista', async () => {
    const { ui } = overview()
    await overviewReady(ui)
    const alert = ui.getByRole('alert')
    expect(alert.textContent).toBe(copy.admin.onlyYou + copy.admin.addAdmin)
    expect(alert.compareDocumentPosition(ui.getByRole('list')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(adminsList(ui)).toEqual([fill(copy.admin.self, { name: 'Marina Alves' }) + 'marina@vega.com'])
  })

  it('dois admins: sem aviso; "(você)" primeiro, depois por nome; admin fora da lista é ignorado', async () => {
    const { ui, onGetOrgAccess } = mount(
      {
        people: [...everyone, NIC],
        onGetOrgAccess: vi.fn(async () =>
          access({ admins: [DIEGO.user.id, uid('@u-yyyyyyyyyyyy:tayet.local'), BRUNA.user.id, MARINA.user.id] }),
        ),
      },
      'overview',
    )
    await overviewReady(ui)
    expect(ui.queryByRole('alert')).toBeNull()
    expect(adminsList(ui)).toEqual([
      fill(copy.admin.self, { name: 'Marina Alves' }) + 'marina@vega.com',
      'Bruna Limabruna@vega.com',
      'Diego Martinsdiego@vega.com',
    ])
    // V4: the shell's own read, no second call.
    expect(onGetOrgAccess).toHaveBeenCalledTimes(1)
  })

  it('o aviso segue o adminCount do servidor, não o cruzamento com a lista', async () => {
    // Two admins on the server, one of them outside #all: the list shows one, and there is no warning.
    const { ui } = mount(
      { onGetOrgAccess: async () => access({ admins: [MARINA.user.id, uid('@u-yyyyyyyyyyyy:tayet.local')] }) },
      'overview',
    )
    await overviewReady(ui)
    expect(adminsList(ui)).toHaveLength(1)
    expect(ui.queryByRole('alert')).toBeNull()
  })

  it('V5: carregando, só o título e "Gerenciar em Pessoas", sem aviso e sem lista', () => {
    const { ui } = mount({ onGetOrgAccess: () => new Promise(() => {}) }, 'overview')
    expect(ui.getByRole('heading', { name: copy.admin.admins })).toBeTruthy()
    expect(ui.getByRole('button', { name: copy.admin.manageInPeople })).toBeTruthy()
    expect(ui.queryByRole('alert')).toBeNull()
    expect(ui.queryByRole('list')).toBeNull()
  })

  it('V5: leitura que falha (não 403): a linha de erro com role="alert" no lugar da lista, sem aviso nem botão', async () => {
    const { ui } = mount({ onGetOrgAccess: async () => Promise.reject(new PeopleUnavailableError()) }, 'overview')
    const alert = await waitFor(() => ui.getByRole('alert'))
    expect(alert.textContent).toBe(copy.admin.adminsFailed)
    expect(ui.queryByRole('list')).toBeNull()
    expect(ui.queryByRole('button', { name: copy.admin.addAdmin })).toBeNull()
    // The cards still count the list.
    expect(cards(ui)).toHaveLength(4)
  })

  it('a leitura se repete ao reabrir a casca', async () => {
    const reads = vi.fn().mockRejectedValueOnce(new PeopleUnavailableError()).mockResolvedValue(access())
    const first = mount({ onGetOrgAccess: reads }, 'overview')
    await waitFor(() => first.ui.getByText(copy.admin.adminsFailed))
    first.ui.unmount()
    const again = mount({ onGetOrgAccess: reads }, 'overview')
    await overviewReady(again.ui)
    expect(reads).toHaveBeenCalledTimes(2)
  })

  it('R6: o 403 na leitura não desenha erro (a superfície fecha acima)', async () => {
    const reads = vi.fn().mockRejectedValue(new OrgAccessDeniedError())
    const { ui } = mount({ onGetOrgAccess: reads }, 'overview')
    await waitFor(() => expect(reads).toHaveBeenCalled())
    await Promise.resolve()
    expect(ui.queryByRole('alert')).toBeNull()
    expect(ui.queryByRole('list')).toBeNull()
  })
})
