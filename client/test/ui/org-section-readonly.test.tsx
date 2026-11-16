// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { UserProfileDialog } from '../../src/ui/components/UserProfileDialog'
import { ProfileEditor } from '../../src/ui/components/ProfileEditor'
import type { MyProfile, UserId, UserProfile } from '../../src/acl'

// Guarda de read-only da camada organizacional (ADR-054, §3.3 do PR-3). A seção org é LEITURA: nenhum
// verbo. Diferente do guarda do PR-2 (que tinha que furar o TIPO), aqui a proteção é PURAMENTE de
// runtime/DOM — não há tipo absorvendo a mutação, então mutar o valor pra um <input> já exercita o
// caminho defendido. A query é ESCOPADA ao container da seção, não ao documento: o ProfileEditor TEM
// inputs (apelido/pronomes/recado) e a ProfilePhoto TEM botões — mas fora da seção org.

const uid = (s: string): UserId => s as unknown as UserId

afterEach(cleanup)

const orgFull = {
  authority: 'directory' as const,
  fullName: 'Alice Alves',
  jobTitle: 'Engenheira de Plataforma',
  workEmail: 'alice@empresa.example',
}

function assertNoVerbs(section: Element) {
  expect(section.querySelector('input')).toBeNull()
  expect(section.querySelector('textarea')).toBeNull()
  expect(section.querySelector('select')).toBeNull()
  expect(section.querySelector('button')).toBeNull()
  expect(section.querySelector('[contenteditable]')).toBeNull()
}

describe('seção org é read-only — sem verbo (ADR-054 §3.3)', () => {
  it('UserProfileDialog: "Da organização" não tem elemento editável/acionável', async () => {
    const profile: UserProfile = {
      id: uid('@bob:tayet.local'),
      displayName: 'Bob Brown', kind: 'member',
      org: orgFull,
    }
    const { container } = render(
      <UserProfileDialog
        userId={profile.id}
        onLoadUserProfile={async () => profile}
        onClose={() => {}}
      />,
    )
    const section = await waitFor(() => {
      const el = container.querySelector('[aria-label="Da organização"]')
      if (!el) throw new Error('sem seção ainda')
      return el
    })
    assertNoVerbs(section)
  })

  it('ProfileEditor: "Da sua organização" não tem elemento editável/acionável', async () => {
    const profile: MyProfile = { fullName: 'Alice Stone', org: orgFull }
    const { container } = render(
      <ProfileEditor
        onBack={() => {}}
        onClose={() => {}}
        onLoadProfile={async () => profile}
        onSaveProfile={async () => {}}
        onSaveAvatar={async () => {}}
        onClearAvatar={async () => {}}
      />,
    )
    const section = await waitFor(() => {
      const el = container.querySelector('.profile-editor__org')
      if (!el) throw new Error('sem seção ainda')
      return el
    })
    assertNoVerbs(section)
  })
})
