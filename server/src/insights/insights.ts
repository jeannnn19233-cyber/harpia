import {
  CHAT_PROVIDER_LABELS,
  PROJECT_MEMORY_LIMIT,
  TASK_STATUS_LABELS,
  type Learning,
  type Project,
  type Task,
  type TaskStatus,
  type User
} from '../../../shared/types.ts'
import type { AiRunner } from '../ai/runner.ts'
import { agentsDisabledReason, publishTaskChange } from '../agents/workspace.ts'
import { getUser } from '../auth/users.ts'
import { listItems, listTaskChats, type StoredChat } from '../chat/store.ts'
import type { AppContext } from '../context.ts'
import { parseGitHubRepo } from '../github/client.ts'
import { HttpError } from '../http/errors.ts'
import { getMemory, saveMemory } from '../memory/store.ts'
import { projectPath } from '../projects/routes.ts'
import { getProject } from '../projects/store.ts'
import { listTaskPulls } from '../pulls/store.ts'
import { getTask, insertEvent, listEvents } from '../tasks/store.ts'
import {
  DUPLICATE_INSTRUCTIONS,
  SUGGESTION_INSTRUCTIONS,
  SUMMARY_INSTRUCTIONS,
  appendLearning,
  clip,
  duplicatePrompt,
  parseDuplicate,
  parseSuggestion,
  parseSummary,
  suggestionPrompt
} from './prompts.ts'
import {
  decideLearning,
  dropPendingLearnings,
  getJudgment,
  getLearning,
  getSummary,
  insertLearning,
  listTaskLearnings,
  saveJudgment,
  saveSummary,
  tasksNeedingSummary,
  type Judgment
} from './store.ts'

// Pasta (na pasta de cada pessoa) onde rodam as chamadas de IA do vigia: sem arquivos, sem ferramentas.
const AI_FOLDER = '.harpia/ia'
// Resumos automáticos só para tasks concluídas nas últimas 48 h, no máximo 2 por varredura.
const SUMMARY_WINDOW_MS = 48 * 60 * 60 * 1000
const SUMMARIES_PER_SWEEP = 2

function firstName(user: User | null): string {
  return user?.name.split(' ')[0] ?? 'alguém'
}

// O vigia com IA (fase 4b). Tudo roda no Claude Code de quem está envolvido, nunca numa conta central.
export class Insights {
  private readonly ctx: AppContext
  private readonly ai: AiRunner
  private readonly judging = new Set<string>()
  private readonly summarizing = new Set<number>()
  private readonly pending = new Set<Promise<unknown>>()
  // Chamado quando um julgamento termina, para o vigia anunciar logo (sem esperar a próxima varredura).
  onJudged: () => void = () => undefined

  constructor(ctx: AppContext, ai: AiRunner) {
    this.ctx = ctx
    this.ai = ai
  }

  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise)
    void promise.finally(() => this.pending.delete(promise)).catch(() => undefined)
    return promise
  }

  private async cwd(user: User): Promise<string> {
    return this.ctx.agents.prepareFolder(user, AI_FOLDER)
  }

  // ── Tasks parecidas ───────────────────────────────────────────────────────────────────────

  judgment(fingerprint: string): Judgment | null {
    return getJudgment(this.ctx.db, fingerprint)
  }

  // Pede à IA (no Claude de quem criou a task mais nova) que confirme se as duas tasks são a mesma.
  requestJudgment(fingerprint: string, a: Task, b: Task): void {
    if (this.judging.has(fingerprint) || agentsDisabledReason(this.ctx)) return
    const judge = getUser(this.ctx.db, b.createdBy) ?? (b.ownerId ? getUser(this.ctx.db, b.ownerId) : null) ?? getUser(this.ctx.db, a.createdBy)
    if (!judge) return
    this.judging.add(fingerprint)
    const project = getProject(this.ctx.db, a.projectId)
    const owner = (task: Task) => firstName(task.ownerId ? getUser(this.ctx.db, task.ownerId) : null)
    const run = (async () => {
      let judgment: Judgment
      try {
        const text = await this.ai.complete({
          user: judge,
          instructions: DUPLICATE_INSTRUCTIONS,
          prompt: duplicatePrompt({
            project: project?.name ?? '',
            a: { number: a.number, title: a.title, description: a.description, owner: owner(a) },
            b: { number: b.number, title: b.title, description: b.description, owner: owner(b) }
          }),
          model: 'haiku',
          cwd: await this.cwd(judge),
          timeoutMs: 2 * 60 * 1000
        })
        const parsed = parseDuplicate(text)
        judgment = parsed
          ? { verdict: parsed.same ? 'duplicate' : 'different', reason: parsed.reason, userId: judge.id }
          : { verdict: 'error', reason: 'Resposta fora do formato.', userId: judge.id }
      } catch (error) {
        judgment = { verdict: 'error', reason: (error as Error).message, userId: judge.id }
      }
      saveJudgment(this.ctx.db, fingerprint, judgment, this.ctx.now())
      this.judging.delete(fingerprint)
      this.onJudged()
    })()
    void this.track(run)
  }

  // ── Resumo e aprendizados ─────────────────────────────────────────────────────────────────

  // Chamado pelo vigia: resume as tasks concluídas há pouco que ainda não têm resumo.
  sweepSummaries(projectId: number): void {
    if (agentsDisabledReason(this.ctx)) return
    const since = new Date(this.ctx.now().getTime() - SUMMARY_WINDOW_MS).toISOString()
    for (const taskId of tasksNeedingSummary(this.ctx.db, projectId, since, SUMMARIES_PER_SWEEP)) {
      const task = getTask(this.ctx.db, taskId)
      if (task) void this.summarize(task, null).catch(() => undefined)
    }
  }

  // Quem escreve: quem pediu, senão o responsável, senão quem participou ou criou a task.
  private summaryAuthor(task: Task, requester: User | null): User | null {
    if (requester) return requester
    for (const id of [task.ownerId, ...task.participantIds, task.createdBy]) {
      const user = id ? getUser(this.ctx.db, id) : null
      if (user) return user
    }
    return null
  }

  summarize(task: Task, requester: User | null): Promise<void> {
    if (this.summarizing.has(task.id)) return Promise.reject(new HttpError(409, 'O resumo desta task já está sendo escrito.'))
    const author = this.summaryAuthor(task, requester)
    if (!author) return Promise.resolve()
    this.summarizing.add(task.id)
    const running = saveSummary(this.ctx.db, { taskId: task.id, userId: author.id, status: 'running', now: this.ctx.now() })
    this.ctx.hub.broadcast({ type: 'task_summary', summary: running })
    const run = this.writeSummary(task, author).finally(() => this.summarizing.delete(task.id))
    return this.track(run)
  }

  private async writeSummary(task: Task, author: User): Promise<void> {
    const project = getProject(this.ctx.db, task.projectId)
    if (!project) return
    let result: ReturnType<typeof parseSummary> = null
    let error: string | null = null
    try {
      const text = await this.ai.complete({
        user: author,
        instructions: SUMMARY_INSTRUCTIONS,
        prompt: await this.material(project, task),
        model: 'sonnet',
        cwd: await this.cwd(author),
        timeoutMs: 5 * 60 * 1000
      })
      result = parseSummary(text)
      if (!result) error = 'A IA não devolveu o resumo no formato esperado.'
    } catch (failure) {
      error = (failure as Error).message
    }
    const now = this.ctx.now()
    if (!result) {
      this.ctx.hub.broadcast({
        type: 'task_summary',
        summary: saveSummary(this.ctx.db, { taskId: task.id, userId: author.id, status: 'failed', error, now })
      })
      return
    }
    const summary = saveSummary(this.ctx.db, { taskId: task.id, userId: author.id, status: 'ready', summary: result.summary, now })
    for (const id of dropPendingLearnings(this.ctx.db, task.id)) {
      this.ctx.hub.broadcast({ type: 'learning', learning: { ...(getLearning(this.ctx.db, id) as Learning), id, status: 'dismissed' } })
    }
    const learnings = result.learnings.map((learning) =>
      insertLearning(this.ctx.db, { taskId: task.id, projectId: task.projectId, ...learning, now })
    )
    const event = insertEvent(this.ctx.db, {
      taskId: task.id,
      actorId: null,
      type: 'summarized',
      data: { userId: author.id, learnings: learnings.length },
      now,
      countsAsActivity: false
    })
    this.ctx.hub.broadcast({ type: 'task_summary', summary })
    for (const learning of learnings) this.ctx.hub.broadcast({ type: 'learning', learning })
    publishTaskChange(this.ctx, task.id, [event])
    const extra = learnings.length > 0 ? `\n\n💡 ${learnings.length} aprendizado(s) sugerido(s) esperando aprovação no Harpia.` : ''
    await this.ctx.notifier.sendTo(
      task.ownerId ?? author.id,
      `📝 Resumo de T-${task.number} "${task.title}"\n\n${result.summary}${extra}${this.ctx.notifier.link('/')}`
    )
  }

  // Tudo o que a IA lê para escrever o resumo (sem ferramentas: o servidor monta o material).
  private async material(project: Project, task: Task): Promise<string> {
    const name = (id: unknown) => firstName(typeof id === 'number' ? getUser(this.ctx.db, id) : null)
    const status = (value: unknown) => TASK_STATUS_LABELS[value as TaskStatus] ?? String(value)
    const events = listEvents(this.ctx.db, task.id, 200)
      .map((event) => {
        const who = event.actorId ? name(event.actorId) : 'Harpia'
        switch (event.type) {
          case 'comment':
            return `- ${who} comentou: ${clip(String(event.data.body ?? ''), 600)}`
          case 'status_changed':
            return `- ${who} moveu de ${status(event.data.from)} para ${status(event.data.to)}`
          case 'watcher_notice':
          case 'summarized':
            return null
          default:
            return `- ${who}: ${event.type}${event.data.number ? ` #${event.data.number}` : ''}`
        }
      })
      .filter(Boolean)
      .join('\n')

    const conversations = listTaskChats(this.ctx.db, task.id)
      .map((chat: StoredChat) => {
        const lines = listItems(this.ctx.db, chat.id, 400)
          .filter((item) => item.kind === 'user' || (item.kind === 'assistant' && !item.streaming))
          .map((item) =>
            item.kind === 'user' ? `> ${name(chat.userId)}: ${clip(item.text, 500)}` : item.kind === 'assistant' ? clip(item.text, 800) : ''
          )
        return `### Conversa de ${name(chat.userId)} com o ${CHAT_PROVIDER_LABELS[chat.provider]}\n${clip(lines.join('\n\n'), 8000)}`
      })
      .join('\n\n')

    const mirror = projectPath(this.ctx, project)
    const work: string[] = []
    for (const pull of listTaskPulls(this.ctx.db, task.id).slice(0, 3)) {
      const changes = await this.ctx.git.branchWork(mirror, pull.branch, task.createdAt).catch(() => null)
      work.push(
        `### PR #${pull.number} (${pull.state}), branch ${pull.branch}` +
          (changes ? `\nCommits:\n${changes.log || '(nenhum)'}\n\nArquivos:\n${changes.stat}\n\n\`\`\`diff\n${clip(changes.diff, 15000)}\n\`\`\`` : '\n(a branch não está mais no servidor)')
      )
    }
    const agents = (await this.ctx.git.readFile(mirror, project.defaultBranch, 'AGENTS.md').catch(() => null)) ?? ''
    const memory = getMemory(this.ctx.db, project.id).body

    return [
      `Projeto: ${project.name}`,
      `Task T-${task.number} "${task.title}" (${status(task.status)})`,
      `Descrição:\n${clip(task.description.trim(), 3000) || '(vazia)'}`,
      `## Histórico\n${events || '(vazio)'}`,
      `## Conversas com os agentes\n${conversations || '(nenhuma)'}`,
      `## O que mudou no código\n${work.join('\n\n') || '(nenhum PR)'}`,
      `## AGENTS.md atual\n${clip(agents, 6000) || '(não existe)'}`,
      `## Memória do projeto\n${memory || '(vazia)'}`
    ].join('\n\n')
  }

  // ── Aprovar ou descartar um aprendizado ───────────────────────────────────────────────────

  async applyLearning(learningId: number, user: User, editedText?: string): Promise<Learning> {
    const learning = getLearning(this.ctx.db, learningId)
    if (!learning) throw new HttpError(404, 'Aprendizado não encontrado.')
    if (learning.status !== 'pending') throw new HttpError(409, 'Este aprendizado já foi decidido.')
    const project = getProject(this.ctx.db, learning.projectId)
    const task = getTask(this.ctx.db, learning.taskId)
    if (!project || !task) throw new HttpError(404, 'Task não encontrada.')
    const text = (editedText ?? learning.text).trim()
    const now = this.ctx.now()
    let prUrl: string | null = null

    if (learning.target === 'memory') {
      const memory = getMemory(this.ctx.db, project.id)
      const body = memory.body.trim() ? `${memory.body.trim()}\n- ${text}` : `- ${text}`
      if (body.length > PROJECT_MEMORY_LIMIT) {
        throw new HttpError(400, `A memória do projeto passaria do limite de ${PROJECT_MEMORY_LIMIT} caracteres. Enxugue a memória antes.`)
      }
      const saved = saveMemory(this.ctx.db, { projectId: project.id, body, userId: user.id, now })
      this.ctx.hub.broadcast({ type: 'memory', memory: saved })
    } else {
      prUrl = await this.openLearningPr(project, task, learning, text, user)
    }

    const decided = decideLearning(this.ctx.db, learning.id, { status: 'applied', userId: user.id, text, prUrl, now }) as Learning
    const event = insertEvent(this.ctx.db, {
      taskId: task.id,
      actorId: user.id,
      type: 'learning_applied',
      data: { learningId: learning.id, target: learning.target, text, prUrl },
      now
    })
    this.ctx.hub.broadcast({ type: 'learning', learning: decided })
    publishTaskChange(this.ctx, task.id, [event])
    return decided
  }

  // O aprendizado vai para o AGENTS.md por um PR normal (que também passa pela revisão automática).
  private async openLearningPr(project: Project, task: Task, learning: Learning, text: string, user: User): Promise<string> {
    const repo = parseGitHubRepo(project.repoUrl)
    if (!repo) throw new HttpError(400, 'O repositório deste projeto não é do GitHub: aprove para a memória do projeto.')
    const mirror = projectPath(this.ctx, project)
    await this.ctx.git.fetch(mirror)
    const agents = await this.ctx.git.readFile(mirror, project.defaultBranch, 'AGENTS.md')
    const claude = agents === null ? await this.ctx.git.readFile(mirror, project.defaultBranch, 'CLAUDE.md') : null
    // Sem AGENTS.md, usa o CLAUDE.md que já existe (se não for só um "@AGENTS.md"); senão cria o AGENTS.md.
    const file = agents === null && claude !== null && !/^\s*@AGENTS\.md\s*$/.test(claude) ? 'CLAUDE.md' : 'AGENTS.md'
    const current = file === 'AGENTS.md' ? agents : claude
    const branch = `harpia/aprendizado-${learning.id}`
    const title = `Aprendizado da T-${task.number}: ${text.length > 60 ? `${text.slice(0, 57)}…` : text}`
    await this.ctx.git.commitFile(mirror, {
      base: project.defaultBranch,
      branch,
      path: file,
      content: appendLearning(current, text),
      message: `${title}\n\n${learning.reason}`,
      author: { name: user.name, email: user.email }
    })
    await this.ctx.git.push(mirror, project.repoUrl, branch)
    const pr = await this.ctx.github.createPullRequest(repo, {
      title,
      head: branch,
      base: project.defaultBranch,
      body: [
        `Aprendizado sugerido pela IA ao concluir a T-${task.number} "${task.title}" e aprovado por ${user.name} no Harpia.`,
        '',
        `**Regra:** ${text}`,
        '',
        `**Por quê:** ${learning.reason}`
      ].join('\n')
    })
    return pr.url
  }

  dismissLearning(learningId: number, user: User): Learning {
    const learning = getLearning(this.ctx.db, learningId)
    if (!learning) throw new HttpError(404, 'Aprendizado não encontrado.')
    if (learning.status !== 'pending') throw new HttpError(409, 'Este aprendizado já foi decidido.')
    const now = this.ctx.now()
    const decided = decideLearning(this.ctx.db, learning.id, { status: 'dismissed', userId: user.id, now }) as Learning
    const event = insertEvent(this.ctx.db, {
      taskId: learning.taskId,
      actorId: user.id,
      type: 'learning_dismissed',
      data: { learningId: learning.id, text: learning.text },
      now
    })
    this.ctx.hub.broadcast({ type: 'learning', learning: decided })
    publishTaskChange(this.ctx, learning.taskId, [event])
    return decided
  }

  taskInsights(taskId: number) {
    return { summary: getSummary(this.ctx.db, taskId), learnings: listTaskLearnings(this.ctx.db, taskId) }
  }

  // ── Sugestão de próxima mensagem nas conversas com o Codex ────────────────────────────────

  // Depois de cada vez do Codex, o Claude (Haiku) da dona sugere a próxima mensagem.
  suggestFor(chat: StoredChat, apply: (text: string) => void): void {
    if (chat.provider !== 'codex' || chat.origin !== 'user' || agentsDisabledReason(this.ctx)) return
    const owner = getUser(this.ctx.db, chat.userId)
    if (!owner?.codexSuggestions) return
    const items = listItems(this.ctx.db, chat.id, 60)
    const request = [...items].reverse().find((item) => item.kind === 'user')
    const reply = [...items].reverse().find((item) => item.kind === 'assistant')
    if (request?.kind !== 'user' || reply?.kind !== 'assistant' || reply.id < request.id) return
    const task = chat.taskId ? getTask(this.ctx.db, chat.taskId) : null
    const run = (async () => {
      try {
        const text = await this.ai.complete({
          user: owner,
          instructions: SUGGESTION_INSTRUCTIONS,
          prompt: suggestionPrompt({ request: request.text, reply: reply.text, task: task ? `T-${task.number} "${task.title}"` : null }),
          model: 'haiku',
          cwd: await this.cwd(owner),
          timeoutMs: 60 * 1000
        })
        const suggestion = parseSuggestion(text)
        if (suggestion) apply(suggestion)
      } catch {
        // Sem Claude conectado ou sem cota: só não há sugestão.
      }
    })()
    void this.track(run)
  }
}
