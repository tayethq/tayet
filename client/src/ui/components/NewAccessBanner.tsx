import type { AccessId } from '@tayet/client'
import { Button } from '../primitives'
import { t } from '../i18n'

// Passive, dismissible "new access to your account" banner (ADR-018 §3.3). Product vocabulary only —
// "acesso", never "dispositivo"/crypto (P1; the DOM render-scan is fail-closed against it). Pure
// presentational: clean domain props, driven identically by the live app and the render-scan test.
// The opaque AccessId is carried so dismiss can hand it back to acknowledgeAccess — NEVER rendered.
export interface NewAccess {
  access: AccessId
  // From the device's MAS display name (Device.friendlyName); absent/blank → generic copy only.
  friendlyName?: string
}

// Colapso a uma linha-resumo (PR-S2, fork S2-1=b): UM aviso, sempre. N=1 mantém o nome do dispositivo
// (o sinal de reconhecimento que decide dispensar-vs-Redefinir); N>1 colapsa pra contagem, sem nome (o
// detalhe por-acesso vive no modal de conta). Dispensar reconhece o LOTE — cada AccessId volta opaco a
// acknowledgeAccess. Sem stacking, sem cap: o bound é estrutural (uma linha, qualquer que seja N).
// Forma (workspace.md §14 item 1, §6.7; A3-5): UM wrapper — a `region` é a faixa, o `status` é só o
// texto; a ação quieta no idioma do "Restaurar" vivo (Button ghost `gestao`, §19.5 item 4).
export function NewAccessBanner({
  accesses,
  onDismiss,
}: {
  accesses: NewAccess[]
  onDismiss: (access: AccessId) => void
}) {
  if (accesses.length === 0) return null
  const multi = accesses.length > 1
  const name = multi ? undefined : accesses[0]?.friendlyName?.trim()
  const title = t('account.newAccess', { n: accesses.length })
  const detail = multi
    ? t('account.wasItYou')
    : name
      ? t('account.accessedFrom', { device: name })
      : t('account.accessedRecently')
  return (
    <div className="new-access-banner" role="region" aria-label={t('account.securityNotices')}>
      <div className="new-access-banner__text" role="status">
        <strong className="new-access-banner__title">{title}</strong>
        <span className="new-access-banner__detail">{detail}</span>
      </div>
      <Button
        variant="ghost"
        size="gestao"
        className="new-access-banner__dismiss"
        onClick={() => accesses.forEach((a) => onDismiss(a.access))}
      >
        {t('account.dismissMine')}
      </Button>
    </div>
  )
}
