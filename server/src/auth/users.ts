import type { User, UserRole } from '../../../shared/types.ts'
import type { Db } from '../db/index.ts'

interface UserRow {
  id: number
  name: string
  email: string
  role: UserRole
  created_at: string
  password_hash: string
  github_login: string | null
  codex_suggestions: number
}

function toUser(row: UserRow): User {
  return { id: row.id, name: row.name, email: row.email, role: row.role, githubLogin: row.github_login,
    codexSuggestions: row.codex_suggestions === 1,
    createdAt: row.created_at
  }
}

// Pessoa da equipe dona de um usuário do GitHub (sem diferenciar maiúsculas).
export function findUserByGitHubLogin(db: Db, login: string): User | null {
  const row = db.prepare('SELECT * FROM users WHERE lower(github_login) = lower(?)').get(login) as UserRow | undefined
  return row ? toUser(row) : null
}

export function setCodexSuggestions(db: Db, userId: number, enabled: boolean): User | null {
  db.prepare('UPDATE users SET codex_suggestions = ? WHERE id = ?').run(enabled ? 1 : 0, userId)
  return getUser(db, userId)
}

export function setGitHubLogin(db: Db, userId: number, login: string | null): User | null {
  db.prepare('UPDATE users SET github_login = ? WHERE id = ?').run(login, userId)
  return getUser(db, userId)
}

export function countUsers(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS total FROM users').get() as { total: number }
  return row.total
}

export function listUsers(db: Db): User[] {
  const rows = db.prepare('SELECT * FROM users ORDER BY name COLLATE NOCASE').all() as unknown as UserRow[]
  return rows.map(toUser)
}

export function getUser(db: Db, id: number): User | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
  return row ? toUser(row) : null
}

export function getUserWithPassword(db: Db, email: string): { user: User; passwordHash: string } | null {
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined
  return row ? { user: toUser(row), passwordHash: row.password_hash } : null
}

export function emailInUse(db: Db, email: string): boolean {
  return db.prepare('SELECT 1 FROM users WHERE email = ?').get(email) !== undefined
}

export function insertUser(
  db: Db,
  input: { name: string; email: string; passwordHash: string; role: UserRole; now: Date }
): User {
  const result = db
    .prepare('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(input.name, input.email, input.passwordHash, input.role, input.now.toISOString())
  const user = getUser(db, Number(result.lastInsertRowid))
  if (!user) throw new Error('Usuário recém-criado não encontrado.')
  return user
}
