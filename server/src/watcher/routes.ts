import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { PROJECT_MEMORY_LIMIT } from '../../../shared/types.ts'
import { requireUser } from '../auth/guard.ts'
import type { AppContext } from '../context.ts'
import { HttpError, parse, parseId } from '../http/errors.ts'
import { getMemory, saveMemory } from '../memory/store.ts'
import { getProject } from '../projects/store.ts'
import { findSimilarTasks } from '../search/similar.ts'
import { dismissFinding, getFinding, listOpenFindings } from './store.ts'
import type { Watcher } from './watcher.ts'

const memorySchema = z.object({ body: z.string().max(PROJECT_MEMORY_LIMIT) })

export function registerWatcherRoutes(app: FastifyInstance, ctx: AppContext, watcher: Watcher, intervalSeconds: number): void {
  const timer = setInterval(() => {
    void watcher.sweep().catch((error) => app.log.warn(error, 'Falha na varredura do vigia.'))
  }, intervalSeconds * 1000)
  timer.unref()
  app.addHook('onReady', async () => {
    void watcher.sweep().catch((error) => app.log.warn(error, 'Falha na varredura do vigia.'))
    await ctx.notifier.start()
  })
  app.addHook('preClose', async () => {
    clearInterval(timer)
    ctx.notifier.stop()
  })

  function loadProject(id: unknown) {
    const project = getProject(ctx.db, parseId(id))
    if (!project) throw new HttpError(404, 'Projeto não encontrado.')
    return project
  }

  app.get('/api/projects/:id/findings', async (request) => {
    const project = loadProject((request.params as { id: string }).id)
    return { findings: listOpenFindings(ctx.db, project.id) }
  })

  // "Verificar agora": roda o vigia sem esperar a próxima varredura.
  app.post('/api/projects/:id/findings/check', async (request) => {
    const project = loadProject((request.params as { id: string }).id)
    await watcher.sweep()
    return { findings: listOpenFindings(ctx.db, project.id) }
  })

  app.post('/api/findings/:id/dismiss', async (request) => {
    const user = requireUser(request)
    const finding = getFinding(ctx.db, parseId((request.params as { id: string }).id))
    if (!finding) throw new HttpError(404, 'Aviso não encontrado.')
    const updated = dismissFinding(ctx.db, finding.id, user.id, ctx.now())
    if (updated) ctx.hub.broadcast({ type: 'finding', finding: updated })
    return { finding: updated }
  })

  // Tasks parecidas com um texto (usado enquanto a pessoa digita o título de uma task nova).
  app.get('/api/projects/:id/similar-tasks', async (request) => {
    const project = loadProject((request.params as { id: string }).id)
    const query = request.query as { q?: string; exclude?: string }
    const text = (query.q ?? '').slice(0, 300)
    return {
      tasks: findSimilarTasks(ctx.db, {
        projectId: project.id,
        text,
        excludeTaskId: query.exclude ? Number(query.exclude) : undefined
      })
    }
  })

  app.get('/api/projects/:id/memory', async (request) => {
    const project = loadProject((request.params as { id: string }).id)
    return { memory: getMemory(ctx.db, project.id) }
  })

  app.put('/api/projects/:id/memory', async (request) => {
    const user = requireUser(request)
    const project = loadProject((request.params as { id: string }).id)
    const { body } = parse(memorySchema, request.body)
    const memory = saveMemory(ctx.db, { projectId: project.id, body: body.trim(), userId: user.id, now: ctx.now() })
    ctx.hub.broadcast({ type: 'memory', memory })
    return { memory }
  })

  app.get('/api/me/notifications', async (request) => {
    const user = requireUser(request)
    return {
      settings: {
        telegram: {
          available: ctx.notifier.available(),
          botUsername: ctx.notifier.botUsername,
          linked: ctx.notifier.isLinked(user.id)
        }
      }
    }
  })

  app.post('/api/me/notifications/telegram', async (request) => {
    const user = requireUser(request)
    if (!ctx.notifier.available()) {
      throw new HttpError(503, 'O bot do Telegram não está configurado. Um administrador define HARPIA_TELEGRAM_BOT_TOKEN.')
    }
    return { link: ctx.notifier.createLinkCode(user.id) }
  })

  app.delete('/api/me/notifications/telegram', async (request) => {
    const user = requireUser(request)
    ctx.notifier.unlink(user.id)
    return { ok: true }
  })
}
