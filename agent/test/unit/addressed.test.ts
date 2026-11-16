import { describe, it, expect } from 'vitest'
import { addressedOf } from '../../src/addressed.ts'

// Shape do `state` de GET /context/{eventId}?limit=0 — o snapshot do nascimento
// (F5/F7). Critério do fan-out do spike C1: membros `join` + `invite`; todo o resto
// fora. Saída em localparts (contrato do PUT /v1/sessions da PR-2).

function member(mxid: string, membership: string): Record<string, unknown> {
  return { type: 'm.room.member', state_key: mxid, content: { membership } }
}

describe('addressedOf — endereçados do estado no primeiro evento da sessão', () => {
  it('join e invite entram; leave/ban/knock não', () => {
    const state = [
      member('@ana:tayet.local', 'join'),
      member('@beto:tayet.local', 'invite'),
      member('@carol:tayet.local', 'leave'),
      member('@dinah:tayet.local', 'ban'),
      member('@edu:tayet.local', 'knock'),
    ]
    expect(addressedOf(state)).toEqual(['ana', 'beto'])
  })

  it('eventos de estado que não são m.room.member são ignorados', () => {
    const state = [
      { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
      { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'shared' } },
      member('@ana:tayet.local', 'join'),
    ]
    expect(addressedOf(state)).toEqual(['ana'])
  })

  it('extrai o localpart do mxid (sem @, sem servidor) e deduplica ordenado', () => {
    const state = [
      member('@zoe:tayet.local', 'join'),
      member('@ana:outro.servidor.example', 'join'),
      member('@ana:outro.servidor.example', 'join'),
    ]
    expect(addressedOf(state)).toEqual(['ana', 'zoe'])
  })

  it('shape defensivo: entradas malformadas são ignoradas, nunca inferidas', () => {
    const state = [
      null,
      'string',
      { type: 'm.room.member' }, // sem state_key/content
      { type: 'm.room.member', state_key: 'sem-arroba', content: { membership: 'join' } },
      { type: 'm.room.member', state_key: '@:tayet.local', content: { membership: 'join' } },
      { type: 'm.room.member', state_key: '@ana:tayet.local', content: { membership: 42 } },
      { type: 'm.room.member', state_key: '@ana:tayet.local', content: null },
      member('@ok:tayet.local', 'join'),
    ]
    expect(addressedOf(state)).toEqual(['ok'])
  })

  it('state ausente/não-array → conjunto vazio', () => {
    expect(addressedOf(undefined)).toEqual([])
    expect(addressedOf(null)).toEqual([])
    expect(addressedOf({})).toEqual([])
    expect(addressedOf([])).toEqual([])
  })
})
