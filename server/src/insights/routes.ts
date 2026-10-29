import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ensureAgentsEnabled } from '../agents/workspace.ts'
import { requireUser } from '../auth/guard.ts'
import type { AppContext } from '../context.ts'
import { HttpError, parse, parseId } from '../http/errors.ts'
import { getProject } from '../projects/store.ts'
import { getTask } from '../tasks/store.ts'
import type { Insights } from './insights.ts'
import { listPendingLearnings } from './store.ts'

const applySchema = z.object({ text: z.string().trim().min(5).max(600).optional() })

export function registerInsightRoutes(app: FastifyInstance, ctx: AppContext, insights: Insights): void {
  function loadTask(id: unknown) {
    const task = getTask(ctx.db, parseId(id))
    if (!task) throw new HttpError(404, 'Task não encontrada.')
    return task
  }

  // Resumo e aprendizados de uma task.
  app.get('/api/tasks/:id/insights', async (request) => {
    requireUser(request)
    return insights.taskInsights(loadTask((request.params as { id: string }).id).id)
  })

  // Escreve (ou reescreve) o resumo com o Claude de quem pediu.
  app.post('/api/tasks/:id/summary', async (request) => {
    const user = requireUser(request)
    const task = loadTask((request.params as { id: string }).id)
    if (task.status !== 'done') throw new HttpError(400, 'O resumo é feito quando a task está concluída.')
    ensureAgentsEnabled(ctx)
    void insights.summarize(task, user).catch((error) => app.log.warn(error, 'Falha no resumo da task.'))
    return insights.taskInsights(task.id)
  })

  // Aprendizados esperando aprovação no projeto (aparecem no Vigia).
  app.get('/api/projects/:id/learnings', async (request) => {
    requireUser(request)
    const project = getProject(ctx.db, parseId((request.params as { id: string }).id))
    if (!project) throw new HttpError(404, 'Projeto não encontrado.')
    return { learnings: listPendingLearnings(ctx.db, project.id) }
  })

  // Qualquer pessoa da equipe aprova (podendo ajustar o texto) ou descarta.
  app.post('/api/learnings/:id/apply', async (request) => {
    const user = requireUser(request)
    const { text } = parse(applySchema, request.body ?? {})
    return { learning: await insights.applyLearning(parseId((request.params as { id: string }).id), user, text) }
  })

  app.post('/api/learnings/:id/dismiss', async (request) => {
    const user = requireUser(request)
    return { learning: insights.dismissLearning(parseId((request.params as { id: string }).id), user) }
  })
}
