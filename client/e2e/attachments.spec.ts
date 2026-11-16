import { readFile } from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { readZip } from '../test/support/zip-reader'
import { WAL, XAN } from './fixtures/users'
import { expectNoProtocolLeak } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { accountSettings } from './support/account'
import { ACCOUNT, DATA_EXPORT, MANAGE, TIMELINE } from './support/labels'
import { signIn } from './support/login'
import { attach, drawnImage, expectDownload, jpegPhoto, pdf, png } from './support/media'
import { addMember, createChannel, deleteSharedRooms, openManage } from './support/rooms'
import { uploadedMedia } from './support/server-facts'
import { channelRow, dmWith, messages, startDm, title } from './support/workspace'

// ROTEIRO-U2 2.1: attachments, end to end (PLANO-RELEASE-PUBLICA §8.54). wal (A) and xan (B) — the
// spec's own Dex pair (fixtures/users.ts, one pair per spec). In their DM (encrypted) an image and a
// PDF go both ways: the image renders (decoded, naturalWidth > 0) and the PDF downloads with the exact
// bytes sent. While the upload is in flight the row says "Sending…" (held with page.route, released).
// In a public channel of the pair (in the clear, ADR-045; never #all) wal sends both and xan gets
// them. After a reload of both pages nothing turned into a placeholder and a download still works
// (§8.21: the media 401 after a reload). The server lists wal's uploads: the DM's are opaque
// (ciphertext), the channel's carry their type. The DOM is scanned for protocol ids (P1) at every
// step. PNG and PDF are built in memory (support/media.ts). Two phone-sized photos (4032×3024 and
// 3024×4032, built the same way) sit in the reading box on both sides, also after the reload.
// A phone photo with its orientation in EXIF (an 800×600 JPEG stored sideways, Orientation = 6; built in
// the page's canvas, support/media.ts), sent by xan, shows upright — portrait box, the stored top-left quadrant at the
// top right — in the DM (the decrypted original) and in the public channel (the server's thumbnail), on
// both sides and after the reload; the same JPEG without EXIF, once in the DM, shows as stored.
// Last, wal exports their data (ADR-096; PLANO-EXPORT-DADOS §0.3.6 item 15): the zip names the pair's DM and
// channel, holds the bytes of the files wal sent (decrypted from the DM, plain from the channel) and none of
// xan's, every text entry passes the leak-scan, and a second download right before "Fechar" completes (H2).

// Display names as the MAS imported them from the Dex `name` claim (see conversation.spec.ts).
const WAL_NAME = 'wal'
const XAN_NAME = 'xan'

const UPLOAD = /\/_matrix\/(media\/v3|client\/v1\/media)\/upload/

// An image row is ready: the <img> named by the file is decoded (not the pending box, not the alt
// placeholder).
async function expectImage(page: Page, name: string): Promise<void> {
  const image = messages(page).getByRole('img', { name, exact: true })
  await expect(image).toBeVisible({ timeout: 60_000 })
  await expect
    .poll(() => image.evaluate((el) => el.tagName === 'IMG' && (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0), {
      timeout: 30_000,
    })
    .toBe(true)
}

// A large photo sits in its reading box: decoded at full size, inside .message__image's caps, with the
// longest side on its cap and no distortion. Reading size is a CSS fact, so it is asserted as one; the
// phone photo's orientation (EXIF) is expectOriented, below.
const BOX = { maxWidth: 320, maxHeight: 240 }
const UPRIGHT = { width: 600, height: 800 }
const AS_STORED = { width: 800, height: 600 }
async function expectReadingBox(page: Page, photo: { name: string; width: number; height: number }): Promise<void> {
  await expectImage(page, photo.name)
  const image = messages(page).getByRole('img', { name: photo.name, exact: true })
  await image.scrollIntoViewIfNeeded()
  const box = await image.evaluate((el) => {
    const { width, height } = el.getBoundingClientRect()
    const { naturalWidth, naturalHeight, className } = el as HTMLImageElement
    return { width, height, naturalWidth, naturalHeight, className }
  })
  console.log(`[e2e] ${photo.name}: ${JSON.stringify(box)}`)
  expect([box.naturalWidth, box.naturalHeight]).toEqual([photo.width, photo.height])
  expect(box.width).toBeLessThanOrEqual(BOX.maxWidth)
  expect(box.height).toBeLessThanOrEqual(BOX.maxHeight)
  const landscape = photo.width >= photo.height
  expect(landscape ? box.width : box.height).toBeCloseTo(landscape ? BOX.maxWidth : BOX.maxHeight, 0)
  expect(Math.abs(box.width / box.height - box.naturalWidth / box.naturalHeight)).toBeLessThan(0.02)
}

// A JPEG with or without its EXIF orientation, as the browser draws it: inside the reading box, upright
// (taller than wide, the stored top-left quadrant at the top right) or as stored (wider than tall, the
// quadrant in place). `natural` is asserted where the original travels (the DM's decrypted file); in the
// public channel the client asks the server for a thumbnail, of another size.
async function expectOriented(
  page: Page,
  photo: { name: string; upright: boolean },
  natural?: { width: number; height: number },
): Promise<void> {
  await expectImage(page, photo.name)
  const image = messages(page).getByRole('img', { name: photo.name, exact: true })
  await image.scrollIntoViewIfNeeded()
  const drawn = await drawnImage(image)
  console.log(`[e2e] ${photo.name}: ${JSON.stringify(drawn)}`)
  expect(drawn.width).toBeLessThanOrEqual(BOX.maxWidth)
  expect(drawn.height).toBeLessThanOrEqual(BOX.maxHeight)
  if (natural) expect([drawn.naturalWidth, drawn.naturalHeight]).toEqual([natural.width, natural.height])
  if (photo.upright) {
    expect(drawn.height).toBeGreaterThan(drawn.width)
    expect(drawn.naturalHeight).toBeGreaterThan(drawn.naturalWidth)
    expect([drawn.topLeft, drawn.topRight, drawn.bottomLeft, drawn.bottomRight]).toEqual(['blue', 'red', 'yellow', 'green'])
  } else {
    expect(drawn.width).toBeGreaterThan(drawn.height)
    expect([drawn.topLeft, drawn.topRight, drawn.bottomLeft, drawn.bottomRight]).toEqual(['red', 'green', 'blue', 'yellow'])
  }
}

test.beforeAll(async () => {
  await deleteSharedRooms('wal', 'xan')
})

test('attachments: image and PDF both ways in a DM, one way in a public channel; they survive a reload', async ({ browser }) => {
  test.setTimeout(300_000)
  const ts = Date.now()
  // Synapse's created_ts against this host's clock: a margin for the container's skew.
  const startedAt = ts - 5_000
  // Two sizes: the DM's image and the channel's are told apart in the server's upload list.
  const dmImage = { name: `wal-img-${ts}.png`, mime: 'image/png', bytes: png(64, 48) }
  const dmPdf = { name: `wal-doc-${ts}.pdf`, mime: 'application/pdf', bytes: pdf(`wal to xan ${ts}`) }
  const backImage = { name: `xan-img-${ts}.png`, mime: 'image/png', bytes: png(48, 64) }
  const backPdf = { name: `xan-doc-${ts}.pdf`, mime: 'application/pdf', bytes: pdf(`xan to wal ${ts}`) }
  const chImage = { name: `canal-img-${ts}.png`, mime: 'image/png', bytes: png(80, 60) }
  const chPdf = { name: `canal-doc-${ts}.pdf`, mime: 'application/pdf', bytes: pdf(`canal ${ts}`) }
  // A phone's two orientations, in full 12 MP.
  const landscape = { name: `foto-paisagem-${ts}.png`, mime: 'image/png', width: 4032, height: 3024, bytes: png(4032, 3024) }
  const portrait = { name: `foto-retrato-${ts}.png`, mime: 'image/png', width: 3024, height: 4032, bytes: png(3024, 4032) }
  // A phone photo stored sideways with EXIF Orientation = 6, and the same JPEG without EXIF (bytes built in
  // step 4b, in the page's canvas). Shown upright it is 600×800; as stored, 800×600.
  const exifDm = { name: `foto-exif-${ts}.jpg`, mime: 'image/jpeg', bytes: Buffer.alloc(0) as Buffer, upright: true }
  const plainDm = { name: `foto-sem-exif-${ts}.jpg`, mime: 'image/jpeg', bytes: Buffer.alloc(0) as Buffer, upright: false }
  const exifChannel = { name: `canal-foto-exif-${ts}.jpg`, mime: 'image/jpeg', bytes: Buffer.alloc(0) as Buffer, upright: true }
  const channelName = `anx-${ts}`

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  // Boots: wal 2 (login, reload in step 6); xan 2 (login, reload in step 6).
  const consoleA = new ConsoleLedger('wal', [...FIRST_LOGIN_404, ...recognizedSet404(2)])
  const consoleB = new ConsoleLedger('xan', [...FIRST_LOGIN_404, ...recognizedSet404(2)])
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')

    await test.step('1. DM wal↔xan; wal attaches an image: "Sending…" while the upload is held, then it renders on both', async () => {
      await signIn(pageA, WAL)
      await signIn(pageB, XAN)
      await startDm(pageA, XAN_NAME)
      // The invite is auto-joined on xan's side (ADR-044).
      await expect(dmWith(pageB, WAL_NAME)).toBeVisible({ timeout: 60_000 })

      // Hold the upload (not answer it): the row shows its pending state, then the request goes on
      // untouched — nothing injected, so nothing for the console ledger to allow.
      let release!: () => void
      const held = new Promise<void>((r) => (release = r))
      let hits = 0
      await pageA.route(UPLOAD, async (route) => {
        hits++
        await held
        await route.continue()
      })
      await attach(pageA, dmImage)
      const pending = messages(pageA).locator('article').filter({ hasText: TIMELINE.sending })
      await expect(pending).toBeVisible()
      release()
      await expect(pending).toHaveCount(0, { timeout: 60_000 })
      await pageA.unroute(UPLOAD)
      expect(hits).toBeGreaterThan(0)
      await expectImage(pageA, dmImage.name)
      await dmWith(pageB, WAL_NAME).click()
      await expectImage(pageB, dmImage.name)
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('2. wal attaches a PDF: "📎 <name>" on both; xan downloads it, byte for byte', async () => {
      await attach(pageA, dmPdf)
      await expect(messages(pageA).getByRole('link', { name: TIMELINE.fileLink(dmPdf.name), exact: true })).toBeVisible({
        timeout: 60_000,
      })
      await expectDownload(pageB, dmPdf.name, dmPdf.bytes)
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('3. xan sends an image and a PDF back; wal sees the image and downloads the PDF', async () => {
      await attach(pageB, backImage)
      await expectImage(pageB, backImage.name)
      await attach(pageB, backPdf)
      await expectImage(pageA, backImage.name)
      await expectDownload(pageA, backPdf.name, backPdf.bytes)
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('4. wal attaches a large photo in each orientation: both sit in the reading box on both sides', async () => {
      for (const photo of [landscape, portrait]) {
        await attach(pageA, photo)
        await expectReadingBox(pageA, photo)
        await expectReadingBox(pageB, photo)
      }
      await expectNoProtocolLeak(pageA, pageB)
    })

    // xan sends the phone photos: wal's message budget is spent by the steps around this one (the dev-stack's
    // rc_message keeps Synapse's default burst; the CI's homeserver.ci.yaml raises it).
    await test.step('4b. xan attaches a phone photo with EXIF orientation: upright on both sides; the same JPEG without EXIF, as stored', async () => {
      const jpeg = await jpegPhoto(pageB, 800, 600)
      exifDm.bytes = jpeg.rotated
      exifChannel.bytes = jpeg.rotated
      plainDm.bytes = jpeg.plain
      await attach(pageB, exifDm)
      await expectOriented(pageB, exifDm, UPRIGHT)
      await expectOriented(pageA, exifDm, UPRIGHT)
      await attach(pageB, plainDm)
      await expectOriented(pageB, plainDm, AS_STORED)
      await expectOriented(pageA, plainDm, AS_STORED)
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('5. a public channel of the pair: wal attaches an image and a PDF; xan sees and downloads', async () => {
      await createChannel(pageA, { name: channelName, kind: 'public' })
      await openManage(pageA, channelName)
      await addMember(pageA, XAN_NAME)
      await pageA.getByRole('button', { name: MANAGE.close }).click()
      await attach(pageA, chImage)
      await expectImage(pageA, chImage.name)
      await attach(pageA, chPdf)
      await expect(channelRow(pageB, channelName)).toBeVisible({ timeout: 60_000 })
      await channelRow(pageB, channelName).click()
      await expectImage(pageB, chImage.name)
      await expectDownload(pageB, chPdf.name, chPdf.bytes)
      // The photo with EXIF in the clear: xan sends it, wal reads the server's thumbnail.
      await attach(pageB, exifChannel)
      await expectOriented(pageB, exifChannel)
      await expectOriented(pageA, exifChannel)
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('6. reload both: no image turned into a placeholder; a download still works', async () => {
      for (const page of [pageA, pageB]) {
        await page.reload()
        await expect(title(page)).toBeVisible()
      }
      // After the reload both sides read the channel's photo from the server's thumbnail.
      for (const page of [pageA, pageB]) {
        await channelRow(page, channelName).click()
        await expectOriented(page, exifChannel)
      }
      await expectImage(pageB, chImage.name)
      for (const [page, peer] of [
        [pageA, XAN_NAME],
        [pageB, WAL_NAME],
      ] as const) {
        await dmWith(page, peer).click()
        await expectImage(page, dmImage.name)
        await expectImage(page, backImage.name)
        await expectReadingBox(page, portrait)
        await expectOriented(page, exifDm, UPRIGHT)
        await expectOriented(page, plainDm, AS_STORED)
      }
      // §8.21: the media fetch after a reload was a 401. One download proves it closed.
      await expectDownload(pageB, dmPdf.name, dmPdf.bytes)
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('7. the server lists wal’s uploads: the DM’s are opaque, the channel’s carry their type', async () => {
      const uploads = (await uploadedMedia('wal')).filter((m) => m.createdTs >= startedAt)
      console.log(`[e2e] wal's uploads this run: ${JSON.stringify(uploads)}`)
      const plain = (f: { mime: string; bytes: Buffer }) => uploads.filter((m) => m.type === f.mime && m.size === f.bytes.length)
      // The channel is in the clear: its files are stored as sent.
      expect(plain(chImage)).toHaveLength(1)
      expect(plain(chPdf)).toHaveLength(1)
      // The DM is encrypted: its files are stored as opaque ciphertext, never with their type.
      expect(plain(dmImage)).toHaveLength(0)
      expect(plain(dmPdf)).toHaveLength(0)
      expect(uploads.filter((m) => m.type === 'application/octet-stream').length).toBeGreaterThanOrEqual(2)
    })

    await test.step('8. wal exports their data: "Cópia pronta", the pair\'s conversations and wal\'s files in the zip', async () => {
      const account = await accountSettings(pageA)
      await account.getByRole('button', { name: DATA_EXPORT.entry }).click()
      const dialog = pageA.getByRole('dialog', { name: DATA_EXPORT.dialog })
      await expect(dialog.getByRole('button', { name: DATA_EXPORT.prepare, exact: true })).toBeFocused()
      await expectNoProtocolLeak(pageA)
      await dialog.getByRole('button', { name: DATA_EXPORT.prepare, exact: true }).click()
      await expectNoProtocolLeak(pageA)
      // Either end title; only the one without gaps passes ("com lacunas" here is a failure of the test).
      const end = dialog.getByText(new RegExp(`^${DATA_EXPORT.ready}`))
      await expect(end).toBeVisible({ timeout: 120_000 })
      await expect(end).toHaveText(DATA_EXPORT.ready)
      await expectNoProtocolLeak(pageA)

      const downloadButton = dialog.getByRole('button', { name: DATA_EXPORT.download, exact: true })
      const [download] = await Promise.all([pageA.waitForEvent('download'), downloadButton.click()])
      expect(download.suggestedFilename()).toMatch(/^tayet-export-\d{4}-\d{2}-\d{2}\.zip$/)
      const zip = await readFile(await download.path())
      // readZip checks every entry's CRC (and its local header against the central directory).
      const { entries } = readZip(zip)
      const entry = (name: string) => {
        const found = entries.find((e) => e.name === name)
        if (!found) throw new Error(`no ${name} in the zip`)
        return found
      }
      console.log(`[e2e] export: ${zip.length} bytes, ${entries.length} entries`)
      expect(entry('README.txt').data.toString('utf8').split('\n')[0]).toBe(DATA_EXPORT.readmeFirstLine)
      const manifest = JSON.parse(entry('manifest.json').data.toString('utf8')) as {
        conversations: Array<{ file: string; name: string; kind: string }>
      }
      JSON.parse(entry('account.json').data.toString('utf8'))
      const conversation = (kind: string, name: string) => {
        const c = manifest.conversations.find((x) => x.kind === kind && x.name === name)
        expect(c, `${kind} ${name} in the manifest`).toBeTruthy()
        return entry(c!.file)
      }
      conversation('dm', XAN_NAME)
      conversation('public', channelName)
      const files = entries.filter((e) => e.name.startsWith('attachments/'))
      const has = (bytes: Buffer) => files.some((e) => e.data.equals(bytes))
      for (const f of [dmPdf, dmImage, chPdf, chImage]) expect(has(f.bytes), `${f.name} in the zip`).toBe(true)
      for (const f of [backPdf, backImage, exifDm, plainDm]) expect(has(f.bytes), `xan's ${f.name} not in the zip`).toBe(false)
      for (const e of entries.filter((x) => /\.(json|txt)$/.test(x.name)))
        expect(findProtocolLeaksInText(e.data.toString('utf8')), e.name).toEqual([])

      // H2: the second download, then "Fechar" at once (which revokes the URL): it still completes whole.
      const [second] = await Promise.all([pageA.waitForEvent('download'), downloadButton.click()])
      await dialog.locator('.ui-dialog__footer').getByRole('button', { name: DATA_EXPORT.close, exact: true }).click()
      expect(await second.failure()).toBeNull()
      expect((await readFile(await second.path())).length).toBe(zip.length)
      await expect(pageA.getByRole('dialog', { name: ACCOUNT.dialog })).toBeVisible()
      await expectNoProtocolLeak(pageA)
      await pageA.getByRole('dialog', { name: ACCOUNT.dialog }).getByRole('button', { name: ACCOUNT.close, exact: true }).click()
    })

    console.log(`[e2e] console A: ${JSON.stringify(consoleA.observed())}`)
    console.log(`[e2e] console B: ${JSON.stringify(consoleB.observed())}`)
    consoleA.expectClean()
    consoleB.expectClean()
  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})
