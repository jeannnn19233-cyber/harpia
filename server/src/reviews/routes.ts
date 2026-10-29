import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ensureAgentsEnabled } from '../agents/workspace.ts'
import { requireUser } from '../auth/guard.ts'
import { getUser } from '../auth/users.ts'
import type { AppContext } from '../context.ts'
import { parseGitHubRepo } from '../github/client.ts'
import { HttpError, parse, parseId } from '../http/errors.ts'
import { getProject, getReviewSettings, setProjectReview, updateReviewSettings } from '../projects/store.ts'
import { carregarMemoria, listarLicoes } from './memory.ts'
import type { PrReviewer } from './reviewer.ts'
import { listProjectJobs, publicJob } from './store.ts'

const toggleSchema = z.object({ enabled: z.boolean() })
const requestSchema = z.object({ number: z.coerce.number().int().positive() })
const settingsSchema = z.object({
  defaultReviewerId: z.number().int().positive().nullable().optional(),
  rules: z.string().max(200000).optional()
})
const answerSchema = z.object({ text: z.string().trim().min(1).max(4000) })

export function registerReviewRoutes(app: FastifyInstance, ctx: AppContext, reviewer: PrReviewer): void {
  app.addHook('onReady', async () => reviewer.start())
  app.addHook('preClose', async () => reviewer.stop())

  function loadProject(id: unknown) {
    const project = getProject(ctx.db, parseId(id))
    if (!project) throw new HttpError(404, 'Projeto não encontrado.')
    return project
  }

  app.get('/api/projects/:id/reviews', async (request) => {
    requireUser(request)
    const project = loadProject((request.params as { id: string }).id)
    const settings = getReviewSettings(ctx.db, project.id)
    return {
      reviews: listProjectJobs(ctx.db, project.id).map(publicJob),
      github: parseGitHubRepo(project.repoUrl) !== null,
      settings: { prReview: project.prReview, defaultReviewerId: project.defaultReviewerId, rules: settings.rules },
      lessons: listarLicoes(ctx.db, project.id)
    }
  })

  // Liga ou desliga o revisor de PRs do projeto.
  app.put('/api/projects/:id/review', async (request) => {
    requireUser(request)
    const project = loadProject((request.params as { id: string }).id)
    const { enabled } = parse(toggleSchema, request.body)
    if (enabled && !parseGitHubRepo(project.repoUrl)) throw new HttpError(400, 'O revisor só funciona com repositórios do GitHub.')
    const updated = setProjectReview(ctx.db, project.id, enabled, ctx.now())
    if (updated) ctx.hub.broadcast({ type: 'project', project: updated })
    return { project: updated }
  })

  // Revisor padrão e as regras do revisor (a "skill"), que ficam só no servidor.
  app.patch('/api/projects/:id/review-settings', async (request) => {
    requireUser(request)
    const project = loadProject((request.params as { id: string }).id)
    const input = parse(settingsSchema, request.body)
    if (input.defaultReviewerId && !getUser(ctx.db, input.defaultReviewerId)) throw new HttpError(404, 'Pessoa não encontrada.')
    const updated = updateReviewSettings(ctx.db, project.id, input)
    if (updated) ctx.hub.broadcast({ type: 'project', project: updated })
    const settings = getReviewSettings(ctx.db, project.id)
    return { settings: { prReview: project.prReview, defaultReviewerId: updated?.defaultReviewerId ?? null, rules: settings.rules } }
  })

  // Revisa um PR agora, com o revisor de quem pediu.
  app.post('/api/projects/:id/reviews', async (request) => {
    const user = requireUser(request)
    const project = loadProject((request.params as { id: string }).id)
    const { number } = parse(requestSchema, request.body)
    ensureAgentsEnabled(ctx)
    return { review: publicJob(await reviewer.requestReview(project, number, user)) }
  })

  // Confere os PRs abertos agora, sem esperar a próxima volta.
  app.post('/api/projects/:id/reviews/check', async (request) => {
    requireUser(request)
    const project = loadProject((request.params as { id: string }).id)
    await reviewer.poll()
    return { reviews: listProjectJobs(ctx.db, project.id).map(publicJob) }
  })

  app.post('/api/reviews/:id/answer', async (request) => {
    const user = requireUser(request)
    const { text } = parse(answerSchema, request.body)
    return { review: publicJob(reviewer.answer(parseId((request.params as { id: string }).id), user, text)) }
  })

  app.post('/api/reviews/:id/retry', async (request) => {
    const user = requireUser(request)
    return { review: publicJob(reviewer.retry(parseId((request.params as { id: string }).id), user)) }
  })

  // Memória por achado de um PR (o que já foi apontado e o que já foi resolvido).
  app.get('/api/projects/:id/pulls/:number/memory', async (request) => {
    requireUser(request)
    const params = request.params as { id: string; number: string }
    const project = loadProject(params.id)
    return { memory: carregarMemoria(ctx.db, project.id, parseId(params.number)) }
  })
}
