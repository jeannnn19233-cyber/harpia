import { existsSync, mkdirSync, renameSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { LinuxAgentSystem } from './agents/linux.ts'
import { registerAgentRoutes } from './agents/routes.ts'
import type { AgentSystem } from './agents/system.ts'
import { registerAuthGuard } from './auth/guard.ts'
import { ChatManager } from './chat/manager.ts'
import { createClaudeProvider, listClaudeModels } from './chat/providers/claude.ts'
import { createCodexProvider, listCodexModels } from './chat/providers/codex.ts'
import type { ModelLister, ProviderFactory } from './chat/providers/types.ts'
import { registerChatRoutes } from './chat/routes.ts'
import { registerAuthRoutes } from './auth/routes.ts'
import { deleteExpiredSessions } from './auth/sessions.ts'
import type { AppConfig, AppContext } from './context.ts'
import { openDatabase } from './db/index.ts'
import { registerErrorHandler } from './http/errors.ts'
import { createGitHubClient, type GitHubClient } from './github/client.ts'
import { Notifier } from './notify/notifier.ts'
import type { TelegramClient } from './notify/telegram.ts'
import { systemGit, type GitRunner } from './projects/git.ts'
import { registerPullRoutes } from './pulls/routes.ts'
import { registerProjectRoutes } from './projects/routes.ts'
import { RealtimeHub } from './realtime/hub.ts'
import { registerRealtimeRoutes } from './realtime/routes.ts'
import { registerTaskRoutes } from './tasks/routes.ts'
import { registerRoutineRoutes } from './routines/routes.ts'
import { RoutineRunner } from './routines/runner.ts'
import { registerWatcherRoutes } from './watcher/routes.ts'
import { Watcher } from './watcher/watcher.ts'

export interface BuildOptions {
  config: AppConfig
  logger?: FastifyServerOptions['logger']
  git?: GitRunner
  agents?: AgentSystem
  chatProviders?: ProviderFactory
  chatModels?: ModelLister
  github?: GitHubClient
  // Bot do Telegram para os avisos. null desliga.
  telegram?: TelegramClient | null
  // false: o servidor não lê sozinho as mensagens do bot (os testes chamam pollOnce).
  pollTelegram?: boolean
  now?: () => Date
  // Limites de tempo das execuções automáticas (os testes usam valores curtos).
  routineLimits?: { inactivityMs?: number; maxMs?: number }
}

// O banco fica numa pasta só do servidor, fora do alcance dos usuários dos agentes.
// Instalações antigas guardavam o banco direto na pasta de dados: ele é movido uma vez.
function databaseFile(dataDir: string): string {
  const serverDir = join(dataDir, 'server')
  mkdirSync(serverDir, { recursive: true })
  chmodSync(serverDir, 0o700)
  const file = join(serverDir, 'harpia.db')
  const legacy = join(dataDir, 'harpia.db')
  if (!existsSync(file) && existsSync(legacy)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(legacy + suffix)) renameSync(legacy + suffix, file + suffix)
    }
  }
  return file
}

// Serviços que os testes e outros módulos precisam acessar diretamente.
export interface AppServices {
  chat: ChatManager
  routines: RoutineRunner
}

export async function buildApp(options: BuildOptions): Promise<{ app: FastifyInstance; ctx: AppContext; services: AppServices }> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1024 * 1024 })
  const dataDir = options.config.dataDir
  const ctx: AppContext = {
    db: openDatabase(databaseFile(dataDir)),
    hub: new RealtimeHub(),
    config: options.config,
    git: options.git ?? systemGit,
    agents:
      options.agents ??
      (await LinuxAgentSystem.create({ homesDir: join(dataDir, 'homes'), runDir: join(dataDir, 'run') })),
    github:
      options.github ??
      createGitHubClient({ token: process.env.HARPIA_GITHUB_TOKEN ?? null, apiUrl: process.env.HARPIA_GITHUB_API_URL }),
    notifier: null as unknown as Notifier,
    now: options.now ?? (() => new Date())
  }
  ctx.notifier = new Notifier({
    db: ctx.db,
    now: ctx.now,
    telegram: options.telegram ?? null,
    isOnline: (userId) => ctx.hub.onlineUserIds().includes(userId),
    publicUrl: options.config.allowedOrigins[0] ?? null,
    autoPoll: options.pollTelegram ?? true,
    warn: (error, message) => app.log.warn(error, message)
  })

  registerErrorHandler(app)
  await app.register(cookie)
  await app.register(websocket)
  registerAuthGuard(app, ctx)

  registerAuthRoutes(app, ctx)
  registerProjectRoutes(app, ctx)
  registerTaskRoutes(app, ctx)
  registerAgentRoutes(app, ctx)
  // Os provedores rodam como o usuário Linux de quem abriu a conversa.
  const providers: ProviderFactory =
    options.chatProviders ??
    ((input) => {
      const spawn = (process: { command: string; args: string[]; cwd: string; env: Record<string, string> }) =>
        ctx.agents.spawnPiped({ user: input.user, ...process })
      return input.provider === 'claude' ? createClaudeProvider(input, spawn) : createCodexProvider(input, spawn)
    })
  const lister: ModelLister =
    options.chatModels ??
    ((input) => {
      const spawn = (process: { command: string; args: string[]; cwd: string; env: Record<string, string> }) =>
        ctx.agents.spawnPiped({ user: input.user, ...process })
      return input.provider === 'claude' ? listClaudeModels(spawn, input.cwd) : listCodexModels(spawn, input.cwd)
    })
  const chat = new ChatManager(ctx, providers, lister)
  registerChatRoutes(app, ctx, chat)
  const routines = new RoutineRunner(ctx, chat, {
    tickSeconds: options.config.routineTickSeconds,
    maxConcurrent: options.config.maxConcurrentRuns,
    ...options.routineLimits
  })
  registerRoutineRoutes(app, ctx, routines)
  registerPullRoutes(app, ctx)
  registerWatcherRoutes(
    app,
    ctx,
    new Watcher(ctx, { staleHours: options.config.staleHours, reviewHours: options.config.reviewHours }),
    options.config.watcherIntervalSeconds
  )
  registerRealtimeRoutes(app, ctx)

  const webDir = options.config.webDir
  if (webDir && existsSync(join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false })
    // A interface tem rotas próprias (ex.: /convite/abc); todas carregam o index.html.
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html')
      }
      return reply.status(404).send({ error: 'Rota não encontrada.' })
    })
  }

  const cleanup = setInterval(() => deleteExpiredSessions(ctx.db, ctx.now()), 60 * 60 * 1000)
  cleanup.unref()
  app.addHook('onClose', async () => {
    clearInterval(cleanup)
    ctx.db.close()
  })

  return { app, ctx, services: { chat, routines } }
}
