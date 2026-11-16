import { useCallback, useEffect, useRef, useState } from 'react'
import type { Channel, DataExportOptions, DataExportPart } from '@tayet/client'
import { createZipWriter } from './zip'
import { EXPORT_FILE, getLocale, t } from './i18n'

// The data export's screen state (ADR-096 dec. 6; PLANO-EXPORT-DADOS §0.3.6 items 8 to 12). The hook lives
// inside the dialog: unmounting it aborts a preparation in flight and revokes the file's URL. It consumes
// the verb with `for await`, which is what lets the search backfill go again when the export ends
// (exportMyData holds it the whole time), and which always closes the iterator: an early exit (a cancel,
// a failed zip entry) calls its return(). Cancelling goes back to `idle` at once; the run's parts and its
// rejection are then ignored. Every other rejection, from the verb or from the zip writer, is `failed`.

export type DataExportVerb = (opts: DataExportOptions) => AsyncIterable<DataExportPart>

export type DataExportState =
  | { kind: 'idle' }
  | { kind: 'failed' }
  | { kind: 'preparing'; done: number; total: number }
  | { kind: 'ready'; conversations: number; bytes: number; incomplete: Array<{ channel: Channel; gaps: number }> }

const pad = (n: number): string => String(n).padStart(2, '0')

/** `tayet-export-AAAA-MM-DD.zip`, with the local date (§0.3.6 item 5). */
export function exportFileName(now: Date): string {
  return `${EXPORT_FILE.prefix}${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}${EXPORT_FILE.extension}`
}

const UNITS = [
  ['byte', 1],
  ['kilobyte', 1e3],
  ['megabyte', 1e6],
  ['gigabyte', 1e9],
] as const

/**
 * `value` rounded to `digits` decimal places by Intl.NumberFormat itself, the same rounding the display
 * uses: the locale changes only the separators, never the rounding, so deciding with this number and
 * formatting `value` with the same digits cannot disagree.
 */
function rounded(value: number, digits: number): number {
  return Number(
    new Intl.NumberFormat('en-US', {
      useGrouping: false,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value),
  )
}

/**
 * The file's size in decimal units (§0.3.6 item 6 and its erratum). The
 * starting unit is the largest in which the raw value is 1 or more. Outside byte, one decimal place
 * when the value rounded to one place is under 10, otherwise a whole number. When the rounded value
 * reaches 1000 and a larger unit exists, the next unit is taken and the rule applies again: 999 600
 * bytes is "1,0 MB", never "1000 kB". Every decision reads the value as Intl.NumberFormat rounds it
 * (`rounded`), so the decision and the text shown always agree.
 */
export function formatSize(bytes: number, locale: string): string {
  let start = 0
  UNITS.forEach(([, factor], i) => {
    if (bytes >= factor) start = i
  })
  const candidates = UNITS.slice(start)
  for (const [i, [unit, factor]] of candidates.entries()) {
    const value = bytes / factor
    const digits = unit !== 'byte' && rounded(value, 1) < 10 ? 1 : 0
    if (rounded(value, digits) >= 1000 && i < candidates.length - 1) continue
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit,
      unitDisplay: 'short',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value)
  }
  throw new Error('unreachable: the last candidate unit always formats')
}

export function useDataExport(verb: DataExportVerb): {
  state: DataExportState
  prepare: () => void
  cancel: () => void
  download: () => void
} {
  const [state, setState] = useState<DataExportState>({ kind: 'idle' })
  const run = useRef<AbortController | null>(null)
  const file = useRef<{ url: string; name: string } | null>(null)

  // Aborts the run in flight (its parts and its rejection are ignored from here on) and lets the file go.
  const release = useCallback(() => {
    run.current?.abort()
    run.current = null
    if (file.current) URL.revokeObjectURL(file.current.url)
    file.current = null
  }, [])

  useEffect(() => release, [release])

  const prepare = useCallback(() => {
    release()
    const controller = new AbortController()
    run.current = controller
    const live = (): boolean => run.current === controller
    setState({ kind: 'preparing', done: 0, total: 0 })
    void (async () => {
      const zip = createZipWriter()
      try {
        const parts = verb({
          readme: t('dataExport.readme'),
          unnamedAccess: t('account.accessUnknown'),
          signal: controller.signal,
        })
        for await (const part of parts) {
          if (!live()) return
          if (part.t === 'file') await zip.add(part.path, part.content)
          else if (part.t === 'attachment') await zip.add(part.path, part.data)
          else if (part.t === 'progress') setState({ kind: 'preparing', done: part.done, total: part.total })
          else {
            const blob = zip.finish()
            run.current = null
            file.current = { url: URL.createObjectURL(blob), name: exportFileName(new Date()) }
            setState({
              kind: 'ready',
              conversations: part.totals.conversations,
              bytes: blob.size,
              incomplete: part.incomplete,
            })
            return
          }
          if (!live()) return
        }
        throw new Error('data export: the parts ended without the last one')
      } catch {
        if (!live()) return
        run.current = null
        setState({ kind: 'failed' })
      }
    })()
  }, [verb, release])

  const cancel = useCallback(() => {
    release()
    setState({ kind: 'idle' })
  }, [release])

  // A temporary <a download> per click, as many times as the person wants (§0.3.6 item 12).
  const download = useCallback(() => {
    const ready = file.current
    if (!ready) return
    const link = document.createElement('a')
    link.href = ready.url
    link.download = ready.name
    link.hidden = true
    document.body.appendChild(link)
    link.click()
    link.remove()
  }, [])

  return { state, prepare, cancel, download }
}

/** The locale's size of the export file, for the summary under the title. */
export const fileSize = (bytes: number): string => formatSize(bytes, getLocale())
