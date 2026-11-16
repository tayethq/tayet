import { describe, it, expect, vi } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry } from '../src/acl'

// P1 boundary (mecânica) de setAvatar/removeAvatar (ADR-041). Avatar é mídia de perfil pública:
// upload cleartext (uploadContent, NÃO attachment-crypto) + setAvatarUrl; o mxc fica nas chamadas do
// SDK e o verbo devolve um MediaRef opaco (mintMediaRef cunha um token e confina o mxc). NÃO se roda
// findProtocolLeaks no MediaRef — ele É um handle opaco branded por design (ADR-009, como User.avatar);
// a prova mxc-fora-do-DOM é o render-scan do PR-2. Aqui prova-se a MECÂNICA: File entra, as chamadas
// certas saem, o MediaRef volta. Espelha my-profile.test.ts (fake SDK client + MatrixGateway).

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const MXID = '@alice:tayet.local'

function gatewayWith(opts: { avatarUrl?: string }) {
  const uploadContent = vi.fn(async (_f: File) => ({ content_uri: 'mxc://tayet.local/fresh' }))
  const setAvatarUrl = vi.fn(async () => ({}))
  const fakeClient = {
    getUserId: () => MXID,
    getUser: (_id: string) => ({ avatarUrl: opts.avatarUrl, rawDisplayName: 'Alice Stone' }),
    getAccountData: (_type: string) => undefined,
    uploadContent,
    setAvatarUrl,
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  return { gateway, uploadContent, setAvatarUrl }
}

describe('setAvatar/removeAvatar boundary mechanics (ADR-041)', () => {
  it('setAvatar: cleartext upload → setAvatarUrl(mxc) → returns a MediaRef', async () => {
    const { gateway, uploadContent, setAvatarUrl } = gatewayWith({})
    const file = new File([new Uint8Array([1, 2, 3])], 'me.png', { type: 'image/png' })
    const ref = await gateway.setAvatar(file)
    expect(uploadContent).toHaveBeenCalledWith(file) // cleartext: o File cru, sem cifra
    expect(setAvatarUrl).toHaveBeenCalledWith('mxc://tayet.local/fresh')
    expect(ref).toBeTruthy() // MediaRef opaco — contrato cumprido
    // o mxc fresco NÃO é o valor do MediaRef que cruza: mintMediaRef cunha um token e confina o mxc
    expect(ref).not.toBe('mxc://tayet.local/fresh')
  })

  it('removeAvatar clears the profile avatar', async () => {
    const { gateway, setAvatarUrl } = gatewayWith({ avatarUrl: 'mxc://tayet.local/old' })
    await gateway.removeAvatar()
    expect(setAvatarUrl).toHaveBeenCalledWith('')
  })

  it('getMyProfile surfaces the current avatar as a MediaRef (or undefined when none)', async () => {
    const withAvatar = gatewayWith({ avatarUrl: 'mxc://tayet.local/current' })
    expect((await withAvatar.gateway.getMyProfile()).avatar).toBeTruthy()
    const without = gatewayWith({})
    expect((await without.gateway.getMyProfile()).avatar).toBeUndefined()
  })
})
