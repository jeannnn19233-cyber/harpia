import type { PullRequest, PullRequestState } from '../../../shared/types.ts'
import type { Db } from '../db/index.ts'

interface PullRow {
  id: number
  task_id: number
  user_id: number
  number: number
  url: string
  branch: string
  base: string
  state: PullRequestState
  created_at: string
  updated_at: string
}

function toPull(row: PullRow): PullRequest {
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    number: row.number,
    url: row.url,
    branch: row.branch,
    base: row.base,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function getPull(db: Db, id: number): PullRequest | null {
  const row = db.prepare('SELECT * FROM pull_requests WHERE id = ?').get(id) as PullRow | undefined
  return row ? toPull(row) : null
}

export function listTaskPulls(db: Db, taskId: number): PullRequest[] {
  const rows = db.prepare('SELECT * FROM pull_requests WHERE task_id = ? ORDER BY id').all(taskId) as unknown as PullRow[]
  return rows.map(toPull)
}

export function listOpenPulls(db: Db): PullRequest[] {
  const rows = db.prepare("SELECT * FROM pull_requests WHERE state = 'open' ORDER BY id").all() as unknown as PullRow[]
  return rows.map(toPull)
}

// PRs ainda abertos de todas as tasks de um projeto, para os cards do quadro.
export function listProjectPulls(db: Db, projectId: number): PullRequest[] {
  const rows = db
    .prepare('SELECT p.* FROM pull_requests p JOIN tasks t ON t.id = p.task_id WHERE t.project_id = ? ORDER BY p.id')
    .all(projectId) as unknown as PullRow[]
  return rows.map(toPull)
}

export function findTaskPull(db: Db, taskId: number, branch: string, number: number): PullRequest | null {
  const row = db
    .prepare('SELECT * FROM pull_requests WHERE task_id = ? AND branch = ? AND number = ?')
    .get(taskId, branch, number) as PullRow | undefined
  return row ? toPull(row) : null
}

export function insertPull(
  db: Db,
  input: { taskId: number; userId: number; number: number; url: string; branch: string; base: string; now: Date }
): PullRequest {
  const now = input.now.toISOString()
  const result = db
    .prepare(
      `INSERT INTO pull_requests (task_id, user_id, number, url, branch, base, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`
    )
    .run(input.taskId, input.userId, input.number, input.url, input.branch, input.base, now, now)
  return getPull(db, Number(result.lastInsertRowid)) as PullRequest
}

export function setPullState(db: Db, id: number, state: PullRequestState, now: Date): PullRequest | null {
  db.prepare('UPDATE pull_requests SET state = ?, updated_at = ? WHERE id = ?').run(state, now.toISOString(), id)
  return getPull(db, id)
}

export function touchPull(db: Db, id: number, now: Date): PullRequest | null {
  db.prepare('UPDATE pull_requests SET updated_at = ? WHERE id = ?').run(now.toISOString(), id)
  return getPull(db, id)
}

export function countOpenPulls(db: Db, taskId: number): number {
  const row = db.prepare("SELECT COUNT(*) AS total FROM pull_requests WHERE task_id = ? AND state = 'open'").get(taskId) as {
    total: number
  }
  return row.total
}
