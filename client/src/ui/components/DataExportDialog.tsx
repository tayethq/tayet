import { useId } from 'react'
import type { Channel } from '@tayet/client'
import { Button, Dialog } from '../primitives'
import { PrivateLock, PrivateMarkSpace, bareName } from './ChannelLabel'
import { fileSize, useDataExport, type DataExportVerb } from '../useDataExport'
import { t, GLYPH } from '../i18n'

// Dialog "Exportar seus dados" (manifesto account-access.md §12; ADR-096 dec. 6 and 11): the shell of
// "Convidar pessoa" (§9.1), five states. `idle` and `failed` are the artboard's `parado` (failed adds the
// error line, §12.1 item 7); `preparing` shows the count per conversation and a determinate bar; the end
// (`pronto`, or `incompleto` when a conversation has a gap) replaces the body, in the mould of the invite's
// success. Closing (✕, Esc, "Cancelar", "Fechar") goes back to "Sua conta"; it unmounts the dialog, and with
// it the hook, which cancels a preparation and lets the file go (PLANO-EXPORT-DADOS §0.3.6 items 1 and 8).
// No beforeunload: it would hold back the "Usar aqui" handover (ADR-065; §0.3.6 item 11). P1: a
// conversation shows by its name and kind mark, never by an id.

const INCLUDES = ['profile', 'messages', 'conversations', 'approvals', 'accesses', 'agents'] as const

// The gap row's mark column (§0.3.6 item 2): '#' for a public channel, the lock for a private one, empty
// for a DM or a group conversation.
function GapMark({ channel }: { channel: Channel }) {
  if (channel.kind === 'private') {
    return (
      <>
        <span className="data-export__mark">
          <PrivateLock />
        </span>
        <PrivateMarkSpace />
      </>
    )
  }
  return (
    <span className="data-export__mark" aria-hidden="true">
      {channel.kind === 'public' ? GLYPH.hash : null}
    </span>
  )
}

export function DataExportDialog({ onExport, onClose }: { onExport: DataExportVerb; onClose: () => void }) {
  const { state, prepare, cancel, download } = useDataExport(onExport)
  const includesId = useId()
  const title = t('dataExport.title')

  if (state.kind === 'ready') {
    const gaps = state.incomplete
    return (
      <Dialog
        className="compose-dialog data-export"
        title={title}
        onClose={onClose}
        closeLabel={t('dialog.close')}
        footer={
          <Button variant="secondary" onClick={onClose}>
            {t('dialog.close')}
          </Button>
        }
      >
        <div className="data-export__body">
          <div>
            <div className="data-export__title">
              {gaps.length > 0 ? t('dataExport.readyWithGaps') : t('dataExport.ready')}
            </div>
            <div className="data-export__label">
              {t('dataExport.conversations', { n: state.conversations })} {GLYPH.dot} {fileSize(state.bytes)}
            </div>
          </div>
          {gaps.length > 0 && (
            <>
              <p className="data-export__text">{t('dataExport.gapsIntro', { n: gaps.length })}</p>
              <ul className="data-export__gaps">
                {gaps.map(({ channel, gaps: count }) => (
                  <li key={channel.id} className="data-export__gap">
                    <GapMark channel={channel} />
                    <span className="data-export__gap-name">{bareName(channel)}</span>
                    <span className="data-export__label">{t('dataExport.gapMessages', { n: count })}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="data-export__help">{t('dataExport.warning')}</p>
          <Button variant="fill" className="data-export__download" autoFocus onClick={download}>
            {t('dataExport.download')}
          </Button>
        </div>
      </Dialog>
    )
  }

  if (state.kind === 'preparing') {
    const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0
    return (
      <Dialog
        className="compose-dialog data-export"
        title={title}
        onClose={onClose}
        closeLabel={t('dialog.close')}
        footer={
          <Button key="preparing" variant="secondary" autoFocus onClick={cancel}>
            {t('account.cancel')}
          </Button>
        }
      >
        <div className="data-export__body">
          <div className="data-export__status" role="status">
            <span className="data-export__status-text">{t('dataExport.preparing')}</span>
            <span className="data-export__label">
              {t('dataExport.progress', { done: state.done, n: state.total })}
            </span>
          </div>
          <div
            className="data-export__track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={state.total}
            aria-valuenow={state.done}
            aria-label={t('dataExport.preparingLabel')}
          >
            <div className="data-export__bar" style={{ width: `${pct}%` }} />
          </div>
          <p className="data-export__help">{t('dataExport.keepOpen')}</p>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog
      className="compose-dialog data-export"
      title={title}
      onClose={onClose}
      closeLabel={t('dialog.close')}
      footer={
        <>
          <Button key="idle-cancel" variant="secondary" onClick={onClose}>
            {t('account.cancel')}
          </Button>
          <Button key="idle-prepare" variant="fill" autoFocus onClick={prepare}>
            {t('dataExport.prepare')}
          </Button>
        </>
      }
    >
      <div className="data-export__body">
        <p className="data-export__text">{t('dataExport.intro')}</p>
        <div className="data-export__includes">
          <span id={includesId} className="data-export__label">
            {t('dataExport.includesLabel')}
          </span>
          <ul className="data-export__list" aria-labelledby={includesId}>
            {INCLUDES.map((key) => (
              <li key={key}>{t(`dataExport.includes.${key}`)}</li>
            ))}
          </ul>
        </div>
        <p className="data-export__help">{t('dataExport.othersExcluded')}</p>
        {state.kind === 'failed' && (
          <p className="compose-dialog__error" role="alert">
            {t('dataExport.failed')}
          </p>
        )}
      </div>
    </Dialog>
  )
}
