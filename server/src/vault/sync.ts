import { join } from 'node:path'
import type { User } from '../../../shared/types.ts'
import { agentsDisabledReason } from '../agents/workspace.ts'
import { listUsers } from '../auth/users.ts'
import type { AppContext } from '../context.ts'
import { VAULT_FOLDER } from './paths.ts'

// Sessão do tmux, na conta de cada pessoa, que mantém o cofre sincronizado com o Obsidian Sync.
export const SYNC_SESSION = 'harpia-obsync'

export interface VaultSyncStatus {
  // O "ob" (obsidian-headless) está instalado no servidor.
  available: boolean
  // A pessoa já fez "ob login" e "ob sync-setup" apontando para o cofre.
  configured: boolean
  syncing: boolean
}

// Mantém o "ob sync --continuous" rodando para cada pessoa que configurou o Obsidian Sync no cofre.
export class VaultSync {
  private readonly ctx: AppContext
  private readonly intervalSeconds: number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(ctx: AppContext, intervalSeconds: number) {
    this.ctx = ctx
    this.intervalSeconds = intervalSeconds
  }

  start(): void {
    if (this.intervalSeconds <= 0) return
    this.timer = setInterval(() => void this.checkAll(), this.intervalSeconds * 1000)
    this.timer.unref()
    void this.checkAll()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async checkAll(): Promise<void> {
    if (agentsDisabledReason(this.ctx)) return
    for (const user of listUsers(this.ctx.db)) {
      await this.ensure(user).catch(() => undefined)
    }
  }

  // Confere a pessoa e liga a sincronização se ela estiver configurada e parada.
  async ensure(user: User): Promise<VaultSyncStatus> {
    const vaults = await this.ctx.agents.obsidianVaults(user)
    if (vaults === null) return { available: false, configured: false, syncing: false }
    const vault = join(this.ctx.agents.homeDir(user), VAULT_FOLDER)
    const configured = vaults.some((path) => path.replace(/\/+$/, '') === vault)
    if (!configured) return { available: true, configured: false, syncing: false }
    if (!(await this.ctx.agents.isRunning(user, SYNC_SESSION))) {
      await this.ctx.agents.startSession({
        user,
        name: SYNC_SESSION,
        cwd: vault,
        command: `exec ob sync --continuous --path "$HOME/${VAULT_FOLDER}"`
      })
    }
    return { available: true, configured: true, syncing: await this.ctx.agents.isRunning(user, SYNC_SESSION) }
  }
}
