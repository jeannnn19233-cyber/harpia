import type { AgentAccounts, Project, Task, User } from '../../shared/types.ts'
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

  async accounts(user: User): Promise<AgentAccounts> {
    return this.accountsByUser.get(user.id) ?? { claude: false, codex: false }
  }
}
