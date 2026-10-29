import { createHash } from 'node:crypto'
import type { Finding, FindingKind, Task, TaskEvent, User } from '../../../shared/types.ts'
import { agentsDisabledReason, publishTaskChange } from '../agents/workspace.ts'
import { getUser } from '../auth/users.ts'
import type { AppContext } from '../context.ts'
import { transaction } from '../db/index.ts'
import { listProjects } from '../projects/store.ts'
import { countOpenPulls } from '../pulls/store.ts'
import { significantWords, titleSimilarity } from '../search/similar.ts'
import type { Insights } from '../insights/insights.ts'
import { insertEvent, listTasks } from '../tasks/store.ts'
import { findingExists, resolveMissing, upsertFinding, type FindingInput } from './store.ts'

export interface WatcherOptions {
  // Sem atividade de pessoas nem de agentes por esse tempo, a task é considerada parada.
  staleHours: number
  // Em "Revisão" sem PR aberto por esse tempo, o vigia pergunta se dá para concluir.
  reviewHours: number
  // Vigia com IA (fase 4b). Sem ele, tudo segue só com as regras fixas.
  insights?: Insights | null
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export function describeDuration(hours: number): string {
  if (hours < 48) return `${Math.round(hours)} horas`
  return `${Math.round(hours / 24)} dias`
}

// O vigia acompanha a área de tasks e avisa a equipe. As regras fixas (sem IA) encontram os
// problemas; com a fase 4b, a IA de quem está envolvido confirma as tasks parecidas e escreve o
// resumo das tasks concluídas.
export class Watcher {
  private readonly ctx: AppContext
  private readonly options: WatcherOptions
  private running: Promise<void> | null = null

  constructor(ctx: AppContext, options: WatcherOptions) {
    this.ctx = ctx
    this.options = options
  }

  // Uma varredura por vez; quem pedir durante uma varredura espera ela terminar.
  sweep(): Promise<void> {
    if (!this.running) {
      this.running = this.sweepAll().finally(() => {
        this.running = null
      })
    }
    return this.running
  }

  private async sweepAll(): Promise<void> {
    for (const project of listProjects(this.ctx.db)) {
      const tasks = listTasks(this.ctx.db, project.id).filter((task) => task.status !== 'done')
      const found: Partial<Record<FindingKind, FindingInput[]>> = {
        stale: [],
        review_without_pr: [],
        duplicate: this.duplicates(project.id, tasks)
      }
      for (const task of tasks) {
        const finding = this.staleOrReview(project.id, task)
        if (finding) found[finding.kind]!.push(finding)
      }
      // Comparar arquivos depende do git de cada pessoa; sem terminais ligados, fica de fora.
      if (!agentsDisabledReason(this.ctx)) {
        const overlaps = await this.overlaps(project.id, project.defaultBranch, tasks)
        if (overlaps) found.file_overlap = overlaps
      }
      for (const [kind, inputs] of Object.entries(found) as [FindingKind, FindingInput[]][]) {
        await this.apply(project.id, kind, inputs)
      }
      this.options.insights?.sweepSummaries(project.id)
    }
  }

  private async apply(projectId: number, kind: FindingKind, inputs: FindingInput[]): Promise<void> {
    const now = this.ctx.now()
    const announced: { finding: Finding; events: Map<number, TaskEvent[]> }[] = []
    const changed: Finding[] = []
    transaction(this.ctx.db, () => {
      for (const input of inputs) {
        const { finding, isNew } = upsertFinding(this.ctx.db, input, now)
        if (!isNew) continue
        changed.push(finding)
        const events = new Map<number, TaskEvent[]>()
        for (const taskId of finding.taskIds) {
          events.set(taskId, [
            insertEvent(this.ctx.db, {
              taskId,
              actorId: null,
              type: 'watcher_notice',
              data: { findingId: finding.id, kind, message: finding.message },
              now,
              countsAsActivity: false
            })
          ])
        }
        announced.push({ finding, events })
      }
      changed.push(...resolveMissing(this.ctx.db, projectId, kind, new Set(inputs.map((input) => input.fingerprint)), now))
    })
    for (const finding of changed) this.ctx.hub.broadcast({ type: 'finding', finding })
    for (const { finding, events } of announced) {
      for (const [taskId, list] of events) publishTaskChange(this.ctx, taskId, list)
      const link = finding.taskIds.length > 0 ? this.ctx.notifier.link('/') : ''
      await this.ctx.notifier.notifyUsers(finding.userIds, `Vigia do Harpia\n${finding.message}${link}`)
    }
  }

  private people(task: Task): number[] {
    return [...new Set([...(task.ownerId ? [task.ownerId] : []), ...task.participantIds])]
  }

  // Última atividade da task: eventos, comentários e mensagens dos agentes.
  private lastActivity(task: Task): string {
    const row = this.ctx.db
      .prepare(
        `SELECT MAX(ci.updated_at) AS last FROM chat_items ci JOIN chats c ON c.id = ci.chat_id WHERE c.task_id = ?`
      )
      .get(task.id) as { last: string | null }
    return row.last && row.last > task.lastActivityAt ? row.last : task.lastActivityAt
  }

  private agentBusy(task: Task): boolean {
    return (
      this.ctx.db
        .prepare("SELECT 1 FROM chats WHERE task_id = ? AND status IN ('working', 'waiting')")
        .get(task.id) !== undefined
    )
  }

  private staleOrReview(projectId: number, task: Task): FindingInput | null {
    if (task.status === 'backlog' || this.agentBusy(task)) return null
    const activity = this.lastActivity(task)
    const hours = (this.ctx.now().getTime() - new Date(activity).getTime()) / 3600000
    const label = `T-${task.number} "${task.title}"`

    if (task.status === 'review' && countOpenPulls(this.ctx.db, task.id) === 0 && hours >= this.options.reviewHours) {
      return {
        projectId,
        kind: 'review_without_pr',
        fingerprint: `review:${task.id}:${activity}`,
        taskIds: [task.id],
        userIds: this.people(task),
        message: `${label} está em Revisão há ${describeDuration(hours)} sem PR aberto. Falta abrir o PR ou dá para concluir?`,
        details: { hours: Math.round(hours) }
      }
    }
    if (hours >= this.options.staleHours) {
      return {
        projectId,
        kind: 'stale',
        fingerprint: `stale:${task.id}:${activity}`,
        taskIds: [task.id],
        userIds: this.people(task),
        message: `${label} está parada há ${describeDuration(hours)}, sem atividade de pessoas nem de agentes.`,
        details: { hours: Math.round(hours) }
      }
    }
    return null
  }

  private duplicates(projectId: number, tasks: Task[]): FindingInput[] {
    const found: FindingInput[] = []
    for (let i = 0; i < tasks.length; i++) {
      for (let j = i + 1; j < tasks.length; j++) {
        const [a, b] = [tasks[i], tasks[j]].sort((x, y) => x.number - y.number)
        const common = significantWords(a.title).filter((word) => significantWords(b.title).includes(word))
        if (common.length < 2 || titleSimilarity(a.title, b.title) < 0.6) continue
        const fingerprint = `duplicate:${a.id}:${b.id}`
        let message = `T-${a.number} "${a.title}" e T-${b.number} "${b.title}" parecem ser a mesma task. Vale juntar as duas ou deixar clara a diferença.`
        const details: Record<string, unknown> = { words: common }
        // Com IA: um aviso novo só sai depois que o Claude de quem criou a task confirma.
        const insights = this.options.insights
        if (insights && !findingExists(this.ctx.db, fingerprint)) {
          // Títulos editados pedem um julgamento novo.
          const judgeKey = `${fingerprint}:${hash(`${a.title}\n${b.title}`)}`
          const judgment = insights.judgment(judgeKey)
          if (!judgment) {
            insights.requestJudgment(judgeKey, a, b)
            continue
          }
          if (judgment.verdict === 'different') continue
          if (judgment.verdict === 'duplicate') {
            const judge = judgment.userId ? getUser(this.ctx.db, judgment.userId) : null
            message = `T-${a.number} "${a.title}" e T-${b.number} "${b.title}" parecem ser a mesma task. ${judgment.reason ?? ''} (confirmado pelo Claude de ${judge?.name.split(' ')[0] ?? 'alguém'}). Vale juntar as duas ou deixar clara a diferença.`
            details.ai = { reason: judgment.reason, userId: judgment.userId }
          }
        }
        found.push({
          projectId,
          kind: 'duplicate',
          fingerprint,
          taskIds: [a.id, b.id],
          userIds: [...new Set([...this.people(a), ...this.people(b)])],
          message,
          details
        })
      }
    }
    return found
  }

  // Pessoas diferentes alterando os mesmos arquivos (na mesma task ou em tasks diferentes).
  private async overlaps(projectId: number, base: string, tasks: Task[]): Promise<FindingInput[] | null> {
    const open = new Map(tasks.map((task) => [task.id, task]))
    const worktrees = this.ctx.db
      .prepare('SELECT task_id, user_id, path FROM task_worktrees')
      .all() as { task_id: number; user_id: number; path: string }[]
    const touched = new Map<string, { taskId: number; userId: number }[]>()
    for (const worktree of worktrees) {
      const task = open.get(worktree.task_id)
      const user = getUser(this.ctx.db, worktree.user_id)
      if (!task || !user) continue
      try {
        const files = await this.ctx.agents.changedFiles({ user, path: worktree.path, base })
        for (const file of files) {
          const list = touched.get(file.path) ?? []
          list.push({ taskId: task.id, userId: user.id })
          touched.set(file.path, list)
        }
      } catch {
        // Cópia apagada ou ainda sem commits: nada a comparar.
      }
    }

    const pairs = new Map<string, { a: { taskId: number; userId: number }; b: { taskId: number; userId: number }; files: string[] }>()
    for (const [path, entries] of touched) {
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          if (entries[i].userId === entries[j].userId) continue
          const [a, b] = [entries[i], entries[j]].sort((x, y) => x.userId - y.userId || x.taskId - y.taskId)
          const key = `${a.userId}:${a.taskId}|${b.userId}:${b.taskId}`
          const pair = pairs.get(key) ?? { a, b, files: [] }
          pair.files.push(path)
          pairs.set(key, pair)
        }
      }
    }

    const name = (id: number) => (getUser(this.ctx.db, id) as User | null)?.name.split(' ')[0] ?? 'alguém'
    const number = (id: number) => open.get(id)?.number
    return [...pairs.entries()].map(([key, { a, b, files }]) => {
      files.sort()
      const shown = files.slice(0, 5).join(', ') + (files.length > 5 ? ` e mais ${files.length - 5}` : '')
      const message =
        a.taskId === b.taskId
          ? `${name(a.userId)} e ${name(b.userId)} estão alterando os mesmos arquivos em T-${number(a.taskId)}: ${shown}. Combinem quem mexe em quê para evitar conflito.`
          : `${name(a.userId)} (T-${number(a.taskId)}) e ${name(b.userId)} (T-${number(b.taskId)}) estão alterando os mesmos arquivos: ${shown}. Combinem quem mexe em quê para evitar conflito.`
      return {
        projectId,
        kind: 'file_overlap' as const,
        fingerprint: `overlap:${hash(`${key}:${files.join('\n')}`)}`,
        taskIds: [...new Set([a.taskId, b.taskId])],
        userIds: [a.userId, b.userId],
        message,
        details: { files }
      }
    })
  }
}
