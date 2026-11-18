// A fake FormFacade for the Slack layer's tests (no SDK, no stack): it records what the layer opens and the results
// it writes, holds the layer's listener, and hands it a submission as the core would.
import type { FormFacade, FormListener, FormOpenRequest, FormOutcome, FormSubmitted } from '../../src/core/forms'
import type { FormField, FormValues } from '@tayet/shared'

export interface FakeForms extends FormFacade {
  opened: Array<FormOpenRequest & { id: string }>
  results: Array<{ conversation: string; submission: string; outcome: FormOutcome }>
  listener: FormListener | undefined
  // The next opens throw these, in order.
  failOpen: Error[]
  // A submission of the n-th form opened (the last by default), as the core hands it over.
  submit(values: FormValues, opts?: { by?: string; index?: number }): FormSubmitted
}

let n = 0

export function fakeForms(): FakeForms {
  const f: FakeForms = {
    opened: [],
    results: [],
    listener: undefined,
    failOpen: [],
    open(req) {
      const fail = f.failOpen.shift()
      if (fail !== undefined) return Promise.reject(fail)
      n += 1
      const id = `${1_732_100_000 + n}.000200`
      f.opened.push({ ...req, id })
      return Promise.resolve({ id })
    },
    result(conversation, submission, outcome) {
      f.results.push({ conversation, submission, outcome })
      return Promise.resolve()
    },
    listen(next) {
      f.listener = next
    },
    submit(values, opts = {}) {
      const o = f.opened.at(opts.index ?? -1)
      if (o === undefined || f.listener === undefined) throw new Error('nothing to submit')
      n += 1
      const form = o.form as { title: string; submitLabel: string; fields: FormField[] }
      const s: FormSubmitted = {
        conversation: o.conversation,
        form: { id: o.id, title: form.title, submitLabel: form.submitLabel, fields: form.fields, ...(typeof o.meta === 'string' && { meta: o.meta }) },
        submission: { id: `${1_732_200_000 + n}.000300`, by: opts.by ?? 'UALICEAAAAA', at: Date.now(), values },
        origin: { kind: o.origin.kind, anchor: o.origin.kind === 'card' ? o.origin.card : o.origin.message },
      }
      f.listener(s)
      return s
    },
  }
  return f
}
