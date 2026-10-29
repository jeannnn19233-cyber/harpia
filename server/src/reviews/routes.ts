import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ensureAgentsEnabled } from '../agents/workspace.ts'
import { requireUser } from '../auth/guard.ts'
import type { AppContext } from '../context.ts'
import { parseGitHubRepo } from '../github/client.ts'
import { HttpError, parse, parseId } from '../http/errors.ts'
import { getProject, setProjectReview } from '../projects/store.ts'
import type { PrReviewer } from './reviewer.ts'
import { listProjectReviews } from './store.ts'

const toggleSchema = z.object({ enabled: z.boolean() })
const requestSchema = z.object({ number: z.coerce.number().int().positive() })

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
    return { reviews: listProjectReviews(ctx.db, project.id), github: parseGitHubRepo(project.repoUrl) !== null }
  })

  // Liga ou desliga a revisão automática dos PRs do projeto.
  app.put('/api/projects/:id/review', async (request) => {
    requireUser(request)
    const project = loadProject((request.params as { id: string }).id)
    const { enabled } = parse(toggleSchema, request.body)
    if (enabled && !parseGitHubRepo(project.repoUrl)) throw new HttpError(400, 'A revisão automática só funciona com repositórios do GitHub.')
    const updated = setProjectReview(ctx.db, project.id, enabled)
    if (updated) ctx.hub.broadcast({ type: 'project', project: updated })
    return { project: updated }
  })

  // Revisa um PR agora, com o Claude de quem pediu.
  app.post('/api/projects/:id/reviews', async (request) => {
    const user = requireUser(request)
    const project = loadProject((request.params as { id: string }).id)
    const { number } = parse(requestSchema, request.body)
    ensureAgentsEnabled(ctx)
    return { review: await reviewer.requestReview(project, number, user) }
  })

  // Confere os PRs abertos agora, sem esperar a próxima volta.
  app.post('/api/projects/:id/reviews/check', async (request) => {
    requireUser(request)
    const project = loadProject((request.params as { id: string }).id)
    await reviewer.poll()
    return { reviews: listProjectReviews(ctx.db, project.id) }
  })
}
