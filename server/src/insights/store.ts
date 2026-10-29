import type { Learning, LearningTarget, TaskSummary } from '../../../shared/types.ts'
import type { Db } from '../db/index.ts'

interface SummaryRow {
  task_id: number
  user_id: number | null
  status: TaskSummary['status']
  summary: string | null
  error: string | null
  created_at: string
  updated_at: string
}

interface LearningRow {
  id: number
  task_id: number
  project_id: number
  target: LearningTarget
  text: string
  reason: string
  status: Learning['status']
  decided_by: number | null
  pr_url: string | null
  created_at: string
  decided_at: string | null
}

function toSummary(row: SummaryRow): TaskSummary {
  return {
    taskId: row.task_id,
    userId: row.user_id,
    status: row.status,
    summary: row.summary,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toLearning(row: LearningRow): Learning {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    target: row.target,
    text: row.text,
    reason: row.reason,
    status: row.status,
    decidedBy: row.decided_by,
    prUrl: row.pr_url,
    createdAt: row.created_at,
    decidedAt: row.decided_at
  }
}

export function getSummary(db: Db, taskId: number): TaskSummary | null {
  const row = db.prepare('SELECT * FROM task_summaries WHERE task_id = ?').get(taskId) as SummaryRow | undefined
  return row ? toSummary(row) : null
}

export function saveSummary(
  db: Db,
  input: { taskId: number; userId: number | null; status: TaskSummary['status']; summary?: string | null; error?: string | null; now: Date }
): TaskSummary {
  const stamp = input.now.toISOString()
  db.prepare(
    `INSERT INTO task_summaries (task_id, user_id, status, summary, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (task_id) DO UPDATE SET user_id = excluded.user_id, status = excluded.status,
       summary = COALESCE(excluded.summary, task_summaries.summary), error = excluded.error, updated_at = excluded.updated_at`
  ).run(input.taskId, input.userId, input.status, input.summary ?? null, input.error ?? null, stamp, stamp)
  return getSummary(db, input.taskId) as TaskSummary
}

// Tasks concluídas há pouco que ainda não têm resumo (as antigas não gastam a cota de ninguém).
export function tasksNeedingSummary(db: Db, projectId: number, since: string, limit: number): number[] {
  const rows = db
    .prepare(
      `SELECT t.id FROM tasks t LEFT JOIN task_summaries s ON s.task_id = t.id
       WHERE t.project_id = ? AND t.status = 'done' AND t.closed_at >= ? AND s.task_id IS NULL
       ORDER BY t.closed_at LIMIT ?`
    )
    .all(projectId, since, limit) as { id: number }[]
  return rows.map((row) => row.id)
}

export function getLearning(db: Db, id: number): Learning | null {
  const row = db.prepare('SELECT * FROM learnings WHERE id = ?').get(id) as LearningRow | undefined
  return row ? toLearning(row) : null
}

export function listTaskLearnings(db: Db, taskId: number): Learning[] {
  const rows = db.prepare('SELECT * FROM learnings WHERE task_id = ? ORDER BY id').all(taskId) as unknown as LearningRow[]
  return rows.map(toLearning)
}

export function listPendingLearnings(db: Db, projectId: number): Learning[] {
  const rows = db
    .prepare("SELECT * FROM learnings WHERE project_id = ? AND status = 'pending' ORDER BY id DESC")
    .all(projectId) as unknown as LearningRow[]
  return rows.map(toLearning)
}

export function insertLearning(
  db: Db,
  input: { taskId: number; projectId: number; target: LearningTarget; text: string; reason: string; now: Date }
): Learning {
  const result = db
    .prepare(
      `INSERT INTO learnings (task_id, project_id, target, text, reason, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    )
    .run(input.taskId, input.projectId, input.target, input.text, input.reason, input.now.toISOString())
  return getLearning(db, Number(result.lastInsertRowid)) as Learning
}

// Sugestões ainda pendentes de uma task (trocadas quando o resumo é refeito).
export function dropPendingLearnings(db: Db, taskId: number): number[] {
  const rows = db.prepare("SELECT id FROM learnings WHERE task_id = ? AND status = 'pending'").all(taskId) as { id: number }[]
  db.prepare("DELETE FROM learnings WHERE task_id = ? AND status = 'pending'").run(taskId)
  return rows.map((row) => row.id)
}

export function decideLearning(
  db: Db,
  id: number,
  input: { status: 'applied' | 'dismissed'; userId: number; text?: string; prUrl?: string | null; now: Date }
): Learning | null {
  db.prepare('UPDATE learnings SET status = ?, decided_by = ?, text = COALESCE(?, text), pr_url = ?, decided_at = ? WHERE id = ?').run(
    input.status,
    input.userId,
    input.text ?? null,
    input.prUrl ?? null,
    input.now.toISOString(),
    id
  )
  return getLearning(db, id)
}

export interface Judgment {
  verdict: 'duplicate' | 'different' | 'error'
  reason: string | null
  userId: number | null
}

export function getJudgment(db: Db, fingerprint: string): Judgment | null {
  const row = db.prepare('SELECT verdict, reason, user_id FROM ai_judgments WHERE fingerprint = ?').get(fingerprint) as
    | { verdict: Judgment['verdict']; reason: string | null; user_id: number | null }
    | undefined
  return row ? { verdict: row.verdict, reason: row.reason, userId: row.user_id } : null
}

export function saveJudgment(db: Db, fingerprint: string, judgment: Judgment, now: Date): void {
  db.prepare(
    `INSERT INTO ai_judgments (fingerprint, user_id, verdict, reason, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (fingerprint) DO UPDATE SET user_id = excluded.user_id, verdict = excluded.verdict, reason = excluded.reason`
  ).run(fingerprint, judgment.userId, judgment.verdict, judgment.reason, now.toISOString())
}
