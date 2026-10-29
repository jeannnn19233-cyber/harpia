import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { CHAT_PROVIDERS, PERMISSION_MODES, type User } from '../../../shared/types.ts'
import { requireUser } from '../auth/guard.ts'
import {
  ensureAgentsEnabled,
  ensureTaskOpen,
  joinTaskForWork,
  prepareTaskWorkspace,
  publishTaskChange
} from '../agents/workspace.ts'
import type { AppContext } from '../context.ts'
import { transaction } from '../db/index.ts'
import { HttpError, parse, parseId } from '../http/errors.ts'
import { getTask, insertEvent } from '../tasks/store.ts'
import type { ChatManager } from './manager.ts'
import { getChat, insertChat, listActiveChats, listItems, listTaskChats, publicChat, type StoredChat } from './store.ts'

const createSchema = z.object({
  provider: z.enum(CHAT_PROVIDERS),
  permissionMode: z.enum(PERMISSION_MODES).default('ask')
})
const messageSchema = z.object({ text: z.string().trim().min(1).max(100000) })
const decisionSchema = z.object({ decision: z.enum(['allow', 'deny']) })
const updateSchema = z.object({ permissionMode: z.enum(PERMISSION_MODES) })

export function registerChatRoutes(app: FastifyInstance, ctx: AppContext, manager: ChatManager): void {
  app.addHook('onReady', async () => manager.recoverAfterRestart())
  app.addHook('preClose', async () => manager.shutdown())

  function loadChat(id: unknown): StoredChat {
    const chat = getChat(ctx.db, parseId(id))
    if (!chat) throw new HttpError(404, 'Conversa não encontrada.')
    return chat
  }

  // Só quem abriu a conversa fala com o agente dela; a equipe acompanha.
  function requireOwner(chat: StoredChat, user: User): void {
    if (chat.userId !== user.id) throw new HttpError(403, 'Esta conversa é de outra pessoa. Você pode acompanhar, mas não enviar.')
  }

  app.get('/api/chats/active', async () => ({ chats: listActiveChats(ctx.db).map(publicChat) }))

  app.get('/api/tasks/:id/chats', async (request) => {
    const taskId = parseId((request.params as { id: string }).id)
    if (!getTask(ctx.db, taskId)) throw new HttpError(404, 'Task não encontrada.')
    return { chats: listTaskChats(ctx.db, taskId).map(publicChat) }
  })

  app.post('/api/tasks/:id/chats', async (request) => {
    const user = requireUser(request)
    const task = getTask(ctx.db, parseId((request.params as { id: string }).id))
    if (!task) throw new HttpError(404, 'Task não encontrada.')
    const input = parse(createSchema, request.body)
    ensureAgentsEnabled(ctx)
    ensureTaskOpen(task)
    const worktree = await prepareTaskWorkspace(ctx, task, user, (error, message) => app.log.warn(error, message))

    const { chat, events } = transaction(ctx.db, () => {
      const now = ctx.now()
      const created = insertChat(ctx.db, {
        taskId: task.id,
        userId: user.id,
        provider: input.provider,
        permissionMode: input.permissionMode,
        branch: worktree.branch,
        cwd: worktree.path,
        now
      })
      const list = joinTaskForWork(ctx, task.id, user, now)
      list.push(
        insertEvent(ctx.db, {
          taskId: task.id,
          actorId: user.id,
          type: 'chat_started',
          data: { chatId: created.id, provider: input.provider, branch: worktree.branch },
          now
        })
      )
      return { chat: created, events: list }
    })
    ctx.hub.broadcast({ type: 'chat', chat: publicChat(chat) })
    publishTaskChange(ctx, task.id, events)
    return { chat: publicChat(chat) }
  })

  app.get('/api/chats/:id', async (request) => {
    const chat = loadChat((request.params as { id: string }).id)
    return { chat: publicChat(chat), items: listItems(ctx.db, chat.id) }
  })

  app.post('/api/chats/:id/messages', async (request) => {
    const user = requireUser(request)
    const chat = loadChat((request.params as { id: string }).id)
    requireOwner(chat, user)
    if (chat.status === 'closed') throw new HttpError(409, 'Esta conversa foi encerrada.')
    ensureAgentsEnabled(ctx)
    const { text } = parse(messageSchema, request.body)
    await manager.send(chat, user, text)
    return { ok: true }
  })

  app.post('/api/chats/:id/interrupt', async (request) => {
    const chat = loadChat((request.params as { id: string }).id)
    requireOwner(chat, requireUser(request))
    await manager.interrupt(chat)
    return { ok: true }
  })

  app.post('/api/chats/:id/approvals/:itemId', async (request) => {
    const user = requireUser(request)
    const params = request.params as { id: string; itemId: string }
    const chat = loadChat(params.id)
    requireOwner(chat, user)
    const { decision } = parse(decisionSchema, request.body)
    return { item: manager.decide(chat, parseId(params.itemId), decision, user) }
  })

  app.patch('/api/chats/:id', async (request) => {
    const chat = loadChat((request.params as { id: string }).id)
    requireOwner(chat, requireUser(request))
    const { permissionMode } = parse(updateSchema, request.body)
    await manager.setPermissionMode(chat, permissionMode)
    return { chat: publicChat(getChat(ctx.db, chat.id) ?? chat) }
  })

  app.post('/api/chats/:id/close', async (request) => {
    const user = requireUser(request)
    const chat = loadChat((request.params as { id: string }).id)
    if (chat.userId !== user.id && user.role !== 'admin') {
      throw new HttpError(403, 'Só quem abriu a conversa (ou um administrador) pode encerrá-la.')
    }
    manager.close(chat)
    return { chat: publicChat(getChat(ctx.db, chat.id) ?? chat) }
  })
}
