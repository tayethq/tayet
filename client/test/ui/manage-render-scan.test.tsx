// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { Workspace } from '../../src/ui/components/Workspace'
import type { Channel, ChannelId, MemberState, Role, User, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'

// P1 gate for the management surface (mirrors render-scan.test.tsx). The channel's id and EVERY
// member/candidate id deliberately carry a REAL protocol shape (the ADR-008 residual: the runtime id
// value IS the room/user id); their names are clean. If the panel — any dialog, the roster, or the
// add-member picker — ever rendered an id or any protocol vocabulary, the scan over innerHTML (text +
// attributes) turns red. Clean fields (channel name/topic, member displayName, candidate displayName)
// must still render. This is the U2 INVERSION of the U1 gate: the roster is now PRESENT (U1 asserted
// its absence), and it must carry only clean display names — never the opaque user.id.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId

afterEach(cleanup)

const channel: Channel = {
  id: cid('!engineering:tayet.local'), // protocol-shaped on purpose
  name: '#engineering',
  kind: 'public',
  topic: 'Builds, releases and the occasional fire drill',
  memberCount: 4,
  unread: { count: 0, mentions: 0 },
}

// Roster: protocol-shaped ids, clean display names; one of each role (admin/member/guest).
const members: Array<{ user: User; role: Role; state: MemberState; self: boolean }> = [
  { user: { id: uid('@ana:tayet.local'), displayName: 'Ana Lima', kind: 'member' }, role: 'admin', state: 'active', self: false },
  { user: { id: uid('@bruno:tayet.local'), displayName: 'Bruno Sato', kind: 'member' }, role: 'member', state: 'active', self: false },
  { user: { id: uid('@gisele:tayet.local'), displayName: 'Gisele Rocha', kind: 'member' }, role: 'guest', state: 'active', self: false },
]

// Candidate pool for the picker: also protocol-shaped ids, clean names.
const candidates: User[] = [{ id: uid('@carol:tayet.local'), displayName: 'Carol Dias', kind: 'member' }]

const noopVerb = () => Promise.resolve()

function renderPanel() {
  return render(
    <Workspace
      channels={[channel]}
      selectedChannelId={channel.id}
      messages={[]}
      usersById={{}}
      connection="connected"
      managing={channel}
      members={members}
      onManageChannel={() => {}}
      onCloseManage={() => {}}
      onUpdateChannel={noopVerb}
      onArchiveChannel={noopVerb}
      onLeaveChannel={noopVerb}
      onAddMember={noopVerb}
      onRemoveMember={noopVerb}
      onSetRole={noopVerb}
      loadCandidates={() => Promise.resolve(candidates)}
      onSelectChannel={() => {}}
      onSend={() => {}}
    />,
  )
}

describe('DOM render-scan (P1) — channel management surface (U2)', () => {
  it('renders clean name/topic/roster/candidates and leaks NO protocol shape', async () => {
    const { container, getByRole, findByRole, findByText } = renderPanel()

    // Positive control: the clean, user-facing content IS on screen — channel + the whole roster.
    const text = () => container.textContent ?? ''
    expect(text()).toContain('#engineering')
    expect(text()).toContain('Builds, releases and the occasional fire drill')
    expect(text()).toContain('Ana Lima')
    expect(text()).toContain('Bruno Sato')
    expect(text()).toContain('Gisele Rocha')

    // Roster present (panel + roster), no leak (the opaque ids live only in keys/payloads).
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])

    // Add-member picker open + candidates loaded: scan again with the candidate display name on screen.
    fireEvent.click(getByRole('button', { name: copy.channel.addMember }))
    await findByRole('dialog', { name: copy.channel.addMember })
    await findByText('Carol Dias')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
    fireEvent.click(getByRole('button', { name: copy.channel.close }))

    // Remove-member dialog open: scan again (body interpolates the clean displayName, never the id).
    fireEvent.click(getByRole('button', { name: fill(copy.channel.removeNamed, { name: 'Ana Lima' }) }))
    expect(getByRole('dialog', { name: copy.channel.removeTitle })).toBeTruthy()
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
    fireEvent.click(getByRole('button', { name: copy.channel.cancel }))

    // Archive dialog open: scan again.
    fireEvent.click(getByRole('button', { name: copy.channel.archiveTitle }))
    expect(getByRole('dialog', { name: copy.channel.archiveTitle })).toBeTruthy()
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
    fireEvent.click(getByRole('button', { name: copy.channel.cancel }))

    // Leave dialog open: scan again.
    fireEvent.click(getByRole('button', { name: copy.channel.leaveTitle }))
    expect(getByRole('dialog', { name: copy.channel.leaveTitle })).toBeTruthy()
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })
})
