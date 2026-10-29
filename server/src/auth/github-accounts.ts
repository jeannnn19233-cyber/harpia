import type { Db } from '../db/index.ts'
import type { SecretBox } from './secrets.ts'

// GitHub de cada pessoa: o login e o token (cifrado). O token nunca sai do servidor: nem para a
// interface, nem para os agentes.
export function getGitHubAccount(db: Db, secrets: SecretBox, userId: number): { login: string; token: string } | null {
  const row = db.prepare('SELECT login, token FROM github_accounts WHERE user_id = ?').get(userId) as
    | { login: string; token: string }
    | undefined
  if (!row) return null
  try {
    return { login: row.login, token: secrets.open(row.token) }
  } catch {
    return null
  }
}

export function saveGitHubAccount(db: Db, secrets: SecretBox, input: { userId: number; login: string; token: string; now: Date }): void {
  const stamp = input.now.toISOString()
  db.prepare(
    `INSERT INTO github_accounts (user_id, login, token, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET login = excluded.login, token = excluded.token, updated_at = excluded.updated_at`
  ).run(input.userId, input.login, secrets.seal(input.token), stamp, stamp)
  db.prepare('UPDATE users SET github_login = ? WHERE id = ?').run(input.login, input.userId)
}

export function deleteGitHubAccount(db: Db, userId: number): void {
  db.prepare('DELETE FROM github_accounts WHERE user_id = ?').run(userId)
}
