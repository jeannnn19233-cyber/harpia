// Regras do app de computador sem nada de Electron, para testar isoladas.

export type ServerCheck = { ok: true; url: string } | { ok: false; error: string }

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

// Endereço do servidor do Harpia digitado pela pessoa. Só HTTPS, a não ser na própria máquina
// (desenvolvimento): o cookie de sessão viaja nesse endereço.
export function checkServerUrl(input: string): ServerCheck {
  const text = input.trim()
  if (!text) return { ok: false, error: 'Informe o endereço do Harpia da sua equipe.' }
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return { ok: false, error: 'Endereço inválido. Exemplo: https://harpia.suaempresa.com.br' }
  }
  const local = LOCAL_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return { ok: false, error: 'Use um endereço https:// (http só vale para a própria máquina).' }
  }
  if (url.username || url.password) return { ok: false, error: 'O endereço não pode ter usuário ou senha.' }
  return { ok: true, url: url.origin }
}

// O que abre dentro da janela: só páginas do próprio servidor. Todo o resto (GitHub, links das
// conversas) vai para o navegador; esquemas estranhos (file:, javascript:) não abrem em lugar nenhum.
export function navigationTarget(target: string, server: string | null): 'inside' | 'browser' | 'block' {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return 'block'
  }
  if (server && url.origin === new URL(server).origin) return 'inside'
  if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:') return 'browser'
  return 'block'
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export const DEFAULT_SIZE = { width: 1440, height: 900 }
export const MIN_SIZE = { width: 960, height: 600 }

// Posição salva da janela, só se ela ainda cabe numa tela (o monitor externo pode ter saído).
export function restoreBounds(saved: Bounds | null | undefined, screens: Bounds[]): Bounds | null {
  if (!saved || saved.width < MIN_SIZE.width || saved.height < MIN_SIZE.height) return null
  const visible = screens.some(
    (area) =>
      saved.x + 80 >= area.x &&
      saved.y >= area.y &&
      saved.x + 80 <= area.x + area.width &&
      saved.y + 40 <= area.y + area.height
  )
  return visible ? saved : null
}

// Contador no ícone do app: um número pequeno e honesto.
export function badgeCount(value: unknown): number {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? Math.min(n, 99) : 0
}
