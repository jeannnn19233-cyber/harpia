import { randomBytes } from 'node:crypto'
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
import {
  canSeeChat,
  getChat,
  insertChat,
  listActiveChats,
  listGeneralChats,
  listItems,
  listTaskChats,
  publicChat,
  type StoredChat
} from './store.ts'

// Nomes de modelo como o Claude Code e o Codex usam (ex.: "opus", "gpt-5.1-codex", "claude-x[1m]").
const modelSchema = z
  .string()
  .trim()
  .regex(/^[\w.:\-[\]/]{1,100}$/, 'Modelo inválido.')
  .nullable()
const createSchema = z.object({
  provider: z.enum(CHAT_PROVIDERS),
  permissionMode: z.enum(PERMISSION_MODES).default('ask'),
  model: modelSchema.default(null)
})
const messageSchema = z.object({ text: z.string().trim().min(1).max(100000) })
const decisionSchema = z.object({ decision: z.enum(['allow', 'deny']) })
const updateSchema = z
  .object({
    permissionMode: z.enum(PERMISSION_MODES).optional(),
    model: modelSchema.optional(),
    shared: z.boolean().optional(),
    title: z.string().trim().min(1).max(120).optional()
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), 'Nada para alterar.')
const modelsQuery = z.object({ provider: z.enum(CHAT_PROVIDERS) })

export function registerChatRoutes(app: FastifyInstance, ctx: AppContext, manager: ChatManager): void {
  app.addHook('onReady', async () => manager.recoverAfterRestart())
  app.addHook('preClose', async () => manager.shutdown())

  // Conversas privadas de outra pessoa respondem como se não existissem.
  function loadChat(id: unknown, user: User): StoredChat {
    const chat = getChat(ctx.db, parseId(id))
    if (!chat || !canSeeChat(chat, user.id)) throw new HttpError(404, 'Conversa não encontrada.')
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
        model: input.model,
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
    manager.publish(chat)
    publishTaskChange(ctx, task.id, events)
    return { chat: publicChat(chat) }
  })

  // Conversas fora das tasks: as minhas e as que a equipe compartilhou.
  app.get('/api/chats', async (request) => {
    const user = requireUser(request)
    return { chats: listGeneralChats(ctx.db, user.id).map(publicChat) }
  })

  app.post('/api/chats', async (request) => {
    const user = requireUser(request)
    const input = parse(createSchema, request.body)
    ensureAgentsEnabled(ctx)
    // Cada conversa tem uma pasta própria na pasta da pessoa, para o agente não misturar arquivos.
    const stamp = ctx.now().toISOString().slice(0, 10)
    let cwd: string
    try {
      cwd = await ctx.agents.prepareFolder(user, `conversas/${stamp}-${randomBytes(3).toString('hex')}`)
    } catch (error) {
      app.log.warn(error, 'falha ao preparar a pasta da conversa')
      throw new HttpError(500, 'Não foi possível preparar a pasta da conversa no servidor.')
    }
    const chat = insertChat(ctx.db, {
      taskId: null,
      userId: user.id,
      provider: input.provider,
      permissionMode: input.permissionMode,
      branch: null,
      cwd,
      model: input.model,
      now: ctx.now()
    })
    manager.publish(chat)
    return { chat: publicChat(chat) }
  })

  app.get('/api/me/models', async (request) => {
    const user = requireUser(request)
    const { provider } = parse(modelsQuery, request.query)
    ensureAgentsEnabled(ctx)
    try {
      return { models: await manager.models(provider, user), error: null }
    } catch (error) {
      app.log.warn(error, 'falha ao listar modelos')
      return { models: [], error: 'Não foi possível consultar os modelos da sua conta agora. A conversa usa o modelo padrão.' }
    }
  })

  app.get('/api/chats/:id', async (request) => {
    const chat = loadChat((request.params as { id: string }).id, requireUser(request))
    return { chat: publicChat(chat), items: listItems(ctx.db, chat.id) }
  })

  app.post('/api/chats/:id/messages', async (request) => {
    const user = requireUser(request)
    const chat = loadChat((request.params as { id: string }).id, user)
    requireOwner(chat, user)
    if (chat.status === 'closed') throw new HttpError(409, 'Esta conversa foi encerrada.')
    ensureAgentsEnabled(ctx)
    const { text } = parse(messageSchema, request.body)
    await manager.send(chat, user, text)
    return { ok: true }
  })

  app.post('/api/chats/:id/interrupt', async (request) => {
    const user = requireUser(request)
    const chat = loadChat((request.params as { id: string }).id, user)
    requireOwner(chat, user)
    await manager.interrupt(chat)
    return { ok: true }
  })

  app.post('/api/chats/:id/approvals/:itemId', async (request) => {
    const user = requireUser(request)
    const params = request.params as { id: string; itemId: string }
    const chat = loadChat(params.id, user)
    requireOwner(chat, user)
    const { decision } = parse(decisionSchema, request.body)
    return { item: manager.decide(chat, parseId(params.itemId), decision, user) }
  })

  app.patch('/api/chats/:id', async (request) => {
    const user = requireUser(request)
    const chat = loadChat((request.params as { id: string }).id, user)
    requireOwner(chat, user)
    const input = parse(updateSchema, request.body)
    if (input.shared !== undefined && chat.taskId !== null) {
      throw new HttpError(400, 'Conversas de task já são visíveis para toda a equipe.')
    }
    if (input.permissionMode) await manager.setPermissionMode(chat, input.permissionMode)
    if (input.model !== undefined) await manager.setModel(chat, input.model)
    if (input.shared !== undefined) manager.setShared(chat, input.shared)
    if (input.title) manager.rename(chat, input.title)
    return { chat: publicChat(getChat(ctx.db, chat.id) ?? chat) }
  })

  // Só conversas fora das tasks podem ser excluídas: as de task fazem parte do histórico da equipe.
  app.delete('/api/chats/:id', async (request) => {
    const user = requireUser(request)
    const chat = loadChat((request.params as { id: string }).id, user)
    requireOwner(chat, user)
    if (chat.taskId !== null) throw new HttpError(400, 'Conversas de task ficam no histórico da task. Use "Encerrar".')
    manager.remove(chat)
    return { ok: true }
  })

  app.post('/api/chats/:id/close', async (request) => {
    const user = requireUser(request)
    const chat = loadChat((request.params as { id: string }).id, user)
    if (chat.userId !== user.id && (user.role !== 'admin' || chat.taskId === null)) {
      throw new HttpError(403, 'Só quem abriu a conversa (ou um administrador) pode encerrá-la.')
    }
    manager.close(chat)
    return { chat: publicChat(getChat(ctx.db, chat.id) ?? chat) }
  })
}
