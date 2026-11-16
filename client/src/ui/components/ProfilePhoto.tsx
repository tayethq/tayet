import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { MediaRef } from '@tayet/client'
import { Button } from '../primitives'
import { useMedia } from '../MediaContext'
import { t } from '../i18n'

// Controle de foto de perfil (ADR-041 PR-3). Distinto do primitivo Avatar inline: preview grande
// editável + Trocar/Remover, com lifecycle de upload próprio. IMEDIATO-NA-AÇÃO (Fork 3): Trocar faz
// upload no pick (não atrás do Salvar do apelido); Remover limpa na hora. P1: renderiza só uma URL
// resolvida (useMedia do avatar opaco) ou um objectURL local — NUNCA o mr_*/mxc. O monograma (iniciais
// limpas) é o fallback sem foto. Bespoke (ratificado ii): a preocupação editável + a escala de perfil
// não pertencem ao primitivo decorativo inline.

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const raw = parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : name.trim().slice(0, 2)
  return raw.toUpperCase()
}

export function ProfilePhoto({
  avatar,
  name,
  onSaveAvatar,
  onClearAvatar,
}: {
  avatar?: MediaRef
  name: string
  onSaveAvatar: (file: File) => Promise<void>
  onClearAvatar: () => Promise<void>
}) {
  const resolved = useMedia(avatar, 'thumbnail').url // foto atual (mr_* → URL, atrás do barrel)
  const [localPreview, setLocalPreview] = useState<string | undefined>(undefined) // objectURL in-flight
  const [cleared, setCleared] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Revoga o objectURL ao substituir/desmontar (sem leak).
  useEffect(() => {
    return () => {
      if (localPreview) URL.revokeObjectURL(localPreview)
    }
  }, [localPreview])

  const shownUrl = localPreview ?? (cleared ? undefined : resolved)
  const hasPhoto = Boolean(shownUrl)

  function replacePreview(next: string | undefined) {
    setLocalPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return next
    })
  }

  async function pickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // permite re-pick do mesmo arquivo
    if (!file) return
    replacePreview(URL.createObjectURL(file))
    setCleared(false)
    setError(false)
    setBusy(true)
    try {
      await onSaveAvatar(file)
      setBusy(false)
    } catch {
      setBusy(false)
      setError(true)
      replacePreview(undefined) // volta pra foto atual no erro
    }
  }

  async function remove() {
    if (busy) return
    replacePreview(undefined)
    setError(false)
    setBusy(true)
    try {
      await onClearAvatar()
      setCleared(true)
      setBusy(false)
    } catch {
      setBusy(false)
      setError(true)
    }
  }

  return (
    <section className="profile-photo" aria-label={t('profile.photo')}>
      <span className="profile-photo__preview" aria-hidden="true">
        {hasPhoto ? (
          <img className="profile-photo__img" src={shownUrl} alt="" />
        ) : (
          <span className="profile-photo__monogram">{initialsOf(name)}</span>
        )}
      </span>
      <div className="profile-photo__meta">
        <div className="profile-photo__actions">
          <Button variant="secondary" disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? t('profile.photoUploading') : hasPhoto ? t('profile.photoChange') : t('profile.photoAdd')}
          </Button>
          {hasPhoto && (
            <Button variant="ghost" disabled={busy} onClick={remove}>
              {t('profile.photoRemove')}
            </Button>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="profile-photo__file"
            onChange={pickFile}
          />
        </div>
        {error && (
          <p className="profile-photo__error" role="status">
            {t('profile.photoFailed')}
          </p>
        )}
      </div>
    </section>
  )
}
