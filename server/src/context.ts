import type { Db } from './db/index.ts'
import type { AgentSystem } from './agents/system.ts'
import type { SecretBox } from './auth/secrets.ts'
import type { GitHubClient } from './github/client.ts'
import type { Notifier } from './notify/notifier.ts'
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
  // De quantos em quantos segundos o servidor confere no GitHub se os PRs tiveram merge.
  prPollSeconds: number
  // Vigia: intervalo entre varreduras e limites para "task parada" e "Revisão sem PR".
  watcherIntervalSeconds: number
  staleHours: number
  reviewHours: number
  // Rotinas: de quanto em quanto tempo o agendador confere (0 desliga, nos testes) e quantas rodam
  // ao mesmo tempo no servidor todo.
  routineTickSeconds: number
  maxConcurrentRuns: number
  // Revisão de PRs: intervalo entre as olhadas no GitHub (0 desliga) e quanto tempo o PR precisa
  // ficar sem commits novos antes da revisão.
  reviewPollSeconds: number
  reviewSettleSeconds: number
  // De quanto em quanto tempo o servidor confere se a sincronização do cofre com o Obsidian está ligada (0 desliga).
  vaultSyncSeconds: number
  // Vigia com IA (fase 4b): tasks parecidas confirmadas, resumos, aprendizados e sugestões no Codex.
  aiInsights: boolean
}

export interface AppContext {
  db: Db
  hub: RealtimeHub
  config: AppConfig
  git: GitRunner
  agents: AgentSystem
  // GitHub com o token do servidor (HARPIA_GITHUB_TOKEN): ler os PRs, abrir os PRs das tasks.
  github: GitHubClient
  // GitHub com o token de uma pessoa: o revisor publica, corrige e aprova em nome dela.
  githubFor: (token: string) => GitHubClient
  secrets: SecretBox
  notifier: Notifier
  now: () => Date
}
