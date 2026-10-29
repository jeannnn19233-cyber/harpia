import type { User, UserRole } from '../../../shared/types.ts'
import type { Db } from '../db/index.ts'

interface UserRow {
  id: number
  name: string
  email: string
  role: UserRole
  created_at: string
  password_hash: string
}

function toUser(row: UserRow): User {
  return { id: row.id, name: row.name, email: row.email, role: row.role, createdAt: row.created_at }
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
