import type { Db } from './db/index.ts'
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
}

export interface AppContext {
  db: Db
  hub: RealtimeHub
  config: AppConfig
  git: GitRunner
  now: () => Date
}
