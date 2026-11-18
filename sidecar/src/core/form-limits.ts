// The limits of an agent's form, for the local API's layers: src/api/** never imports the shared translator
// (its lint), so a layer reads the shared constants through here — one source with the core (core/forms.ts).
export {
  FORM_CONTEXT_MAX,
  FORM_ERROR_MAX,
  FORM_FIELDS_MAX,
  FORM_FIELD_ID_MAX,
  FORM_GROUPS_MAX,
  FORM_GROUP_LABEL_MAX,
  FORM_HINT_MAX,
  FORM_LABEL_MAX,
  FORM_MAX_BYTES,
  FORM_META_MAX,
  FORM_OPTIONS_MAX,
  FORM_OPTION_DESCRIPTION_MAX,
  FORM_OPTION_LABEL_MAX,
  FORM_OPTION_VALUE_MAX,
  FORM_PLACEHOLDER_MAX,
  FORM_CHECKBOX_OPTIONS_MAX,
  FORM_RADIO_OPTIONS_MAX,
  FORM_SUBMIT_LABEL_MAX,
  FORM_TEXT_MAX,
  FORM_TITLE_MAX,
} from '@tayet/shared/internal'

import { FORM_BLOCK, FORM_MAX_BYTES, buildFormDefinitionContent, readFormDefinition } from '@tayet/shared/internal'
import type { FormField } from '@tayet/shared'

// A submission older than this when the core reads it (the server's instant against this clock) is ignored.
export const FORM_SUBMISSION_MAX_AGE_MS = 60_000

// Whether a form in the product's schema would be written: 'too_large' when its block passes the size limit,
// 'invalid' when it breaks any other rule (the shared reader, the core's own check before the write).
const PLACEHOLDER_ID = `$${'x'.repeat(43)}`
const encoder = new TextEncoder()
export function formDefinitionCheck(form: { title: string; submitLabel: string; fields: readonly FormField[] }, meta?: string): 'ok' | 'too_large' | 'invalid' {
  let content: ReturnType<typeof buildFormDefinitionContent>
  try {
    content = buildFormDefinitionContent(PLACEHOLDER_ID, PLACEHOLDER_ID, form.title, form.submitLabel, form.fields, meta)
  } catch {
    return 'invalid'
  }
  if (encoder.encode(JSON.stringify(content[FORM_BLOCK])).length > FORM_MAX_BYTES) return 'too_large'
  return readFormDefinition(content) !== undefined ? 'ok' : 'invalid'
}
