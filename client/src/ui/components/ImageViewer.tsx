import { createContext, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import type { MediaRef } from '@tayet/client'
import { useMedia } from '../MediaContext'
import { saveFile } from '../save-file'
import { trapFocusKeyDown } from '../focus-trap'
import { Close } from '../icons'
import { t, GLYPH } from '../i18n'

// The image a thumbnail opens (manifest workspace.md §25.2, §23.5 item 2). The name is the image's `alt`, the
// text the domain already carries (PLANO-MOBILE §0.14 V5); author and time come from the message, already
// clean (P1). `returnFocus` is the thumbnail, which gets the focus back on close.
export interface ImageView {
  media: MediaRef
  name?: string
  author: string
  time: string
  returnFocus: HTMLElement | null
}

// Opens the viewer from a thumbnail. Provided by the Workspace; without it (the harness) a thumbnail is not a
// button.
export const OpenImageContext = createContext<((view: ImageView) => void) | undefined>(undefined)

// One viewer for both widths, local to this surface (one consumer; not a primitive). A child of the
// `.workspace`, absolute over the whole window, never fixed, no portal (the BottomSheet's way). Wide: opaque in
// --color-bg, the image fitted with a 24 margin and a click toggles the real size, with scrolling, never past
// it; the button, Esc and a click outside the image close it. Narrow: a screen of the stack (the Workspace's
// useStackDialog, V4), close · author and time · "Baixar", the image across the width, no zoom (§25.9).
// "Baixar" is disabled while loading and on failure, by the button's own disabled state (§25.10 item 7).
export function ImageViewer({ image, narrow, onClose }: { image: ImageView; narrow: boolean; onClose: () => void }) {
  const media = useMedia(image.media)
  const [real, setReal] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const back = useRef(image.returnFocus)
  back.current = image.returnFocus
  useLayoutEffect(() => {
    closeRef.current?.focus()
    return () => {
      if (back.current?.isConnected) back.current.focus()
    }
  }, [])
  const ready = media.status === 'ready' && media.url !== undefined
  const zoom = ready && !narrow
  // A click on the backdrop, never on the image or a control, closes the wide viewer.
  const outside = (e: MouseEvent<HTMLElement>): void => {
    if (!narrow && e.target === e.currentTarget) onClose()
  }

  const close = (
    <button type="button" className="image-viewer__close" ref={closeRef} aria-label={t('dialog.close')} onClick={onClose}>
      <Close size={narrow ? 20 : 16} />
    </button>
  )
  const download = (
    <button
      type="button"
      className="image-viewer__download"
      disabled={!ready}
      onClick={() => media.url && saveFile(media.url, image.name ?? t('timeline.imageAlt'))}
    >
      {t('viewer.download')}
    </button>
  )
  const who = (
    <div className="image-viewer__who">
      <span className="image-viewer__author">{image.author}</span>
      <span className="image-viewer__time">{image.time}</span>
    </div>
  )

  return (
    <section
      ref={rootRef}
      className="image-viewer"
      data-real={zoom && real ? 'true' : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={image.name ? t('viewer.label', { name: image.name }) : t('timeline.image')}
      onKeyDown={(e) => trapFocusKeyDown(e, rootRef.current, onClose)}
    >
      <header className="image-viewer__header">
        {narrow ? (
          <>
            {close}
            {who}
            {download}
          </>
        ) : (
          <>
            {who}
            {download}
            {close}
          </>
        )}
      </header>
      <div className="image-viewer__body" onClick={outside}>
        {ready ? (
          <div className="image-viewer__frame" onClick={outside}>
            {zoom ? (
              <button
                type="button"
                className="image-viewer__toggle"
                aria-label={real ? t('viewer.fit') : t('viewer.actualSize')}
                onClick={() => setReal((r) => !r)}
              >
                <img className="image-viewer__image" src={media.url} alt="" />
              </button>
            ) : (
              <img className="image-viewer__image" src={media.url} alt="" />
            )}
          </div>
        ) : media.status === 'failed' ? (
          <div className="image-viewer__failed" role="alert">
            <span className="image-viewer__failed-text">{t('viewer.failed')}</span>
            <span className="image-viewer__failed-dot" aria-hidden="true">
              {GLYPH.dot}
            </span>
            <button type="button" className="image-viewer__retry" onClick={media.retry}>
              {t('timeline.retry')}
            </button>
          </div>
        ) : (
          <span className="image-viewer__loading" role="status">
            {t('viewer.loading')}
          </span>
        )}
      </div>
    </section>
  )
}
