import {
  query,
  type CanUseTool,
  type PermissionMode as SdkPermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess
} from '@anthropic-ai/claude-agent-sdk'
import type { ChatModel, PermissionMode } from '../../../../shared/types.ts'
import { truncate, type ProviderAdapter, type ProviderHooks, type ProviderInput, type SpawnAsUser } from './types.ts'

// O Claude Code instalado na imagem. Ele usa o login que a pessoa fez em "Minhas IAs".
const CLAUDE_BIN = process.env.HARPIA_CLAUDE_BIN ?? '/usr/local/bin/claude'

const SDK_MODES: Record<PermissionMode, SdkPermissionMode> = {
  ask: 'default',
  edits: 'acceptEdits',
  auto: 'bypassPermissions'
}

// Fila de mensagens da pessoa, consumida pelo SDK enquanto a conversa estiver aberta.
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly pending: SDKUserMessage[] = []
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null
  private closed = false

  push(message: SDKUserMessage): void {
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: message, done: false })
    } else {
      this.pending.push(message)
    }
  }

  close(): void {
    this.closed = true
    this.waiting?.({ value: undefined, done: true })
    this.waiting = null
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const message = this.pending.shift()
        if (message) return Promise.resolve({ value: message, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => (this.waiting = resolve))
      }
    }
  }
}

export function friendlyClaudeError(error: string): string {
  if (/not logged in|\/login|invalid api key|authentication/i.test(error)) {
    return 'O Claude não está conectado na sua conta. Abra "Minhas IAs", conecte o Claude Code e envie a mensagem de novo.'
  }
  return error
}

// Resumo de uma ferramenta do Claude para mostrar na conversa.
export function describeClaudeTool(name: string, input: Record<string, unknown>): string {
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  switch (name) {
    case 'Bash':
      return text(input.command)
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return text(input.file_path) || text(input.notebook_path)
    case 'Grep':
    case 'Glob':
      return text(input.pattern)
    case 'WebFetch':
      return text(input.url)
    case 'WebSearch':
      return text(input.query)
    case 'Task':
    case 'Agent':
      return text(input.description)
    default:
      return truncate(JSON.stringify(input), 300)
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === 'object' && 'text' in block ? String((block as { text: unknown }).text) : ''))
      .join('\n')
  }
  return ''
}

// Traduz as mensagens do SDK para os avisos do Harpia. Separado para poder ser testado.
export class ClaudeMessageMapper {
  private readonly hooks: ProviderHooks
  // Blocos de texto ainda abertos em cada mensagem do assistente, na ordem em que começaram.
  private readonly openText = new Map<string, string[]>()
  private currentMessageId: string | null = null
  private readonly toolNames = new Map<string, string>()

  constructor(hooks: ProviderHooks) {
    this.hooks = hooks
  }

  handle(message: SDKMessage): void {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') this.hooks.onSession(message.session_id)
        if (message.subtype === 'api_retry') {
          this.hooks.onNotice(`A conexão com a Anthropic falhou. Tentando de novo (${message.attempt} de ${message.max_retries})…`)
        }
        return
      case 'stream_event':
        return this.handleStream(message.event as unknown as Record<string, unknown>)
      case 'assistant':
        return this.handleAssistant(message.message as unknown as { id: string; content: Record<string, unknown>[] }, message.error)
      case 'user':
        return this.handleToolResults(message.message as unknown as { content: unknown })
      case 'prompt_suggestion':
        if (message.suggestion.trim()) this.hooks.onSuggestion(message.suggestion.trim())
        return
      case 'result': {
        let error: string | null = null
        if (message.is_error) {
          error =
            message.subtype === 'success'
              ? message.result
              : ('errors' in message && Array.isArray(message.errors) && message.errors.join('\n')) || 'O Claude encerrou com erro.'
        }
        this.openText.clear()
        this.hooks.onTurnEnd(error ? friendlyClaudeError(error) : null)
        return
      }
      default:
        return
    }
  }

  private handleStream(event: Record<string, unknown>): void {
    if (event.type === 'message_start') {
      this.currentMessageId = String((event.message as { id?: string } | undefined)?.id ?? '')
      return
    }
    const messageId = this.currentMessageId
    if (!messageId) return
    const index = Number(event.index)
    const key = `${messageId}:${index}`
    if (event.type === 'content_block_start') {
      const block = event.content_block as { type: string; id?: string; name?: string }
      if (block.type === 'text') {
        const open = this.openText.get(messageId) ?? []
        open.push(key)
        this.openText.set(messageId, open)
      } else if (block.type === 'tool_use' && block.id) {
        this.toolNames.set(block.id, block.name ?? 'ferramenta')
        this.hooks.onToolStart(block.id, block.name ?? 'ferramenta', '')
      }
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta as { type: string; text?: string }
      if (delta.type === 'text_delta' && delta.text && this.openText.get(messageId)?.includes(key)) {
        this.hooks.onTextDelta(key, delta.text)
      }
    }
  }

  private handleAssistant(message: { id: string; content: Record<string, unknown>[] }, error?: string): void {
    // Mensagens de erro do próprio Claude (ex.: falta de login) aparecem uma vez só, no fim da vez.
    if (error) return
    for (const block of message.content ?? []) {
      if (block.type === 'text') {
        // Fecha o bloco de texto que veio em pedaços; se não veio em pedaços, cria um novo.
        const open = this.openText.get(message.id) ?? []
        const key = open.shift() ?? `${message.id}:final:${Math.random().toString(36).slice(2)}`
        this.openText.set(message.id, open)
        this.hooks.onTextDone(key, String(block.text ?? ''))
      } else if (block.type === 'tool_use') {
        const id = String(block.id)
        const name = String(block.name ?? this.toolNames.get(id) ?? 'ferramenta')
        this.toolNames.set(id, name)
        this.hooks.onToolStart(id, name, describeClaudeTool(name, (block.input ?? {}) as Record<string, unknown>))
      }
    }
  }

  private handleToolResults(message: { content: unknown }): void {
    if (!Array.isArray(message.content)) return
    for (const block of message.content as Record<string, unknown>[]) {
      if (block.type !== 'tool_result') continue
      const id = String(block.tool_use_id)
      const output = toolResultText(block.content)
      this.hooks.onToolEnd(id, block.is_error !== true, output ? truncate(output) : null)
    }
  }
}

// Variáveis que o SDK precisa passar ao Claude Code. O resto do ambiente do servidor fica de fora.
function claudeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && (key.startsWith('CLAUDE_CODE_') || key.startsWith('CLAUDE_AGENT_SDK'))) result[key] = value
  }
  return result
}

function spawner(spawnAsUser: SpawnAsUser, cwd: string) {
  // Com entrada e saída em pipe, stdin e stdout sempre existem.
  return (options: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined> }) =>
    spawnAsUser({ command: options.command, args: options.args, cwd: options.cwd ?? cwd, env: claudeEnv(options.env) }) as unknown as SpawnedProcess
}

// Pergunta ao Claude Code da pessoa quais modelos a conta dela oferece. Não gasta tokens.
export async function listClaudeModels(spawnAsUser: SpawnAsUser, cwd: string): Promise<ChatModel[]> {
  const queue = new MessageQueue()
  const session = query({
    prompt: queue,
    options: { cwd, pathToClaudeCodeExecutable: CLAUDE_BIN, settingSources: ['user'], spawnClaudeCodeProcess: spawner(spawnAsUser, cwd) }
  })
  try {
    const models = await session.supportedModels()
    return models
      .filter((model) => model.value !== 'default')
      .map((model) => ({ id: model.value, label: model.displayName, description: model.description }))
  } finally {
    queue.close()
    session.close()
  }
}

export function createClaudeProvider(input: ProviderInput, spawnAsUser: SpawnAsUser): ProviderAdapter {
  const { hooks } = input
  const queue = new MessageQueue()
  const mapper = new ClaudeMessageMapper(hooks)
  let running: Query | null = null
  let closed = false

  const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
    const decision = await hooks.requestApproval({
      title: `Usar ${toolName}`,
      detail: describeClaudeTool(toolName, toolInput),
      signal: options.signal
    })
    return decision === 'allow'
      ? { behavior: 'allow', updatedInput: toolInput }
      : { behavior: 'deny', message: 'A pessoa recusou esta ação.' }
  }

  const start = () => {
    running = query({
      prompt: queue,
      options: {
        cwd: input.cwd,
        resume: input.resumeId ?? undefined,
        model: input.model ?? undefined,
        includePartialMessages: true,
        // Depois de cada vez, o Claude sugere a próxima mensagem (quase grátis: usa o cache da conversa).
        promptSuggestions: true,
        permissionMode: SDK_MODES[input.permissionMode],
        allowDangerouslySkipPermissions: true,
        canUseTool,
        systemPrompt: input.instructions
          ? { type: 'preset', preset: 'claude_code', append: input.instructions }
          : { type: 'preset', preset: 'claude_code' },
        tools: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        pathToClaudeCodeExecutable: CLAUDE_BIN,
        // Com entrada e saída em pipe, stdin e stdout sempre existem.
        spawnClaudeCodeProcess: spawner(spawnAsUser, input.cwd)
      }
    })
    const current = running
    void (async () => {
      try {
        for await (const message of current) mapper.handle(message)
        if (!closed) hooks.onExit(null)
      } catch (error) {
        if (!closed) hooks.onExit((error as Error).message)
      }
    })()
  }

  return {
    async send(text) {
      if (!running) start()
      queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
    },
    // O Claude Code lê mensagens novas durante a vez e as considera no próximo passo.
    async steer(text) {
      if (!running) start()
      queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
    },
    async interrupt() {
      await running?.interrupt()
    },
    async setPermissionMode(mode) {
      input.permissionMode = mode
      await running?.setPermissionMode(SDK_MODES[mode])
    },
    async setModel(model) {
      input.model = model
      await running?.setModel(model ?? undefined)
    },
    close() {
      closed = true
      queue.close()
      running?.close()
    }
  }
}
