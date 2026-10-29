import type { Task, TaskEvent, TaskEventType, TaskStatus } from '../../../shared/types.ts'
import type { Db } from '../db/index.ts'

interface TaskRow {
  id: number
  project_id: number
  number: number
  title: string
  description: string
  status: TaskStatus
  owner_id: number | null
  position: number
  created_by: number
  created_at: string
  updated_at: string
  last_activity_at: string
  closed_at: string | null
}

interface EventRow {
  id: number
  task_id: number
  actor_id: number | null
  type: TaskEventType
  data: string
  created_at: string
}

function participantIds(db: Db, taskId: number): number[] {
  const rows = db
    .prepare('SELECT user_id FROM task_participants WHERE task_id = ? ORDER BY joined_at, user_id')
    .all(taskId) as { user_id: number }[]
  return rows.map((row) => row.user_id)
}

function toTask(db: Db, row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    number: row.number,
    title: row.title,
    description: row.description,
    status: row.status,
    ownerId: row.owner_id,
    participantIds: participantIds(db, row.id),
    position: row.position,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    closedAt: row.closed_at
  }
}

function toEvent(row: EventRow): TaskEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    actorId: row.actor_id,
    type: row.type,
    data: JSON.parse(row.data) as Record<string, unknown>,
    createdAt: row.created_at
  }
}

export function listTasks(db: Db, projectId: number): Task[] {
  const rows = db
    .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY status, position, id')
    .all(projectId) as unknown as TaskRow[]
  return rows.map((row) => toTask(db, row))
}

export function getTask(db: Db, id: number): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
  return row ? toTask(db, row) : null
}

// Posição no fim de uma coluna do quadro.
export function endOfColumn(db: Db, projectId: number, status: TaskStatus): number {
  const row = db
    .prepare('SELECT MAX(position) AS last FROM tasks WHERE project_id = ? AND status = ?')
    .get(projectId, status) as { last: number | null }
  return (row.last ?? 0) + 1000
}

export function insertTask(
  db: Db,
  input: { projectId: number; title: string; description: string; ownerId: number | null; createdBy: number; now: Date }
): Task {
  const counter = db.prepare('SELECT next_task_number FROM projects WHERE id = ?').get(input.projectId) as
    | { next_task_number: number }
    | undefined
  if (!counter) throw new Error('Projeto não encontrado.')
  db.prepare('UPDATE projects SET next_task_number = next_task_number + 1 WHERE id = ?').run(input.projectId)

  const now = input.now.toISOString()
  const result = db
    .prepare(
      `INSERT INTO tasks (project_id, number, title, description, status, owner_id, position,
                          created_by, created_at, updated_at, last_activity_at)
       VALUES (?, ?, ?, ?, 'backlog', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.projectId,
      counter.next_task_number,
      input.title,
      input.description,
      input.ownerId,
      endOfColumn(db, input.projectId, 'backlog'),
      input.createdBy,
      now,
      now,
      now
    )
  const taskId = Number(result.lastInsertRowid)
  if (input.ownerId !== null) addParticipant(db, taskId, input.ownerId, input.now)
  const task = getTask(db, taskId)
  if (!task) throw new Error('Task recém-criada não encontrada.')
  return task
}

export function updateTaskRow(
  db: Db,
  id: number,
  fields: Partial<{
    title: string
    description: string
    status: TaskStatus
    ownerId: number | null
    position: number
    closedAt: string | null
  }>,
  now: Date
): void {
  const columns: Record<string, string> = {
    title: 'title',
    description: 'description',
    status: 'status',
    ownerId: 'owner_id',
    position: 'position',
    closedAt: 'closed_at'
  }
  const sets: string[] = []
  const values: (string | number | null)[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    sets.push(`${columns[key]} = ?`)
    values.push(value)
  }
  sets.push('updated_at = ?')
  values.push(now.toISOString())
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
}

export function isParticipant(db: Db, taskId: number, userId: number): boolean {
  return db.prepare('SELECT 1 FROM task_participants WHERE task_id = ? AND user_id = ?').get(taskId, userId) !== undefined
}

export function addParticipant(db: Db, taskId: number, userId: number, now: Date): boolean {
  const result = db
    .prepare('INSERT OR IGNORE INTO task_participants (task_id, user_id, joined_at) VALUES (?, ?, ?)')
    .run(taskId, userId, now.toISOString())
  return result.changes > 0
}

export function removeParticipant(db: Db, taskId: number, userId: number): boolean {
  const result = db.prepare('DELETE FROM task_participants WHERE task_id = ? AND user_id = ?').run(taskId, userId)
  return result.changes > 0
}

// Registra um acontecimento na task e atualiza a data da última atividade.
export function insertEvent(
  db: Db,
  input: { taskId: number; actorId: number | null; type: TaskEventType; data?: Record<string, unknown>; now: Date }
): TaskEvent {
  const now = input.now.toISOString()
  const result = db
    .prepare('INSERT INTO task_events (task_id, actor_id, type, data, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(input.taskId, input.actorId, input.type, JSON.stringify(input.data ?? {}), now)
  db.prepare('UPDATE tasks SET last_activity_at = ? WHERE id = ?').run(now, input.taskId)
  const row = db.prepare('SELECT * FROM task_events WHERE id = ?').get(Number(result.lastInsertRowid)) as unknown as EventRow
  return toEvent(row)
}

export function listEvents(db: Db, taskId: number, limit = 500): TaskEvent[] {
  const rows = db
    .prepare('SELECT * FROM (SELECT * FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id')
    .all(taskId, limit) as unknown as EventRow[]
  return rows.map(toEvent)
}
