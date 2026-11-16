// The upload v2 flow (ADR-087 dec. 6; PLANO-AGENTES §0.3.12 item 6) — what @slack/web-api's
// filesUploadV2 does, against the local listener:
//   1. files.getUploadURLExternal { filename, length } → { upload_url, file_id }: the upload_url is
//      absolute, `<listener>/slack/upload/<ticket>` (single-use), the file_id a provisional `F…` of the
//      staging (slack/staging.ts). A length over the upload limit → `file_too_large`.
//   2. POST <upload_url> with the bytes (router.ts, the upload route; one multipart file field).
//   3. files.completeUploadExternal { files: [{ id, title? }], channel_id, thread_ts?, initial_comment? }:
//      `initial_comment` (mrkdwn → rich) goes out as a text message BEFORE the files; each file then goes
//      out through the core's upload(), in the thread when `thread_ts` names one. The answer's files
//      carry the core's definitive `F…` (its file token), not the provisional one.
// files.upload (v1) → `method_deprecated`.
//
// files.info (S-f3) { file: F… } → { file }: the core's download() reads the file map (FileRef) and gives
// its name, type and bytes — `size` is the bytes' length (the FileRef carries no size; declared, §8.22).
// `url_private` / `url_private_download` = `<listener>/slack/files/<F…>` (router.ts). No `created`,
// `user`, `channels`, `original_w/h`: the FileRef carries none of them (declared). Unknown → file_not_found.
//
// Failure semantics of step 3 (declared, §8.19): every id is checked first (unknown, not uploaded or
// expired → `file_not_found`, nothing sent). Then the sends run in order and stop at the first failure,
// whose code is the answer; what already went out stays (a message cannot be taken back without a trace),
// and the log says how many of how many went out. A completion CONSUMES its files: the staging of every
// id it names is deleted when it ends, success or failure — a retry starts over from step 1.
// The product carries no file title: `title` (default: the filename) only comes back in the answer.
import { readFile } from 'node:fs/promises'
import { ReadError } from '../../core/read'
import { NAME_MAX } from '../../core/write'
import type { ApiMessage } from '../contract'
import { resolverOf } from './chat'
import { mrkdwnToRich } from './mrkdwn'
import { slackFile } from './translate'
import { deprecatedMethod, int, nested, required, SLACK_TEXT_MAX, SlackError, str, type SlackCtx, type SlackMethods } from './router'
import type { StagedFile, UploadStaging } from './staging'

const MIMETYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
}
const TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/

// The filename's extension decides; else the multipart part's own type when it says something; else bytes.
export function mimetypeOf(filename: string, partType: string | undefined): string {
  const dot = filename.lastIndexOf('.')
  const byName = dot > 0 ? MIMETYPES[filename.slice(dot + 1).toLowerCase()] : undefined
  if (byName !== undefined) return byName
  const part = partType?.split(';')[0]?.trim().toLowerCase()
  return part !== undefined && TYPE.test(part) && part !== 'application/octet-stream' ? part : 'application/octet-stream'
}

const validName = (name: string): boolean => name.length <= NAME_MAX && !name.includes('/') && name.trim() !== ''

function stagingOf(ctx: SlackCtx): UploadStaging {
  if (ctx.staging === null) throw new SlackError('service_unavailable')
  return ctx.staging
}

interface Wanted {
  id: string
  title: string | undefined
}

function wantedOf(raw: unknown): Wanted[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new SlackError('invalid_arguments')
  const out = raw.map((f): Wanted => {
    if (f === null || typeof f !== 'object') throw new SlackError('invalid_arguments')
    const { id, title } = f as Record<string, unknown>
    if (typeof id !== 'string' || (title !== undefined && title !== null && typeof title !== 'string')) throw new SlackError('invalid_arguments')
    return { id, title: typeof title === 'string' && title !== '' ? title : undefined }
  })
  if (new Set(out.map((f) => f.id)).size !== out.length) throw new SlackError('invalid_arguments')
  return out
}

const threadNotFound = (err: unknown): unknown => (err instanceof ReadError && err.code === 'message_not_found' ? new SlackError('thread_not_found') : err)

export const FILE_METHODS: SlackMethods = {
  'files.getUploadURLExternal': async (args, ctx) => {
    const staging = stagingOf(ctx)
    const filename = required(args, 'filename')
    const length = int(args, 'length')
    if (length === undefined || length === 0) throw new SlackError('invalid_arguments')
    if (!validName(filename)) throw new SlackError('invalid_arguments')
    if (length > (await ctx.write.uploadLimit())) throw new SlackError('file_too_large')
    const base = ctx.baseUrl()
    if (base === null) throw new SlackError('service_unavailable')
    const { ticket, id } = staging.issue(filename, length)
    return { upload_url: `${base}/slack/upload/${ticket}`, file_id: id }
  },

  'files.completeUploadExternal': async (args, ctx) => {
    const staging = stagingOf(ctx)
    const wanted = wantedOf(nested(args, 'files'))
    const ids = wanted.map((f) => f.id)
    try {
      const channel = required(args, 'channel_id', 'channel_not_found')
      const thread = str(args, 'thread_ts')
      const comment = str(args, 'initial_comment')
      const staged = staging.take(ids)
      const files = staged.map((s, i) => ({ staged: s, title: (wanted[i] as Wanted).title ?? s.filename, mimetype: mimetypeOf(s.filename, s.partType) }))
      // Before any effect: what the edge would withhold from an answer is refused here (server.ts preflight).
      let content: ReturnType<typeof mrkdwnToRich> | null = null
      if (comment !== undefined && comment.trim() !== '') {
        content = mrkdwnToRich(comment, resolverOf(ctx))
        if (Buffer.byteLength(content.text, 'utf8') > SLACK_TEXT_MAX) throw new SlackError('msg_too_long')
        ctx.preflight('files.completeUploadExternal', channel, content.text)
      }
      for (const f of files) ctx.preflight('files.completeUploadExternal', channel, f.title, f.staged.filename)
      ctx.read.conversation(channel)

      let sent = 0
      const total = files.length + (content !== null ? 1 : 0)
      const out: Array<{ id: string; name: string; title: string; mimetype: string; size: number }> = []
      try {
        if (content !== null) {
          await ctx.write.post(channel, {
            text: content.text,
            ...(content.rich !== undefined && { rich: content.rich }),
            ...(content.mentions.length > 0 && { mentions: content.mentions }),
            ...(thread !== undefined && { thread }),
          })
          sent++
        }
        for (const f of files) {
          const m: ApiMessage = await ctx.write.upload(channel, {
            name: f.staged.filename,
            mimetype: f.mimetype,
            body: () => readStaged(f.staged),
            ...(thread !== undefined && { thread }),
          })
          sent++
          const file = ctx.native(m, 'files.completeUploadExternal').files?.[0]
          if (file === undefined) throw new SlackError('internal_error')
          out.push({ id: file.id, name: file.name, title: f.title, mimetype: file.mimetype, size: file.size })
        }
      } catch (err) {
        if (sent > 0) ctx.log({ evt: 'slack-upload-partial', sent, total })
        throw threadNotFound(err)
      }
      return { files: out }
    } finally {
      await staging.drop(ids)
    }
  },

  'files.info': async (args, ctx) => {
    const id = required(args, 'file', 'file_not_found')
    const base = ctx.baseUrl()
    if (base === null) throw new SlackError('service_unavailable')
    const d = await ctx.write.download(id)
    return { file: slackFile({ id, name: d.name, mimetype: d.mimetype, size: d.bytes.byteLength }, base), comments: [], response_metadata: { next_cursor: '' } }
  },

  'files.upload': deprecatedMethod(),
}

async function readStaged(f: StagedFile): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(f.path))
  } catch {
    throw new SlackError('file_not_found')
  }
}
