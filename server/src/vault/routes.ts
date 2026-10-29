import type { FastifyInstance } from 'fastify'
import { agentsDisabledReason } from '../agents/workspace.ts'
import { requireUser } from '../auth/guard.ts'
import type { AppContext } from '../context.ts'
import type { VaultSync } from './sync.ts'
import { VAULT_FOLDER } from './paths.ts'

export function registerVaultRoutes(app: FastifyInstance, ctx: AppContext, sync: VaultSync): void {
  app.addHook('onReady', async () => sync.start())
  app.addHook('preClose', async () => sync.stop())

  // "Meu agente": o cofre, o Obsidian Sync e o que chegou pelo Telegram por último.
  app.get('/api/me/vault', async (request) => {
    const user = requireUser(request)
    const disabled = agentsDisabledReason(ctx)
    const obsidian = disabled ? { available: false, configured: false, syncing: false } : await sync.ensure(user)
    const total = ctx.db.prepare('SELECT COUNT(*) AS total FROM vault_items WHERE user_id = ?').get(user.id) as { total: number }
    const recent = ctx.db
      .prepare('SELECT kind, path, created_at FROM vault_items WHERE user_id = ? ORDER BY id DESC LIMIT 8')
      .all(user.id) as { kind: string; path: string; created_at: string }[]
    return {
      folder: `~/${VAULT_FOLDER}`,
      disabledReason: disabled,
      obsidian,
      telegram: { available: ctx.notifier.available(), linked: ctx.notifier.isLinked(user.id), botUsername: ctx.notifier.botUsername },
      items: total.total,
      recent: recent.map((item) => ({ kind: item.kind, path: item.path, createdAt: item.created_at }))
    }
  })
}
