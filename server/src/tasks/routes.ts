import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { TASK_STATUSES, type Task, type TaskEvent } from '../../../shared/types.ts'
import type { AppContext } from '../context.ts'
import { requireUser } from '../auth/guard.ts'
import { getUser } from '../auth/users.ts'
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
