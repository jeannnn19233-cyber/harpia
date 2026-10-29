import type { Db } from './db/index.ts'
import type { AgentSystem } from './agents/system.ts'
import type { GitRunner } from './projects/git.ts'
import type { RealtimeHub } from './realtime/hub.ts'

export interface AppConfig {
  // Pasta com o banco e os repositórios clonados.
  dataDir: string
  reposDir: string
  // true quando o Harpia é servido por HTTPS (ex.: tailscale serve).
  cookieSecure: boolean
  // Pasta com a interface web já compilada (web/dist). null desativa.
  webDir: string | null
  // Endereços pelos quais a equipe abre o Harpia (ex.: https://harpia.tailnet.ts.net).
  // Necessário quando um proxy, como o tailscale serve, troca o cabeçalho Host.
  allowedOrigins: string[]
  // Código exigido para criar a primeira conta. null permite criar sem código.
  setupCode: string | null
  // Terminais com agentes de IA (fase 3). Desligados até o administrador ligar.
  terminalsEnabled: boolean
  // Limite de sessões abertas ao mesmo tempo por pessoa.
  maxSessionsPerUser: number
}

export interface AppContext {
  db: Db
  hub: RealtimeHub
  config: AppConfig
  git: GitRunner
  agents: AgentSystem
  now: () => Date
}
