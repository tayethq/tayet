// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { InvitePersonDialog } from '../../src/ui/components/InvitePersonDialog'
import { AccountSettings } from '../../src/ui/components/AccountSettings'
import { PeopleUnavailableError, PersonExistsError } from '../../src/acl'
import type { Channel, ChannelId, NewPerson, Person, PersonInvite, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'
import { noExport } from '../support/data-export-fake'

// Dialog "Convidar pessoa" e os confirms (manifesto account-access.md §9.1, §9.2 g), um it por estado
// do artboard. Fixtures com shape de protocolo de propósito: nunca chegam ao DOM.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const channel = (name: string, over: Partial<Channel> = {}): Channel => ({
  id: cid(`!${name}:tayet.local`),
  name: `#${name}`,
  kind: 'public',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
  ...over,
})
const produto = channel('produto')
const design = channel('design')
const sigilo = channel('sigilo', { kind: 'private' })
const channels = [
  channel('all', { kind: 'public', org: true }),
  produto,
  design,
  sigilo,
  channel('Ana', { kind: 'dm', name: 'Ana' }),
]

const invited: PersonInvite = {
  user: { id: uid('@u-abc234def567:tayet.local'), displayName: 'Vera Campos', kind: 'guest' },
  failedChannels: [],
}

function open(onInvite: (p: NewPerson) => Promise<PersonInvite> = async () => invited) {
  const onClose = vi.fn()
  const ui = render(<InvitePersonDialog channels={channels} onInvite={onInvite} onClose={onClose} />)
  const type = (label: string, value: string) => fireEvent.change(ui.getByLabelText(label), { target: { value } })
  const submit = () => fireEvent.click(ui.getByRole('button', { name: copy.people.submit }))
  const fill2 = () => {
    type(copy.people.fieldName, 'Vera Campos')
    type(copy.people.fieldEmail, 'vera@campos.com')
  }
  return { ui, onClose, type, submit, fillForm: fill2 }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('InvitePersonDialog', () => {
  it('editando: a ordem do artboard; canais sem DM e sem #all; a ajuda muda com o tipo', () => {
    const { ui } = open()
    const text = ui.container.textContent ?? ''
    const order = [copy.people.fieldName, copy.people.fieldEmail, copy.people.fieldKind, copy.people.fieldChannels]
    expect(order.map((s) => text.indexOf(s))).toEqual(order.map((s) => text.indexOf(s)).sort((a, b) => a - b))
    expect(ui.getByText(copy.people.helpMember)).toBeTruthy()
    expect(ui.getByRole('button', { name: '#produto' })).toBeTruthy()
    expect(ui.getByRole('button', { name: '#design' })).toBeTruthy()
    expect(ui.queryByRole('button', { name: '#all' })).toBeNull()
    expect(text).not.toContain('Ana')

    fireEvent.click(ui.getByRole('button', { name: copy.people.kindGuest }))
    expect(ui.getByText(copy.people.helpGuest)).toBeTruthy()
    expect(ui.queryByRole('alert')).toBeNull()
  })

  it('chips: selecionar e tirar; o convite leva os canais e os dados aparados', async () => {
    const onInvite = vi.fn(async () => invited)
    const { ui, type, submit } = open(onInvite)
    type(copy.people.fieldName, '  Vera Campos ')
    type(copy.people.fieldEmail, ' vera@campos.com ')
    fireEvent.click(ui.getByRole('button', { name: '#produto' }))
    fireEvent.click(ui.getByRole('button', { name: '#design' }))
    fireEvent.click(ui.getByRole('button', { name: fill(copy.people.removeChannel, { channel: 'design' }) }))
    submit()
    await waitFor(() => expect(ui.getByText(copy.people.inviteReady)).toBeTruthy())
    expect(onInvite).toHaveBeenCalledWith({
      name: 'Vera Campos',
      email: 'vera@campos.com',
      kind: 'member',
      channels: [produto.id],
    })
  })

  it('marca do canal: # para público, cadeado para privado, antes e depois de selecionar', () => {
    const { ui } = open()
    const chip = (text: string) => ui.getByText(text, { selector: '.compose-dialog__chip' })

    fireEvent.click(ui.getByRole('button', { name: '#produto' }))
    expect(chip('produto').querySelector('.compose-dialog__chip-mark')?.textContent).toBe('#')
    expect(within(chip('produto')).queryByRole('img')).toBeNull()

    expect(ui.queryByRole('button', { name: '#sigilo' })).toBeNull()
    fireEvent.click(ui.getByRole('button', { name: `${copy.channel.privateMark} sigilo` }))
    expect(chip('sigilo').querySelector('.compose-dialog__chip-mark')?.textContent).toBe('')
    expect(within(chip('sigilo')).getByRole('img', { name: copy.channel.privateMark })).toBeTruthy()
    expect(ui.getByRole('button', { name: fill(copy.people.removeChannel, { channel: 'sigilo' }) })).toBeTruthy()
  })

  it('enviando: corpo inerte, Cancelar desabilitado, "Convidando…" com aria-busy, Esc não fecha', async () => {
    let finish!: (r: PersonInvite) => void
    const { ui, fillForm, submit, onClose } = open(() => new Promise((resolve) => (finish = resolve)))
    fillForm()
    submit()
    const cta = await ui.findByRole('button', { name: copy.people.submitting })
    expect(cta.getAttribute('aria-busy')).toBe('true')
    expect((cta as HTMLButtonElement).disabled).toBe(true)
    expect((ui.getByRole('button', { name: copy.account.cancel }) as HTMLButtonElement).disabled).toBe(true)
    expect(ui.container.querySelector('.compose-dialog__fields')?.hasAttribute('inert')).toBe(true)
    fireEvent.keyDown(ui.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    finish(invited)
    await waitFor(() => expect(ui.getByText(copy.people.inviteReady)).toBeTruthy())
  })

  it('erroCampo: PersonExistsError marca o email e digitar limpa', async () => {
    const { ui, fillForm, submit, type } = open(async () => {
      throw new PersonExistsError()
    })
    fillForm()
    submit()
    await waitFor(() => expect(ui.getByText(copy.people.emailTaken)).toBeTruthy())
    expect(ui.getByLabelText(copy.people.fieldEmail).getAttribute('aria-invalid')).toBe('true')
    expect(ui.queryByRole('alert')).toBeNull()
    type(copy.people.fieldEmail, 'outra@campos.com')
    expect(ui.queryByText(copy.people.emailTaken)).toBeNull()
  })

  it('erroGeral: indisponibilidade é alert no fim do corpo, e o formulário segue vivo', async () => {
    const { ui, fillForm, submit } = open(async () => {
      throw new PeopleUnavailableError()
    })
    fillForm()
    submit()
    await waitFor(() => expect(ui.getByRole('alert').textContent).toBe(copy.people.inviteError))
    expect(ui.getByRole('button', { name: copy.people.submit })).toBeTruthy()
  })

  it('semCanal: convidado sem canal não envia, e a ajuda vira aviso até escolher um canal', () => {
    const onInvite = vi.fn(async () => invited)
    const { ui, fillForm, submit } = open(onInvite)
    fillForm()
    fireEvent.click(ui.getByRole('button', { name: copy.people.kindGuest }))
    submit()
    expect(onInvite).not.toHaveBeenCalled()
    expect(ui.getByRole('alert').textContent).toBe(copy.people.helpGuest)
    fireEvent.click(ui.getByRole('button', { name: '#produto' }))
    expect(ui.queryByRole('alert')).toBeNull()
  })

  it('sucesso: o corpo é substituído pelas instruções, com o host do app', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { ui, fillForm, submit, onClose } = open()
    fillForm()
    submit()
    const text = fill(copy.people.instructions, {
      name: 'Vera Campos',
      address: window.location.host,
      email: 'vera@campos.com',
    })
    await waitFor(() => expect(ui.getByText(text)).toBeTruthy())
    expect(ui.queryByLabelText(copy.people.fieldEmail)).toBeNull()
    expect(ui.queryByRole('alert')).toBeNull()

    fireEvent.click(ui.getByRole('button', { name: copy.people.copyInstructions }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(text))

    const closes = ui.getAllByRole('button', { name: copy.dialog.close })
    fireEvent.click(closes[closes.length - 1]!)
    expect(onClose).toHaveBeenCalled()
    expect(findProtocolLeaksInText(ui.container.innerHTML)).toEqual([])
  })

  it('sem área de transferência: deixa o texto selecionado', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    const { ui, fillForm, submit } = open()
    fillForm()
    submit()
    await waitFor(() => expect(ui.getByText(copy.people.inviteReady)).toBeTruthy())
    fireEvent.click(ui.getByRole('button', { name: copy.people.copyInstructions }))
    await waitFor(() => expect(window.getSelection()?.toString()).toContain('vera@campos.com'))
  })

  it('failedChannels: sucesso com aviso listando os canais', async () => {
    const { ui, fillForm, submit } = open(async () => ({ ...invited, failedChannels: [design.id] }))
    fillForm()
    submit()
    await waitFor(() =>
      expect(ui.getByRole('alert').textContent).toBe(fill(copy.people.channelsFailed, { channels: '#design' })),
    )
    expect(ui.getByText(copy.people.inviteReady)).toBeTruthy()
  })
})

describe('confirms de Pessoas', () => {
  const person = (name: string, pending: boolean): Person => ({
    user: { id: uid(`@u-abc234def567-${name}:tayet.local`), displayName: name, kind: 'member' },
    pending,
    self: false,
  })
  function panel(onRemovePerson: (user: UserId) => Promise<void>) {
    const ui = render(
      <AccountSettings
        open
        orgAdmin
        people={[person('Bruna', false), person('Lúcia', true)]}
        inviteChannels={channels}
        onInvitePerson={async () => invited}
        onRemovePerson={onRemovePerson}
        accesses={[]}
        onLoadProfile={async () => ({ fullName: 'Marina' })}
        onSaveProfile={async () => {}}
        onSaveAvatar={async () => {}}
        onClearAvatar={async () => {}} onExportData={noExport}
        onReset={() => {}}
        onSignOut={() => {}}
        theme="light"
        onThemeChange={() => {}}
        onClose={() => {}}
      />
    )
    fireEvent.click(ui.getByRole('button', { name: new RegExp(copy.people.title) }))
    return ui
  }

  it('Remover: alertdialog com o corpo do §9.2 d; Cancelar não remove, danger-fill remove e volta', async () => {
    const onRemove = vi.fn(async () => {})
    const ui = panel(onRemove)
    const title = fill(copy.people.removeTitle, { name: 'Bruna' })
    fireEvent.click(ui.getByRole('button', { name: fill(copy.people.removeLabel, { name: 'Bruna' }) }))
    const dialog = ui.getByRole('alertdialog', { name: title })
    expect(dialog.textContent).toContain(fill(copy.people.removeBody, { name: 'Bruna' }))

    fireEvent.click(ui.getByRole('button', { name: copy.account.cancel }))
    expect(onRemove).not.toHaveBeenCalled()
    expect(ui.queryByRole('alertdialog')).toBeNull()

    fireEvent.click(ui.getByRole('button', { name: fill(copy.people.removeLabel, { name: 'Bruna' }) }))
    const danger = ui.getByRole('button', { name: copy.people.remove })
    expect(danger.getAttribute('data-variant')).toBe('danger-fill')
    fireEvent.click(danger)
    await waitFor(() => expect(ui.queryByRole('alertdialog')).toBeNull())
    expect(onRemove).toHaveBeenCalledWith(uid('@u-abc234def567-Bruna:tayet.local'))
    expect(ui.getByRole('list', { name: copy.people.title })).toBeTruthy()
  })

  it('Cancelar convite: a forma do confirm com a copy do §9.2 g', async () => {
    const onRemove = vi.fn(async () => {})
    const ui = panel(onRemove)
    fireEvent.click(ui.getByRole('button', { name: fill(copy.people.cancelInviteTitle, { name: 'Lúcia' }) }))
    const dialog = ui.getByRole('alertdialog', { name: fill(copy.people.cancelInviteTitle, { name: 'Lúcia' }) })
    expect(dialog.textContent).toContain(fill(copy.people.cancelInviteBody, { name: 'Lúcia' }))
    fireEvent.click(ui.getByRole('button', { name: copy.people.cancelInvite }))
    await waitFor(() => expect(onRemove).toHaveBeenCalled())
  })

  it('falha fica no confirm, com alert', async () => {
    const ui = panel(async () => {
      throw new PeopleUnavailableError()
    })
    fireEvent.click(ui.getByRole('button', { name: fill(copy.people.removeLabel, { name: 'Bruna' }) }))
    fireEvent.click(ui.getByRole('button', { name: copy.people.remove }))
    await waitFor(() => expect(ui.getByRole('alert').textContent).toBe(copy.newConversation.failed))
    expect(ui.getByRole('alertdialog')).toBeTruthy()
  })

  it('"Convidar pessoa" abre o dialog, e fechar volta à lista com o filtro', () => {
    const ui = panel(async () => {})
    const filter = () => ui.getByRole('textbox', { name: copy.people.filter }) as HTMLInputElement
    fireEvent.change(filter(), { target: { value: 'bru' } })
    fireEvent.click(ui.getByRole('button', { name: copy.people.invite }))
    expect(ui.getByRole('dialog', { name: copy.people.invite })).toBeTruthy()
    fireEvent.click(ui.getByRole('button', { name: copy.account.cancel }))
    expect(filter().value).toBe('bru')
  })
})
