import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { NameInUseError } from '@tayet/client'
import type { AgentColor, AgentPatch, NewAgent, Person, UserId } from '@tayet/client'
import { Button, Dialog, Field } from '../primitives'
import { AgentAvatar, agentColorOf } from './AgentAvatar'
import { t } from '../i18n'

// AgentDialog (manifesto account-access.md §11.2; ADR-086 Proposto). The admin creates, edits, reissues
// and removes an agent. States of the canvas (AgentDialog.dc.html): `criar`, `nomeEmUso`, `criado`,
// `editar`, `reemitir`, `reemitido`, `remover`. The form states reuse the Convidar pessoa shell
// (compose-dialog); the confirms reuse the Remover pessoa idiom (alertdialog, dot + title).
//
// The credential (`criado`, `reemitido`) is shown ONCE: it lives only in this component's state while
// the dialog is open, is never logged and never stored, and goes away with the dialog (the service
// does not keep it either). P1: the agent is named by its display name; user.id only travels in the
// verbs' closures.
//
// Those two states show the whole command (manifesto §11.5; PLANO-AGENTES §0.3.8): `npx tayet-agent
// --server <the product's address> --token <credential>`. The address is the page's own origin — what
// the person already sees in the address bar — never a protocol address (P1 exclusion-with-pointer,
// §11.5).

// The order of the picker (2 rows of 5), as on the canvas.
export const AGENT_COLORS: readonly AgentColor[] = [
  'areia',
  'petroleo',
  'turquesa',
  'salvia',
  'ocre',
  'argila',
  'barro',
  'malva',
  'ardosia',
  'grafite',
]

// The install command shown in `criado`/`reemitido` (§11.5): the product's address is the page's origin.
// `prefix` is everything before the credential, so the credential can sit in its own element.
export function agentCommand(origin: string, token: string): { prefix: string; text: string } {
  const prefix = `npx tayet-agent --server ${origin} --token `
  return { prefix, text: prefix + token }
}

// The colour a new agent starts with: the service's default when none is sent.
const DEFAULT_COLOR: AgentColor = 'areia'

type Step =
  | { kind: 'form' } // criar / nomeEmUso / editar
  | { kind: 'credential'; token: string; reissued: boolean } // criado / reemitido
  | { kind: 'reissue' } // reemitir
  | { kind: 'remove' } // remover

export type AgentDialogMode = { kind: 'create' } | { kind: 'edit'; agent: Person } | { kind: 'remove'; agent: Person }

// The colour picker: 10 options in 2×5, each option IS the agent avatar of the list, with no text —
// the colour's name is only its accessible name. A radiogroup with roving focus (arrows move and
// select, as a native radio group does). Selected = accent ring (CSS).
function ColorPicker({ value, onChange, labelId }: { value: AgentColor; onChange: (c: AgentColor) => void; labelId: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const move = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    e.preventDefault()
    const next = (index + step + AGENT_COLORS.length) % AGENT_COLORS.length
    onChange(AGENT_COLORS[next]!)
    refs.current[next]?.focus()
  }
  return (
    <div className="agent-dialog__swatches" role="radiogroup" aria-labelledby={labelId}>
      {AGENT_COLORS.map((color, i) => (
        <button
          key={color}
          ref={(el) => {
            refs.current[i] = el
          }}
          type="button"
          role="radio"
          className="agent-dialog__swatch"
          aria-checked={color === value}
          aria-label={t(`agent.colors.${color}`)}
          tabIndex={color === value ? 0 : -1}
          onClick={() => onChange(color)}
          onKeyDown={(e) => move(e, i)}
        >
          <AgentAvatar color={color} decorative />
        </button>
      ))}
    </div>
  )
}

export function AgentDialog({
  mode,
  operatorName,
  onCreate,
  onUpdate,
  onReissue,
  onRemove,
  onClose,
}: {
  mode: AgentDialogMode
  // The admin's own name: the operator of an agent they create (the `criado` header line).
  operatorName?: string
  onCreate: (name: string, color: AgentColor) => Promise<NewAgent>
  onUpdate: (user: UserId, patch: AgentPatch) => Promise<void>
  onReissue: (user: UserId) => Promise<{ token: string }>
  onRemove: (user: UserId) => Promise<void>
  onClose: () => void
}) {
  const existing = mode.kind === 'create' ? undefined : mode.agent
  const [step, setStep] = useState<Step>(mode.kind === 'remove' ? { kind: 'remove' } : { kind: 'form' })
  const [name, setName] = useState(existing?.user.displayName ?? '')
  const [color, setColor] = useState<AgentColor>(agentColorOf(existing?.user) ?? DEFAULT_COLOR)
  const [busy, setBusy] = useState(false)
  const [nameInUse, setNameInUse] = useState(false)
  const [failed, setFailed] = useState(false)
  // What the `criado` header shows: the name and colour as created.
  const [created, setCreated] = useState<{ name: string; color: AgentColor } | undefined>(undefined)

  const nameRef = useRef<HTMLInputElement>(null)
  const commandRef = useRef<HTMLElement>(null)
  const tokenRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (step.kind === 'form') nameRef.current?.focus()
  }, [step.kind])

  const trimmed = name.trim()
  const guard = busy ? () => {} : onClose
  const agentName = existing?.user.displayName ?? trimmed

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setFailed(false)
    try {
      await action()
    } catch (error) {
      if (error instanceof NameInUseError) setNameInUse(true)
      else setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || trimmed.length === 0 || nameInUse) return
    if (!existing) {
      await run(async () => {
        const { token } = await onCreate(trimmed, color)
        setCreated({ name: trimmed, color })
        setStep({ kind: 'credential', token, reissued: false })
      })
      return
    }
    const patch: AgentPatch = {
      ...(trimmed !== existing.user.displayName ? { name: trimmed } : {}),
      ...(color !== agentColorOf(existing.user) ? { color } : {}),
    }
    if (Object.keys(patch).length === 0) {
      onClose()
      return
    }
    await run(async () => {
      await onUpdate(existing.user.id, patch)
      onClose()
    })
  }

  // Copiar copies the whole command; "Copiar só a credencial" only the credential. Without a clipboard
  // (a denied permission, a plain-http origin) the same text is left selected to copy by hand.
  async function copy(text: string, which: 'command' | 'credential') {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const box = which === 'command' ? commandRef.current : tokenRef.current
      if (box) window.getSelection()?.selectAllChildren(box)
    }
  }

  // ── reemitir / remover: the Remover pessoa confirm idiom ──
  if (step.kind === 'reissue' || step.kind === 'remove') {
    const removing = step.kind === 'remove'
    const title = removing ? t('agent.removeTitle', { name: agentName }) : t('agent.reissueTitle', { name: agentName })
    // Cancel: a reissue goes back to the edit it came from; a removal closes.
    const back = busy ? () => {} : removing ? onClose : () => setStep({ kind: 'form' })
    const confirm = () =>
      run(async () => {
        if (!existing) return
        if (removing) {
          await onRemove(existing.user.id)
          onClose()
        } else {
          const { token } = await onReissue(existing.user.id)
          setStep({ kind: 'credential', token, reissued: true })
        }
      })
    return (
      <Dialog
        role="alertdialog"
        size="gestao"
        ariaLabel={title}
        title={
          <span className="account-settings__confirm-title">
            <span
              className={removing ? 'account-settings__confirm-dot' : 'account-settings__confirm-dot agent-dialog__dot--primary'}
              aria-hidden="true"
            />
            {title}
          </span>
        }
        onClose={back}
        footer={
          <>
            <Button variant="secondary" autoFocus disabled={busy} onClick={back}>
              {t('agent.cancel')}
            </Button>
            <Button variant={removing ? 'danger-fill' : 'fill'} disabled={busy} onClick={() => void confirm()}>
              {removing ? t('agent.remove') : t('agent.reissue')}
            </Button>
          </>
        }
      >
        <div className="account-settings__confirm-body people__confirm-body">
          <p>{removing ? t('agent.removeBody', { name: agentName }) : t('agent.reissueBody')}</p>
          {failed && (
            <p className="compose-dialog__error" role="alert">
              {t('agent.failed')}
            </p>
          )}
        </div>
      </Dialog>
    )
  }

  // ── criado / reemitido: the credential, once ──
  if (step.kind === 'credential') {
    const shown = created ?? { name: agentName, color: agentColorOf(existing?.user) ?? DEFAULT_COLOR }
    const operator = existing ? existing.user.operatorName : operatorName
    const command = agentCommand(window.location.origin, step.token)
    return (
      <Dialog
        className="compose-dialog agent-dialog"
        title={step.reissued ? t('agent.reissuedTitle') : t('agent.createdTitle')}
        onClose={onClose}
        closeLabel={t('dialog.close')}
        footer={
          <Button variant="fill" onClick={onClose}>
            {t('agent.done')}
          </Button>
        }
      >
        <div className="compose-dialog__fields agent-dialog__body">
          <div className="agent-dialog__who">
            <AgentAvatar color={shown.color} />
            <span className="agent-dialog__who-text">
              <span className="agent-dialog__who-name">{shown.name}</span>
              {operator !== undefined && (
                <span className="agent-dialog__help">{t('agent.operatedBy', { name: operator })}</span>
              )}
            </span>
          </div>
          <p className="agent-dialog__intro">{step.reissued ? t('agent.reissuedIntro') : t('agent.createdIntro')}</p>
          <div className="ui-field">
            <span className="ui-field__label">{t('agent.command')}</span>
            <div className="agent-dialog__token">
              <code ref={commandRef} data-agent-command="">
                {command.prefix}
                <span ref={tokenRef} data-agent-credential="">
                  {step.token}
                </span>
              </code>
              <button type="button" className="agent-dialog__copy" autoFocus onClick={() => void copy(command.text, 'command')}>
                {t('agent.copy')}
              </button>
            </div>
            <p className="agent-dialog__help">{t('agent.nodeRequirement')}</p>
          </div>
          <button type="button" className="agent-dialog__alt" onClick={() => void copy(step.token, 'credential')}>
            {t('agent.copyCredentialOnly')}
          </button>
          <p className="agent-dialog__warn">{t('agent.credentialOnce')}</p>
        </div>
      </Dialog>
    )
  }

  // ── criar / nomeEmUso / editar ──
  const editing = existing !== undefined
  const colorLabelId = 'agent-dialog-color'
  return (
    <Dialog
      className="compose-dialog agent-dialog"
      title={editing ? t('agent.editTitle') : t('agent.createTitle')}
      onClose={guard}
      closeLabel={t('dialog.close')}
    >
      <form className="compose-dialog__form" onSubmit={submit} noValidate>
        <div className="compose-dialog__fields agent-dialog__body" inert={busy}>
          {!editing && <p className="agent-dialog__intro">{t('agent.intro')}</p>}
          <div className="invite-person__field">
            <Field
              label={t('agent.fieldName')}
              htmlFor="agent-name"
              inputRef={nameRef}
              inputProps={{
                value: name,
                autoComplete: 'off',
                'aria-invalid': nameInUse,
                'aria-describedby': nameInUse ? 'agent-name-error' : undefined,
                onChange: (e) => {
                  setName(e.target.value)
                  setNameInUse(false)
                  setFailed(false)
                },
              }}
            />
            {nameInUse && (
              <p id="agent-name-error" className="compose-dialog__error">
                {t('agent.nameInUse')}
              </p>
            )}
          </div>
          <div className="ui-field">
            <span id={colorLabelId} className="ui-field__label">
              {t('agent.fieldColor')}
            </span>
            <ColorPicker value={color} onChange={setColor} labelId={colorLabelId} />
          </div>
          {failed && (
            <p className="compose-dialog__error" role="alert">
              {t('agent.failed')}
            </p>
          )}
        </div>
        <div className="ui-dialog__footer">
          {editing && (
            <Button
              variant="secondary"
              className="agent-dialog__reissue"
              disabled={busy}
              onClick={() => {
                setFailed(false)
                setStep({ kind: 'reissue' })
              }}
            >
              {t('agent.reissueCredential')}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('agent.cancel')}
          </Button>
          <Button variant="fill" type="submit" disabled={busy || trimmed.length === 0 || nameInUse} aria-busy={busy || undefined}>
            {editing ? t('agent.save') : t('agent.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
