import { useState } from 'react'
import { BottomSheet, Button, Field } from '../primitives'
import { isSafeHref } from './safe-href'
import { t } from '../i18n'

// What the composer hands up when the link opens on a narrow window: the seeds of the two fields and the two
// edits, which close over the composer's editor (its selection stays put while the focus is in the sheet).
export interface LinkRequest {
  text: string
  url: string
  // The caret is inside a link: "Editar link", "Salvar" and "Remover".
  editing: boolean
  apply: (text: string, href: string) => void
  remove: () => void
  // The editor, which takes the focus back when the sheet closes.
  returnFocus: HTMLElement | null
}

// The link sheet on the narrow window (workspace.md §23.7 item 3, §23.9): the composer's link Dialog as a
// BottomSheet with the form padding. Title "Inserir link" or "Editar link"; "Texto" and "URL" on the touch floor;
// an invalid scheme marks the URL field danger with `composer.linkInvalid` and creates no link (barrier 1,
// isSafeHref, as in the Dialog); stacked buttons: "Inserir"/"Salvar" (primary), "Remover" (danger, editing only)
// and "Cancelar". The first focus is a field, by the Dialog's rule: URL when a text is seeded, else Texto.
// Mounted by the Workspace as a direct child of the `.workspace` (the sheet's contract); the state lives there.
export function LinkSheet({ request, onClose }: { request: LinkRequest; onClose: () => void }) {
  const [text, setText] = useState(request.text)
  const [url, setUrl] = useState(request.url)
  const [invalid, setInvalid] = useState(false)
  const title = request.editing ? t('composer.linkEdit') : t('composer.linkInsert')
  const submit = (): void => {
    const href = url.trim()
    if (!isSafeHref(href)) {
      setInvalid(true)
      return
    }
    request.apply(text, href)
    onClose()
  }
  return (
    <BottomSheet ariaLabel={title} onClose={onClose} returnFocus={request.returnFocus} padding="form" focus="field">
      <form
        className="link-sheet"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <h2 className="link-sheet__title">{title}</h2>
        <Field
          label={t('composer.linkText')}
          htmlFor="link-sheet-text"
          inputProps={{ value: text, autoFocus: request.text === '', onChange: (e) => setText(e.target.value) }}
        />
        <Field
          label={t('composer.linkUrl')}
          htmlFor="link-sheet-url"
          error={invalid ? t('composer.linkInvalid') : undefined}
          inputProps={{
            value: url,
            autoFocus: request.text !== '',
            onChange: (e) => {
              setUrl(e.target.value)
              setInvalid(false)
            },
          }}
        />
        <div className="link-sheet__actions">
          <Button variant="fill" type="submit">
            {request.editing ? t('composer.linkSave') : t('composer.linkInsertAction')}
          </Button>
          {request.editing && (
            <Button
              variant="danger"
              onClick={() => {
                request.remove()
                onClose()
              }}
            >
              {t('composer.linkRemove')}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            {t('composer.linkCancel')}
          </Button>
        </div>
      </form>
    </BottomSheet>
  )
}
