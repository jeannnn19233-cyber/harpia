import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { ChatModel, PermissionMode } from '../../../../shared/types.ts'
import { truncate, type ProviderAdapter, type ProviderHooks, type ProviderInput, type SpawnAsUser } from './types.ts'

const CODEX_BIN = process.env.HARPIA_CODEX_BIN ?? 'codex'

// O sandbox do Codex depende de recursos do Linux que não existem dentro do container.
// O isolamento vem do usuário Linux de cada pessoa; o modo decide quando pedir aprovação.
const APPROVAL_POLICY: Record<PermissionMode, string> = {
  ask: 'untrusted',
  edits: 'on-request',
  auto: 'never'
}
const SANDBOX = 'danger-full-access'

type Json = Record<string, unknown>

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

// O Codex tenta de novo sozinho quando a conexão com a OpenAI falha.
export function codexRetryNotice(message: string): string {
  if (/waiting for network/i.test(message)) return 'Sem conexão com a OpenAI. O Codex continua tentando; use "Parar" para desistir.'
  const attempt = message.match(/(\d+)\/(\d+)/)
  if (attempt) return `A conexão com a OpenAI caiu. Tentando de novo (${attempt[1]} de ${attempt[2]})…`
  return `O Codex está tentando de novo: ${message}`
}

// Traduz os avisos do app-server do Codex para os do Harpia. Separado para poder ser testado.
export class CodexEventMapper {
  private readonly hooks: ProviderHooks

  constructor(hooks: ProviderHooks) {
    this.hooks = hooks
  }

  notification(method: string, params: Json): void {
    switch (method) {
      case 'item/started':
        return this.itemStarted(params.item as Json)
      case 'item/agentMessage/delta':
        return this.hooks.onTextDelta(String(params.itemId), String(params.delta ?? ''))
      case 'item/completed':
        return this.itemCompleted(params.item as Json)
      case 'turn/completed': {
        const turn = params.turn as { status?: string; error?: { message?: string } | null }
        const error = turn.status === 'failed' ? (turn.error?.message ?? 'O Codex encerrou com erro.') : null
        return this.hooks.onTurnEnd(error)
      }
      case 'error': {
        const error = params.error as { message?: string; additionalDetails?: string | null } | undefined
        if (params.willRetry === true) return this.hooks.onNotice(codexRetryNotice(error?.message ?? ''))
        return this.hooks.onTurnEnd(error?.message ?? 'O Codex encerrou com erro.')
      }
      default:
        return
    }
  }

  private itemStarted(item: Json): void {
    const id = String(item.id)
    switch (item.type) {
      case 'commandExecution':
        return this.hooks.onToolStart(id, 'Comando', String(item.command ?? ''))
      case 'fileChange':
        return this.hooks.onToolStart(id, 'Arquivos', this.changedPaths(item))
      case 'mcpToolCall':
        return this.hooks.onToolStart(id, String(item.tool ?? 'ferramenta'), String(item.server ?? ''))
      case 'webSearch':
        return this.hooks.onToolStart(id, 'Busca na web', String(item.query ?? ''))
      default:
        return
    }
  }

  private itemCompleted(item: Json): void {
    const id = String(item.id)
    switch (item.type) {
      case 'agentMessage':
        return this.hooks.onTextDone(id, String(item.text ?? ''))
      case 'commandExecution': {
        const output = typeof item.aggregatedOutput === 'string' ? truncate(item.aggregatedOutput) : null
        const ok = item.status === 'completed' && (item.exitCode === 0 || item.exitCode === null || item.exitCode === undefined)
        return this.hooks.onToolEnd(id, ok, output)
      }
      case 'fileChange': {
        const changes = (item.changes as { path: string; diff: string }[] | undefined) ?? []
        const diff = changes.map((change) => `${change.path}\n${change.diff}`).join('\n')
        return this.hooks.onToolEnd(id, item.status === 'completed', diff ? truncate(diff) : null)
      }
      case 'mcpToolCall':
      case 'webSearch':
        return this.hooks.onToolEnd(id, item.status !== 'failed', null)
      default:
        return
    }
  }

  changedPaths(item: Json): string {
    const changes = (item.changes as { path: string }[] | undefined) ?? []
    return changes.map((change) => change.path).join(', ')
  }
}

const CLIENT_INFO = { name: 'harpia', title: 'Harpia', version: '0.1.0' }

// Pergunta ao Codex da pessoa quais modelos a conta dela oferece (model/list). Não gasta tokens.
export function listCodexModels(spawnAsUser: SpawnAsUser, cwd: string, timeoutMs = 20000): Promise<ChatModel[]> {
  const child = spawnAsUser({ command: CODEX_BIN, args: ['app-server'], cwd, env: {} })
  const send = (message: Json) => child.stdin?.write(`${JSON.stringify(message)}\n`)
  return new Promise<ChatModel[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('O Codex demorou para responder.')), timeoutMs)
    child.on('error', reject)
    child.on('exit', () => reject(new Error('O Codex encerrou antes de listar os modelos.')))
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let message: Json
      try {
        message = JSON.parse(line) as Json
      } catch {
        return
      }
      if (message.id === 1) {
        send({ jsonrpc: '2.0', method: 'initialized' })
        send({ jsonrpc: '2.0', id: 2, method: 'model/list', params: { includeHidden: false } })
      } else if (message.id === 2) {
        clearTimeout(timer)
        const error = message.error as { message?: string } | undefined
        if (error) return reject(new Error(error.message ?? 'O Codex não listou os modelos.'))
        const data = ((message.result as Json | undefined)?.data ?? []) as { model: string; displayName?: string; description?: string }[]
        resolve(data.map((model) => ({ id: model.model, label: model.displayName || model.model, description: model.description ?? '' })))
      }
    })
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: CLIENT_INFO, capabilities: {} } })
  }).finally(() => child.kill('SIGTERM'))
}

export function createCodexProvider(input: ProviderInput, spawnAsUser: SpawnAsUser): ProviderAdapter {
  const { hooks } = input
  const mapper = new CodexEventMapper(hooks)
  let child: ChildProcess | null = null
  let ready: Promise<string> | null = null
  let nextId = 1
  const pending = new Map<number, Pending>()
  let threadId: string | null = input.resumeId
  let turnId: string | null = null
  // Vez em andamento, que aceita mensagens no meio (turn/steer).
  let activeTurnId: string | null = null
  let closed = false
  let stderr = ''

  const write = (message: Json) => {
    child?.stdin?.write(`${JSON.stringify(message)}\n`)
  }

  const request = (method: string, params: Json): Promise<unknown> => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      write({ jsonrpc: '2.0', id, method, params })
    })
  }

  // Pedidos de aprovação do Codex viram cartões "Permitir/Recusar" na conversa.
  const answerServerRequest = async (id: unknown, method: string, params: Json) => {
    let title: string
    let detail: string
    if (method === 'item/commandExecution/requestApproval') {
      title = 'Executar comando'
      detail = String(params.command ?? '') + (params.reason ? `\n${String(params.reason)}` : '')
    } else if (method === 'item/fileChange/requestApproval') {
      title = 'Alterar arquivos'
      detail = String(params.reason ?? 'O Codex quer aplicar mudanças nos arquivos.')
    } else {
      write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Pedido não suportado pelo Harpia: ${method}` } })
      return
    }
    const decision = await hooks.requestApproval({ title, detail })
    write({ jsonrpc: '2.0', id, result: { decision: decision === 'allow' ? 'accept' : 'decline' } })
  }

  const handleLine = (line: string) => {
    let message: Json
    try {
      message = JSON.parse(line) as Json
    } catch {
      return
    }
    const hasId = message.id !== undefined && message.id !== null
    if (hasId && typeof message.method === 'string') {
      void answerServerRequest(message.id, message.method, (message.params ?? {}) as Json)
    } else if (hasId) {
      const waiter = pending.get(Number(message.id))
      if (!waiter) return
      pending.delete(Number(message.id))
      const error = message.error as { message?: string } | undefined
      if (error) waiter.reject(new Error(error.message ?? 'Erro no Codex.'))
      else waiter.resolve(message.result)
    } else if (typeof message.method === 'string') {
      if (message.method === 'turn/started') {
        turnId = String(((message.params as Json).turn as Json | undefined)?.id ?? turnId)
        activeTurnId = turnId
      }
      if (message.method === 'turn/completed') activeTurnId = null
      mapper.notification(message.method, (message.params ?? {}) as Json)
    }
  }

  const start = (): Promise<string> => {
    child = spawnAsUser({ command: CODEX_BIN, args: ['app-server'], cwd: input.cwd, env: {} })
    createInterface({ input: child.stdout! }).on('line', handleLine)
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
    child.on('exit', (code) => {
      for (const waiter of pending.values()) waiter.reject(new Error('O Codex encerrou.'))
      pending.clear()
      child = null
      ready = null
      if (!closed) hooks.onExit(code === 0 ? null : stderr.trim().split('\n').at(-1) || `O Codex encerrou (código ${code}).`)
    })
    child.on('error', (error) => {
      if (!closed) hooks.onExit(error.message)
    })

    return (async () => {
      await request('initialize', { clientInfo: CLIENT_INFO, capabilities: {} })
      write({ jsonrpc: '2.0', method: 'initialized' })
      const settings = {
        cwd: input.cwd,
        approvalPolicy: APPROVAL_POLICY[input.permissionMode],
        sandbox: SANDBOX,
        ...(input.model ? { model: input.model } : {}),
        ...(input.instructions ? { developerInstructions: input.instructions } : {})
      }
      const response = (await (threadId
        ? request('thread/resume', { threadId, ...settings, excludeTurns: true })
        : request('thread/start', settings))) as { thread: { id: string } }
      threadId = response.thread.id
      hooks.onSession(threadId)
      return threadId
    })()
  }

  return {
    async send(text) {
      if (!ready) ready = start()
      const thread = await ready
      const response = (await request('turn/start', {
        threadId: thread,
        input: [{ type: 'text', text, text_elements: [] }],
        approvalPolicy: APPROVAL_POLICY[input.permissionMode],
        ...(input.model ? { model: input.model } : {})
      })) as { turn?: { id?: string } }
      if (response.turn?.id) {
        turnId = response.turn.id
        activeTurnId = response.turn.id
      }
    },
    async steer(text) {
      if (!threadId || !activeTurnId) return this.send(text)
      try {
        await request('turn/steer', {
          threadId,
          expectedTurnId: activeTurnId,
          input: [{ type: 'text', text, text_elements: [] }]
        })
      } catch {
        // A vez acabou no meio do caminho: a mensagem começa uma vez nova.
        await this.send(text)
      }
    },
    async interrupt() {
      if (threadId && turnId) await request('turn/interrupt', { threadId, turnId })
    },
    async setPermissionMode(mode) {
      // Vale a partir da próxima mensagem.
      input.permissionMode = mode
    },
    async setModel(model) {
      // Vale a partir da próxima mensagem (o turn/start leva o modelo escolhido).
      input.model = model
    },
    close() {
      closed = true
      child?.kill('SIGTERM')
    }
  }
}
