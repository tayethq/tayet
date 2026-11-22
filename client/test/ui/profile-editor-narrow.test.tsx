// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ProfileEditor } from '../../src/ui/components/ProfileEditor'
import type { MyProfile } from '../../src/acl'
import { copy } from '../support/copy'

// "Editar perfil" on the narrow window (edit-profile.md §9.1).

afterEach(cleanup)

const never = () => new Promise<never>(() => {})
function editor({
  load = () => Promise.resolve<MyProfile>({ fullName: 'Marina Alves' }),
  save = async () => {},
  onBack = () => {},
}: { load?: () => Promise<MyProfile>; save?: () => Promise<void>; onBack?: () => void } = {}) {
  const v = render(
    <ProfileEditor narrow onBack={onBack} onClose={() => {}} onLoadProfile={load} onSaveProfile={save} onSaveAvatar={async () => {}} onClearAvatar={async () => {}} />,
  )
  const footer = () => v.container.querySelector<HTMLElement>('.account-screen__footer')
  return { ...v, footer }
}
async function ready(v: ReturnType<typeof editor>) {
  await waitFor(() => expect(v.footer()).not.toBeNull())
  const save = () => within(v.footer()!).getByRole('button', { name: copy.profile.save }) as HTMLButtonElement
  const status = () => v.footer()!.querySelector('[role="status"]')!.textContent
  const type = () => fireEvent.change(v.getByLabelText(copy.profile.nickname), { target: { value: 'Mari' } })
  return { save, status, type }
}

describe('"Editar perfil" narrow', () => {
  it('a screen with back and title, no ✕; the footer outside the scroll, the state over the button', async () => {
    const onBack = vi.fn()
    const v = editor({ onBack })
    await ready(v)
    expect(v.container.querySelector('.ui-dialog')).toBeNull()
    expect(v.getByRole('heading', { name: copy.profile.editTitle })).toBeTruthy()
    expect(v.queryByRole('button', { name: copy.dialog.close })).toBeNull()
    expect(v.footer()!.closest('.account-screen__body')).toBeNull()
    const footer = v.footer()!.querySelector('.profile-editor__footer')!
    expect([...footer.children].map((el) => el.tagName)).toEqual(['SPAN', 'BUTTON'])
    fireEvent.click(v.getByRole('button', { name: copy.dialog.back }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('the order: photo, nickname, pronouns, note, organization', async () => {
    const v = editor()
    await ready(v)
    const order = [...v.container.querySelectorAll('.profile-photo, #profile-nickname, #profile-pronouns, #profile-note, .profile-editor__org')]
    expect(order.map((el) => el.id || el.className)).toEqual(['profile-photo', 'profile-nickname', 'profile-pronouns', 'profile-note', 'profile-editor__org'])
  })

  it('no change: disabled; saving: disabled with the state; saved: the state, disabled again', async () => {
    let done: () => void = () => {}
    const v = editor({ save: () => new Promise<void>((r) => (done = r)) })
    const ui = await ready(v)
    expect(ui.save().disabled).toBe(true)
    expect(ui.status()).toBe('')
    ui.type()
    expect(ui.save().disabled).toBe(false)
    fireEvent.click(ui.save())
    expect(ui.status()).toBe(copy.profile.saving)
    expect(ui.save().disabled).toBe(true)
    done()
    await waitFor(() => expect(ui.status()).toBe(copy.profile.saved))
    expect(ui.save().disabled).toBe(true)
  })

  it('a failed save: the state, and the button live', async () => {
    const v = editor({ save: () => Promise.reject(new Error('no')) })
    const ui = await ready(v)
    ui.type()
    fireEvent.click(ui.save())
    await waitFor(() => expect(ui.status()).toBe(copy.profile.saveFailed))
    expect(ui.save().disabled).toBe(false)
  })

  it('loading: the status and no footer', () => {
    const v = editor({ load: never })
    expect(v.getByRole('status').textContent).toBe(copy.profile.loading)
    expect(v.footer()).toBeNull()
  })

  it('a failed load: the alert and no footer', async () => {
    const v = editor({ load: () => Promise.reject(new Error('no')) })
    await waitFor(() => expect(v.getByRole('alert').textContent).toBe(copy.profile.loadOwnFailed))
    expect(v.footer()).toBeNull()
  })

  it('the keyboard: the footer drops the bottom safe area, the screen follows the visual viewport', () => {
    const css = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'styles.narrow.css'), 'utf8')
    expect(css).toMatch(/:root\[data-keyboard\] \.account-screen__footer \{\s*padding-bottom: var\(--space-12\);/)
    expect(css).toMatch(/\.workspace > \.account-screen,/)
  })
})
