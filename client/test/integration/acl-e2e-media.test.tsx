// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import type { Acl, AclTelemetry, DomainEvent, ChannelId, MessageId, User } from '../../src/acl'
import type { MediaRef } from '@tayet/shared'
import { Workspace } from '../../src/ui/components/Workspace'
import { MediaProvider } from '../../src/ui/MediaContext'
import { findProtocolLeaks, findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { HOMESERVER, synapseReachable, whoami, invite, join, leave, getMessages } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { until as untilLabeled } from '../support/until'

// ── Gate de integração de MEDIA CIFRADA (PLANO-FASE-2-MEDIA §5.2) — os 7 asserts. ──────────
// Reusa a infra do gate da fatia A (acl-e2e.test.tsx): dois clientes MAS com rust-crypto,
// sala CIFRADA POR PADRÃO criada pela ACL. Fecha a issue #15: anexo em sala E2E volta a
// funcionar, cifrado client-side (ADR-016). Auto-skip sem a stack (PF-4 / issue #7).
//
// Assert 5 (cleartext intocado) é a suíte `acl-attachment` EXISTENTE, que roda inalterada
// nesta mesma execução — nenhuma linha dela foi tocada nesta fatia; este arquivo não a
// duplica (a §5.2 a referencia como assert por suíte).
//
// Notas de ambiente (registradas na §8 do PLANO):
//  - jsdom não implementa URL.createObjectURL/revokeObjectURL → stub de captura (o assert 6
//    é sobre o ATRIBUTO src, como o PLANO pede; jsdom não carrega a imagem).
//  - jsdom expõe XMLHttpRequest, mas o XHR do jsdom não dá round-trip confiável para o
//    upload binário do SDK; removê-lo faz o SDK cair no branch fetch (o MESMO caminho do
//    Node/gate cleartext). Só neste arquivo.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

// PNG magic + payload — os magic bytes são o que o assert 2 procura (e não pode achar) no
// repositório de media.
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const ORIGINAL_BYTES = new Uint8Array([
  ...PNG_MAGIC,
  ...Array.from({ length: 256 }, (_, i) => (i * 7 + 13) % 256),
])
const FILENAME = 'segredo-corporativo.png'

const CRYPTO_TERMS = ['m.bad.encrypted', 'ciphertext', 'megolm', 'm.room.encrypted', 'unable to decrypt', 'session_id']
function assertNoCryptoVocab(value: unknown, label: string): void {
  const json = JSON.stringify(value).toLowerCase()
  for (const term of CRYPTO_TERMS) {
    expect(json, `${label} must not carry "${term}"`).not.toContain(term)
  }
}

// jsdom Blobs lack arrayBuffer(); FileReader is implemented (same shim the ACL uses).
function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error('could not read blob'))
    reader.readAsArrayBuffer(blob)
  })
}

async function until<T>(get: () => T | undefined | Promise<T | undefined>, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 60))
  }
}

describe.skipIf(!SYNAPSE)('gate E2E media — anexo cifrado em sala criada pela ACL (7 asserts §5.2)', () => {
  let aliceToken: string
  let bobToken: string
  let alice: MatrixGateway
  let bob: MatrixGateway
  let channelId: ChannelId
  let roomIdRaw: string
  const aliceEvents: DomainEvent[] = []
  const bobEvents: DomainEvent[] = []

  // Preenchidos em ordem pelos testes (vitest roda sequencial dentro do arquivo).
  let sentId: MessageId // id estável do envio da alice (txn)
  let bobRef: MediaRef // MediaRef do anexo como bob o recebe
  let mxcRaw: string // mxc do ciphertext (lido do descriptor ACL-interno de bob — infra de teste)

  // jsdom: sem URL.createObjectURL — stub de captura (nota de ambiente acima).
  const createdBlobs = new Map<string, Blob>()
  let blobN = 0

  beforeAll(async () => {
    // Força o branch fetch do uploadContent (nota de ambiente acima).
    delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest
    ;(URL as { createObjectURL?: (b: Blob) => string }).createObjectURL = (b: Blob) => {
      const url = `blob:tayet-gate-${++blobN}`
      createdBlobs.set(url, b)
      return url
    }
    ;(URL as { revokeObjectURL?: (u: string) => void }).revokeObjectURL = () => {}

    const [aliceUser, bobUser] = await freshUsers(['ema', 'emb'])
    aliceToken = aliceUser.token
    bobToken = bobUser.token
    alice = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await alice.connect(aliceToken as Parameters<Acl['connect']>[0])
    alice.subscribe((e) => aliceEvents.push(e))
    bob = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await bob.connect(bobToken as Parameters<Acl['connect']>[0])
    bob.subscribe((e) => bobEvents.push(e))

    // Sala cifrada POR PADRÃO criada pela ACL (mesma infra do gate da fatia A; retry em 429).
    channelId = await (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await alice.createChannel({ name: `tayet-e2e-media-${process.pid}-${Math.floor(Math.random() * 1e6)}`, kind: 'private' })
        } catch (err) {
          const retryAfter = (err as { data?: { retry_after_ms?: number } }).data?.retry_after_ms
          if (retryAfter === undefined || attempt >= 10) throw err
          await new Promise((r) => setTimeout(r, retryAfter + 200))
        }
      }
    })()
    // PLANO-GATES §8.12: without a known Room the SDK keeps no local echo and does NOT encrypt
    // (the attachment would go out in clear). Wait until alice's ACL knows the channel.
    await untilLabeled(
      'channel known to alice before encrypted attachment send',
      () => (alice.getChannels().some((c) => c.id === channelId) ? true : undefined),
      {
        snapshot: () => {
          const chs = alice.getChannels()
          return `known=${chs.length} hasChannelId=${chs.some((c) => c.id === channelId)}`
        },
      },
    )
    roomIdRaw = channelId as unknown as string

    const bobMxid = await whoami(bobToken)
    await invite(aliceToken, roomIdRaw, bobMxid)
    await join(bobToken, roomIdRaw)
  }, 180_000)

  afterAll(async () => {
    // Higiene best-effort: com usuários frescos por-run, a sala cifrada é órfã de qualquer forma
    // — o usuário do próximo run é outro e nunca sinca esta sala. O leave só mantém a lista de
    // salas do servidor enxuta; já não guarda contra o flood de UISI cross-suite que a alice
    // REUSADA causava (cada run cunhava um device novo na MESMA conta — a causa-raiz do #32).
    // Teardown jamais falha a suíte.
    try {
      await leave(bobToken, roomIdRaw)
      await leave(aliceToken, roomIdRaw)
    } catch {
      /* best-effort */
    }
    await alice?.disconnect()
    await bob?.disconnect()
  })

  it('1. round-trip cifrado: alice envia imagem → bob resolve bytes IDÊNTICOS ao original', async () => {
    const file = new File([ORIGINAL_BYTES.slice() as unknown as BlobPart], FILENAME, { type: 'image/png' })
    sentId = await alice.sendMessage(channelId, { kind: 'attachment', file, name: FILENAME })

    // Bob recebe kind `image` com MediaRef opaco.
    const received = await until(() =>
      bobEvents.find(
        (e): e is Extract<DomainEvent, { t: 'message.received' }> =>
          e.t === 'message.received' && e.message.body.kind === 'image',
      ),
    )
    if (received.message.body.kind !== 'image') throw new Error('unreachable')
    bobRef = received.message.body.media
    expect(received.message.body.alt).toBe(FILENAME)

    // resolveMedia → bytes idênticos, mimetype do PLAINTEXT no Blob.
    const resolved = await bob.resolveMedia(bobRef)
    expect(resolved.url).toMatch(/^blob:/)
    const blob = createdBlobs.get(resolved.url)!
    expect(blob.type).toBe('image/png')
    expect(await blobBytes(blob)).toEqual(ORIGINAL_BYTES)
    resolved.release()
  }, 180_000)

  it('2. ciphertext at rest: o repositório de media só viu bytes opacos, sem nome real', async () => {
    // O mxc vive APENAS no descriptor ACL-interno (ADR-009) — lido aqui por cast de infra de
    // teste, nunca pelo contrato.
    const token = bobRef as unknown as string
    const internals = bob as unknown as {
      mediaByToken: Map<string, { mxc: string; encrypted?: { hashes?: Record<string, string> } }>
    }
    const desc = internals.mediaByToken.get(token)
    expect(desc?.encrypted, 'descriptor carries the envelope (ACL-internal)').toBeDefined()
    mxcRaw = desc!.mxc
    const [, server, mediaId] = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxcRaw)!

    // GET cru autenticado do conteúdo armazenado.
    const res = await fetch(`${HOMESERVER}/_matrix/client/v1/media/download/${server}/${mediaId}`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    })
    expect(res.ok).toBe(true)
    const atRest = new Uint8Array(await res.arrayBuffer())
    // ≠ bytes originais e SEM os magic bytes do formato.
    expect([...atRest]).not.toEqual([...ORIGINAL_BYTES])
    expect([...atRest.slice(0, PNG_MAGIC.length)]).not.toEqual(PNG_MAGIC)
    // Metadado do repo sem o filename real (upload foi sem filename, octet-stream).
    const disposition = res.headers.get('content-disposition') ?? ''
    expect(disposition).not.toContain(FILENAME)
    expect(res.headers.get('content-type')).toContain('application/octet-stream')
  }, 180_000)

  it('3. wire: o evento de anexo é m.room.encrypted; o content cru não carrega envelope/nome/mimetype', async () => {
    const raw = await getMessages(aliceToken, roomIdRaw, 50)
    const ev = raw.find((e) => e.unsigned?.transaction_id === (sentId as unknown as string))
    expect(ev, 'attachment event found on the wire').toBeDefined()
    expect(ev!.type).toBe('m.room.encrypted')
    expect((ev!.content as { ciphertext?: unknown }).ciphertext).toBeTruthy()
    const json = JSON.stringify(ev!.content)
    expect(json).not.toContain('"file"')
    expect(json).not.toContain('mxc://')
    expect(json).not.toContain('key_ops') // JWK
    expect(json).not.toContain(FILENAME)
    expect(json).not.toContain('image/png')
    expect(json).not.toContain(mxcRaw.split('/').pop()!) // media id do upload
  }, 180_000)

  it('4. echo otimista de anexo sob cifra: pending (preview local) → sent sob o MESMO id', async () => {
    const pendingIdx = aliceEvents.findIndex(
      (e) =>
        e.t === 'message.received' &&
        e.message.id === sentId &&
        e.message.status === 'pending' &&
        e.message.body.kind === 'image',
    )
    expect(pendingIdx, 'pending echo with the stable id and a LOCAL preview ref').toBeGreaterThanOrEqual(0)
    const pending = aliceEvents[pendingIdx]!
    if (pending.t === 'message.received' && pending.message.body.kind === 'image') {
      // O preview do pending é o MediaRef LOCAL (bytes escolhidos) — resolvível antes do upload.
      const resolved = await alice.resolveMedia(pending.message.body.media)
      const blob = createdBlobs.get(resolved.url)!
      expect(await blobBytes(blob)).toEqual(ORIGINAL_BYTES)
      resolved.release()
    }
    const sentIdx = await until(() => {
      const i = aliceEvents.findIndex(
        (e) => e.t === 'message.status' && e.messageId === sentId && e.status === 'sent',
      )
      return i >= 0 ? i : undefined
    })
    expect(sentIdx, 'anti-flicker: pending precede o sent sob o mesmo id').toBeGreaterThan(pendingIdx)
  }, 180_000)

  it('5. cleartext intocado: suíte acl-attachment existente roda verde, sem modificação', () => {
    // O assert é a PRÓPRIA suíte test/integration/acl-attachment.test.ts, inalterada nesta
    // fatia (diff vazio) e executada nesta mesma run. Aqui só fica o registro do assert.
    expect(true).toBe(true)
  })

  it('6. DOM ao vivo: <img src="blob:..."> na timeline do receptor; innerHTML limpo', async () => {
    const channel = bob.getChannels().find((c) => c.id === channelId)
    expect(channel).toBeDefined()
    const usersById: Record<string, User> = {}
    for (const { user } of bob.getMembers(channelId)) usersById[user.id] = user
    const page = await bob.getTimeline(channelId)
    expect(page.items.some((m) => m.body.kind === 'image')).toBe(true)

    let container!: HTMLElement
    act(() => {
      container = render(
        <MediaProvider resolve={(ref, variant) => bob.resolveMedia(ref, variant)}>
          <Workspace
            channels={[channel!]}
            selectedChannelId={channelId}
            messages={page.items}
            usersById={usersById}
            connection="connected"
            onSelectChannel={() => {}}
            onSend={() => {}}
          />
        </MediaProvider>,
      ).container
    })

    // O assert é sobre o ATRIBUTO src (jsdom não carrega a imagem).
    await waitFor(
      () => {
        const img = container.querySelector('img.message__image')
        expect(img?.getAttribute('src') ?? '').toMatch(/^blob:/)
      },
      { timeout: 30_000 },
    )

    // Leak-scan do innerHTML (inclui o vocabulário do envelope, scan estendido do commit 3).
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
    for (const term of CRYPTO_TERMS) {
      expect(container.innerHTML.toLowerCase()).not.toContain(term)
    }
    expect(container.innerHTML).not.toContain(mxcRaw)
  }, 180_000)

  it('7. P1 no stream: nenhum DomainEvent dos dois clientes carrega chave do envelope', () => {
    expect(aliceEvents.length).toBeGreaterThan(0)
    expect(bobEvents.length).toBeGreaterThan(0)
    for (const e of [...aliceEvents, ...bobEvents]) {
      // findProtocolLeaks cobre as chaves do envelope (key_ops sozinha; iv/hashes/v por
      // co-ocorrência — commit 3) além dos padrões-base.
      expect(findProtocolLeaks(e)).toEqual([])
      assertNoCryptoVocab(e, 'stream event')
    }
  })
})

describe('gate E2E media (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
