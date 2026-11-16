// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { BootMessage } from '../../src/ui/components/BootMessage'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'

afterEach(cleanup)

// Render-scan da chrome de App (espelha account-render-scan; PLANO §8). Cada estado de boot na tela:
// controle positivo + zero shape de protocolo + vocabulário neutro (sem dispositivo/crypto/
// homeserver/matrix/oidc/token). O motivo real da falha vive no console do SDK, nunca no DOM. Fatia
// 2a adiciona os variantes redirecting/preparing e o no-session com botão SSO. Atenção: "Preparando
// seu acesso seguro" NÃO pode disparar o leak-scan (sem cripto/chave/verify).
describe('DOM render-scan — BootMessage (P1 na tela)', () => {
  for (const variant of ['connecting', 'error', 'no-session', 'redirecting', 'preparing', 'revoked', 'idp-denied', 'failed', 'elsewhere', 'handoff'] as const) {
    it(`estado "${variant}" não vaza shape de protocolo nem vocabulário de infra`, () => {
      const { container } = render(
        <BootMessage
          variant={variant}
          ssoLabel="Dex (local)"
          onRetry={() => {}}
          onSignIn={() => {}}
          onSignOut={() => {}}
          onTakeOver={() => {}}
        />,
      )
      const html = container.innerHTML
      // A superfície inteira entra no scan (escopo A′): o wordmark e o esqueleto da casca estão no
      // HTML varrido de toda variante, não só a copy da variante.
      expect(container.querySelector('.boot-wordmark')?.textContent).toBe('tayet')
      expect(container.querySelector('.boot-surface__skeleton')).not.toBeNull()
      expect(container.querySelector('[data-phase]')?.getAttribute('data-phase')).toBe(variant)
      expect(findProtocolLeaksInText(html)).toEqual([])
      expect(html).not.toMatch(/dispositiv/i)
      expect(html).not.toMatch(/homeserver|matrix|oidc|\btoken\b/i)
    })
  }

  // ADR-065: a tela da aba sem lock e as duas copies de espera do "Usar aqui".
  it('lock de aba: neutra + espera + espera secundária, sem vazamento e com a copy ratificada', () => {
    const elsewhere = render(<BootMessage variant="elsewhere" onTakeOver={() => {}} />)
    expect(elsewhere.container.textContent).toContain('O Tayet já está aberto em outra aba deste navegador')
    expect(elsewhere.container.textContent).toContain('Continue por lá ou traga o Tayet para esta aba.')
    expect(elsewhere.container.textContent).toContain('Usar aqui')
    cleanup()
    const long = render(<BootMessage variant="handoff" waitedLong />)
    const html = long.container.innerHTML
    expect(long.container.textContent).toContain('A outra aba não respondeu. Feche-a ou volte a ela por um instante.')
    expect(findProtocolLeaksInText(html)).toEqual([])
    expect(html).not.toMatch(/dispositiv|sess[aã]o|session/i)
    cleanup()
    expect(render(<BootMessage variant="handoff" />).container.textContent).toContain('Trazendo o Tayet para esta aba…')
  })

  it('controles positivos: a copy de cada estado está na tela', () => {
    expect(render(<BootMessage variant="connecting" />).container.textContent).toContain('Conectando')
    cleanup()

    const noSession = render(
      <BootMessage variant="no-session" ssoLabel="Dex (local)" onSignIn={() => {}} />,
    )
    expect(noSession.container.textContent).toContain('Entre no Tayet')
    expect(noSession.container.textContent).toContain('Continuar com Dex (local)')
    cleanup()

    expect(render(<BootMessage variant="redirecting" ssoLabel="Dex (local)" />).container.textContent).toContain(
      'Levando você ao Dex (local)',
    )
    cleanup()

    expect(render(<BootMessage variant="preparing" />).container.textContent).toContain(
      'Preparando seu acesso seguro',
    )
    cleanup()

    const err = render(<BootMessage variant="error" onRetry={() => {}} />)
    expect(err.container.textContent).toContain('Não foi possível conectar')
    expect(err.container.textContent).toContain('Tentar novamente')
    cleanup()

    const denied = render(<BootMessage variant="idp-denied" ssoLabel="Dex (local)" onSignIn={() => {}} />)
    expect(denied.container.textContent).toContain('Não foi possível entrar')
    expect(denied.container.textContent).toContain('Tentar de novo')
    cleanup()

    // §8.9: estado neutro de falha de boot — copy honesta (não afirma causa) + as duas ações.
    const failed = render(<BootMessage variant="failed" onRetry={() => {}} onSignOut={() => {}} />)
    expect(failed.container.textContent).toContain('Não foi possível iniciar')
    expect(failed.container.textContent).toContain('Tentar novamente')
    expect(failed.container.textContent).toContain('Entrar de novo')
    // Guarda da inversão: aqui NÃO se manda conferir a conexão.
    expect(failed.container.textContent).not.toContain('Confira sua conexão')
  })
})
