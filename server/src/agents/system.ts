import type { AgentAccounts, Project, Task, User } from '../../../shared/types.ts'

// Terminal ligado a uma sessão do tmux, visto por uma pessoa no navegador.
export interface TerminalHandle {
  onData(listener: (data: string) => void): void
  onExit(listener: () => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

// Tudo o que mexe no sistema operacional: usuários Linux, cópias de trabalho e tmux.
// A versão real fica em linux.ts; os testes usam uma versão em memória.
export interface AgentSystem {
  // null quando dá para usar terminais; senão, o motivo em português.
  unavailableReason(): string | null
  prepareUser(user: User): Promise<void>
  // Cria (ou reaproveita) a cópia de trabalho da pessoa para a task e devolve o caminho e a branch.
  prepareWorktree(input: { user: User; project: Project; task: Task; mirrorPath: string }): Promise<{
    path: string
    branch: string
  }>
  homeDir(user: User): string
  // command null abre só o shell.
  startSession(input: { user: User; name: string; cwd: string; command: string | null }): Promise<void>
  isRunning(user: User, name: string): Promise<boolean>
  stopSession(user: User, name: string): Promise<void>
  attach(input: { user: User; name: string; readOnly: boolean; cols: number; rows: number }): TerminalHandle
  accounts(user: User): Promise<AgentAccounts>
}

// Comando que cada tipo de sessão abre. Ao sair do agente, a pessoa cai num shell no mesmo lugar.
export const AGENT_COMMANDS: Record<'claude' | 'codex' | 'shell' | 'account', string | null> = {
  claude: 'claude; exec bash -l',
  codex: 'codex; exec bash -l',
  shell: null,
  account: null
}

export function sessionName(sessionId: number): string {
  return `harpia-${sessionId}`
}
