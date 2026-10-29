import type { PrQueue, PrReview, PrReviewCounts, PrReviewStatus, PrReviewVerdict } from '../../../shared/types.ts'
import type { Db } from '../db/index.ts'

interface JobRow {
  id: number
  project_id: number
  number: number
  queue: PrQueue
  trigger_key: string
  head_sha: string
  title: string
  url: string
  author_login: string
  reviewer_id: number | null
  status: PrReviewStatus
  verdict: PrReviewVerdict | null
  summary: string | null
  counts: string | null
  review_url: string | null
  chat_id: number | null
  error: string | null
  trigger: 'auto' | 'manual'
  line: string | null
  pushed_sha: string | null
  question: string | null
  answer: string | null
  attempts: number
  priority: number
  created_at: string
  updated_at: string
}

export interface StoredJob extends PrReview {
  triggerKey: string
  priority: number
}

function toJob(row: JobRow): StoredJob {
  return {
    id: row.id,
    projectId: row.project_id,
    number: row.number,
    queue: row.queue,
    triggerKey: row.trigger_key,
    headSha: row.head_sha,
    title: row.title,
    url: row.url,
    authorLogin: row.author_login,
    reviewerId: row.reviewer_id,
    status: row.status,
    verdict: row.verdict,
    summary: row.summary,
    counts: row.counts ? (JSON.parse(row.counts) as PrReviewCounts) : null,
    reviewUrl: row.review_url,
    chatId: row.chat_id,
    error: row.error,
    trigger: row.trigger,
    line: row.line,
    pushedSha: row.pushed_sha,
    question: row.question,
    answer: row.answer,
    attempts: row.attempts,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function publicJob(job: StoredJob): PrReview {
  const { triggerKey: _key, priority: _priority, ...rest } = job
  return rest
}

export function getJob(db: Db, id: number): StoredJob | null {
  const row = db.prepare('SELECT * FROM pr_jobs WHERE id = ?').get(id) as JobRow | undefined
  return row ? toJob(row) : null
}

export function findJob(db: Db, projectId: number, number: number, queue: PrQueue, key: string): StoredJob | null {
  const row = db
    .prepare('SELECT * FROM pr_jobs WHERE project_id = ? AND number = ? AND queue = ? AND trigger_key = ?')
    .get(projectId, number, queue, key) as JobRow | undefined
  return row ? toJob(row) : null
}

export function listProjectJobs(db: Db, projectId: number, limit = 80): StoredJob[] {
  const rows = db.prepare('SELECT * FROM pr_jobs WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, limit) as unknown as JobRow[]
  return rows.map(toJob)
}

export function listPullJobs(db: Db, projectId: number, number: number): StoredJob[] {
  const rows = db.prepare('SELECT * FROM pr_jobs WHERE project_id = ? AND number = ? ORDER BY id').all(projectId, number) as unknown as JobRow[]
  return rows.map(toJob)
}

export function listWaitingJobs(db: Db): StoredJob[] {
  const rows = db
    .prepare("SELECT * FROM pr_jobs WHERE status = 'waiting' ORDER BY priority, number, id")
    .all() as unknown as JobRow[]
  return rows.map(toJob)
}

// Último commit já tratado por uma fila neste PR (para a re-revisão saber o que mudou).
export function lastHandledSha(db: Db, projectId: number, number: number, queues: PrQueue[]): string | null {
  const row = db
    .prepare(
      `SELECT head_sha, pushed_sha FROM pr_jobs WHERE project_id = ? AND number = ? AND status = 'posted'
       AND queue IN (${queues.map(() => '?').join(', ')}) ORDER BY id DESC LIMIT 1`
    )
    .get(projectId, number, ...queues) as { head_sha: string; pushed_sha: string | null } | undefined
  return row ? (row.pushed_sha ?? row.head_sha) : null
}

// O commit foi enviado pelo revisor desta mesma pessoa: não volta para ela revisar (passo 13 da
// skill). A correção feita pelo revisor do autor continua indo para o colega revisar.
export function pushedByReviewer(db: Db, projectId: number, number: number, sha: string, reviewerId: number): boolean {
  return (
    db.prepare('SELECT 1 FROM pr_jobs WHERE project_id = ? AND number = ? AND pushed_sha = ? AND reviewer_id = ?').get(projectId, number, sha, reviewerId) !==
    undefined
  )
}

export function insertJob(
  db: Db,
  input: {
    projectId: number
    number: number
    queue: PrQueue
    key: string
    headSha: string
    title: string
    url: string
    authorLogin: string
    reviewerId: number | null
    status: PrReviewStatus
    priority: number
    error?: string | null
    trigger: 'auto' | 'manual'
    now: Date
  }
): StoredJob {
  const stamp = input.now.toISOString()
  const result = db
    .prepare(
      `INSERT INTO pr_jobs (project_id, number, queue, trigger_key, head_sha, title, url, author_login, reviewer_id, status,
                            priority, error, trigger, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.projectId,
      input.number,
      input.queue,
      input.key,
      input.headSha,
      input.title,
      input.url,
      input.authorLogin,
      input.reviewerId,
      input.status,
      input.priority,
      input.error ?? null,
      input.trigger,
      stamp,
      stamp
    )
  return getJob(db, Number(result.lastInsertRowid)) as StoredJob
}

const COLUMNS: Record<string, string> = {
  status: 'status',
  reviewerId: 'reviewer_id',
  verdict: 'verdict',
  summary: 'summary',
  counts: 'counts',
  reviewUrl: 'review_url',
  chatId: 'chat_id',
  error: 'error',
  trigger: 'trigger',
  title: 'title',
  line: 'line',
  pushedSha: 'pushed_sha',
  question: 'question',
  answer: 'answer',
  attempts: 'attempts',
  priority: 'priority',
  headSha: 'head_sha'
}

export function updateJob(
  db: Db,
  id: number,
  fields: Partial<{
    status: PrReviewStatus
    reviewerId: number | null
    verdict: PrReviewVerdict | null
    summary: string | null
    counts: PrReviewCounts | null
    reviewUrl: string | null
    chatId: number | null
    error: string | null
    trigger: 'auto' | 'manual'
    title: string
    line: string | null
    pushedSha: string | null
    question: string | null
    answer: string | null
    attempts: number
    priority: number
    headSha: string
  }>,
  now: Date
): StoredJob | null {
  const sets: string[] = []
  const values: (string | number | null)[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    sets.push(`${COLUMNS[key]} = ?`)
    values.push(key === 'counts' && value !== null ? JSON.stringify(value) : (value as string | number | null))
  }
  sets.push('updated_at = ?')
  values.push(now.toISOString())
  db.prepare(`UPDATE pr_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
  return getJob(db, id)
}

// Execuções interrompidas por um reinício voltam para a fila (contando como tentativa).
export function requeueRunningJobs(db: Db, now: Date): void {
  db.prepare(
    `UPDATE pr_jobs SET status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'waiting' END, attempts = attempts + 1,
       error = 'O servidor reiniciou durante a execução.', updated_at = ? WHERE status = 'running'`
  ).run(now.toISOString())
}

export function recordPublished(db: Db, input: { reviewId: number; projectId: number; number: number; jobId: number; now: Date }): void {
  db.prepare('INSERT OR IGNORE INTO pr_published (github_review_id, project_id, number, job_id, created_at) VALUES (?, ?, ?, ?, ?)').run(
    input.reviewId,
    input.projectId,
    input.number,
    input.jobId,
    input.now.toISOString()
  )
}

export function publishedIds(db: Db, projectId: number, number: number): Set<number> {
  const rows = db.prepare('SELECT github_review_id FROM pr_published WHERE project_id = ? AND number = ?').all(projectId, number) as {
    github_review_id: number
  }[]
  return new Set(rows.map((row) => row.github_review_id))
}

export function getFlags(db: Db, projectId: number, number: number): { reviewerRequested: boolean; draftedByReviewer: boolean } {
  const row = db.prepare('SELECT reviewer_requested, drafted_by_reviewer FROM pr_flags WHERE project_id = ? AND number = ?').get(projectId, number) as
    | { reviewer_requested: number; drafted_by_reviewer: number }
    | undefined
  return { reviewerRequested: row?.reviewer_requested === 1, draftedByReviewer: row?.drafted_by_reviewer === 1 }
}

export function setFlag(db: Db, projectId: number, number: number, flag: 'reviewer_requested' | 'drafted_by_reviewer', value: boolean): void {
  db.prepare('INSERT OR IGNORE INTO pr_flags (project_id, number) VALUES (?, ?)').run(projectId, number)
  db.prepare(`UPDATE pr_flags SET ${flag} = ? WHERE project_id = ? AND number = ?`).run(value ? 1 : 0, projectId, number)
}

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(db: Db, key: string, value: string | null): void {
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
}
