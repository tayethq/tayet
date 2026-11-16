import { useState } from 'react'
import { dismissNotifications, loadNotificationsPref } from './notifications-pref'

// Hook app-side (lives in App, next to useTheme): the notifications prompt of ADR-073 dec. 6. Shown
// only while the browser has not been asked (`default`) and the user has not dismissed it; `denied`
// shows nothing. The permission is asked ONLY from the click (a user gesture), never at boot.
const permission = (): NotificationPermission | undefined =>
  typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : undefined

const shouldPrompt = (): boolean => permission() === 'default' && loadNotificationsPref() !== 'dismissed'

export function useNotificationsPrompt(): { prompt: boolean; enable: () => void; dismiss: () => void } {
  const [prompt, setPrompt] = useState(shouldPrompt)
  const enable = () => {
    void Notification.requestPermission()
      .catch(() => undefined)
      .then(() => setPrompt(shouldPrompt()))
  }
  const dismiss = () => {
    dismissNotifications()
    setPrompt(false)
  }
  return { prompt, enable, dismiss }
}
