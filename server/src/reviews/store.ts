import type { PrReview, PrReviewCounts, PrReviewStatus, PrReviewVerdict } from '../../../shared/types.ts'
import type { Db } from '../db/index.ts'

interface ReviewRow {
  id: number
  project_id: number
  number: number
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
  created_at: string
  updated_at: string
}

function toReview(row: ReviewRow): PrReview {
  return {
    id: row.id,
    projectId: row.project_id,
    number: row.number,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function getReview(db: Db, id: number): PrReview | null {
  const row = db.prepare('SELECT * FROM pr_reviews WHERE id = ?').get(id) as ReviewRow | undefined
  return row ? toReview(row) : null
}

export function findReview(db: Db, projectId: number, number: number, headSha: string): PrReview | null {
  const row = db
    .prepare('SELECT * FROM pr_reviews WHERE project_id = ? AND number = ? AND head_sha = ?')
    .get(projectId, number, headSha) as ReviewRow | undefined
  return row ? toReview(row) : null
}

export function listProjectReviews(db: Db, projectId: number, limit = 50): PrReview[] {
  const rows = db
    .prepare('SELECT * FROM pr_reviews WHERE project_id = ? ORDER BY id DESC LIMIT ?')
    .all(projectId, limit) as unknown as ReviewRow[]
  return rows.map(toReview)
}

// Revisões esperando o PR "acalmar" (sem commits novos por alguns minutos).
export function listWaitingReviews(db: Db, projectId: number, number: number): PrReview[] {
  const rows = db
    .prepare("SELECT * FROM pr_reviews WHERE project_id = ? AND number = ? AND status = 'waiting' ORDER BY id")
    .all(projectId, number) as unknown as ReviewRow[]
  return rows.map(toReview)
}

export function insertReview(
  db: Db,
  input: {
    projectId: number
    number: number
    headSha: string
    title: string
    url: string
    authorLogin: string
    reviewerId: number | null
    status: PrReviewStatus
    error?: string | null
    trigger: 'auto' | 'manual'
    now: Date
  }
): PrReview {
  const stamp = input.now.toISOString()
  const result = db
    .prepare(
      `INSERT INTO pr_reviews (project_id, number, head_sha, title, url, author_login, reviewer_id, status, error, trigger, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.projectId,
      input.number,
      input.headSha,
      input.title,
      input.url,
      input.authorLogin,
      input.reviewerId,
      input.status,
      input.error ?? null,
      input.trigger,
      stamp,
      stamp
    )
  return getReview(db, Number(result.lastInsertRowid)) as PrReview
}

export function updateReview(
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
  }>,
  now: Date
): PrReview | null {
  const columns: Record<string, string> = {
    status: 'status',
    reviewerId: 'reviewer_id',
    verdict: 'verdict',
    summary: 'summary',
    counts: 'counts',
    reviewUrl: 'review_url',
    chatId: 'chat_id',
    error: 'error',
    trigger: 'trigger',
    title: 'title'
  }
  const sets: string[] = []
  const values: (string | number | null)[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    sets.push(`${columns[key]} = ?`)
    values.push(key === 'counts' && value !== null ? JSON.stringify(value) : (value as string | number | null))
  }
  sets.push('updated_at = ?')
  values.push(now.toISOString())
  db.prepare(`UPDATE pr_reviews SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
  return getReview(db, id)
}

// Revisões interrompidas por um reinício: não são repetidas sozinhas (pode-se pedir de novo).
export function failRunningReviews(db: Db, now: Date): void {
  db.prepare(
    `UPDATE pr_reviews SET status = 'failed', error = 'O servidor reiniciou durante a revisão. Peça de novo se quiser.', updated_at = ?
     WHERE status = 'running'`
  ).run(now.toISOString())
}
