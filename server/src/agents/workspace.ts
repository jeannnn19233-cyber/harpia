import type { Task, TaskEvent, User } from '../../../shared/types.ts'
import type { AppContext } from '../context.ts'
import { HttpError } from '../http/errors.ts'
import { projectPath } from '../projects/routes.ts'
import { getProject } from '../projects/store.ts'
import { addParticipant, endOfColumn, getTask, insertEvent, updateTaskRow } from '../tasks/store.ts'
import { saveWorktree } from './store.ts'

// Mensagem para quando os terminais e chats com agentes não podem ser usados.
export function agentsDisabledReason(ctx: AppContext): string | null {
  if (!ctx.config.terminalsEnabled) {
    return 'Os agentes estão desligados. Um administrador liga com HARPIA_TERMINALS=on (veja docs/COOLIFY.md).'
  }
  return ctx.agents.unavailableReason()
}

export function ensureAgentsEnabled(ctx: AppContext): void {
  const reason = agentsDisabledReason(ctx)
  if (reason) throw new HttpError(503, reason)
}

export function ensureTaskOpen(task: Task): void {
  if (task.status === 'done') throw new HttpError(409, 'A task já foi concluída. Reabra a task para trabalhar nela.')
}

// Prepara a cópia de trabalho da pessoa para a task: atualiza o espelho, cria o usuário
// Linux (se preciso) e a worktree na branch dela.
export async function prepareTaskWorkspace(
  ctx: AppContext,
  task: Task,
  user: User,
  warn: (error: unknown, message: string) => void
): Promise<{ path: string; branch: string }> {
  const project = getProject(ctx.db, task.projectId)
  if (!project || project.cloneStatus !== 'ready') {
    throw new HttpError(409, 'O repositório do projeto ainda não está pronto.')
  }
  const mirrorPath = projectPath(ctx, project)
  try {
    await ctx.git.fetch(mirrorPath)
  } catch (error) {
    // Sem rede, segue com a última versão baixada.
    warn(error, 'Não foi possível atualizar o espelho do repositório.')
  }
  let worktree: { path: string; branch: string }
  try {
    await ctx.agents.prepareUser(user)
    worktree = await ctx.agents.prepareWorktree({ user, project, task, mirrorPath })
  } catch (error) {
    throw new HttpError(500, `Não foi possível preparar sua cópia do código: ${(error as Error).message}`)
  }
  saveWorktree(ctx.db, { taskId: task.id, userId: user.id, ...worktree, now: ctx.now() })
  return worktree
}

// Quem começa a trabalhar numa task passa a participar dela. Se a task estava no Backlog,
// vai para "Em andamento" e, sem responsável, essa pessoa assume.
// Deve rodar dentro de uma transação.
export function joinTaskForWork(ctx: AppContext, taskId: number, user: User, now: Date): TaskEvent[] {
  const task = getTask(ctx.db, taskId)
  if (!task) return []
  const events: TaskEvent[] = []
  if (task.status === 'backlog') {
    const ownerId = task.ownerId ?? user.id
    updateTaskRow(
      ctx.db,
      task.id,
      { status: 'in_progress', ownerId, position: endOfColumn(ctx.db, task.projectId, 'in_progress') },
      now
    )
    events.push(
      insertEvent(ctx.db, {
        taskId: task.id,
        actorId: user.id,
        type: 'status_changed',
        data: { from: 'backlog', to: 'in_progress', reason: 'agent' },
        now
      })
    )
    if (task.ownerId === null) {
      events.push(insertEvent(ctx.db, { taskId: task.id, actorId: user.id, type: 'owner_changed', data: { from: null, to: user.id }, now }))
    }
  }
  if (addParticipant(ctx.db, task.id, user.id, now)) {
    events.push(
      insertEvent(ctx.db, { taskId: task.id, actorId: user.id, type: 'participant_joined', data: { userId: user.id, reason: 'agent' }, now })
    )
  }
  return events
}

export function publishTaskChange(ctx: AppContext, taskId: number, events: TaskEvent[]): void {
  const task = getTask(ctx.db, taskId)
  if (task) ctx.hub.broadcast({ type: 'task', task })
  for (const event of events) ctx.hub.broadcast({ type: 'task_event', event })
}
