import type { ChildProcess } from 'node:child_process'
import type { AgentAccounts, ChangedFile, Project, Task, User } from '../../shared/types.ts'
import type { AgentSystem, TerminalHandle } from '../src/agents/system.ts'

// Versão em memória do sistema de agentes, para testar as rotas sem tmux nem usuários Linux.
export class FakeAgentSystem implements AgentSystem {
  reason: string | null = null
  readonly running = new Map<string, { user: number; cwd: string; command: string | null }>()
  readonly preparedUsers = new Set<number>()
  readonly written: { name: string; data: string }[] = []
  readonly attached: { name: string; readOnly: boolean }[] = []
  accountsByUser = new Map<number, AgentAccounts>()

  unavailableReason(): string | null {
    return this.reason
  }

  async prepareUser(user: User): Promise<void> {
    this.preparedUsers.add(user.id)
  }

  async prepareWorktree(input: { user: User; project: Project; task: Task }) {
    return {
      path: `/fake/${input.user.id}/${input.project.slug}/T-${input.task.number}`,
      branch: `harpia/T-${input.task.number}-u${input.user.id}`
    }
  }

  homeDir(user: User): string {
    return `/fake/${user.id}`
  }

  readonly checkouts: { user: number; number: number; sha: string }[] = []
  async prepareReviewCheckout(input: { user: User; project: Project; number: number; sha: string }): Promise<string> {
    this.checkouts.push({ user: input.user.id, number: input.number, sha: input.sha })
    return `/fake/${input.user.id}/revisoes/${input.project.slug}/pr-${input.number}`
  }

  readonly folders: string[] = []
  async prepareFolder(user: User, relativePath: string): Promise<string> {
    this.preparedUsers.add(user.id)
    const path = `/fake/${user.id}/${relativePath}`
    this.folders.push(path)
    return path
  }

  async startSession(input: { user: User; name: string; cwd: string; command: string | null }): Promise<void> {
    this.running.set(input.name, { user: input.user.id, cwd: input.cwd, command: input.command })
  }

  async isRunning(_user: User, name: string): Promise<boolean> {
    return this.running.has(name)
  }

  async stopSession(_user: User, name: string): Promise<void> {
    this.running.delete(name)
  }

  attach(input: { user: User; name: string; readOnly: boolean }): TerminalHandle {
    this.attached.push({ name: input.name, readOnly: input.readOnly })
    const listeners: ((data: string) => void)[] = []
    // Ecoa o que foi digitado, como um terminal faria.
    return {
      onData: (listener) => {
        listeners.push(listener)
        setTimeout(() => listener(`conectado a ${input.name}\r\n`), 0)
      },
      onExit: () => undefined,
      write: (data) => {
        this.written.push({ name: input.name, data })
        for (const listener of listeners) listener(data)
      },
      resize: () => undefined,
      kill: () => undefined
    }
  }

  spawnPiped(): ChildProcess {
    throw new Error('Os testes usam provedores de chat falsos.')
  }

  changes: ChangedFile[] = []
  uncommitted = false
  ahead = 0
  readonly commits: string[] = []

  async changedFiles(_input: { user: User; path: string; base: string }): Promise<ChangedFile[]> {
    return this.changes
  }

  async hasUncommittedChanges(_input: { user: User; path: string }): Promise<boolean> {
    return this.uncommitted
  }

  async commitAll(input: { message: string }): Promise<void> {
    this.commits.push(input.message)
    this.uncommitted = false
    this.ahead++
  }

  async commitsAhead(_input: { user: User; path: string; base: string }): Promise<number> {
    return this.ahead
  }

  async exportBranch(input: { branch: string }): Promise<string> {
    return `/fake/export/${input.branch}.bundle`
  }

  async accounts(user: User): Promise<AgentAccounts> {
    return this.accountsByUser.get(user.id) ?? { claude: false, codex: false }
  }
}
