import { existsSync } from 'node:fs'
import { join } from 'node:path'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { registerAuthGuard } from './auth/guard.ts'
import { registerAuthRoutes } from './auth/routes.ts'
import { deleteExpiredSessions } from './auth/sessions.ts'
import type { AppConfig, AppContext } from './context.ts'
import { openDatabase } from './db/index.ts'
import { registerErrorHandler } from './http/errors.ts'
import { systemGit, type GitRunner } from './projects/git.ts'
import { registerProjectRoutes } from './projects/routes.ts'
import { RealtimeHub } from './realtime/hub.ts'
import { registerRealtimeRoutes } from './realtime/routes.ts'
import { registerTaskRoutes } from './tasks/routes.ts'

export interface BuildOptions {
  config: AppConfig
  logger?: FastifyServerOptions['logger']
  git?: GitRunner
  now?: () => Date
}

export async function buildApp(options: BuildOptions): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1024 * 1024 })
  const ctx: AppContext = {
    db: openDatabase(join(options.config.dataDir, 'harpia.db')),
    hub: new RealtimeHub(),
    config: options.config,
    git: options.git ?? systemGit,
    now: options.now ?? (() => new Date())
  }

  registerErrorHandler(app)
  await app.register(cookie)
  await app.register(websocket)
  registerAuthGuard(app, ctx)

  registerAuthRoutes(app, ctx)
  registerProjectRoutes(app, ctx)
  registerTaskRoutes(app, ctx)
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

  return { app, ctx }
}
