import { CHAT_PROVIDER_LABELS, type ChatItem, type ChatModel, type ChatProvider, type PermissionMode, type User } from '../../../shared/types.ts'
import { agentsDisabledReason } from '../agents/workspace.ts'
import { getUser } from '../auth/users.ts'
import { getMemory } from '../memory/store.ts'
import { getProject } from '../projects/store.ts'
import { getTask } from '../tasks/store.ts'
import type { AppContext } from '../context.ts'
import { HttpError } from '../http/errors.ts'
import type { ModelLister, ProviderAdapter, ProviderFactory, ProviderHooks } from './providers/types.ts'
import {
  canSeeChat,
  deleteChat,
  getChat,
  getItem,
  insertItem,
  itemData,
  listBusyChats,
  publicChat,
  updateChat,
  updateItem,
  type ChatItemData,
  type StoredChat
} from './store.ts'

interface Runtime {
  adapter: ProviderAdapter
  lastActiveAt: number
  // Itens da conversa ligados a cada bloco do provedor (texto, ferramenta).
  items: Map<string, number>
  // Aprovações esperando a decisão da pessoa.
  approvals: Map<number, (decision: 'allow' | 'deny') => void>
  // Aviso de andamento da vez atual, atualizado no lugar.
  noticeItemId: number | null
}

// Conversas paradas por mais tempo que isso têm o processo do agente desligado para poupar
// memória. A próxima mensagem retoma a mesma conversa.
const IDLE_SHUTDOWN_MS = 20 * 60 * 1000
// A lista de modelos de cada conta muda pouco; perguntar de novo só depois disso.
const MODELS_CACHE_MS = 10 * 60 * 1000

export class ChatManager {
  private readonly ctx: AppContext
  private readonly factory: ProviderFactory
  private readonly runtimes = new Map<number, Runtime>()
  private readonly sweeper: ReturnType<typeof setInterval>
  private readonly lister: ModelLister
  private readonly modelsCache = new Map<string, { at: number; models: Promise<ChatModel[]> }>()
  // Depois de cada vez terminada sem erro (usado para sugerir a próxima mensagem no Codex).
  onTurnFinished: (chat: StoredChat) => void = () => undefined
  // Quem espera o fim da vez de cada conversa (execuções automáticas).
  private readonly turnWaiters = new Map<number, ((error: string | null) => void)[]>()

  constructor(ctx: AppContext, factory: ProviderFactory, lister: ModelLister) {
    this.ctx = ctx
    this.factory = factory
    this.lister = lister
    this.sweeper = setInterval(() => this.shutdownIdle(), 60 * 1000)
    this.sweeper.unref()
  }

  // Diagnóstico dos agentes de uma pessoa, etapa por etapa, para achar onde a corrente quebra:
  // servidor, usuário no servidor, login, programa e (com "live") uma resposta de verdade.
  async diagnose(user: User, provider: ChatProvider, live: boolean): Promise<DiagnosisStep[]> {
    const steps: DiagnosisStep[] = []
    const name = provider === 'claude' ? 'Claude Code' : 'Codex'
    const add = (key: DiagnosisStep['key'], ok: boolean, detail: string) => {
      steps.push({ key, ok, detail })
      return ok
    }
    const disabled = agentsDisabledReason(this.ctx)
    if (!add('server', !disabled, disabled ?? 'Os agentes estão ligados neste servidor.')) return steps
    try {
      await this.ctx.agents.prepareUser(user)
      add('user', true, 'Sua pasta e seu usuário no servidor estão prontos.')
    } catch (error) {
      add('user', false, `Não consegui preparar seu usuário no servidor: ${(error as Error).message.slice(0, 300)}`)
      return steps
    }
    const accounts = await this.ctx.agents.accounts(user)
    if (
      !add(
        'login',
        accounts[provider],
        accounts[provider]
          ? `Há um login do ${name} guardado na sua pasta.`
          : `O ${name} não está conectado na sua conta. Em "Minhas IAs", clique em "Conectar ${name}".`
      )
    ) {
      return steps
    }
    const cwd = this.ctx.agents.homeDir(user)
    try {
      const models = await withTimeout(this.lister({ provider, user, cwd }), 45000, `O ${name} não respondeu em 45 s ao listar os modelos.`)
      add('program', true, `O ${name} abriu com o seu usuário e oferece ${models.length} modelo(s): ${models.map((model) => model.label).join(', ')}.`)
    } catch (error) {
      add('program', false, `O ${name} não abriu direito: ${(error as Error).message.slice(0, 400)}`)
      return steps
    }
    if (!live) return steps
    try {
      const folder = await this.ctx.agents.prepareFolder(user, 'diagnostico')
      const reply = await withTimeout(this.ping(provider, user, folder), 120000, `O ${name} não respondeu em 2 minutos.`)
      add('reply', /\bok\b/i.test(reply), reply ? `O ${name} respondeu: "${reply.slice(0, 200)}"` : `O ${name} terminou sem responder nada.`)
    } catch (error) {
      add('reply', false, (error as Error).message.slice(0, 600))
    }
    return steps
  }

  // Uma mensagem curta de verdade ("responda ok"), com o modelo mais barato da conta.
  private ping(provider: ChatProvider, user: User, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let text = ''
      let settled = false
      const finish = (error: string | null) => {
        if (settled) return
        settled = true
        adapter.close()
        if (error) reject(new Error(error))
        else resolve(text.trim())
      }
      const adapter = this.factory({
        provider,
        user,
        cwd,
        resumeId: null,
        permissionMode: 'ask',
        model: provider === 'claude' ? 'haiku' : null,
        policy: provider === 'claude' ? { tools: [], roots: [cwd] } : null,
        bare: provider === 'claude',
        instructions: 'Teste de conexão do Harpia. Responda apenas com a palavra ok, sem usar ferramentas.',
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
          onExit: (error) => finish(error ?? (text ? null : 'O agente encerrou sem responder.'))
        }
      })
      adapter.send('Responda apenas com a palavra: ok').catch((error: Error) => finish(error.message))
    })
  }

  // Ao iniciar, nenhuma conversa está rodando: as que estavam trabalhando foram interrompidas.
  recoverAfterRestart(): void {
    for (const chat of listBusyChats(this.ctx.db)) {
      this.addItem(chat.id, { kind: 'error', text: 'O servidor reiniciou e interrompeu o agente. Envie uma mensagem para continuar.' })
      this.setStatus(chat.id, 'idle')
    }
  }

  isRunning(chatId: number): boolean {
    return this.runtimes.has(chatId)
  }

  async send(chat: StoredChat, author: User, text: string): Promise<void> {
    if (chat.status === 'waiting') {
      throw new HttpError(409, 'O agente está esperando sua aprovação. Responda o pedido antes de mandar outra mensagem.')
    }
    if (chat.suggestion) this.publish(updateChat(this.ctx.db, chat.id, { suggestion: null }, this.ctx.now()))
    // Com o agente trabalhando, a mensagem entra no meio da vez dele, como no Claude Code.
    const running = this.runtimes.get(chat.id)
    if (chat.status === 'working' && running) {
      this.addItem(chat.id, { kind: 'user', text, authorId: author.id, steer: true })
      running.lastActiveAt = Date.now()
      try {
        await running.adapter.steer(text)
      } catch (error) {
        this.addItem(chat.id, { kind: 'error', text: `Não foi possível entregar a mensagem ao agente: ${(error as Error).message}` })
      }
      return
    }
    this.addItem(chat.id, { kind: 'user', text, authorId: author.id })
    if (chat.title === 'Nova conversa') {
      const title = text.replace(/\s+/g, ' ').trim().slice(0, 60)
      this.publish(updateChat(this.ctx.db, chat.id, { title }, this.ctx.now()))
    }
    this.setStatus(chat.id, 'working')
    const runtime = this.ensureRuntime(chat)
    runtime.lastActiveAt = Date.now()
    try {
      await runtime.adapter.send(text)
    } catch (error) {
      const message = `Não foi possível falar com o agente: ${(error as Error).message}`
      this.addItem(chat.id, { kind: 'error', text: message })
      this.resolveTurn(chat.id, message)
      this.dropRuntime(chat.id)
      this.setStatus(chat.id, 'idle')
    }
  }

  // Sugestão vinda de fora do provedor (ex.: a do Codex, escrita pelo Claude). Só vale se a pessoa
  // ainda não mandou outra mensagem.
  applySuggestion(chatId: number, text: string): void {
    const chat = getChat(this.ctx.db, chatId)
    if (!chat || chat.status !== 'idle' || chat.suggestion) return
    this.publish(updateChat(this.ctx.db, chatId, { suggestion: text.slice(0, 500) }, this.ctx.now()))
  }

  // Uma vez completa sem ninguém olhando (rotinas, revisões, Telegram): manda a mensagem, espera o
  // fim e devolve a última resposta do agente. Para o agente se ele ficar parado ou passar do limite.
  async runTurn(
    chat: StoredChat,
    text: string,
    limits: { inactivityMs?: number; maxMs?: number } = {}
  ): Promise<{ text: string; error: string | null }> {
    const owner = getUser(this.ctx.db, chat.userId)
    if (!owner) throw new HttpError(404, 'Dona da conversa não encontrada.')
    if (chat.status !== 'idle') throw new HttpError(409, 'A conversa já está ocupada.')
    const inactivityMs = limits.inactivityMs ?? 10 * 60 * 1000
    const maxMs = limits.maxMs ?? 60 * 60 * 1000
    const before = this.lastItemId(chat.id)
    const started = Date.now()
    let watchdog: ReturnType<typeof setInterval> | undefined
    const finished = new Promise<string | null>((resolve) => {
      const list = this.turnWaiters.get(chat.id) ?? []
      list.push(resolve)
      this.turnWaiters.set(chat.id, list)
      watchdog = setInterval(() => {
        const runtime = this.runtimes.get(chat.id)
        const idleFor = Date.now() - (runtime?.lastActiveAt ?? started)
        if (idleFor < inactivityMs && Date.now() - started < maxMs) return
        const reason =
          idleFor >= inactivityMs
            ? `O agente ficou ${Math.round(inactivityMs / 60000)} minutos sem responder e foi parado.`
            : `A execução passou de ${Math.round(maxMs / 60000)} minutos e foi parada.`
        this.addItem(chat.id, { kind: 'error', text: reason })
        this.resolveTurn(chat.id, reason)
        this.dropRuntime(chat.id)
        this.setStatus(chat.id, 'idle')
      }, Math.min(15000, Math.max(50, inactivityMs / 4)))
    })
    try {
      await this.send(chat, owner, text)
      const error = await finished
      return { text: this.lastAssistantText(chat.id, before), error }
    } finally {
      clearInterval(watchdog)
    }
  }

  private resolveTurn(chatId: number, error: string | null): void {
    const list = this.turnWaiters.get(chatId)
    if (!list) return
    this.turnWaiters.delete(chatId)
    for (const resolve of list) resolve(error)
  }

  private lastItemId(chatId: number): number {
    const row = this.ctx.db.prepare('SELECT MAX(id) AS id FROM chat_items WHERE chat_id = ?').get(chatId) as { id: number | null }
    return row.id ?? 0
  }

  private lastAssistantText(chatId: number, afterId: number): string {
    const row = this.ctx.db
      .prepare("SELECT data FROM chat_items WHERE chat_id = ? AND id > ? AND kind = 'assistant' ORDER BY id DESC LIMIT 1")
      .get(chatId, afterId) as { data: string } | undefined
    return row ? String((JSON.parse(row.data) as { text?: string }).text ?? '').trim() : ''
  }

  async interrupt(chat: StoredChat): Promise<void> {
    await this.runtimes.get(chat.id)?.adapter.interrupt()
  }

  async setPermissionMode(chat: StoredChat, mode: PermissionMode): Promise<void> {
    this.publish(updateChat(this.ctx.db, chat.id, { permissionMode: mode }, this.ctx.now()))
    await this.runtimes.get(chat.id)?.adapter.setPermissionMode(mode)
  }

  async setEffort(chat: StoredChat, effort: string | null): Promise<void> {
    this.publish(updateChat(this.ctx.db, chat.id, { effort }, this.ctx.now()))
    await this.runtimes.get(chat.id)?.adapter.setEffort(effort)
  }

  async setModel(chat: StoredChat, model: string | null): Promise<void> {
    this.publish(updateChat(this.ctx.db, chat.id, { model }, this.ctx.now()))
    await this.runtimes.get(chat.id)?.adapter.setModel(model)
  }

  // Compartilhar mostra a conversa (só leitura) para a equipe; deixar de compartilhar a esconde de novo.
  setShared(chat: StoredChat, shared: boolean): StoredChat | null {
    const updated = updateChat(this.ctx.db, chat.id, { shared }, this.ctx.now())
    this.publish(updated)
    if (updated && !shared) {
      this.ctx.hub.broadcastWhere({ type: 'chat_removed', chatId: chat.id }, (userId) => !canSeeChat(updated, userId))
    }
    return updated
  }

  rename(chat: StoredChat, title: string): StoredChat | null {
    const updated = updateChat(this.ctx.db, chat.id, { title }, this.ctx.now())
    this.publish(updated)
    return updated
  }

  // Exclui a conversa do Harpia. Os arquivos que o agente criou continuam na pasta da pessoa.
  remove(chat: StoredChat): void {
    this.dropRuntime(chat.id)
    deleteChat(this.ctx.db, chat.id)
    this.ctx.hub.broadcastWhere({ type: 'chat_removed', chatId: chat.id }, (userId) => canSeeChat(chat, userId))
  }

  // Modelos que a conta da pessoa oferece. Em caso de falha, a conversa usa o padrão da conta.
  models(provider: ChatProvider, user: User): Promise<ChatModel[]> {
    const key = `${user.id}:${provider}`
    const cached = this.modelsCache.get(key)
    if (cached && Date.now() - cached.at < MODELS_CACHE_MS) return cached.models
    const models = this.lister({ provider, user, cwd: this.ctx.agents.homeDir(user) })
    this.modelsCache.set(key, { at: Date.now(), models })
    models.catch(() => this.modelsCache.delete(key))
    return models
  }

  decide(chat: StoredChat, itemId: number, decision: 'allow' | 'deny', user: User): ChatItem {
    const item = getItem(this.ctx.db, itemId)
    if (!item || item.chatId !== chat.id || item.kind !== 'approval') throw new HttpError(404, 'Pedido de aprovação não encontrado.')
    const resolve = this.runtimes.get(chat.id)?.approvals.get(itemId)
    if (item.status !== 'pending' || !resolve) throw new HttpError(409, 'Este pedido já foi respondido ou expirou.')
    this.runtimes.get(chat.id)?.approvals.delete(itemId)
    const updated = this.updateItem(itemId, {
      ...itemData(item),
      kind: 'approval',
      status: decision === 'allow' ? 'allowed' : 'denied',
      decidedBy: user.id
    } as ChatItemData)
    this.setStatus(chat.id, 'working')
    resolve(decision)
    return updated ?? item
  }

  close(chat: StoredChat): void {
    this.dropRuntime(chat.id)
    this.setStatus(chat.id, 'closed')
  }

  shutdown(): void {
    clearInterval(this.sweeper)
    for (const chatId of [...this.runtimes.keys()]) this.dropRuntime(chatId)
  }

  private shutdownIdle(): void {
    const limit = Date.now() - IDLE_SHUTDOWN_MS
    for (const [chatId, runtime] of this.runtimes) {
      const chat = getChat(this.ctx.db, chatId)
      if (chat?.status === 'idle' && runtime.lastActiveAt < limit) this.dropRuntime(chatId)
    }
  }

  private dropRuntime(chatId: number): void {
    const runtime = this.runtimes.get(chatId)
    if (!runtime) return
    this.runtimes.delete(chatId)
    this.expireApprovals(chatId, runtime)
    runtime.adapter.close()
    this.resolveTurn(chatId, 'A conversa foi encerrada antes do fim.')
  }

  private expireApprovals(chatId: number, runtime: Runtime): void {
    for (const [itemId, resolve] of runtime.approvals) {
      const item = getItem(this.ctx.db, itemId)
      if (item?.kind === 'approval' && item.status === 'pending') {
        this.updateItem(itemId, { ...itemData(item), kind: 'approval', status: 'expired' } as ChatItemData)
      }
      resolve('deny')
    }
    runtime.approvals.clear()
    void chatId
  }

  // O que o agente precisa saber ao começar: a task, a branch e a memória do projeto.
  instructionsFor(chat: StoredChat): string | null {
    if (chat.instructions) return chat.instructions
    if (chat.taskId === null) {
      return (
        'Você está numa conversa pelo Harpia, o workspace da equipe, fora de qualquer task. ' +
        'A pasta atual é só desta conversa: use-a para arquivos de rascunho. Responda em português do Brasil, a menos que a pessoa escreva em outra língua.'
      )
    }
    const task = getTask(this.ctx.db, chat.taskId)
    if (!task) return null
    const project = getProject(this.ctx.db, task.projectId)
    const memory = getMemory(this.ctx.db, task.projectId)
    const parts = [
      `Você está trabalhando pelo Harpia, o workspace da equipe, na task T-${task.number} "${task.title}"` +
        (project ? ` do projeto ${project.name}.` : '.'),
      task.description.trim() ? `Descrição da task:\n${task.description.trim()}` : '',
      `Você está na branch ${chat.branch ?? '(desconhecida)'}, numa cópia do código só desta pessoa. Faça commits normalmente; ` +
        'para entregar, a pessoa usa "Abrir PR" no Harpia. Não faça push nem abra pull requests por conta própria.',
      memory.body ? `Memória do projeto (escrita pela equipe):\n${memory.body}` : ''
    ]
    return parts.filter(Boolean).join('\n\n')
  }

  // Avisa a dona da conversa fora do Harpia (Telegram), só se ela não estiver com o Harpia aberto.
  private notifyOwner(chatId: number, text: (where: string, provider: string) => string): void {
    const chat = getChat(this.ctx.db, chatId)
    if (!chat) return
    const task = chat.taskId ? getTask(this.ctx.db, chat.taskId) : null
    const where = task ? `T-${task.number} "${task.title}"` : `"${chat.title}"`
    void this.ctx.notifier.notifyUsers([chat.userId], text(where, CHAT_PROVIDER_LABELS[chat.provider]) + this.ctx.notifier.link('/'), {
      onlyOffline: true
    })
  }

  private ensureRuntime(chat: StoredChat): Runtime {
    const existing = this.runtimes.get(chat.id)
    if (existing) return existing
    const user = getUser(this.ctx.db, chat.userId)
    if (!user) throw new HttpError(404, 'Dona da conversa não encontrada.')
    if (chat.policy && chat.provider !== 'claude') throw new HttpError(400, 'Execuções automáticas usam o Claude Code.')
    const runtime: Runtime = {
      adapter: null as unknown as ProviderAdapter,
      lastActiveAt: Date.now(),
      items: new Map(),
      approvals: new Map(),
      noticeItemId: null
    }
    runtime.adapter = this.factory({
      provider: chat.provider,
      user,
      cwd: chat.cwd,
      resumeId: chat.providerSessionId,
      permissionMode: chat.permissionMode,
      model: chat.model,
      effort: chat.effort,
      policy: chat.policy,
      instructions: this.instructionsFor(chat),
      hooks: this.hooksFor(chat.id, runtime)
    })
    this.runtimes.set(chat.id, runtime)
    return runtime
  }

  private hooksFor(chatId: number, runtime: Runtime): ProviderHooks {
    const touch = () => (runtime.lastActiveAt = Date.now())
    const current = () => this.runtimes.get(chatId) === runtime
    const textOf = (itemId: number) => {
      const item = getItem(this.ctx.db, itemId)
      return item?.kind === 'assistant' ? item.text : ''
    }
    return {
      onSession: (providerSessionId) => {
        updateChat(this.ctx.db, chatId, { providerSessionId }, this.ctx.now())
      },
      onTextDelta: (key, delta) => {
        if (!current()) return
        touch()
        this.markWorking(chatId)
        const existing = runtime.items.get(key)
        if (existing === undefined) {
          const item = this.addItem(chatId, { kind: 'assistant', text: delta, streaming: true })
          runtime.items.set(key, item.id)
        } else {
          this.updateItem(existing, { kind: 'assistant', text: textOf(existing) + delta, streaming: true })
        }
      },
      onTextDone: (key, text) => {
        if (!current()) return
        touch()
        const existing = runtime.items.get(key)
        if (existing === undefined) {
          if (text.trim()) runtime.items.set(key, this.addItem(chatId, { kind: 'assistant', text, streaming: false }).id)
        } else {
          this.updateItem(existing, { kind: 'assistant', text: text || textOf(existing), streaming: false })
        }
      },
      onToolStart: (key, name, summary) => {
        if (!current()) return
        touch()
        this.markWorking(chatId)
        const existing = runtime.items.get(key)
        if (existing === undefined) {
          runtime.items.set(key, this.addItem(chatId, { kind: 'tool', name, summary, status: 'running', output: null }).id)
        } else if (summary) {
          const item = getItem(this.ctx.db, existing)
          if (item?.kind === 'tool') this.updateItem(existing, { ...itemData(item), kind: 'tool', name, summary } as ChatItemData)
        }
      },
      onToolEnd: (key, ok, output) => {
        if (!current()) return
        touch()
        const existing = runtime.items.get(key)
        const item = existing === undefined ? null : getItem(this.ctx.db, existing)
        if (item?.kind !== 'tool') return
        this.updateItem(item.id, { ...itemData(item), kind: 'tool', status: ok ? 'done' : 'failed', output } as ChatItemData)
      },
      requestApproval: ({ title, detail, signal }) => {
        if (!current()) return Promise.resolve('deny')
        touch()
        const item = this.addItem(chatId, { kind: 'approval', title, detail, status: 'pending', decidedBy: null })
        this.setStatus(chatId, 'waiting')
        this.notifyOwner(chatId, (where, provider) => `Seu ${provider} está esperando aprovação em ${where}:\n${title}: ${detail}`)
        return new Promise((resolve) => {
          runtime.approvals.set(item.id, resolve)
          signal?.addEventListener('abort', () => {
            if (!runtime.approvals.has(item.id)) return
            runtime.approvals.delete(item.id)
            this.updateItem(item.id, { kind: 'approval', title, detail, status: 'expired', decidedBy: null })
            resolve('deny')
          })
        })
      },
      onSuggestion: (text) => {
        if (!current()) return
        this.publish(updateChat(this.ctx.db, chatId, { suggestion: text.slice(0, 500) }, this.ctx.now()))
      },
      onNotice: (text) => {
        if (!current()) return
        touch()
        if (runtime.noticeItemId === null) runtime.noticeItemId = this.addItem(chatId, { kind: 'notice', text }).id
        else this.updateItem(runtime.noticeItemId, { kind: 'notice', text })
      },
      onTurnEnd: (error) => {
        if (!current()) return
        touch()
        runtime.noticeItemId = null
        this.finishStreaming(runtime)
        this.expireApprovals(chatId, runtime)
        if (error) this.addItem(chatId, { kind: 'error', text: error })
        this.setStatus(chatId, 'idle')
        this.resolveTurn(chatId, error)
        const finished = getChat(this.ctx.db, chatId)
        if (!error && finished) this.onTurnFinished(finished)
        // Execuções automáticas avisam pelo próprio canal (rotina, revisão, Telegram).
        if (getChat(this.ctx.db, chatId)?.origin !== 'user') return
        this.notifyOwner(chatId, (where, provider) =>
          error ? `Seu ${provider} parou com erro em ${where}: ${error}` : `Seu ${provider} terminou em ${where}.`
        )
      },
      onExit: (error) => {
        if (!current()) return
        this.runtimes.delete(chatId)
        this.finishStreaming(runtime)
        this.expireApprovals(chatId, runtime)
        const chat = getChat(this.ctx.db, chatId)
        if (chat && (chat.status === 'working' || chat.status === 'waiting')) {
          this.addItem(chatId, { kind: 'error', text: error ?? 'O agente encerrou antes de terminar.' })
          this.setStatus(chatId, 'idle')
        }
        this.resolveTurn(chatId, error ?? 'O agente encerrou antes de terminar.')
      }
    }
  }

  // Uma mensagem enviada bem no fim da vez pode abrir uma vez nova: o agente volta a trabalhar.
  private markWorking(chatId: number): void {
    if (getChat(this.ctx.db, chatId)?.status === 'idle') this.setStatus(chatId, 'working')
  }

  private finishStreaming(runtime: Runtime): void {
    for (const itemId of runtime.items.values()) {
      const item = getItem(this.ctx.db, itemId)
      if (item?.kind === 'assistant' && item.streaming) this.updateItem(itemId, { kind: 'assistant', text: item.text, streaming: false })
      if (item?.kind === 'tool' && item.status === 'running') this.updateItem(itemId, { ...itemData(item), kind: 'tool', status: 'done' } as ChatItemData)
    }
    runtime.items.clear()
  }

  private setStatus(chatId: number, status: StoredChat['status']): void {
    this.publish(updateChat(this.ctx.db, chatId, { status }, this.ctx.now()))
  }

  // Conversas privadas só vão para a dona; as de task e as compartilhadas, para todos.
  publish(chat: StoredChat | null): void {
    if (chat) this.ctx.hub.broadcastWhere({ type: 'chat', chat: publicChat(chat) }, (userId) => canSeeChat(chat, userId))
  }

  private publishItem(item: ChatItem): void {
    const chat = getChat(this.ctx.db, item.chatId)
    if (chat) this.ctx.hub.broadcastWhere({ type: 'chat_item', item }, (userId) => canSeeChat(chat, userId))
  }

  private addItem(chatId: number, data: ChatItemData): ChatItem {
    const item = insertItem(this.ctx.db, chatId, data, this.ctx.now())
    this.publishItem(item)
    return item
  }

  private updateItem(itemId: number, data: ChatItemData): ChatItem | null {
    const item = updateItem(this.ctx.db, itemId, data, this.ctx.now())
    if (item) this.publishItem(item)
    return item
  }
}

export interface DiagnosisStep {
  key: 'server' | 'user' | 'login' | 'program' | 'reply'
  ok: boolean
  detail: string
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
