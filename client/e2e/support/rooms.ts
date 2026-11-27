import { expect, type Locator, type Page } from '@playwright/test'
import { deleteRoom } from '../../test/support/room-admin'
import { MANAGE, NEW_CONVERSATION, LIST } from './labels'
import { groupRoomsOf, roomsNamed, sharedRoomsBesidesOrgChannel } from './server-facts'
import { channelRow, conversations } from './workspace'

// Rooms of a spec's own pair: the hermetic start, and creating and staffing a channel through the UI.

// Hermetic start (PLANO-RELEASE-PUBLICA §8.24): the rooms the pair shares besides the org channel —
// what earlier local runs left behind — are deleted before the first login, so the run creates its
// own. On a fresh stack (CI) there is nothing to delete.
export async function deleteSharedRooms(a: string, b: string): Promise<void> {
  const rooms = await sharedRoomsBesidesOrgChannel(a, b)
  for (const roomId of rooms) await deleteRoom(roomId)
  console.log(`[e2e] rooms of earlier runs deleted: ${rooms.length}`)
}

// The channels a spec names after itself (`prefix`), deleted. For a channel that never holds the pair's
// second person — deleteSharedRooms does not see it — and that would otherwise outlive the spec: a later
// first login of the same person reads its history with a new device, and the messages of a member that
// keeps no key backup (an agent) are backup misses in that spec's console ledger.
export async function deleteChannelsNamed(prefix: string): Promise<void> {
  const rooms = await roomsNamed(prefix)
  for (const roomId of rooms) await deleteRoom(roomId)
  console.log(`[e2e] channels named ${prefix}… deleted: ${rooms.length}`)
}

// The group conversations of a spec's own people, deleted — at its start and at its end, so the spec
// leaves nothing for the next run and an earlier run's group never answers for the same set (ADR-094 dec. 8).
export async function deleteGroupsOf(...localparts: string[]): Promise<void> {
  const rooms = await groupRoomsOf(...localparts)
  for (const roomId of rooms) await deleteRoom(roomId)
  console.log(`[e2e] group conversations deleted: ${rooms.length}`)
}

// A channel of the pair, created from the sidebar's "Novo canal". `name` without the '#'.
export async function createChannel(page: Page, { name, kind }: { name: string; kind: 'public' | 'private' }): Promise<void> {
  await conversations(page).getByRole('button', { name: LIST.newChannel }).click()
  const create = page.getByRole('dialog', { name: NEW_CONVERSATION.dialog })
  await create.getByLabel(NEW_CONVERSATION.name).fill(name)
  await create.getByRole('button', { name: kind === 'public' ? NEW_CONVERSATION.public : NEW_CONVERSATION.private }).click()
  await create.getByRole('button', { name: NEW_CONVERSATION.createChannel }).click()
  await expect(create).toHaveCount(0)
}

// Open the channel and its management panel. The header's button names the channel as its label
// reads (ChannelLabel.tsx manageLabel): '#'+name for a public channel, the lock's name + name for a
// private one (PLANO-RELEASE-PUBLICA §8.66).
export async function openManage(page: Page, name: string, kind: 'public' | 'private' = 'public'): Promise<void> {
  await channelRow(page, name).click()
  await page.getByRole('button', { name: MANAGE.open(kind === 'private' ? `${LIST.privateMark} ${name}` : `#${name}`) }).click()
}

// Add a member from the open management panel. The candidates are read when the dialog opens; the
// member's first-login join of the org channel may reach this client a moment later, so the dialog is
// reopened until the member is in it. Adding keeps the picker open and the person leaves its list
// (channel-management.md §9 item 5); the picker is then closed, back to the roster.
export async function addMember(page: Page, memberName: string): Promise<void> {
  const add = page.getByRole('dialog', { name: MANAGE.addMember })
  const contact = add.getByRole('button', { name: memberName, exact: true })
  await expect(async () => {
    if ((await add.count()) > 0) await page.keyboard.press('Escape')
    await page.getByRole('button', { name: MANAGE.addMember }).click()
    await expect(contact).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 60_000 })
  await contact.click()
  await closePicker(page, contact)
  await expect(page.getByRole('region', { name: MANAGE.members })).toContainText(memberName)
}

// The picker after a pick: the candidate leaves the list once the verb is acknowledged, then the footer's
// "Fechar" goes back to the main view (§9 item 4).
export async function closePicker(page: Page, picked: Locator): Promise<void> {
  const add = page.getByRole('dialog', { name: MANAGE.addMember })
  await expect(picked).toHaveCount(0, { timeout: 30_000 })
  await add.getByRole('button', { name: MANAGE.closePicker, exact: true }).last().click()
  await expect(add).toHaveCount(0)
}

// The rest of the management panel's verbs, from the open panel (the one dialog on screen). Each waits
// for the panel's own acknowledgement — the confirmation view closing, the "Saved" note — and leaves
// the reconciled state (roster, list) to the spec, which asserts it on both sides.

// Remove a member: the row's "Remove <name>" opens the confirmation view, whose "Remove" does it.
export async function removeMember(page: Page, memberName: string): Promise<void> {
  await page.getByRole('button', { name: MANAGE.remove(memberName), exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: MANAGE.confirmRemove, exact: true }).click()
  await expect(page.getByRole('region', { name: MANAGE.members })).toBeVisible()
}

// Change a member's role from the row's control. The roster reconciles through the stream, so the
// control shows the new role only once the server took it.
export async function setRole(page: Page, memberName: string, role: typeof MANAGE.admin | typeof MANAGE.member): Promise<void> {
  await page.getByRole('combobox', { name: MANAGE.role(memberName), exact: true }).selectOption({ label: role })
}

// Leave the channel: "Leave channel", then the confirmation's "Leave"; the panel closes on success.
export async function leaveChannel(page: Page): Promise<void> {
  await page.getByRole('button', { name: MANAGE.leave, exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: MANAGE.confirmLeave, exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

// Edit the name and/or topic: each field commits on Enter → its discreet "Saved" note (the panel
// stays open).
export async function saveChannel(page: Page, { name, topic }: { name?: string; topic?: string }): Promise<void> {
  const dialog = page.getByRole('dialog')
  const commit = async (label: string, value: string) => {
    const field = dialog.getByLabel(label, { exact: true })
    await field.fill(value)
    await field.press('Enter')
    await expect(dialog.getByRole('status')).toHaveText(MANAGE.saved)
  }
  if (name !== undefined) await commit(MANAGE.name, name)
  if (topic !== undefined) await commit(MANAGE.topic, topic)
}
