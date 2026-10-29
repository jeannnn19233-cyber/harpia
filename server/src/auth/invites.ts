import type { Invite, UserRole } from '../../../shared/types.ts'
import type { Db } from '../db/index.ts'
import { hashToken, newToken } from './passwords.ts'

export const INVITE_DAYS = 7

export function createInvite(db: Db, input: { role: UserRole; createdBy: number; now: Date }): Invite {
  const token = newToken()
  const expiresAt = new Date(input.now.getTime() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString()
  db.prepare('INSERT INTO invites (token_hash, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    hashToken(token),
    input.role,
    input.createdBy,
    input.now.toISOString(),
    expiresAt
  )
  return { token, role: input.role, expiresAt }
}

export function findOpenInvite(db: Db, token: string, now: Date): { role: UserRole; expiresAt: string } | null {
  const row = db
    .prepare('SELECT role, expires_at FROM invites WHERE token_hash = ? AND used_by IS NULL')
    .get(hashToken(token)) as { role: UserRole; expires_at: string } | undefined
  if (!row || row.expires_at <= now.toISOString()) return null
  return { role: row.role, expiresAt: row.expires_at }
}

export function markInviteUsed(db: Db, token: string, userId: number, now: Date): void {
  db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE token_hash = ?').run(userId, now.toISOString(), hashToken(token))
}
