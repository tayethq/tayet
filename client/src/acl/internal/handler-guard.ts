import type { AclMode } from '../types'

// PLANO-RELEASE-PUBLICA §8.24, hipótese (4): nenhum handler da ACL pode lançar para dentro do SDK.
// Os eventos de sync (Timeline, AccountData, presença, membros…) são emitidos de dentro do
// processSyncResponse, e um `emit` síncrono propaga a exceção do listener. O loop de sync já avançou o
// token ANTES de processar o lote (matrix-js-sdk 41.6.0, lib/sync.js:756,
// `_this7.client.store.setSyncToken(data.next_batch);`) e trata `device_lists` por ÚLTIMO
// (lib/sync.js:1394, `if (data.device_lists) {`): uma exceção nossa no meio do lote vira
// "Caught /sync error" e a mudança de lista de devices daquele lote se perde para sempre.
//
// O guard captura, registra um sinal neutro (só o nome do site — nunca o erro, que pode carregar
// conteúdo ou ids de protocolo) e segue. Em 'strict' (dev/test/CI) re-lança num microtask: o teste
// ainda vê a exceção (erro não tratado), sem interromper o lote do SDK.
export function guarded<A extends unknown[]>(
  site: string,
  mode: AclMode,
  fn: (...args: A) => void,
): (...args: A) => void {
  return (...args: A): void => {
    try {
      fn(...args)
    } catch (e) {
      console.warn(`[acl] handler failed: ${site}`)
      if (mode === 'strict') {
        queueMicrotask(() => {
          throw e
        })
      }
    }
  }
}
