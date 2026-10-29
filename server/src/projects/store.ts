import type { CloneStatus, Project } from '../../../shared/types.ts'
import type { Db } from '../db/index.ts'

interface ProjectRow {
  id: number
  name: string
  slug: string
  repo_url: string
  default_branch: string
  clone_status: CloneStatus
  clone_error: string | null
  created_by: number
  created_at: string
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    repoUrl: row.repo_url,
    defaultBranch: row.default_branch,
    cloneStatus: row.clone_status,
    cloneError: row.clone_error,
    createdBy: row.created_by,
    createdAt: row.created_at
  }
}

export function listProjects(db: Db): Project[] {
  const rows = db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all() as unknown as ProjectRow[]
  return rows.map(toProject)
}

export function getProject(db: Db, id: number): Project | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
  return row ? toProject(row) : null
}

export function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
  return slug || 'projeto'
}

export function uniqueSlug(db: Db, name: string): string {
  const base = slugify(name)
  let slug = base
  for (let suffix = 2; db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug); suffix++) {
    slug = `${base}-${suffix}`
  }
  return slug
}

export function insertProject(
  db: Db,
  input: { name: string; slug: string; repoUrl: string; defaultBranch: string; createdBy: number; now: Date }
): Project {
  const result = db
    .prepare(
      `INSERT INTO projects (name, slug, repo_url, default_branch, clone_status, created_by, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`
    )
    .run(input.name, input.slug, input.repoUrl, input.defaultBranch, input.createdBy, input.now.toISOString())
  const project = getProject(db, Number(result.lastInsertRowid))
  if (!project) throw new Error('Projeto recém-criado não encontrado.')
  return project
}

export function updateCloneState(
  db: Db,
  id: number,
  state: { status: CloneStatus; error?: string | null; defaultBranch?: string }
): Project | null {
  db.prepare(
    `UPDATE projects
     SET clone_status = ?, clone_error = ?, default_branch = COALESCE(?, default_branch)
     WHERE id = ?`
  ).run(state.status, state.error ?? null, state.defaultBranch ?? null, id)
  return getProject(db, id)
}
