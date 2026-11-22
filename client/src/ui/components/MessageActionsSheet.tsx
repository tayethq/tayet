import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Message } from '@tayet/client'
import { BottomSheet, Button } from '../primitives'
import { Reply, Thread, Copy, Edit, Trash } from '../icons'
import { QUICK } from './Reactions'
import type { MessageActions } from './Timeline'
import { t } from '../i18n'

// The message's action sheet on the narrow window (manifest workspace.md §23.8 items 2–7, §29, §30): the three
// quick reactions · Reply · Reply in thread · Copy text · Edit message · Delete message, each only where the wide
// window offers it (`actions`, from actionsOf). "Editar mensagem" (M5, PLANO-MOBILE §0.15 E1 b) takes the
// composer of the same screen into editing, in the conversation and in the thread. Every action closes the
// sheet; Delete first asks inside it — "Apagar mensagem?", "Apagar" (danger) and "Cancelar", two steps and no
// Dialog (ADR-075 dec. 4 and its addendum). In the thread the caller wires no reply nor thread (§29 item 1).
// Local to this surface: one consumer, the Workspace (below the ADR-036 dec. 3 bar).
export function MessageActionsSheet({
  message,
  actions,
  onReact,
  onReply,
  onOpenThread,
  onEditMessage,
  onDelete,
  onClose,
  returnFocus,
  panelRef,
}: {
  message: Message
  actions: MessageActions
  onReact?: (message: Message, emoji: string) => void
  onReply?: (message: Message) => void
  onOpenThread?: (message: Message) => void
  onEditMessage?: (message: Message) => void
  onDelete?: (message: Message) => void
  onClose: () => void
  returnFocus: HTMLElement | null
  panelRef?: { current: HTMLDivElement | null }
}) {
  const [confirming, setConfirming] = useState(false)
  const confirmRef = useRef<HTMLDivElement>(null)
  // The question opens on the safe choice ("Cancelar", the last button), as on the wide bar.
  useEffect(() => {
    if (confirming) confirmRef.current?.querySelector<HTMLElement>('button:last-child')?.focus()
  }, [confirming])
  const then = (act?: () => void) => (): void => {
    onClose()
    act?.()
  }
  // A refused copy closes the sheet too, with nothing on screen (N8 a).
  const copy = (): void => {
    try {
      navigator.clipboard?.writeText(actions.copy ?? '').then(
        () => {},
        () => {},
      )
    } catch {
      // A clipboard that throws before the promise is a refusal too.
    }
  }
  const row = (label: string, icon: ReactNode, act: () => void, danger = false) => (
    <button type="button" className={danger ? 'message-sheet__row message-sheet__row--danger' : 'message-sheet__row'} onClick={act}>
      {icon}
      {label}
    </button>
  )
  return (
    <BottomSheet ariaLabel={t('timeline.actionsSheet')} onClose={onClose} returnFocus={returnFocus} panelRef={panelRef}>
      {confirming ? (
        <>
          <p className="message-sheet__question">{t('timeline.deleteQuestion')}</p>
          <div className="message-sheet__confirm" ref={confirmRef}>
            <Button variant="danger" size="gestao" onClick={then(() => onDelete?.(message))}>
              {t('timeline.delete')}
            </Button>
            <Button variant="secondary" size="gestao" onClick={onClose}>
              {t('timeline.cancel')}
            </Button>
          </div>
        </>
      ) : (
        <>
          {actions.react && (
            <div className="message-sheet__reactions" role="group" aria-label={t('timeline.reactOpen')}>
              {QUICK.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="message-sheet__emoji"
                  aria-label={t('timeline.react', { emoji })}
                  onClick={then(() => onReact?.(message, emoji))}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
          {actions.reply && row(t('timeline.reply'), <Reply size={20} />, then(() => onReply?.(message)))}
          {actions.thread && row(t('timeline.replyInThread'), <Thread size={20} />, then(() => onOpenThread?.(message)))}
          {actions.copy !== undefined && row(t('timeline.copyText'), <Copy size={20} />, then(copy))}
          {actions.edit && row(t('timeline.editMessage'), <Edit size={20} />, then(() => onEditMessage?.(message)))}
          {actions.delete && row(t('timeline.deleteMessage'), <Trash size={20} />, () => setConfirming(true), true)}
        </>
      )}
    </BottomSheet>
  )
}
