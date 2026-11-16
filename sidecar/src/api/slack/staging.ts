// The staging of the upload v2 flow (PLANO-AGENTES §0.3.12 item 6): `<store>/uploads/<ticket>`.
// - `issue` (files.getUploadURLExternal): a single-use ticket (the upload_url's last segment, 256 random
//   bits) and a provisional `F…` (random; never a file token of the core) for one declared file.
// - `receive` (POST /slack/upload/<ticket>): the ticket is spent on its first use, whatever the outcome;
//   the body is bounded by the declared length (and the upload limit) plus the multipart framing, parsed
//   (slack/multipart.ts, one file field) and written 0600 under a 0700 directory.
// - `take` (files.completeUploadExternal): the uploaded entries of the given provisional ids, or
//   `file_not_found` for any that is unknown, not uploaded or expired; `drop` deletes them.
// - TTL: 10 minutes from the ticket. The expiry sweep runs at boot (everything there is from an earlier
//   run: no ticket survives a restart, so the boot sweep empties the directory) and on every write;
//   `clear` empties it on a clean shutdown.
// File contents and names never reach a log line.
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SlackError } from './errors'
import { parseFilePart } from './multipart'

export const UPLOAD_TTL_MS = 10 * 60 * 1000
// What the multipart framing may add to the declared length (delimiters, part headers, a filename).
export const MULTIPART_OVERHEAD = 16 * 1024
export const TICKET = /^[A-Za-z0-9_-]{43}$/

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const provisionalId = (): string => `F${[...randomBytes(10)].map((b) => B32[b % 32]).join('')}`

export interface StagedFile {
  id: string
  filename: string
  length: number
  expires: number
  path: string
  // Set once the bytes are in.
  size?: number
  partType?: string
}

interface Entry extends StagedFile {
  ticket: string
  spent: boolean
}

export class UploadStaging {
  private readonly byTicket = new Map<string, Entry>()
  private readonly byId = new Map<string, Entry>()
  private readonly ready: Promise<void>

  constructor(
    private readonly dir: string,
    private readonly now: () => number,
    private readonly log: (line: Record<string, unknown>) => void,
  ) {
    this.ready = this.empty('boot')
  }

  issue(filename: string, length: number): { ticket: string; id: string } {
    this.sweep()
    const ticket = randomBytes(32).toString('base64url')
    let id = provisionalId()
    while (this.byId.has(id)) id = provisionalId()
    const entry: Entry = { id, ticket, filename, length, expires: this.now() + UPLOAD_TTL_MS, path: join(this.dir, ticket), spent: false }
    this.byTicket.set(ticket, entry)
    this.byId.set(id, entry)
    return { ticket, id }
  }

  // The entry a ticket opens (spending it), or `file_not_found`.
  open(ticket: string): StagedFile {
    const entry = TICKET.test(ticket) ? this.byTicket.get(ticket) : undefined
    if (entry === undefined || entry.spent || entry.expires <= this.now()) throw new SlackError('file_not_found')
    entry.spent = true
    return entry
  }

  // The bytes of an opened entry: parsed, bounded, written.
  async store(file: StagedFile, body: Buffer, boundary: string, limit: number): Promise<number> {
    const entry = this.byId.get(file.id)
    if (entry === undefined || entry.expires <= this.now()) throw new SlackError('file_not_found')
    const part = parseFilePart(body, boundary)
    if (part.data.length > entry.length || part.data.length > limit) throw new SlackError('file_too_large')
    await this.ready
    this.sweep()
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await writeFile(entry.path, part.data, { mode: 0o600 })
    entry.size = part.data.length
    if (part.type !== undefined) entry.partType = part.type
    return part.data.length
  }

  take(ids: readonly string[]): StagedFile[] {
    const now = this.now()
    return ids.map((id) => {
      const entry = this.byId.get(id)
      if (entry === undefined || entry.size === undefined || entry.expires <= now) throw new SlackError('file_not_found')
      return entry
    })
  }

  async drop(ids: readonly string[]): Promise<void> {
    await Promise.all(ids.map((id) => this.remove(this.byId.get(id))))
  }

  // Expired entries: forgotten, their files deleted (in the background; a failure is logged).
  sweep(): void {
    const now = this.now()
    for (const entry of [...this.byId.values()]) {
      if (entry.expires <= now) void this.remove(entry)
    }
  }

  // Clean shutdown: nothing staged survives.
  async clear(): Promise<void> {
    await this.ready
    this.byId.clear()
    this.byTicket.clear()
    await this.empty('shutdown')
  }

  private async remove(entry: Entry | undefined): Promise<void> {
    if (entry === undefined) return
    this.byId.delete(entry.id)
    this.byTicket.delete(entry.ticket)
    try {
      await rm(entry.path, { force: true })
    } catch (err) {
      this.log({ evt: 'upload-staging-error', op: 'remove', code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
    }
  }

  private async empty(when: 'boot' | 'shutdown'): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      this.log({ evt: 'upload-staging-error', op: when, code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
      return
    }
    const live = new Set([...this.byTicket.keys()])
    const stale = names.filter((n) => !live.has(n))
    await Promise.all(stale.map((n) => rm(join(this.dir, n), { force: true, recursive: true }).catch(() => undefined)))
    if (stale.length > 0) this.log({ evt: 'upload-staging-swept', when, files: stale.length })
  }
}
