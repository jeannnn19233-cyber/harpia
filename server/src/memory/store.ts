import type { ProjectMemory } from '../../../shared/types.ts'
import type { Db } from '../db/index.ts'

export function getMemory(db: Db, projectId: number): ProjectMemory {
  const row = db.prepare('SELECT * FROM project_memories WHERE project_id = ?').get(projectId) as
    | { body: string; updated_by: number | null; updated_at: string }
    | undefined
  return { projectId, body: row?.body ?? '', updatedBy: row?.updated_by ?? null, updatedAt: row?.updated_at ?? null }
}

export function saveMemory(db: Db, input: { projectId: number; body: string; userId: number; now: Date }): ProjectMemory {
  db.prepare(
    `INSERT INTO project_memories (project_id, body, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (project_id) DO UPDATE SET body = excluded.body, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(input.projectId, input.body, input.userId, input.now.toISOString())
  return getMemory(db, input.projectId)
}
