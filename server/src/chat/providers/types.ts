import type { ChatProvider, PermissionMode, User } from '../../../../shared/types.ts'

// O que o provedor (Claude ou Codex) avisa enquanto trabalha. "key" identifica cada
// bloco (um texto, uma ferramenta) para atualizar o mesmo item na conversa.
export interface ProviderHooks {
  onSession(providerSessionId: string): void
  onTextDelta(key: string, delta: string): void
  onTextDone(key: string, text: string): void
  onToolStart(key: string, name: string, summary: string): void
  onToolEnd(key: string, ok: boolean, output: string | null): void
  // O agente quer fazer algo que precisa de aprovação. Resolve com a decisão da pessoa.
  requestApproval(input: { title: string; detail: string; signal?: AbortSignal }): Promise<'allow' | 'deny'>
  // Aviso sobre o andamento (ex.: tentando reconectar). Atualiza o mesmo aviso durante a vez.
  onNotice(text: string): void
  // Próxima mensagem que a pessoa provavelmente vai querer mandar.
  onSuggestion(text: string): void
  onTurnEnd(error: string | null): void
  // O processo do agente terminou (por erro ou porque foi fechado).
  onExit(error: string | null): void
}

export interface ProviderAdapter {
  send(text: string): Promise<void>
  // Mensagem enviada enquanto o agente trabalha: entra no meio da vez dele.
  steer(text: string): Promise<void>
  interrupt(): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  close(): void
}

export interface ProviderInput {
  provider: ChatProvider
  user: User
  cwd: string
  resumeId: string | null
  permissionMode: PermissionMode
  // Contexto que o agente recebe ao começar: a task, a branch e a memória do projeto.
  instructions: string | null
  hooks: ProviderHooks
}

export type ProviderFactory = (input: ProviderInput) => ProviderAdapter

// Saídas longas de comandos são cortadas para não pesar a conversa.
export function truncate(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} caracteres omitidos)` : text
}
