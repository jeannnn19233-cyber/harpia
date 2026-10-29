import type { ChildProcess } from 'node:child_process'
import type { AgentAccounts, ChangedFile, Project, Task, User } from '../../../shared/types.ts'

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
  // Cópia (na pasta da pessoa) do commit de um PR, para o revisor ler. Devolve o caminho.
  prepareReviewCheckout(input: { user: User; project: Project; mirrorPath: string; number: number; sha: string }): Promise<string>
  // HEAD da cópia de revisão e os commits feitos depois de "from" (mensagens e arquivos).
  branchLog(input: { user: User; path: string; from: string }): Promise<{ head: string; commits: { sha: string; message: string; files: string[] }[] }>
  // Cria (como a pessoa) uma pasta dentro da pasta dela e devolve o caminho. Usada pelas conversas fora das tasks.
  prepareFolder(user: User, relativePath: string): Promise<string>
  // Grava um arquivo na pasta da pessoa, como ela (nunca como root: links simbólicos na pasta
  // dela não levam a escrita para fora). Devolve o caminho completo.
  writeUserFile(user: User, relativePath: string, content: Buffer | string): Promise<string>
  // Pastas configuradas no Obsidian Sync (obsidian-headless) da pessoa; null se o "ob" não está instalado.
  obsidianVaults(user: User): Promise<string[] | null>
  // command null abre só o shell.
  startSession(input: { user: User; name: string; cwd: string; command: string | null }): Promise<void>
  isRunning(user: User, name: string): Promise<boolean>
  stopSession(user: User, name: string): Promise<void>
  attach(input: { user: User; name: string; readOnly: boolean; cols: number; rows: number }): TerminalHandle
  accounts(user: User): Promise<AgentAccounts>
  // Roda um programa como o usuário da pessoa, com entrada e saída ligadas ao servidor
  // (usado pelos chats). env acrescenta variáveis ao ambiente limpo da pessoa.
  spawnPiped(input: { user: User; command: string; args: string[]; cwd: string; env?: Record<string, string> }): ChildProcess

  // Git na cópia de trabalho da pessoa (sempre como o usuário dela).
  // Arquivos alterados em relação à branch principal, incluindo o que ainda não foi commitado.
  changedFiles(input: { user: User; path: string; base: string }): Promise<ChangedFile[]>
  hasUncommittedChanges(input: { user: User; path: string }): Promise<boolean>
  commitAll(input: { user: User; path: string; message: string }): Promise<void>
  commitsAhead(input: { user: User; path: string; base: string }): Promise<number>
  // Empacota a branch num arquivo (git bundle) que o servidor importa no espelho. Devolve o caminho.
  exportBranch(input: { user: User; path: string; branch: string }): Promise<string>
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
