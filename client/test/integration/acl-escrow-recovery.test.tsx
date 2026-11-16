// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { render, act } from '@testing-library/react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, DomainEvent, ChannelId, User } from '../../src/acl'
import { Workspace } from '../../src/ui/components/Workspace'
import { findProtocolLeaks, findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { HOMESERVER, synapseReachable, whoami, invite, join, leave } from '../support/synapse'
import { spawnEscrow, readAudit, registerUser, type EscrowProcess } from '../support/escrow-harness'
import { mintOidcSession } from '../support/mint-oidc'
import { until } from '../support/until'
import { copy } from '../support/copy'

// ── Gate de integração da fatia C2 (PLANO-FASE-2-ESCROW-C2 §5.2) — asserts 1–6. ────────────
// Stack real + escrow REAL spawned pelo harness (infra da C1). Mundo virgem por usuários
// RECÉM-REGISTRADOS por run (register-user, caminho documentado da dev-stack): os asserts de
// primeiro login exigem 4S/cross-signing/escrow inexistentes, e alice/bob da stack
// compartilhada acumulam estado entre runs — usuários frescos dão o "pós-reset" do §5.2 sem
// reset destrutivo, e blindam as suítes existentes (que rodam SEM escrow) de qualquer estado
// desta. Auto-skip sem a stack (PF-4 / issue #7).
//
// O assert 2 é o teste do assert 6 do gate da fatia A REAPROVEITADO COM SINAL INVERTIDO —
// nota de fixture do PLANO-FASE-2 §8 (ledger da fatia C): "device novo sem chave → unavailable"
// vira, com o backup ligado, "device novo recupera histórico". Não é regressão; é a fixture
// honrada. A linhagem (device novo de membro existente, conectado após os envios, fixture
// natural de UISI) vive agora aqui e no assert 5 (P4: a MESMA situação com escrow indisponível
// segue degradando para `unavailable` — o comportamento da fatia A é o modo degradado da C2).

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

// Vocabulário que jamais aparece em shape de domínio ou DOM (assert 4; complementa o
// leak-scan estrutural, que já cobre escrow/key backup/secret storage — commit 3).
const CRYPTO_TERMS = ['m.bad.encrypted', 'ciphertext', 'megolm', 'm.room.encrypted', 'unable to decrypt', 'session_id']
function assertNoCryptoVocab(value: unknown, label: string): void {
  const json = JSON.stringify(value).toLowerCase()
  for (const term of CRYPTO_TERMS) {
    expect(json, `${label} must not carry "${term}"`).not.toContain(term)
  }
}

const authed = (token: string): { headers: { Authorization: string } } => ({
  headers: { Authorization: `Bearer ${token}` },
})

describe.skipIf(!SYNAPSE)('gate C2 — backup automático + cold start via escrow (§5.2, asserts 1–6)', () => {
  const suffix = `${process.pid}${Math.floor(Math.random() * 1e6)}`
  const userA = `c2a${suffix}`
  const userB = `c2b${suffix}`
  const userR = `c2r${suffix}`

  let escrow: EscrowProcess
  let storeDir: string
  let orgKeyB64: string
  let prevEnv: string | undefined

  let aliceToken: string
  let bobToken: string
  let alice: MatrixGateway
  let bob: Acl
  let channelId: ChannelId
  let roomIdRaw: string
  const instances: Array<Pick<Acl, 'disconnect'>> = []
  const allEvents: DomainEvent[] = []
  const track = (events: DomainEvent[]) => (e: DomainEvent) => {
    events.push(e)
    allEvents.push(e)
  }
  const aliceEvents: DomainEvent[] = []
  const acl3Events: DomainEvent[] = []
  // Instante (ISO) em que o acl2 do teste 2 terminou de desconectar — insumo do dump do teste 3.
  let acl2DisconnectedAt: string | undefined

  const backupReady = (token: string) => async (): Promise<true | undefined> => {
    const res = await fetch(`${HOMESERVER}/_matrix/client/v3/room_keys/version`, authed(token))
    return res.status === 200 ? true : undefined
  }

  beforeAll(async () => {
    storeDir = await mkdtemp(pathJoin(tmpdir(), 'escrow-c2-gate-'))
    orgKeyB64 = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64')
    escrow = await spawnEscrow(storeDir, orgKeyB64)
    // O canal de config da ACL é o env (PF-2 item 4) — setado ANTES de qualquer connect e
    // restaurado no teardown (as demais suítes rodam SEM escrow, por construção).
    prevEnv = process.env.TAYET_ESCROW_URL
    process.env.TAYET_ESCROW_URL = escrow.base

    registerUser(userA)
    registerUser(userB)
    registerUser(userR)
    aliceToken = (await mintOidcSession(userA, 'gatepass123')).accessToken
    bobToken = (await mintOidcSession(userB, 'gatepass123')).accessToken

    alice = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await alice.connect(aliceToken as Parameters<Acl['connect']>[0])
    instances.push(alice)
    alice.subscribe(track(aliceEvents))
    bob = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await bob.connect(bobToken as Parameters<Acl['connect']>[0])
    instances.push(bob)
    bob.subscribe(track([]))

    // Determinismo do setup: só envia DEPOIS que o bootstrap em background de ambos assentou
    // (backup version no servidor) — as sessões Megolm dos envios nascem com o engine ativo.
    await until('beforeAll: alice backup version on server', backupReady(aliceToken))
    await until('beforeAll: bob backup version on server', backupReady(bobToken))

    channelId = await (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await alice.createChannel({ name: `tayet-c2-${suffix}`, kind: 'private' })
        } catch (err) {
          const retryAfter = (err as { data?: { retry_after_ms?: number } }).data?.retry_after_ms
          if (retryAfter === undefined || attempt >= 10) throw err
          await new Promise((r) => setTimeout(r, retryAfter + 200))
        }
      }
    })()
    roomIdRaw = channelId as unknown as string
    await invite(aliceToken, roomIdRaw, await whoami(bobToken))
    await join(bobToken, roomIdRaw)

    // ADR-058: sendMessage rejects for a channel the session does not know yet; wait for it.
    await until(
      'beforeAll: channel known to alice before send',
      async () => ((await alice.getChannels()).some((c) => c.id === channelId) ? true : undefined),
      {
        snapshot: async () => {
          const chs = await alice.getChannels()
          return `known=${chs.length} hasChannelId=${chs.some((c) => c.id === channelId)}`
        },
      },
    )
    await until(
      'beforeAll: channel known to bob before send',
      async () => ((await bob.getChannels()).some((c) => c.id === channelId) ? true : undefined),
      {
        snapshot: async () => {
          const chs = await bob.getChannels()
          return `known=${chs.length} hasChannelId=${chs.some((c) => c.id === channelId)}`
        },
      },
    )
    await alice.sendMessage(channelId, { kind: 'text', text: 'mensagem antiga um' })
    await bob.sendMessage(channelId, { kind: 'text', text: 'mensagem antiga dois' })
    // Ambos decifram ao vivo antes de qualquer cold start.
    await until('beforeAll: alice decrypts bob message live', () =>
      aliceEvents.some(
        (e) => e.t === 'message.received' && e.message.body.kind === 'text' && e.message.body.text === 'mensagem antiga dois',
      )
        ? true
        : undefined,
    )

    // Determinismo do cold start: espera o backup de alice CONTER as duas sessões no servidor.
    // Achado da fonte (registrado na §8): o engine de backup do SDK só agenda upload quando uma
    // chave INBOUND chega (maybeUploadKey ← onRoomKeysUpdated) — a chave de bob é o gatilho que
    // faz o flush das pendências (a sessão outbound da própria alice junto). Sem esta âncora, o
    // assert 2 dependeria do timing interno do loop de upload (delay aleatório de até 10s).
    const aliceBackupVersion = (
      (await (await fetch(`${HOMESERVER}/_matrix/client/v3/room_keys/version`, authed(aliceToken))).json()) as {
        version: string
      }
    ).version
    await until('beforeAll: alice backup holds both sessions', async () => {
      const res = await fetch(
        `${HOMESERVER}/_matrix/client/v3/room_keys/keys?version=${aliceBackupVersion}`,
        authed(aliceToken),
      )
      if (res.status !== 200) return undefined
      const body = (await res.json()) as { rooms?: Record<string, { sessions: Record<string, unknown> }> }
      const sessions = Object.values(body.rooms ?? {}).reduce((n, r) => n + Object.keys(r.sessions).length, 0)
      return sessions >= 2 ? true : undefined
    })
  }, 240_000)

  afterAll(async () => {
    // Higiene #18: leave + disconnect + kill + tmpdir, sempre best-effort. Os usuários c2* do
    // run permanecem registrados no MAS (classe register-user; sem custo para as suítes
    // existentes, que usam alice/bob).
    try {
      await leave(bobToken, roomIdRaw)
      await leave(aliceToken, roomIdRaw)
    } catch {
      /* best-effort */
    }
    for (const i of instances.splice(0)) {
      try {
        await i.disconnect()
      } catch {
        /* best-effort */
      }
    }
    await escrow?.kill()
    await rm(storeDir, { recursive: true, force: true }).catch(() => undefined)
    if (prevEnv === undefined) delete process.env.TAYET_ESCROW_URL
    else process.env.TAYET_ESCROW_URL = prevEnv
  }, 60_000)

  it('1. primeiro login bootstrapa sozinho: 4S + backup + cross-sign sem interação; depósito no escrow', async () => {
    // Depósito aconteceu (GET direto com o token de alice — observação externa).
    const got = await until('assert 1: alice secret deposited in escrow', async () => {
      const res = await fetch(`${escrow.base}/v1/secret`, authed(aliceToken))
      return res.status === 200 ? ((await res.json()) as { secret: string }) : undefined
    })
    expect(got.secret.length).toBeGreaterThan(0)

    // 4S existe (account data), backup habilitado (versão no servidor), cross-signing publicado.
    const aliceMxid = await whoami(aliceToken)
    const accountData = await fetch(
      `${HOMESERVER}/_matrix/client/v3/user/${encodeURIComponent(aliceMxid)}/account_data/m.secret_storage.default_key`,
      authed(aliceToken),
    )
    expect(accountData.status).toBe(200)
    const backup = await fetch(`${HOMESERVER}/_matrix/client/v3/room_keys/version`, authed(aliceToken))
    expect(backup.status).toBe(200)
    expect(((await backup.json()) as { version?: string }).version).toBeTruthy()
    const keysQuery = await fetch(`${HOMESERVER}/_matrix/client/v3/keys/query`, {
      method: 'POST',
      headers: { ...authed(aliceToken).headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_keys: { [aliceMxid]: [] } }),
    })
    const keys = (await keysQuery.json()) as { master_keys?: Record<string, unknown>; self_signing_keys?: Record<string, unknown> }
    expect(keys.master_keys?.[aliceMxid], 'master key publicada').toBeDefined()
    expect(keys.self_signing_keys?.[aliceMxid], 'self-signing key publicada').toBeDefined()

    // Um depósito por usuário (alice e bob, sujeitos distintos) na auditoria.
    const created = (await readAudit(storeDir)).filter((e) => e.verb === 'put' && e.outcome === 'created')
    expect(created.length).toBe(2)
    expect(new Set(created.map((e) => e.sub)).size).toBe(2)
  }, 180_000)

  it('2. recuperação: cold start decifra o histórico (assert 6 da fatia A INVERTIDO — nota de fixture honrada)', async () => {
    // O teste reaproveitado da fatia A (acl-e2e assert 6): device NOVO de membro existente,
    // token fresco = store virgem, conectado APÓS os envios. Sem backup ele via `unavailable`;
    // com a C2 (escrow → 4S → restore) ele RECUPERA — assert positivo, não regressão
    // (PLANO-FASE-2 §8, nota de fixture; PLANO-FASE-2-ESCROW-C2 §5.2 assert 2).
    const token2 = (await mintOidcSession(userA, 'gatepass123')).accessToken
    const acl2 = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    // Foto da auditoria ANTES do connect: o delta deste teste é a régua da testemunha abaixo.
    const auditBefore = (await readAudit(storeDir)).length
    await acl2.connect(token2 as Parameters<Acl['connect']>[0])
    instances.push(acl2)
    try {
      acl2.subscribe(track([]))

      // Âncora do PF-3: retry com timeout sobre o predicado externo "antigas decifradas" —
      // a recuperação corre em background (login nunca esperou por ela). Testemunha
      // (PLANO-GATES §8.11 item 4): a saída exige TAMBÉM a consulta de custódia do cold start
      // (`retrieve`, depois do restore) no delta da auditoria deste teste — sem ela o GET
      // aterrissava na janela do teste 3. O snapshot separa as duas classes de estouro:
      // "não decifrou" vs "consulta de custódia não aconteceu".
      const decryptedOld = async (): Promise<{ page: Awaited<ReturnType<Acl['getTimeline']>>; um: boolean; dois: boolean }> => {
        const p = await acl2.getTimeline(channelId)
        const texts = p.items.filter((m) => m.body.kind === 'text').map((m) => (m.body.kind === 'text' ? m.body.text : ''))
        return { page: p, um: texts.includes('mensagem antiga um'), dois: texts.includes('mensagem antiga dois') }
      }
      const auditDelta = async () => (await readAudit(storeDir)).slice(auditBefore)
      const page = await until(
        'assert 2: cold start recovers both old messages and custody consult landed',
        async () => {
          const d = await decryptedOld()
          if (!(d.um && d.dois)) return undefined
          return (await auditDelta()).some((e) => e.verb === 'retrieve') ? d.page : undefined
        },
        {
          snapshot: async () => {
            const d = await decryptedOld()
            return `decrypted={um:${d.um},dois:${d.dois}} auditDelta=${JSON.stringify(await auditDelta())}`
          },
        },
      )
      expect(page.items.some((m) => m.body.kind === 'unavailable')).toBe(false)
      const delta = await auditDelta()
      expect(
        delta.filter((e) => e.verb === 'retrieve'),
        `assert 2: exatamente uma consulta de custódia no delta do teste; delta completo: ${JSON.stringify(delta)}`,
      ).toHaveLength(1)
    } finally {
      // Discriminador do warm=cold (PLANO-GATES §8.11): o 2º device da alice (MESMA sub na
      // auditoria) sai de cena antes da janela do teste 3. Best-effort — um disconnect que
      // lança não mascara a falha original do teste. O instante é gravado DEPOIS do
      // disconnect resolver e entra no dump do teste 3.
      instances.splice(instances.indexOf(acl2), 1)
      try {
        await acl2.disconnect()
      } catch {
        /* best-effort */
      }
      acl2DisconnectedAt = new Date().toISOString()
    }
  }, 200_000)

  it('3. warm = cold: segunda passada no device original é no-op (nenhum PUT/GET novo do sujeito na auditoria)', async () => {
    // Caminho único provado por observação externa (§5.2 assert 3): o MESMO ensureKeyRecovery,
    // num device com material já cacheado, decide local e não toca o escrow. (Em Node o store
    // rust é em memória — "reconectar com store íntegro" não existe; o equivalente honesto é a
    // segunda passada na MESMA sessão viva, o mesmo code path do ramo warm.)
    const beforeEntries = await readAudit(storeDir)

    // Sub do sujeito (alice) derivada EMPIRICAMENTE do próprio run, sem hardcode de formato:
    // candidatas = subs dos depósitos `put/created` do assert 1 (alice E bob); a da alice é a
    // única que TAMBÉM aparece em `get/ok` — a observação externa do assert 1 (GET com o token
    // DELA) e o cold start do assert 2 (2º device dela) garantem essas entradas; o bootstrap de
    // bob só produz get/not_found + put/created. Ambiguidade aqui é falha alta e clara, não
    // assert silencioso contra a sub errada.
    const createdSubs = new Set(
      beforeEntries.filter((e) => e.verb === 'put' && e.outcome === 'created').map((e) => e.sub),
    )
    const okGetSubs = new Set(beforeEntries.filter((e) => e.verb === 'get' && e.outcome === 'ok').map((e) => e.sub))
    const subjectSubs = [...createdSubs].filter((s) => s !== undefined && okGetSubs.has(s))
    expect(subjectSubs, 'exatamente uma sub candidata a sujeito (alice)').toHaveLength(1)
    const subjectSub = subjectSubs[0]

    const outcome = await alice.recheckKeyRecovery()
    expect(outcome).toBe('noop')

    // Assert restrito à sub do sujeito; o dump do mismatch carrega o delta INTEIRO
    // (ts/sub/verb/outcome) — é ele que nomeia o ator de fundo (PLANO-GATES §8.6 fork (d)).
    const afterEntries = await readAudit(storeDir)
    const delta = afterEntries.slice(beforeEntries.length)
    const subjectDelta = delta.filter((e) => e.sub === subjectSub)
    expect(
      subjectDelta,
      `warm=cold: auditoria ganhou entrada(s) do sujeito; delta completo: ${JSON.stringify(delta)}; acl2DisconnectedAt: ${acl2DisconnectedAt}`,
    ).toHaveLength(0)

    // Discriminador (PLANO-GATES §8.11): a consulta de custódia do acl2 do assert 2 (2º device
    // da alice, MESMA sub — a auditoria não discrimina device, §8.8) é observada antes do fim
    // do teste 2, e o acl2 é desconectado ali. Uma entrada da sub do sujeito aqui passa a
    // apontar para o device warm.
  }, 60_000)

  it('5. P4 — escrow indisponível: login nunca bloqueia; placeholders; religou → upgrade sem reload', async () => {
    await escrow.kill()

    const token3 = (await mintOidcSession(userA, 'gatepass123')).accessToken
    const acl3 = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    // Conecta MESMO com o escrow morto (custódia é dependência da recuperação de histórico,
    // não do login — §0.2 item 1).
    await acl3.connect(token3 as Parameters<Acl['connect']>[0])
    instances.push(acl3)
    acl3.subscribe(track(acl3Events))

    // Histórico degrada para `unavailable` (a máquina existente da fatia A É o modo degradado).
    const degraded = await until('assert 5: timeline degrades to unavailable', async () => {
      const p = await acl3.getTimeline(channelId)
      return p.items.some((m) => m.body.kind === 'unavailable') ? p : undefined
    })

    // Zero erro técnico visível: o placeholder neutro renderiza e nenhum termo de
    // protocolo/custódia alcança o DOM (a linhagem P4 do assert 6 da fatia A vive aqui).
    const channels = await acl3.getChannels()
    const channel = channels.find((c) => c.id === channelId)
    expect(channel).toBeDefined()
    const members = await acl3.getMembers(channelId)
    const usersById: Record<string, User> = {}
    for (const { user } of members) usersById[user.id] = user
    let container!: HTMLElement
    act(() => {
      container = render(
        <Workspace
          channels={[channel!]}
          selectedChannelId={channelId}
          messages={degraded.items}
          usersById={usersById}
          connection="connected"
          onSelectChannel={() => {}}
          onSend={() => {}}
        />,
      ).container
    })
    // ADR-057 dec. 7: escrow down = the key MAY still arrive (this very test proves it — the
    // upgrade lands when the escrow returns), so the graduated placeholder reads 'awaited'.
    expect(container.textContent ?? '').toContain(copy.timeline.awaited)
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
    for (const term of CRYPTO_TERMS) expect(container.innerHTML.toLowerCase()).not.toContain(term)

    // Religa o escrow (mesma porta, mesmo store — mesma URL que a sessão já carrega): o retry
    // em background recupera e as mensagens presas upgradam pela máquina de message.edited,
    // SEM reload (mesma instância acl3).
    escrow = await spawnEscrow(storeDir, orgKeyB64, escrow.port)
    // A timeline INTEIRA recupera (retry com timeout — as duas mensagens upgradam quando o
    // restore importa as sessões; sem assumir ordem entre os upgrades).
    await until('assert 5: full timeline upgrades after escrow returns', async () => {
      const p = await acl3.getTimeline(channelId)
      const texts = p.items.filter((m) => m.body.kind === 'text').map((m) => (m.body.kind === 'text' ? m.body.text : ''))
      return texts.includes('mensagem antiga um') &&
        texts.includes('mensagem antiga dois') &&
        !p.items.some((m) => m.body.kind === 'unavailable')
        ? true
        : undefined
    })
    // E o upgrade fluiu pela máquina de message.edited (ADR-015 item 1) — sem reload, mesma
    // instância: o que estava preso em `unavailable` virou conteúdo real via evento.
    expect(
      acl3Events.some(
        (e) => e.t === 'message.edited' && e.message.body.kind === 'text' && e.message.body.text.startsWith('mensagem antiga'),
      ),
    ).toBe(true)
  }, 240_000)

  it('6. write-once na janela da corrida: exatamente um created; excedente é conflict; ambos adotam o MESMO segredo', async () => {
    const before = (await readAudit(storeDir)).length

    // Dois devices VIRGENS de um usuário que nunca bootstrapou, conectando simultaneamente.
    const tokenR1 = (await mintOidcSession(userR, 'gatepass123')).accessToken
    const tokenR2 = (await mintOidcSession(userR, 'gatepass123')).accessToken
    const d1 = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    const d2 = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await Promise.all([
      d1.connect(tokenR1 as Parameters<Acl['connect']>[0]),
      d2.connect(tokenR2 as Parameters<Acl['connect']>[0]),
    ])
    instances.push(d1, d2)
    const d1Events: DomainEvent[] = []
    const d2Events: DomainEvent[] = []
    d1.subscribe(track(d1Events))
    d2.subscribe(track(d2Events))

    // Convergência primeiro (condições garantidamente alcançáveis): sala cifrada + mensagens
    // dos DOIS devices; ambos decifram o histórico um do outro (mesmo segredo, mesmo mundo
    // 4S — quem não depositou adotou).
    const raceChannel = await d1.createChannel({ name: `tayet-c2-race-${suffix}`, kind: 'private' })
    await until('assert 6: race channel visible on d2', async () =>
      (await d2.getChannels()).some((c) => c.id === raceChannel) ? true : undefined,
    )
    // ADR-058: sendMessage rejects for a channel the session does not know yet; wait for it.
    await until(
      'assert 6: race channel known to d1',
      async () => ((await d1.getChannels()).some((c) => c.id === raceChannel) ? true : undefined),
      {
        snapshot: async () => {
          const chs = await d1.getChannels()
          return `known=${chs.length} hasChannelId=${chs.some((c) => c.id === raceChannel)}`
        },
      },
    )
    await d1.sendMessage(raceChannel, { kind: 'text', text: 'corrida um' })
    await d2.sendMessage(raceChannel, { kind: 'text', text: 'corrida dois' })
    await until('assert 6: d1 decrypts d2 message', () =>
      d1Events.some((e) => e.t === 'message.received' && e.message.body.kind === 'text' && e.message.body.text === 'corrida dois')
        ? true
        : undefined,
    )
    await until('assert 6: d2 decrypts d1 message', () =>
      d2Events.some((e) => e.t === 'message.received' && e.message.body.kind === 'text' && e.message.body.text === 'corrida um')
        ? true
        : undefined,
    )

    // O write-once garante exatamente um `created`; a CORRIDA (par [conflict, created]) NÃO é
    // desfecho garantido — quando o timing serializa, o segundo device encontra o segredo no
    // retrieve, adota e jamais gera PUT (mundo serializado = adoção correta, PLANO-GATES §8.3).
    // O 409 determinístico vive no unit do escrow; aqui a espera é pela condição GARANTIDA
    // (o depósito do vencedor) e o par da corrida é assertado só quando ela aconteceu.
    await until(
      'assert 6: winner deposit (created) lands in audit',
      async () => {
        const puts = (await readAudit(storeDir)).slice(before).filter((e) => e.verb === 'put')
        return puts.some((e) => e.outcome === 'created') ? puts : undefined
      },
      {
        snapshot: async () => {
          const puts = (await readAudit(storeDir)).slice(before).filter((e) => e.verb === 'put')
          return `puts=${puts.length} outcomes=[${puts.map((e) => e.outcome).join(',')}]`
        },
      },
    )

    const puts = (await readAudit(storeDir)).slice(before).filter((e) => e.verb === 'put')
    const created = puts.filter((e) => e.outcome === 'created')
    expect(created).toHaveLength(1)
    for (const p of puts) {
      if (p.outcome !== 'created') expect(p.outcome).toBe('conflict')
    }
    if (puts.length >= 2) {
      // Corrida exercitada de fato (12/13 dos runs isolados): o par clássico.
      expect(puts.slice(0, 2).map((e) => e.outcome).sort()).toEqual(['conflict', 'created'])
    }

    try {
      await leave(tokenR1, raceChannel as unknown as string)
    } catch {
      /* best-effort */
    }
  }, 240_000)

  it('4. P1 durante TODO o gate: nenhum vocabulário de protocolo/custódia em DomainEvent ou DOM', async () => {
    // Varredura final sobre TUDO que atravessou o stream de qualquer instância do gate — o
    // leak-scan estrutural já carrega escrow/key backup/secret storage (commit 3). O bootstrap
    // não criou NENHUM elemento de UI: a única superfície DOM do gate são as timelines
    // renderizadas nos asserts (escaneadas lá e re-escaneadas aqui no estado recuperado).
    expect(allEvents.length).toBeGreaterThan(0)
    for (const e of allEvents) {
      expect(findProtocolLeaks(e)).toEqual([])
      assertNoCryptoVocab(e, 'stream event')
    }

    const page = await alice.getTimeline(channelId)
    const channels = await alice.getChannels()
    const channel = channels.find((c) => c.id === channelId)
    const members = await alice.getMembers(channelId)
    const usersById: Record<string, User> = {}
    for (const { user } of members) usersById[user.id] = user
    let container!: HTMLElement
    act(() => {
      container = render(
        <Workspace
          channels={[channel!]}
          selectedChannelId={channelId}
          messages={page.items}
          usersById={usersById}
          connection="connected"
          onSelectChannel={() => {}}
          onSend={() => {}}
        />,
      ).container
    })
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
    for (const term of CRYPTO_TERMS) expect(container.innerHTML.toLowerCase()).not.toContain(term)
  }, 120_000)
})

describe('gate C2 (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
