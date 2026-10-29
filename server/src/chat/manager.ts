import type { ChatItem, PermissionMode, User } from '../../../shared/types.ts'
import { getUser } from '../auth/users.ts'
import type { AppContext } from '../context.ts'
import { HttpError } from '../http/errors.ts'
import type { ProviderAdapter, ProviderFactory, ProviderHooks } from './providers/types.ts'
import {
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

export class ChatManager {
  private readonly ctx: AppContext
  private readonly factory: ProviderFactory
  private readonly runtimes = new Map<number, Runtime>()
  private readonly sweeper: ReturnType<typeof setInterval>

  constructor(ctx: AppContext, factory: ProviderFactory) {
    this.ctx = ctx
    this.factory = factory
    this.sweeper = setInterval(() => this.shutdownIdle(), 60 * 1000)
    this.sweeper.unref()
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
    if (chat.status === 'working' || chat.status === 'waiting') {
      throw new HttpError(409, 'O agente ainda está trabalhando. Espere terminar ou interrompa.')
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
      this.addItem(chat.id, { kind: 'error', text: `Não foi possível falar com o agente: ${(error as Error).message}` })
      this.dropRuntime(chat.id)
      this.setStatus(chat.id, 'idle')
    }
  }

  async interrupt(chat: StoredChat): Promise<void> {
    await this.runtimes.get(chat.id)?.adapter.interrupt()
  }

  async setPermissionMode(chat: StoredChat, mode: PermissionMode): Promise<void> {
    this.publish(updateChat(this.ctx.db, chat.id, { permissionMode: mode }, this.ctx.now()))
    await this.runtimes.get(chat.id)?.adapter.setPermissionMode(mode)
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

  private ensureRuntime(chat: StoredChat): Runtime {
    const existing = this.runtimes.get(chat.id)
    if (existing) return existing
    const user = getUser(this.ctx.db, chat.userId)
    if (!user) throw new HttpError(404, 'Dona da conversa não encontrada.')
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
      }
    }
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

  private publish(chat: StoredChat | null): void {
    if (chat) this.ctx.hub.broadcast({ type: 'chat', chat: publicChat(chat) })
  }

  private addItem(chatId: number, data: ChatItemData): ChatItem {
    const item = insertItem(this.ctx.db, chatId, data, this.ctx.now())
    this.ctx.hub.broadcast({ type: 'chat_item', item })
    return item
  }

  private updateItem(itemId: number, data: ChatItemData): ChatItem | null {
    const item = updateItem(this.ctx.db, itemId, data, this.ctx.now())
    if (item) this.ctx.hub.broadcast({ type: 'chat_item', item })
    return item
  }
}
