// Emissor de mensagens cifradas para o gate do agente: client matrix-js-sdk REAL com
// crypto em MEMÓRIA (`useIndexedDB: false` — regime Node provado no spike-cobertura; o
// device vive só o processo do teste, que é o desejado para users frescos). Higiene do
// spike S2.3 (fato colateral, fase b): o js-sdk escolhe os alvos de cifra pelo estado
// LOCAL da sala — enviar antes do membership sincronizar perde o convidado (a chave
// nunca é emitida e o evento fica UISI para sempre). Por isso TODO envio deste harness
// passa por waitLocalMembership antes.

import * as sdk from 'matrix-js-sdk'
import type { MatrixClient } from 'matrix-js-sdk'
import { HOMESERVER, mintToken, whoami, until } from './stack.ts'

export interface Emissor {
  client: MatrixClient
  userId: string
  token: string
}

export async function startEmissor(username: string): Promise<Emissor> {
  const token = await mintToken(username)
  const { userId, deviceId } = await whoami(token)
  const client = sdk.createClient({
    baseUrl: HOMESERVER,
    userId,
    deviceId,
    accessToken: token,
  })
  await client.initRustCrypto({ useIndexedDB: false })
  const prepared = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sync PREPARED timeout')), 60_000)
    client.on(sdk.ClientEvent.Sync, (state) => {
      if (state === sdk.SyncState.Prepared) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  await client.startClient({ initialSyncLimit: 30 })
  await prepared
  return { client, userId, token }
}

// Espera o membership de `userId` aparecer no estado LOCAL do emissor com um dos
// valores dados (a pré-condição de cifra do S2.3).
export async function waitLocalMembership(
  emissor: Emissor,
  roomId: string,
  userId: string,
  memberships: string[],
): Promise<void> {
  await until(
    () => {
      const membership = emissor.client.getRoom(roomId)?.getMember(userId)?.membership
      return membership !== undefined && memberships.includes(membership) ? membership : null
    },
    `membership local de ${userId} em ${roomId} ∈ [${memberships.join(',')}]`,
    60_000,
    500,
  )
}

// Espera o próprio estado local mostrar a sala CIFRADA (o initial_state da criação já
// chegou) — sem isso o sendTextMessage sairia em claro.
export async function waitLocalEncrypted(emissor: Emissor, roomId: string): Promise<void> {
  await until(
    () => {
      const ev = emissor.client
        .getRoom(roomId)
        ?.getLiveTimeline()
        .getState(sdk.EventTimeline.FORWARDS)
        ?.getStateEvents('m.room.encryption', '')
      return ev ? true : null
    },
    `m.room.encryption no estado local de ${roomId}`,
    60_000,
    500,
  )
}

export async function sendEncrypted(
  emissor: Emissor,
  roomId: string,
  body: string,
): Promise<string> {
  const res = await emissor.client.sendTextMessage(roomId, body)
  return res.event_id
}

export async function discardSession(emissor: Emissor, roomId: string): Promise<void> {
  const crypto = emissor.client.getCrypto()
  if (crypto === undefined) throw new Error('emissor sem crypto')
  await crypto.forceDiscardSession(roomId)
}
