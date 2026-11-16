// Barreira 1 (UI) do link: só http/https/mailto sobrevivem à criação. Espelha o predicado do
// sanitizeHref outbound do ACL (defense-in-depth; implementações independentes, sem cross-barrel).
export function isSafeHref(url: string): boolean {
  return /^(https?:|mailto:)/i.test(url.trim())
}
