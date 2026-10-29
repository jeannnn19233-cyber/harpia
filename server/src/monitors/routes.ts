import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireUser } from '../auth/guard.ts'
import { listUsers } from '../auth/users.ts'
import type { AppContext } from '../context.ts'
import { HttpError, parse, parseId } from '../http/errors.ts'
import { getProject } from '../projects/store.ts'
import type { ProjectMonitors } from './monitor.ts'
import { emptyMonitor, getMonitor, listMonitorEvents, publicMonitor, saveMonitorConfig } from './store.ts'

const configSchema = z.object({
  enabled: z.boolean(),
  coolifyAppUuid: z.string().trim().max(100).regex(/^[A-Za-z0-9_-]*$/, 'Identificador da aplicação inválido.'),
  healthChecks: z
    .array(
      z.object({
        url: z
          .string()
          .trim()
          .url('Endereço inválido.')
          .refine((value) => /^https?:\/\//.test(value), 'Use um endereço http ou https.'),
        expect: z.record(z.string().trim().min(1).max(60), z.string().trim().max(200)).default({})
      })
    )
    .max(10)
    .default([]),
  timezone: z
    .string()
    .trim()
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('pt-BR', { timeZone: value })
        return true
      } catch {
        return false
      }
    }, 'Fuso horário inválido.'),
  notifyUserIds: z.array(z.number().int().positive()).max(50).default([])
})

export function registerMonitorRoutes(app: FastifyInstance, ctx: AppContext, monitors: ProjectMonitors): void {
  app.addHook('onReady', async () => monitors.start())
  app.addHook('preClose', async () => monitors.stop())

  function loadProject(id: unknown) {
    const project = getProject(ctx.db, parseId(id))
    if (!project) throw new HttpError(404, 'Projeto não encontrado.')
    return project
  }

  app.get('/api/projects/:id/monitor', async (request) => {
    requireUser(request)
    const project = loadProject((request.params as { id: string }).id)
    const monitor = getMonitor(ctx.db, project.id)
    return {
      monitor: monitor ? publicMonitor(monitor) : emptyMonitor(project.id),
      events: listMonitorEvents(ctx.db, project.id),
      coolifyConfigured: monitors.configured
    }
  })

  // Aplicações que o token do Coolify enxerga, para escolher na tela.
  app.get('/api/monitor/applications', async (request) => {
    requireUser(request)
    if (!monitors.coolify) throw new HttpError(400, 'O servidor não tem HARPIA_COOLIFY_URL e HARPIA_COOLIFY_TOKEN (veja docs/COOLIFY.md).')
    try {
      return { applications: await monitors.coolify.listApplications() }
    } catch (error) {
      throw new HttpError(502, `Não consegui falar com o Coolify: ${(error as Error).message.slice(0, 200)}`)
    }
  })

  app.put('/api/projects/:id/monitor', async (request) => {
    requireUser(request)
    const project = loadProject((request.params as { id: string }).id)
    const input = parse(configSchema, request.body)
    const known = new Set(listUsers(ctx.db).map((user) => user.id))
    if (input.notifyUserIds.some((id) => !known.has(id))) throw new HttpError(404, 'Pessoa não encontrada.')
    if (input.enabled && !input.coolifyAppUuid) throw new HttpError(400, 'Escolha a aplicação do Coolify antes de ligar os vigias.')
    const monitor = saveMonitorConfig(ctx.db, project.id, input, ctx.now())
    ctx.hub.broadcast({ type: 'monitor', monitor: publicMonitor(monitor) })
    return { monitor: publicMonitor(monitor) }
  })

  // Confere agora, sem esperar a próxima volta.
  app.post('/api/projects/:id/monitor/check', async (request) => {
    requireUser(request)
    const project = loadProject((request.params as { id: string }).id)
    const monitor = await monitors.check(project.id)
    return { monitor: monitor ? publicMonitor(monitor) : emptyMonitor(project.id), events: listMonitorEvents(ctx.db, project.id) }
  })
}
