// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { AgentDialog, agentCommand } from '../../src/ui/components/AgentDialog'
import type { NewAgent, Person, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'

// AgentDialog, estados `criado` e `reemitido` com o comando inteiro (manifesto account-access.md §11.5;
// PLANO-AGENTES §0.3.8). O `--server` é a origem da página; a credencial aparece uma vez, dentro do
// comando, no seu próprio elemento. Fixtures com shape de protocolo de propósito: nunca chegam ao DOM.

const uid = (s: string): UserId => s as unknown as UserId
const TOKEN = 'mpt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
const agent: Person = {
  user: { id: uid('@a-abcdefghijkl:tayet.local'), displayName: 'Relatório diário', kind: 'agent', agentColor: 'argila', operatorName: 'Marina Alves' },
  pending: false,
  self: false,
}

function openCreated() {
  const onCreate = vi.fn(async (): Promise<NewAgent> => ({ userId: agent.user.id, token: TOKEN }))
  const ui = render(
    <AgentDialog
      mode={{ kind: 'create' }}
      operatorName="Marina Alves"
      onCreate={onCreate}
      onUpdate={async () => {}}
      onReissue={async () => ({ token: TOKEN })}
      onRemove={async () => {}}
      onClose={() => {}}
    />,
  )
  fireEvent.change(ui.getByLabelText(copy.agent.fieldName), { target: { value: 'Relatório diário' } })
  fireEvent.click(ui.getByRole('button', { name: copy.agent.create }))
  return ui
}

async function created() {
  const ui = openCreated()
  await waitFor(() => expect(ui.getByRole('dialog', { name: copy.agent.createdTitle })).toBeTruthy())
  return ui
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AgentDialog — the whole command (§11.5)', () => {
  it('agentCommand: the product address and the credential, in the command of the canvas', () => {
    expect(agentCommand('https://chat.example.com', 'abc')).toEqual({
      prefix: 'npx tayet-agent --server https://chat.example.com --token ',
      text: 'npx tayet-agent --server https://chat.example.com --token abc',
    })
  })

  it('criado: the command carries the page origin and the credential; the order and copy of the artboard', async () => {
    const ui = await created()
    const origin = window.location.origin
    const command = ui.container.querySelector('[data-agent-command]')!
    expect(command.textContent).toBe(`npx tayet-agent --server ${origin} --token ${TOKEN}`)
    // The credential has its own element, inside the command.
    const credential = ui.container.querySelector('[data-agent-credential]')!
    expect(credential.textContent).toBe(TOKEN)
    expect(command.contains(credential)).toBe(true)
    // Shown once.
    expect((ui.container.textContent ?? '').split(TOKEN).length).toBe(2)
    const text = ui.container.textContent ?? ''
    const order = [
      copy.agent.createdIntro,
      copy.agent.command,
      'npx tayet-agent',
      copy.agent.copy,
      copy.agent.nodeRequirement,
      copy.agent.copyCredentialOnly,
      copy.agent.credentialOnce,
    ].map((s) => text.indexOf(s))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(text).toContain(fill(copy.agent.operatedBy, { name: 'Marina Alves' }))
    expect(findProtocolLeaksInText(ui.container.innerHTML)).toEqual([])
  })

  it('Copiar copies the whole command; "Copiar só a credencial" only the credential', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const ui = await created()
    fireEvent.click(ui.getByRole('button', { name: copy.agent.copy }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText).toHaveBeenLastCalledWith(`npx tayet-agent --server ${window.location.origin} --token ${TOKEN}`)
    fireEvent.click(ui.getByRole('button', { name: copy.agent.copyCredentialOnly }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
    expect(writeText).toHaveBeenLastCalledWith(TOKEN)
  })

  it('without a clipboard: Copiar leaves the command selected, the secondary action only the credential', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    const ui = await created()
    fireEvent.click(ui.getByRole('button', { name: copy.agent.copy }))
    await waitFor(() => expect(window.getSelection()?.toString()).toBe(`npx tayet-agent --server ${window.location.origin} --token ${TOKEN}`))
    fireEvent.click(ui.getByRole('button', { name: copy.agent.copyCredentialOnly }))
    await waitFor(() => expect(window.getSelection()?.toString()).toBe(TOKEN))
  })

  it('reemitido: the reissue intro, the same command and actions', async () => {
    const ui = render(
      <AgentDialog
        mode={{ kind: 'edit', agent }}
        onCreate={async () => ({ userId: agent.user.id, token: TOKEN })}
        onUpdate={async () => {}}
        onReissue={async () => ({ token: TOKEN })}
        onRemove={async () => {}}
        onClose={() => {}}
      />,
    )
    fireEvent.click(ui.getByRole('button', { name: copy.agent.reissueCredential }))
    fireEvent.click(ui.getByRole('button', { name: copy.agent.reissue }))
    await waitFor(() => expect(ui.getByRole('dialog', { name: copy.agent.reissuedTitle })).toBeTruthy())
    const text = ui.container.textContent ?? ''
    expect(text).toContain(copy.agent.reissuedIntro)
    expect(text).not.toContain(copy.agent.createdIntro)
    expect(ui.container.querySelector('[data-agent-command]')!.textContent).toBe(
      `npx tayet-agent --server ${window.location.origin} --token ${TOKEN}`,
    )
    expect(ui.getByRole('button', { name: copy.agent.copyCredentialOnly })).toBeTruthy()
    expect(text).toContain(copy.agent.credentialOnce)
    expect(findProtocolLeaksInText(ui.container.innerHTML)).toEqual([])
  })
})
