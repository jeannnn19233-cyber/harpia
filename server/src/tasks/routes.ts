import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { TASK_STATUSES, type Task, type TaskEvent } from '../../../shared/types.ts'
import type { AppContext } from '../context.ts'
import { requireAdmin, requireUser } from '../auth/guard.ts'
import { getUser, listUsers } from '../auth/users.ts'
import { transaction } from '../db/index.ts'
import { HttpError, parse, parseId } from '../http/errors.ts'
import { getProject } from '../projects/store.ts'
import { countOpenPulls, listTaskPulls } from '../pulls/store.ts'
import {
  addParticipant,
  endOfColumn,
  getTask,
  insertEvent,
  insertTask,
  isParticipant,
  listEvents,
  listTasks,
  removeParticipant,
  updateTaskRow
} from './store.ts'
import { existingByExternal, importSchema, planImport, type ImportPlan } from './import.ts'

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20000).default(''),
  ownerId: z.number().int().positive().nullable().default(null)
})

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(20000),
    status: z.enum(TASK_STATUSES),
    ownerId: z.number().int().positive().nullable(),
    position: z.number().finite()
  })
  .partial()

const commentSchema = z.object({
  body: z.string().trim().min(1).max(20000)
})

export function registerTaskRoutes(app: FastifyInstance, ctx: AppContext): void {
  function loadTask(id: unknown): Task {
    const task = getTask(ctx.db, parseId(id))
    if (!task) throw new HttpError(404, 'Task não encontrada.')
    return task
  }

  function ensureUserExists(userId: number): void {
    if (!getUser(ctx.db, userId)) throw new HttpError(400, 'Responsável não encontrado.')
  }

  // Avisa a equipe e devolve a task atualizada.
  function publish(taskId: number, events: TaskEvent[]): { task: Task; events: TaskEvent[] } {
    const task = getTask(ctx.db, taskId)
    if (!task) throw new HttpError(404, 'Task não encontrada.')
    ctx.hub.broadcast({ type: 'task', task })
    for (const event of events) ctx.hub.broadcast({ type: 'task_event', event })
    return { task, events }
  }

  // Aplica a mudança numa transação e publica o resultado.
  function commit(taskId: number, change: () => TaskEvent[]): { task: Task; events: TaskEvent[] } {
    return publish(taskId, transaction(ctx.db, change))
  }

  app.get('/api/projects/:id/tasks', async (request) => {
    const projectId = parseId((request.params as { id: string }).id)
    if (!getProject(ctx.db, projectId)) throw new HttpError(404, 'Projeto não encontrado.')
    return { tasks: listTasks(ctx.db, projectId) }
  })

  app.post('/api/projects/:id/tasks', async (request) => {
    const user = requireUser(request)
    const projectId = parseId((request.params as { id: string }).id)
    if (!getProject(ctx.db, projectId)) throw new HttpError(404, 'Projeto não encontrado.')
    const input = parse(createSchema, request.body)
    if (input.ownerId !== null) ensureUserExists(input.ownerId)

    const { taskId, events } = transaction(ctx.db, () => {
      const now = ctx.now()
      const created = insertTask(ctx.db, { ...input, projectId, createdBy: user.id, now })
      const event = insertEvent(ctx.db, {
        taskId: created.id,
        actorId: user.id,
        type: 'created',
        data: { ownerId: input.ownerId },
        now
      })
      return { taskId: created.id, events: [event] }
    })
    return { task: publish(taskId, events).task }
  })

  // Importar um quadro de outro lugar (o arquivo pode ter perto de 1 MB).
  const IMPORT_BODY_LIMIT = 8 * 1024 * 1024
  const summary = (plan: ImportPlan) => ({
    create: plan.create,
    update: plan.update,
    unchanged: plan.unchanged,
    byStatus: plan.byStatus,
    unknownOwners: plan.unknownOwners,
    invalid: plan.invalid,
    skippedDone: plan.skippedDone
  })
  const loadImport = (request: { params: unknown; body: unknown }) => {
    const projectId = parseId((request.params as { id: string }).id)
    if (!getProject(ctx.db, projectId)) throw new HttpError(404, 'Projeto não encontrado.')
    const { tarefas, incluirFeitas } = parse(importSchema, request.body)
    return { projectId, plan: planImport(tarefas, listUsers(ctx.db), existingByExternal(ctx.db, projectId), incluirFeitas) }
  }

  // O que a importação vai fazer, sem gravar nada.
  app.post('/api/projects/:id/import/preview', { bodyLimit: IMPORT_BODY_LIMIT }, async (request) => {
    requireAdmin(request)
    return { plan: summary(loadImport(request).plan) }
  })

  // Cria as tasks novas e atualiza as que mudaram na origem, numa transação só; cada criação e
  // mudança vira evento no histórico da task e chega ao vivo para a equipe.
  app.post('/api/projects/:id/import', { bodyLimit: IMPORT_BODY_LIMIT }, async (request) => {
    const user = requireAdmin(request)
    const { projectId, plan } = loadImport(request)
    const touched = transaction(ctx.db, () => {
      const now = ctx.now()
      const changes: { taskId: number; events: TaskEvent[] }[] = []
      const mark = (taskId: number, externalId: string, hash: string) =>
        ctx.db.prepare('UPDATE tasks SET external_id = ?, external_hash = ? WHERE id = ?').run(externalId, hash, taskId)
      for (const item of plan.cards) {
        if (item.action === 'unchanged') continue
        const events: TaskEvent[] = []
        const log = (taskId: number, type: TaskEvent['type'], data: Record<string, unknown>) =>
          events.push(insertEvent(ctx.db, { taskId, actorId: user.id, type, data, now }))
        if (item.action === 'create') {
          const created = insertTask(ctx.db, { projectId, title: item.title, description: item.description, ownerId: item.ownerId, createdBy: user.id, now })
          mark(created.id, item.card.id, item.hash)
          log(created.id, 'created', { ownerId: item.ownerId, importedFrom: item.card.id })
          if (item.status !== 'backlog') {
            updateTaskRow(
              ctx.db,
              created.id,
              { status: item.status, position: endOfColumn(ctx.db, projectId, item.status), closedAt: item.status === 'done' ? now.toISOString() : null },
              now
            )
            log(created.id, 'status_changed', { from: 'backlog', to: item.status, reason: 'import' })
          }
          changes.push({ taskId: created.id, events })
          continue
        }
        const before = item.existing
        if (!before) continue
        const fields: Parameters<typeof updateTaskRow>[2] = {}
        const edited: string[] = []
        if (before.title !== item.title) {
          fields.title = item.title
          edited.push('title')
        }
        if (before.description !== item.description) {
          fields.description = item.description
          edited.push('description')
        }
        if (before.status !== item.status) {
          fields.status = item.status
          fields.position = endOfColumn(ctx.db, projectId, item.status)
          fields.closedAt = item.status === 'done' ? now.toISOString() : null
        }
        if (before.ownerId !== item.ownerId) fields.ownerId = item.ownerId
        updateTaskRow(ctx.db, before.id, fields, now)
        mark(before.id, item.card.id, item.hash)
        if (edited.length) log(before.id, 'edited', { fields: edited, reason: 'import' })
        if (before.status !== item.status) log(before.id, 'status_changed', { from: before.status, to: item.status, reason: 'import' })
        if (before.ownerId !== item.ownerId) {
          log(before.id, 'owner_changed', { from: before.ownerId, to: item.ownerId, reason: 'import' })
          if (item.ownerId !== null && addParticipant(ctx.db, before.id, item.ownerId, now)) {
            log(before.id, 'participant_joined', { userId: item.ownerId, reason: 'owner' })
          }
        }
        changes.push({ taskId: before.id, events })
      }
      return changes
    })
    for (const change of touched) publish(change.taskId, change.events)
    return { plan: summary(plan) }
  })

  app.get('/api/tasks/:id', async (request) => {
    const task = loadTask((request.params as { id: string }).id)
    return { task, events: listEvents(ctx.db, task.id) }
  })

  app.patch('/api/tasks/:id', async (request) => {
    const user = requireUser(request)
    const task = loadTask((request.params as { id: string }).id)
    const input = parse(updateSchema, request.body)
    if (input.ownerId !== undefined && input.ownerId !== null) ensureUserExists(input.ownerId)
    // Com PR aberto, "Feito" depende do merge: a task fecha sozinha.
    if (input.status === 'done' && task.status !== 'done' && countOpenPulls(ctx.db, task.id) > 0) {
      const numbers = listTaskPulls(ctx.db, task.id)
        .filter((pull) => pull.state === 'open')
        .map((pull) => `#${pull.number}`)
        .join(', ')
      throw new HttpError(409, `Esta task tem PR aberto (${numbers}). Ela vai para "Feito" sozinha quando o merge for feito.`)
    }

    return commit(task.id, () => {
      const now = ctx.now()
      const events: TaskEvent[] = []
      const log = (type: TaskEvent['type'], data: Record<string, unknown>) =>
        events.push(insertEvent(ctx.db, { taskId: task.id, actorId: user.id, type, data, now }))

      const fields: Parameters<typeof updateTaskRow>[2] = {}

      const edited: string[] = []
      if (input.title !== undefined && input.title !== task.title) {
        fields.title = input.title
        edited.push('title')
      }
      if (input.description !== undefined && input.description !== task.description) {
        fields.description = input.description
        edited.push('description')
      }

      let ownerId = input.ownerId !== undefined ? input.ownerId : task.ownerId
      const statusChanged = input.status !== undefined && input.status !== task.status

      // Quem puxa uma task sem responsável para "Em andamento" passa a ser o responsável.
      if (statusChanged && input.status === 'in_progress' && ownerId === null) ownerId = user.id

      if (statusChanged && input.status) {
        fields.status = input.status
        fields.closedAt = input.status === 'done' ? now.toISOString() : null
        if (input.position === undefined) fields.position = endOfColumn(ctx.db, task.projectId, input.status)
      }
      if (input.position !== undefined) fields.position = input.position
      if (ownerId !== task.ownerId) fields.ownerId = ownerId

      updateTaskRow(ctx.db, task.id, fields, now)

      if (edited.length > 0) log('edited', { fields: edited })
      if (statusChanged) log('status_changed', { from: task.status, to: input.status })
      if (ownerId !== task.ownerId) {
        log('owner_changed', { from: task.ownerId, to: ownerId })
        if (ownerId !== null && addParticipant(ctx.db, task.id, ownerId, now)) {
          log('participant_joined', { userId: ownerId, reason: 'owner' })
        }
      }
      return events
    })
  })

  app.post('/api/tasks/:id/join', async (request) => {
    const user = requireUser(request)
    const task = loadTask((request.params as { id: string }).id)
    return commit(task.id, () => {
      const now = ctx.now()
      if (!addParticipant(ctx.db, task.id, user.id, now)) return []
      return [insertEvent(ctx.db, { taskId: task.id, actorId: user.id, type: 'participant_joined', data: { userId: user.id }, now })]
    })
  })

  app.post('/api/tasks/:id/leave', async (request) => {
    const user = requireUser(request)
    const task = loadTask((request.params as { id: string }).id)
    if (task.ownerId === user.id) {
      throw new HttpError(409, 'Você é o responsável. Passe a task para outra pessoa antes de sair.')
    }
    return commit(task.id, () => {
      const now = ctx.now()
      if (!isParticipant(ctx.db, task.id, user.id)) return []
      removeParticipant(ctx.db, task.id, user.id)
      return [insertEvent(ctx.db, { taskId: task.id, actorId: user.id, type: 'participant_left', data: { userId: user.id }, now })]
    })
  })

  app.post('/api/tasks/:id/comments', async (request) => {
    const user = requireUser(request)
    const task = loadTask((request.params as { id: string }).id)
    const input = parse(commentSchema, request.body)
    const { events } = commit(task.id, () => [
      insertEvent(ctx.db, { taskId: task.id, actorId: user.id, type: 'comment', data: { body: input.body }, now: ctx.now() })
    ])
    return { event: events[0] }
  })
}
