import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Project } from '../../../shared/types.ts'
import type { AppContext } from '../context.ts'
import { requireUser } from '../auth/guard.ts'
import { HttpError, parse, parseId } from '../http/errors.ts'
import { getProject, insertProject, listProjects, uniqueSlug, updateCloneState } from './store.ts'

const projectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  repoUrl: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .regex(/^(https:\/\/|ssh:\/\/|git@[^:\s]+:|\/)/, 'use https://, ssh://, git@host:caminho ou um caminho local'),
  defaultBranch: z
    .string()
    .trim()
    .max(200)
    .regex(/^[A-Za-z0-9._\/-]*$/, 'nome de branch inválido')
    .refine((value) => !value.startsWith('-'), 'nome de branch inválido')
    .optional()
})

export function projectPath(ctx: AppContext, project: Project): string {
  return join(ctx.config.reposDir, project.slug)
}

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Clones em andamento. O servidor espera por eles antes de fechar o banco.
  const running = new Set<Promise<void>>()
  app.addHook('preClose', async () => {
    await Promise.allSettled(running)
  })

  function startClone(project: Project): void {
    const job = cloneProject(project).finally(() => running.delete(job))
    running.add(job)
  }

  // Clona em segundo plano e avisa a equipe quando termina.
  async function cloneProject(project: Project): Promise<void> {
    const destination = projectPath(ctx, project)
    const publish = (updated: Project | null) => {
      if (updated) ctx.hub.broadcast({ type: 'project', project: updated })
    }
    publish(updateCloneState(ctx.db, project.id, { status: 'cloning' }))
    try {
      await rm(destination, { recursive: true, force: true })
      await ctx.git.clone({
        repoUrl: project.repoUrl,
        destination,
        branch: project.defaultBranch || null
      })
      const branch = await ctx.git.currentBranch(destination)
      publish(updateCloneState(ctx.db, project.id, { status: 'ready', defaultBranch: branch }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      publish(updateCloneState(ctx.db, project.id, { status: 'error', error: message.slice(0, 2000) }))
    }
  }

  app.get('/api/projects', async () => ({ projects: listProjects(ctx.db) }))

  app.get('/api/projects/:id', async (request) => {
    const project = getProject(ctx.db, parseId((request.params as { id: string }).id))
    if (!project) throw new HttpError(404, 'Projeto não encontrado.')
    return { project }
  })

  app.post('/api/projects', async (request) => {
    const user = requireUser(request)
    const input = parse(projectSchema, request.body)
    const project = insertProject(ctx.db, {
      name: input.name,
      slug: uniqueSlug(ctx.db, input.name),
      repoUrl: input.repoUrl,
      defaultBranch: input.defaultBranch ?? '',
      createdBy: user.id,
      now: ctx.now()
    })
    ctx.hub.broadcast({ type: 'project', project })
    startClone(project)
    return { project }
  })

  app.post('/api/projects/:id/clone', async (request) => {
    const project = getProject(ctx.db, parseId((request.params as { id: string }).id))
    if (!project) throw new HttpError(404, 'Projeto não encontrado.')
    if (project.cloneStatus === 'cloning') throw new HttpError(409, 'O repositório já está sendo clonado.')
    startClone(project)
    return { project: { ...project, cloneStatus: 'cloning' } }
  })
}
