import type { Channel } from '@tayet/client'
import { APP_NAME } from './i18n'

// ADR-073 dec. 7: the tab title counts what notifies — unread DMs (every message notifies) and
// mentions in channels (only a mention notifies). Archived channels never count. A group conversation
// counts every unread, like a DM (ADR-094 dec. 10).
export function titleFor(channels: Channel[]): string {
  let n = 0
  for (const c of channels) {
    if (c.archived) continue
    n += c.kind === 'dm' || c.kind === 'group' ? c.unread.count : c.unread.mentions
  }
  return n > 0 ? `(${n}) ${APP_NAME}` : APP_NAME
}

export function applyTitle(channels: Channel[]): void {
  document.title = titleFor(channels)
}
