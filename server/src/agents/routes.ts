import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AGENT_KINDS, CHAT_PROVIDERS, type AgentKind, type ChatProvider, type Task, type TaskEvent, type User } from '../../../shared/types.ts'
import { requireUser } from '../auth/guard.ts'
import { getUser } from '../auth/users.ts'
import type { AppContext } from '../context.ts'
import { transaction } from '../db/index.ts'
import { HttpError, parse, parseId } from '../http/errors.ts'
import { getTask, insertEvent } from '../tasks/store.ts'
import { AgentLogins } from './login.ts'
import {
  countRunningForUser,
  findRunningAccountSession,
  findRunningTaskSession,
  getSession,
  insertSession,
  listRunningSessions,
  listTaskSessions,
  markExited,
  publicSession,
  type StoredSession
} from './store.ts'
import { AGENT_COMMANDS, sessionName } from './system.ts'
import {
  agentsDisabledReason,
  ensureAgentsEnabled,
  ensureTaskOpen,
  joinTaskForWork,
  prepareTaskWorkspace,
  publishTaskChange
} from './workspace.ts'

const startSchema = z.object({ kind: z.enum(AGENT_KINDS) })

const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(64 * 1024) }),
  z.object({ type: z.literal('resize'), cols: z.number().int().min(10).max(500), rows: z.number().int().min(3).max(200) })
])

// De quanto em quanto tempo o servidor confere se as sessões ainda estão vivas.
const MONITOR_INTERVAL_MS = 15000

export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const disabledReason = () => agentsDisabledReason(ctx)
  const ensureEnabled = () => ensureAgentsEnabled(ctx)

  function publishSession(session: StoredSession): void {
    ctx.hub.broadcast({ type: 'session', session: publicSession(session) })
  }

  const publishTask = (taskId: number, events: TaskEvent[]) => publishTaskChange(ctx, taskId, events)

  // Marca a sessão como encerrada, registra na task e avisa a equipe.
  function finishSession(session: StoredSession, actorId: number | null, reason: 'stopped' | 'ended'): void {
    const events = transaction(ctx.db, () => {
      if (!markExited(ctx.db, session.id, ctx.now())) return null
      if (session.taskId === null) return []
      return [
        insertEvent(ctx.db, {
          taskId: session.taskId,
          actorId,
          type: 'agent_stopped',
          data: { sessionId: session.id, kind: session.kind, ownerId: session.userId, reason },
          now: ctx.now()
        })
      ]
    })
    if (events === null) return
    const updated = getSession(ctx.db, session.id)
    if (updated) publishSession(updated)
    if (session.taskId !== null) publishTask(session.taskId, events)
  }

  async function checkSession(session: StoredSession): Promise<void> {
    const owner = getUser(ctx.db, session.userId)
    if (!owner || !(await ctx.agents.isRunning(owner, sessionName(session.id)))) {
      finishSession(session, null, 'ended')
    }
  }

  // Sessões terminam sozinhas quando a pessoa digita "exit" ou o container reinicia.
  let checking = false
  async function checkAll(): Promise<void> {
    if (checking || disabledReason()) return
    checking = true
    try {
      for (const session of listRunningSessions(ctx.db)) await checkSession(session)
    } catch (error) {
      app.log.warn(error, 'Falha ao conferir as sessões dos agentes.')
    } finally {
      checking = false
    }
  }
  const monitor = setInterval(() => void checkAll(), MONITOR_INTERVAL_MS)
  monitor.unref()
  app.addHook('onReady', async () => {
    await checkAll()
  })
  app.addHook('preClose', async () => {
    clearInterval(monitor)
  })

  app.get('/api/agents/status', async () => {
    const reason = disabledReason()
    return { enabled: reason === null, reason }
  })

  app.get('/api/me/accounts', async (request) => {
    const user = requireUser(request)
    ensureEnabled()
    return { accounts: await ctx.agents.accounts(user) }
  })

  // Conectar sem terminal: o Harpia roda o login como a pessoa e mostra o link na tela.
  const logins = new AgentLogins(ctx.agents)
  app.addHook('preClose', async () => logins.close())
  const providerParam = (params: unknown): ChatProvider => {
    const provider = (params as { provider?: string }).provider
    if (!CHAT_PROVIDERS.includes(provider as ChatProvider)) throw new HttpError(404, 'Agente desconhecido.')
    return provider as ChatProvider
  }

  app.get('/api/me/agents/login', async (request) => {
    const user = requireUser(request)
    ensureEnabled()
    return {
      accounts: await ctx.agents.accounts(user),
      logins: { claude: logins.state(user, 'claude'), codex: logins.state(user, 'codex') }
    }
  })

  app.post('/api/me/agents/login/:provider', async (request) => {
    const user = requireUser(request)
    ensureEnabled()
    return { login: await logins.start(user, providerParam(request.params)) }
  })

  const codeSchema = z.object({ code: z.string().trim().min(10, 'Cole o código inteiro que a página mostrou.').max(2000) })
  app.post('/api/me/agents/login/claude/code', async (request) => {
    const user = requireUser(request)
    ensureEnabled()
    const { code } = parse(codeSchema, request.body)
    const login = await logins.submitCode(user, code)
    if (!login) throw new HttpError(409, 'Este login já terminou ou venceu. Clique em "Conectar" de novo.')
    return { login }
  })

  app.delete('/api/me/agents/login/:provider', async (request) => {
    const user = requireUser(request)
    logins.cancel(user, providerParam(request.params))
    return { ok: true }
  })

  app.post('/api/me/agents/logout/:provider', async (request) => {
    const user = requireUser(request)
    ensureEnabled()
    try {
      await logins.logout(user, providerParam(request.params))
    } catch (error) {
      throw new HttpError(502, (error as Error).message)
    }
    return { accounts: await ctx.agents.accounts(user) }
  })

  // Terminal pessoal, na pasta da pessoa: o caminho antigo de conectar, para quem prefere.
  app.post('/api/me/terminal', async (request) => {
    const user = requireUser(request)
    ensureEnabled()
    const existing = findRunningAccountSession(ctx.db, user.id)
    if (existing) {
      if (await ctx.agents.isRunning(user, sessionName(existing.id))) return { session: publicSession(existing) }
      finishSession(existing, null, 'ended')
    }
    await ctx.agents.prepareUser(user)
    const home = ctx.agents.homeDir(user)
    const session = insertSession(ctx.db, { taskId: null, userId: user.id, kind: 'account', branch: null, cwd: home, now: ctx.now() })
    try {
      await ctx.agents.startSession({ user, name: sessionName(session.id), cwd: home, command: null })
    } catch (error) {
      finishSession(session, null, 'ended')
      throw new HttpError(500, `Não foi possível abrir o terminal: ${(error as Error).message}`)
    }
    return { session: publicSession(session) }
  })

  // Sessões abertas em todas as tasks, para o quadro mostrar quem está trabalhando onde.
  app.get('/api/sessions/running', async () => ({
    sessions: listRunningSessions(ctx.db)
      .filter((session) => session.taskId !== null)
      .map(publicSession)
  }))

  app.get('/api/tasks/:id/sessions', async (request) => {
    const taskId = parseId((request.params as { id: string }).id)
    if (!getTask(ctx.db, taskId)) throw new HttpError(404, 'Task não encontrada.')
    return { sessions: listTaskSessions(ctx.db, taskId).map(publicSession) }
  })

  // Terminal da pessoa na task (o painel de baixo): reaproveita o que já estiver aberto.
  app.post('/api/tasks/:id/terminal', async (request) => {
    const user = requireUser(request)
    const task = getTask(ctx.db, parseId((request.params as { id: string }).id))
    if (!task) throw new HttpError(404, 'Task não encontrada.')
    ensureEnabled()
    const existing = findRunningTaskSession(ctx.db, task.id, user.id, 'shell')
    if (existing) {
      if (await ctx.agents.isRunning(user, sessionName(existing.id))) return { session: publicSession(existing) }
      finishSession(existing, null, 'ended')
    }
    // O terminal de apoio é pessoal: não coloca a pessoa na task nem entra no histórico.
    return { session: await openSession(task, user, 'shell', { quiet: true }) }
  })

  app.post('/api/tasks/:id/sessions', async (request) => {
    const user = requireUser(request)
    const task = getTask(ctx.db, parseId((request.params as { id: string }).id))
    if (!task) throw new HttpError(404, 'Task não encontrada.')
    const { kind } = parse(startSchema, request.body)
    return { session: await openSession(task, user, kind) }
  })

  async function openSession(task: Task, user: User, kind: AgentKind, options: { quiet?: boolean } = {}) {
    ensureEnabled()
    ensureTaskOpen(task)
    const max = ctx.config.maxSessionsPerUser
    if (countRunningForUser(ctx.db, user.id) >= max) {
      throw new HttpError(409, `Você já tem ${max} sessões abertas. Encerre uma antes de abrir outra.`)
    }
    const worktree = await prepareTaskWorkspace(ctx, task, user, (error, message) => app.log.warn(error, message))

    const session = insertSession(ctx.db, {
      taskId: task.id,
      userId: user.id,
      kind,
      branch: worktree.branch,
      cwd: worktree.path,
      now: ctx.now()
    })
    try {
      await ctx.agents.startSession({ user, name: sessionName(session.id), cwd: worktree.path, command: AGENT_COMMANDS[kind] })
    } catch (error) {
      finishSession(session, null, 'ended')
      throw new HttpError(500, `Não foi possível abrir o agente: ${(error as Error).message}`)
    }

    if (options.quiet) {
      publishSession(session)
      return publicSession(session)
    }
    const events = transaction(ctx.db, () => {
      const now = ctx.now()
      const list = joinTaskForWork(ctx, task.id, user, now)
      list.push(
        insertEvent(ctx.db, {
          taskId: task.id,
          actorId: user.id,
          type: 'agent_started',
          data: { sessionId: session.id, kind, branch: worktree.branch },
          now
        })
      )
      return list
    })
    publishSession(session)
    publishTask(task.id, events)
    return publicSession(session)
  }

  app.post('/api/sessions/:id/stop', async (request) => {
    const user = requireUser(request)
    const session = getSession(ctx.db, parseId((request.params as { id: string }).id))
    if (!session) throw new HttpError(404, 'Sessão não encontrada.')
    if (session.userId !== user.id && user.role !== 'admin') {
      throw new HttpError(403, 'Só quem abriu a sessão (ou um administrador) pode encerrá-la.')
    }
    ensureEnabled()
    const owner = getUser(ctx.db, session.userId)
    if (owner) await ctx.agents.stopSession(owner, sessionName(session.id))
    finishSession(session, user.id, 'stopped')
    return { session: publicSession(getSession(ctx.db, session.id) ?? session) }
  })

  // Terminal ao vivo. Quem abriu a sessão digita; o resto da equipe assiste.
  app.get('/api/sessions/:id/terminal', { websocket: true }, (socket, request) => {
    const user = request.user
    const id = Number((request.params as { id: string }).id)
    const session = Number.isInteger(id) ? getSession(ctx.db, id) : null
    const query = request.query as { cols?: string; rows?: string }
    const reject = (code: number, reason: string) => socket.close(code, reason)

    if (!user) return reject(4401, 'Faça login para continuar.')
    if (disabledReason()) return reject(4503, 'Os terminais estão desligados.')
    if (!session) return reject(4404, 'Sessão não encontrada.')
    if (session.kind === 'account' && session.userId !== user.id) return reject(4403, 'Terminal pessoal de outra pessoa.')
    if (session.status !== 'running') return reject(4410, 'Sessão encerrada.')
    const owner = getUser(ctx.db, session.userId)
    if (!owner) return reject(4404, 'Dona da sessão não encontrada.')

    const readOnly = session.userId !== user.id
    const cols = Math.min(Math.max(Number(query.cols) || 120, 10), 500)
    const rows = Math.min(Math.max(Number(query.rows) || 30, 3), 200)
    const terminal = ctx.agents.attach({ user: owner, name: sessionName(session.id), readOnly, cols, rows })

    terminal.onData((data) => {
      if (socket.readyState === 1) socket.send(data)
    })
    terminal.onExit(() => {
      if (socket.readyState === 1) socket.close(1000, 'Terminal fechado.')
      void checkSession(session)
    })
    socket.on('message', (raw) => {
      let message: z.infer<typeof clientMessageSchema>
      try {
        message = clientMessageSchema.parse(JSON.parse(String(raw)))
      } catch {
        return
      }
      if (message.type === 'resize') terminal.resize(message.cols, message.rows)
      else if (!readOnly) terminal.write(message.data)
    })
    socket.on('close', () => terminal.kill())
  })
}
