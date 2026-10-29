import { describe, expect, it } from 'vitest'
import { badgeCount, checkServerUrl, navigationTarget, restoreBounds } from '../src/rules.ts'

describe('endereço do servidor', () => {
  it('aceita https e completa o esquema, guardando só a origem', () => {
    expect(checkServerUrl(' harpia.clarumi.com ')).toEqual({ ok: true, url: 'https://harpia.clarumi.com' })
    expect(checkServerUrl('https://harpia.clarumi.com/projetos?x=1')).toEqual({ ok: true, url: 'https://harpia.clarumi.com' })
    expect(checkServerUrl('http://localhost:7420')).toEqual({ ok: true, url: 'http://localhost:7420' })
  })

  it('recusa http fora da própria máquina, credenciais na URL e lixo', () => {
    expect(checkServerUrl('http://harpia.clarumi.com')).toMatchObject({ ok: false, error: expect.stringContaining('https://') })
    expect(checkServerUrl('https://ana:senha@harpia.clarumi.com')).toMatchObject({ ok: false })
    expect(checkServerUrl('')).toMatchObject({ ok: false })
    expect(checkServerUrl('ftp://harpia.clarumi.com')).toMatchObject({ ok: false })
    expect(checkServerUrl('https://')).toMatchObject({ ok: false })
  })
})

describe('navegação', () => {
  const server = 'https://harpia.clarumi.com'
  it('o servidor abre na janela; o resto, no navegador; esquemas perigosos, em lugar nenhum', () => {
    expect(navigationTarget('https://harpia.clarumi.com/api/me', server)).toBe('inside')
    expect(navigationTarget('https://github.com/clarumi/loja/pull/42', server)).toBe('browser')
    expect(navigationTarget('https://harpia.clarumi.com.evil.com/', server)).toBe('browser')
    expect(navigationTarget('http://harpia.clarumi.com/', server)).toBe('browser')
    expect(navigationTarget('mailto:ana@exemplo.com', server)).toBe('browser')
    expect(navigationTarget('file:///etc/passwd', server)).toBe('block')
    expect(navigationTarget('javascript:alert(1)', server)).toBe('block')
    expect(navigationTarget('não é url', server)).toBe('block')
    expect(navigationTarget('https://harpia.clarumi.com/', null)).toBe('browser')
  })
})

describe('janela', () => {
  const screen = { x: 0, y: 0, width: 1920, height: 1080 }
  it('restaura a posição só se ainda cabe numa tela', () => {
    expect(restoreBounds({ x: 100, y: 50, width: 1400, height: 900 }, [screen])).toEqual({ x: 100, y: 50, width: 1400, height: 900 })
    expect(restoreBounds({ x: 2500, y: 50, width: 1400, height: 900 }, [screen])).toBeNull()
    expect(restoreBounds({ x: 2500, y: 50, width: 1400, height: 900 }, [screen, { x: 1920, y: 0, width: 2560, height: 1440 }])).not.toBeNull()
    expect(restoreBounds({ x: 0, y: 0, width: 300, height: 200 }, [screen])).toBeNull()
    expect(restoreBounds(null, [screen])).toBeNull()
  })

  it('contador do ícone entre 0 e 99', () => {
    expect(badgeCount(3)).toBe(3)
    expect(badgeCount(250)).toBe(99)
    expect(badgeCount(-1)).toBe(0)
    expect(badgeCount('x')).toBe(0)
  })
})
