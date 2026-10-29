import type { User } from '../../../shared/types.ts'
import type { ProviderFactory } from '../chat/providers/types.ts'

export interface AiRequest {
  user: User
  // Prompt de sistema enxuto (sem o do Claude Code) e a mensagem.
  instructions: string
  prompt: string
  // Apelido do modelo na conta da pessoa ("haiku", "sonnet"); null usa o padrão da conta.
  model: string | null
  cwd: string
  timeoutMs?: number
}

// Chamadas de IA de uma vez só, no Claude Code de cada pessoa, para o vigia, os resumos e as
// sugestões: sem ferramentas, sem conversa guardada e no máximo algumas ao mesmo tempo no servidor.
export class AiRunner {
  private readonly factory: ProviderFactory
  private readonly maxConcurrent: number
  private active = 0
  private readonly queue: (() => void)[] = []

  constructor(factory: ProviderFactory, maxConcurrent = 2) {
    this.factory = factory
    this.maxConcurrent = maxConcurrent
  }

  async complete(request: AiRequest): Promise<string> {
    await this.acquire()
    try {
      return await this.run(request)
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++
      return Promise.resolve()
    }
    return new Promise((resolve) => this.queue.push(resolve))
  }

  private release(): void {
    const next = this.queue.shift()
    if (next) next()
    else this.active--
  }

  private run(request: AiRequest): Promise<string> {
    return new Promise((resolve, reject) => {
      let text = ''
      let settled = false
      const finish = (error: string | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        adapter.close()
        if (error) reject(new Error(error))
        else resolve(text.trim())
      }
      const timer = setTimeout(() => finish('A IA demorou demais para responder.'), request.timeoutMs ?? 3 * 60 * 1000)
      const adapter = this.factory({
        provider: 'claude',
        user: request.user,
        cwd: request.cwd,
        resumeId: null,
        permissionMode: 'auto',
        model: request.model,
        policy: { tools: [], roots: [request.cwd] },
        bare: true,
        instructions: request.instructions,
        hooks: {
          onSession: () => undefined,
          onTextDelta: () => undefined,
          onTextDone: (_key, value) => {
            if (value.trim()) text = value
          },
          onToolStart: () => undefined,
          onToolEnd: () => undefined,
          requestApproval: async () => 'deny',
          onNotice: () => undefined,
          onSuggestion: () => undefined,
          onTurnEnd: (error) => finish(error),
          onExit: (error) => finish(error ?? (settled ? null : 'O Claude encerrou antes de responder.'))
        }
      })
      adapter.send(request.prompt).catch((error: Error) => finish(error.message))
    })
  }
}

// Lê um objeto JSON da resposta (dentro de ```json ou solto).
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  try {
    return JSON.parse(candidate)
  } catch {
    return null
  }
}
