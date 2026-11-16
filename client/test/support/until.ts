// Idioma de espera consolidado (PLANO-GATES §8.1, PR-B2): o MESMO laço poll-até-definido
// das três cópias locais que divergiram — sem retry, sem backoff, sem jitter — mas que fala
// ao morrer. O label é obrigatório e o estouro carrega elapsed real, tentativas e (se
// fornecido) um snapshot do estado parcial: é o que converte estouro mudo em evidência
// (discriminador do M1, issue #151; família settle, §8.2). Defaults = os dominantes entre
// as cópias (150s / 120ms); call sites que divergem passam seus valores explícitos.
export async function until<T>(
  label: string,
  get: () => T | undefined | Promise<T | undefined>,
  opts?: { timeoutMs?: number; pollMs?: number; snapshot?: () => string | Promise<string> },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? 150_000
  const pollMs = opts?.pollMs ?? 120
  const start = Date.now()
  let attempts = 0
  for (;;) {
    attempts++
    const v = await get()
    if (v !== undefined) return v
    const elapsed = Date.now() - start
    if (elapsed > timeoutMs) {
      let detail = ''
      if (opts?.snapshot) {
        // Falha do snapshot jamais mascara o timeout — vira nota na própria mensagem.
        try {
          detail = ` snapshot: ${await opts.snapshot()}`
        } catch (err) {
          detail = ` snapshot failed: ${String(err)}`
        }
      }
      throw new Error(`until(${label}): timed out after ${elapsed}ms (${attempts} attempts)${detail}`)
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}
