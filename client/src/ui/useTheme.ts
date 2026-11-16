import { useState } from 'react'
import { type Theme, loadTheme, saveTheme, applyTheme } from './theme'

// Hook app-side (vive no App, ao lado do useChat). Estado inicial = o tema persistido (igual ao que
// o boot já aplicou — sem flicker). onThemeChange persiste + aplica. NÃO passa pelo useChat: tema é
// config de app, não domínio.
export function useTheme(): { theme: Theme; setTheme: (theme: Theme) => void } {
  const [theme, setThemeState] = useState<Theme>(loadTheme)
  const setTheme = (next: Theme) => {
    setThemeState(next)
    saveTheme(next)
    applyTheme(next)
  }
  return { theme, setTheme }
}
