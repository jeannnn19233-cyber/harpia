import type { User } from '../../../shared/types.ts'
import type { Db } from '../db/index.ts'
import { hashToken, newToken } from './passwords.ts'
import { getUser } from './users.ts'

export const SESSION_COOKIE = 'harpia_session'
export const SESSION_DAYS = 30

export function createSession(db: Db, userId: number, now: Date): { token: string; expiresAt: Date } {
  const token = newToken()
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000)
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    hashToken(token),
    userId,
    now.toISOString(),
    expiresAt.toISOString()
  )
  return { token, expiresAt }
}

export function userForSession(db: Db, token: string, now: Date): User | null {
  const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?').get(hashToken(token)) as
    | { user_id: number; expires_at: string }
    | undefined
  if (!row) return null
  if (row.expires_at <= now.toISOString()) {
    deleteSession(db, token)
    return null
  }
  return getUser(db, row.user_id)
}

export function deleteSession(db: Db, token: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token))
}

export function deleteExpiredSessions(db: Db, now: Date): void {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString())
}
