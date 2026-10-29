import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { PullRequest, TaskEvent } from '../../../shared/types.ts'
import { getWorktree } from '../agents/store.ts'
import { ensureAgentsEnabled, publishTaskChange } from '../agents/workspace.ts'
import { requireUser } from '../auth/guard.ts'
import type { AppContext } from '../context.ts'
import { transaction } from '../db/index.ts'
import { parseGitHubRepo } from '../github/client.ts'
import { HttpError, parse, parseId } from '../http/errors.ts'
import { projectPath } from '../projects/routes.ts'
import { getProject } from '../projects/store.ts'
import { addParticipant, endOfColumn, getTask, insertEvent, updateTaskRow } from '../tasks/store.ts'
import {
  countOpenPulls,
  getPull,
  insertPull,
  listOpenPulls,
  listProjectPulls,
  listTaskPulls,
  setPullState,
  touchPull
} from './store.ts'

const openSchema = z.object({
  title: z.string().trim().min(1).max(250),
  body: z.string().max(60000).default(''),
  commitMessage: z.string().trim().max(500).optional()
})

export function registerPullRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Evita dois envios ao mesmo tempo da mesma pessoa na mesma task (ex.: clique duplo).
  const busy = new Set<string>()

  function publishPull(pull: PullRequest | null): void {
    if (pull) ctx.hub.broadcast({ type: 'pull_request', pullRequest: pull })
  }

  function loadTaskAndRepo(taskId: unknown) {
    const task = getTask(ctx.db, parseId(taskId))
    if (!task) throw new HttpError(404, 'Task não encontrada.')
    const project = getProject(ctx.db, task.projectId)
    if (!project) throw new HttpError(404, 'Projeto não encontrado.')
    return { task, project }
  }

  // Confere no GitHub se o PR teve merge ou foi fechado. Com o último PR da task
  // aceito, a task vai sozinha para "Feito".
  async function checkPull(pull: PullRequest): Promise<void> {
    const task = getTask(ctx.db, pull.taskId)
    const project = task ? getProject(ctx.db, task.projectId) : null
    const repo = project ? parseGitHubRepo(project.repoUrl) : null
    if (!task || !repo) return
    const info = await ctx.github.getPullRequest(repo, pull.number)
    if (info.state === 'open') return

    const merged = info.merged
    const result = transaction(ctx.db, () => {
      const now = ctx.now()
      const current = getPull(ctx.db, pull.id)
      if (!current || current.state !== 'open') return null
      const updated = setPullState(ctx.db, pull.id, merged ? 'merged' : 'closed', now)
      const events: TaskEvent[] = [
        insertEvent(ctx.db, {
          taskId: task.id,
          actorId: null,
          type: merged ? 'pr_merged' : 'pr_closed',
          data: { number: pull.number, url: pull.url, userId: pull.userId },
          now
        })
      ]
      const fresh = getTask(ctx.db, task.id)
      if (merged && fresh && fresh.status !== 'done' && countOpenPulls(ctx.db, task.id) === 0) {
        updateTaskRow(
          ctx.db,
          task.id,
          { status: 'done', closedAt: now.toISOString(), position: endOfColumn(ctx.db, task.projectId, 'done') },
          now
        )
        events.push(
          insertEvent(ctx.db, {
            taskId: task.id,
            actorId: null,
            type: 'status_changed',
            data: { from: fresh.status, to: 'done', reason: 'merged', number: pull.number },
            now
          })
        )
      }
      return { updated, events }
    })
    if (!result) return
    publishPull(result.updated)
    publishTaskChange(ctx, task.id, result.events)
    const done = result.events.some((event) => event.type === 'status_changed')
    const people = [...new Set([pull.userId, ...task.participantIds, ...(task.ownerId ? [task.ownerId] : [])])]
    const text = merged
      ? `O PR #${pull.number} teve merge${done ? ` e a task T-${task.number} "${task.title}" foi concluída.` : ` (T-${task.number} "${task.title}").`}`
      : `O PR #${pull.number} de T-${task.number} "${task.title}" foi fechado sem merge.`
    await ctx.notifier.notifyUsers(people, text)
  }

  let checking = false
  async function checkAll(): Promise<void> {
    if (checking) return
    checking = true
    try {
      for (const pull of listOpenPulls(ctx.db)) {
        try {
          await checkPull(pull)
        } catch (error) {
          app.log.warn(error, `Não foi possível conferir o PR #${pull.number}.`)
        }
      }
    } finally {
      checking = false
    }
  }
  const poller = setInterval(() => void checkAll(), ctx.config.prPollSeconds * 1000)
  poller.unref()
  app.addHook('preClose', async () => clearInterval(poller))

  app.get('/api/projects/:id/pull-requests', async (request) => {
    const projectId = parseId((request.params as { id: string }).id)
    return { pullRequests: listProjectPulls(ctx.db, projectId) }
  })

  app.get('/api/tasks/:id/pull-requests', async (request) => {
    const { task } = loadTaskAndRepo((request.params as { id: string }).id)
    return { pullRequests: listTaskPulls(ctx.db, task.id) }
  })

  // O que a pessoa mudou na própria cópia, para conferir antes de abrir o PR.
  app.get('/api/tasks/:id/changes', async (request) => {
    const user = requireUser(request)
    const { task, project } = loadTaskAndRepo((request.params as { id: string }).id)
    ensureAgentsEnabled(ctx)
    const worktree = getWorktree(ctx.db, task.id, user.id)
    if (!worktree) return { hasWorktree: false, branch: null, files: [], uncommitted: false }
    try {
      const [files, uncommitted] = await Promise.all([
        ctx.agents.changedFiles({ user, path: worktree.path, base: project.defaultBranch }),
        ctx.agents.hasUncommittedChanges({ user, path: worktree.path })
      ])
      return { hasWorktree: true, branch: worktree.branch, files, uncommitted }
    } catch (error) {
      throw new HttpError(500, `Não foi possível ler suas alterações: ${(error as Error).message}`)
    }
  })

  // Abre o PR com as alterações da pessoa (ou envia novas alterações para o PR já aberto).
  app.post('/api/tasks/:id/pull-requests', async (request) => {
    const user = requireUser(request)
    const { task, project } = loadTaskAndRepo((request.params as { id: string }).id)
    const input = parse(openSchema, request.body)
    ensureAgentsEnabled(ctx)
    const repo = parseGitHubRepo(project.repoUrl)
    if (!repo) throw new HttpError(400, 'O Harpia só abre pull requests em repositórios do GitHub.')
    const worktree = getWorktree(ctx.db, task.id, user.id)
    if (!worktree) {
      throw new HttpError(409, 'Você ainda não tem uma cópia do código nesta task. Abra uma conversa ou o terminal primeiro.')
    }

    const key = `${task.id}:${user.id}`
    if (busy.has(key)) throw new HttpError(409, 'Seu envio anterior ainda está em andamento.')
    busy.add(key)
    try {
      const step = async <T>(label: string, action: () => Promise<T>): Promise<T> => {
        try {
          return await action()
        } catch (error) {
          throw new HttpError(502, `${label}: ${(error as Error).message}`)
        }
      }
      const { path, branch } = worktree
      if (await step('Não foi possível ler suas alterações', () => ctx.agents.hasUncommittedChanges({ user, path }))) {
        const message = input.commitMessage || `T-${task.number}: ${task.title}`
        await step('Não foi possível criar o commit', () => ctx.agents.commitAll({ user, path, message }))
      }
      const ahead = await step('Não foi possível comparar com a branch principal', () =>
        ctx.agents.commitsAhead({ user, path, base: project.defaultBranch })
      )
      if (ahead === 0) throw new HttpError(409, 'Não há alterações para enviar.')

      const mirror = projectPath(ctx, project)
      const bundle = await step('Não foi possível empacotar sua branch', () => ctx.agents.exportBranch({ user, path, branch }))
      await step('Não foi possível levar sua branch ao servidor', () => ctx.git.importBundle(mirror, bundle, branch))
      await step('O GitHub recusou o envio da branch', () => ctx.git.push(mirror, project.repoUrl, branch))

      const existing = listTaskPulls(ctx.db, task.id).find(
        (pull) => pull.userId === user.id && pull.branch === branch && pull.state === 'open'
      )
      if (existing) {
        const events = transaction(ctx.db, () => [
          insertEvent(ctx.db, {
            taskId: task.id,
            actorId: user.id,
            type: 'pr_updated',
            data: { number: existing.number, url: existing.url },
            now: ctx.now()
          })
        ])
        const updated = touchPull(ctx.db, existing.id, ctx.now())
        publishPull(updated)
        publishTaskChange(ctx, task.id, events)
        return { pullRequest: updated, created: false }
      }

      const info = await step('Não foi possível abrir o pull request no GitHub', async () => {
        const found = await ctx.github.findOpenPullRequest(repo, branch)
        if (found) return found
        const body = `${input.body}\n\n---\nAberto pelo Harpia · task T-${task.number}: ${task.title}`.trim()
        return ctx.github.createPullRequest(repo, { title: input.title, body, head: branch, base: project.defaultBranch })
      })

      const { pull, events } = transaction(ctx.db, () => {
        const now = ctx.now()
        const created = insertPull(ctx.db, {
          taskId: task.id,
          userId: user.id,
          number: info.number,
          url: info.url,
          branch,
          base: project.defaultBranch,
          now
        })
        const list: TaskEvent[] = [
          insertEvent(ctx.db, {
            taskId: task.id,
            actorId: user.id,
            type: 'pr_opened',
            data: { number: info.number, url: info.url, branch },
            now
          })
        ]
        if (addParticipant(ctx.db, task.id, user.id, now)) {
          list.push(
            insertEvent(ctx.db, { taskId: task.id, actorId: user.id, type: 'participant_joined', data: { userId: user.id, reason: 'agent' }, now })
          )
        }
        // Com PR aberto, a task vai para revisão.
        const fresh = getTask(ctx.db, task.id)
        if (fresh && (fresh.status === 'backlog' || fresh.status === 'in_progress')) {
          updateTaskRow(
            ctx.db,
            task.id,
            { status: 'review', position: endOfColumn(ctx.db, task.projectId, 'review'), ownerId: fresh.ownerId ?? user.id },
            now
          )
          list.push(
            insertEvent(ctx.db, {
              taskId: task.id,
              actorId: user.id,
              type: 'status_changed',
              data: { from: fresh.status, to: 'review', reason: 'pr_opened', number: info.number },
              now
            })
          )
        }
        return { pull: created, events: list }
      })
      publishPull(pull)
      publishTaskChange(ctx, task.id, events)
      return { pullRequest: pull, created: true }
    } finally {
      busy.delete(key)
    }
  })

  // "Verificar agora": confere no GitHub os PRs abertos da task sem esperar o próximo minuto.
  app.post('/api/tasks/:id/pull-requests/refresh', async (request) => {
    const { task } = loadTaskAndRepo((request.params as { id: string }).id)
    for (const pull of listTaskPulls(ctx.db, task.id).filter((item) => item.state === 'open')) {
      try {
        await checkPull(pull)
      } catch (error) {
        throw new HttpError(502, `Não foi possível conferir o PR #${pull.number}: ${(error as Error).message}`)
      }
    }
    return { pullRequests: listTaskPulls(ctx.db, task.id) }
  })

}
