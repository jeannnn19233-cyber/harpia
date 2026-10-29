import type { AgentKind, AgentSession } from '../../../shared/types.ts'
import type { Db } from '../db/index.ts'

interface SessionRow {
  id: number
  task_id: number | null
  user_id: number
  kind: AgentKind | 'account'
  branch: string | null
  cwd: string
  status: 'running' | 'exited'
  created_at: string
  ended_at: string | null
}

export interface StoredSession extends AgentSession {
  cwd: string
}

function toSession(row: SessionRow): StoredSession {
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    kind: row.kind,
    branch: row.branch,
    cwd: row.cwd,
    status: row.status,
    createdAt: row.created_at,
    endedAt: row.ended_at
  }
}

// O caminho no servidor não vai para a interface.
export function publicSession(session: StoredSession): AgentSession {
  const { cwd: _cwd, ...rest } = session
  return rest
}

export function getSession(db: Db, id: number): StoredSession | null {
  const row = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as SessionRow | undefined
  return row ? toSession(row) : null
}

export function listTaskSessions(db: Db, taskId: number): StoredSession[] {
  const rows = db
    .prepare('SELECT * FROM agent_sessions WHERE task_id = ? ORDER BY id')
    .all(taskId) as unknown as SessionRow[]
  return rows.map(toSession)
}

export function listRunningSessions(db: Db): StoredSession[] {
  const rows = db.prepare("SELECT * FROM agent_sessions WHERE status = 'running' ORDER BY id").all() as unknown as SessionRow[]
  return rows.map(toSession)
}

export function countRunningForUser(db: Db, userId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS total FROM agent_sessions WHERE user_id = ? AND status = 'running' AND kind != 'account'")
    .get(userId) as { total: number }
  return row.total
}

export function findRunningTaskSession(db: Db, taskId: number, userId: number, kind: AgentKind): StoredSession | null {
  const row = db
    .prepare("SELECT * FROM agent_sessions WHERE task_id = ? AND user_id = ? AND kind = ? AND status = 'running' ORDER BY id DESC")
    .get(taskId, userId, kind) as SessionRow | undefined
  return row ? toSession(row) : null
}

export function findRunningAccountSession(db: Db, userId: number): StoredSession | null {
  const row = db
    .prepare("SELECT * FROM agent_sessions WHERE user_id = ? AND kind = 'account' AND status = 'running' ORDER BY id DESC")
    .get(userId) as SessionRow | undefined
  return row ? toSession(row) : null
}

export function insertSession(
  db: Db,
  input: { taskId: number | null; userId: number; kind: AgentKind | 'account'; branch: string | null; cwd: string; now: Date }
): StoredSession {
  const result = db
    .prepare(
      `INSERT INTO agent_sessions (task_id, user_id, kind, branch, cwd, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?)`
    )
    .run(input.taskId, input.userId, input.kind, input.branch, input.cwd, input.now.toISOString())
  const session = getSession(db, Number(result.lastInsertRowid))
  if (!session) throw new Error('Sessão recém-criada não encontrada.')
  return session
}

// Devolve true se a sessão estava aberta e foi encerrada agora.
export function markExited(db: Db, id: number, now: Date): boolean {
  const result = db
    .prepare("UPDATE agent_sessions SET status = 'exited', ended_at = ? WHERE id = ? AND status = 'running'")
    .run(now.toISOString(), id)
  return result.changes > 0
}

export function getWorktree(db: Db, taskId: number, userId: number): { path: string; branch: string } | null {
  const row = db.prepare('SELECT path, branch FROM task_worktrees WHERE task_id = ? AND user_id = ?').get(taskId, userId) as
    | { path: string; branch: string }
    | undefined
  return row ?? null
}

export function saveWorktree(db: Db, input: { taskId: number; userId: number; path: string; branch: string; now: Date }): void {
  db.prepare(
    `INSERT INTO task_worktrees (task_id, user_id, path, branch, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (task_id, user_id) DO UPDATE SET path = excluded.path, branch = excluded.branch`
  ).run(input.taskId, input.userId, input.path, input.branch, input.now.toISOString())
}
