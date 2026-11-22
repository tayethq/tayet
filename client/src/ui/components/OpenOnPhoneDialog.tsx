import { useEffect, useState } from 'react'
import { Button, Dialog } from '../primitives'
import { t } from '../i18n'

// "Abrir no celular" (account-access.md §13.1 item 2; PLANO-MOBILE M7 Q1, Q2), in the shell of "Exportar seus
// dados". The code carries the app's address and nothing else, and the address is never written (P1): not as
// text, title or label. The encoder loads when the dialog opens; the drawing is ours, from its matrix.

// The light margin a reader needs around a code, in modules.
const QUIET_ZONE = 4

export function OpenOnPhoneDialog({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState<{ size: number; path: string } | undefined>(undefined)
  useEffect(() => {
    let alive = true
    import('uqr')
      .then(({ encode }) => {
        const { size, data } = encode(window.location.origin, { ecc: 'M', border: QUIET_ZONE })
        const path = data.flatMap((row, y) => row.map((dark, x) => (dark ? `M${x} ${y}h1v1h-1z` : ''))).join('')
        if (alive) setCode({ size, path })
      })
      // The square stays empty; the failure's text can carry the address, so it is not logged.
      .catch(() => console.error('[open-on-phone] encoder not loaded'))
    return () => {
      alive = false
    }
  }, [])
  return (
    <Dialog
      className="compose-dialog data-export"
      title={t('account.openOnPhone')}
      onClose={onClose}
      closeLabel={t('dialog.close')}
      footer={
        <Button variant="secondary" autoFocus onClick={onClose}>
          {t('dialog.close')}
        </Button>
      }
    >
      <div className="data-export__body">
        <p className="data-export__text">{t('account.openOnPhoneBody')}</p>
        <div className="open-on-phone__code">
          {code && (
            <svg viewBox={`0 0 ${code.size} ${code.size}`} shapeRendering="crispEdges" role="img" aria-label={t('account.openOnPhoneCode')}>
              <path d={code.path} />
            </svg>
          )}
        </div>
        <p className="data-export__help">{t('account.openOnPhoneHelp')}</p>
      </div>
    </Dialog>
  )
}
