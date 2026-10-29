import type { Finding, FindingKind } from '../../../shared/types.ts'
import type { Db } from '../db/index.ts'

interface FindingRow {
  id: number
  project_id: number
  kind: FindingKind
  fingerprint: string
  task_ids: string
  user_ids: string
  message: string
  details: string
  status: Finding['status']
  dismissed_by: number | null
  created_at: string
  updated_at: string
}

function toFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    taskIds: JSON.parse(row.task_ids) as number[],
    userIds: JSON.parse(row.user_ids) as number[],
    message: row.message,
    details: JSON.parse(row.details) as Record<string, unknown>,
    status: row.status,
    dismissedBy: row.dismissed_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function getFinding(db: Db, id: number): Finding | null {
  const row = db.prepare('SELECT * FROM watcher_findings WHERE id = ?').get(id) as FindingRow | undefined
  return row ? toFinding(row) : null
}

export function listOpenFindings(db: Db, projectId: number): Finding[] {
  const rows = db
    .prepare("SELECT * FROM watcher_findings WHERE project_id = ? AND status = 'open' ORDER BY id DESC")
    .all(projectId) as unknown as FindingRow[]
  return rows.map(toFinding)
}

export function findingExists(db: Db, fingerprint: string): boolean {
  return db.prepare('SELECT 1 FROM watcher_findings WHERE fingerprint = ?').get(fingerprint) !== undefined
}

export interface FindingInput {
  projectId: number
  kind: FindingKind
  fingerprint: string
  taskIds: number[]
  userIds: number[]
  message: string
  details: Record<string, unknown>
}

// Grava o aviso. "isNew" diz se é novo (ou se voltou depois de resolvido) e merece ser anunciado.
// Avisos dispensados continuam dispensados enquanto o problema for o mesmo.
export function upsertFinding(db: Db, input: FindingInput, now: Date): { finding: Finding; isNew: boolean } {
  const stamp = now.toISOString()
  const existing = db.prepare('SELECT * FROM watcher_findings WHERE fingerprint = ?').get(input.fingerprint) as
    | FindingRow
    | undefined
  if (!existing) {
    const result = db
      .prepare(
        `INSERT INTO watcher_findings (project_id, kind, fingerprint, task_ids, user_ids, message, details, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
      )
      .run(
        input.projectId,
        input.kind,
        input.fingerprint,
        JSON.stringify(input.taskIds),
        JSON.stringify(input.userIds),
        input.message,
        JSON.stringify(input.details),
        stamp,
        stamp
      )
    return { finding: getFinding(db, Number(result.lastInsertRowid)) as Finding, isNew: true }
  }
  if (existing.status === 'resolved') {
    db.prepare("UPDATE watcher_findings SET status = 'open', message = ?, updated_at = ? WHERE id = ?").run(
      input.message,
      stamp,
      existing.id
    )
    return { finding: getFinding(db, existing.id) as Finding, isNew: true }
  }
  return { finding: toFinding(existing), isNew: false }
}

// Avisos abertos de um tipo que o vigia não encontrou mais: o problema acabou.
export function resolveMissing(db: Db, projectId: number, kind: FindingKind, current: Set<string>, now: Date): Finding[] {
  const rows = db
    .prepare("SELECT * FROM watcher_findings WHERE project_id = ? AND kind = ? AND status = 'open'")
    .all(projectId, kind) as unknown as FindingRow[]
  const resolved: Finding[] = []
  for (const row of rows) {
    if (current.has(row.fingerprint)) continue
    db.prepare("UPDATE watcher_findings SET status = 'resolved', updated_at = ? WHERE id = ?").run(now.toISOString(), row.id)
    resolved.push(getFinding(db, row.id) as Finding)
  }
  return resolved
}

export function dismissFinding(db: Db, id: number, userId: number, now: Date): Finding | null {
  db.prepare("UPDATE watcher_findings SET status = 'dismissed', dismissed_by = ?, updated_at = ? WHERE id = ?").run(
    userId,
    now.toISOString(),
    id
  )
  return getFinding(db, id)
}
