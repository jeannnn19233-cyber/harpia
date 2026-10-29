import type { Project } from '../../../shared/types.ts'
import { listUsers } from '../auth/users.ts'
import type { AppContext } from '../context.ts'
import { parseGitHubRepo } from '../github/client.ts'
import { withGitHubReader } from '../github/reader.ts'
import { getProject } from '../projects/store.ts'
import { deployRound, healthProblem, taskProblem, transitions, type WatchItem } from './checks.ts'
import type { CoolifyClient, CoolifyExecution, CoolifyTask, HttpProbe } from './coolify.ts'
import { insertMonitorEvent, listEnabledMonitors, getMonitor, publicMonitor, saveMonitorState, type StoredMonitor } from './store.ts'

export interface MonitorOptions {
  // De quanto em quanto tempo os vigias olham o Coolify (0 desliga o laço; nos testes).
  pollSeconds: number
  coolify: CoolifyClient | null
  probe: HttpProbe
  warn: (error: unknown, message: string) => void
}

// Vigias dos projetos no Coolify (port do vigia-deploy-clarumi e do vigia-crons-coolify-clarumi do
// Hermes): sem IA e só leitura. Nunca reinicia, nunca refaz deploy, nunca roda uma tarefa.
export class ProjectMonitors {
  private readonly ctx: AppContext
  private readonly options: MonitorOptions
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking: Promise<void> | null = null

  constructor(ctx: AppContext, options: MonitorOptions) {
    this.ctx = ctx
    this.options = options
  }

  get configured(): boolean {
    return this.options.coolify !== null
  }

  get coolify(): CoolifyClient | null {
    return this.options.coolify
  }

  start(): void {
    if (this.options.pollSeconds > 0) {
      this.timer = setInterval(() => void this.tick(), this.options.pollSeconds * 1000)
      this.timer.unref()
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.ticking
  }

  tick(): Promise<void> {
    if (!this.ticking) {
      this.ticking = (async () => {
        for (const monitor of listEnabledMonitors(this.ctx.db)) {
          await this.check(monitor.projectId).catch((error) => this.options.warn(error, 'Vigia do Coolify falhou.'))
        }
      })().finally(() => {
        this.ticking = null
      })
    }
    return this.ticking
  }

  // Uma volta dos vigias de um projeto: deploy, aplicação, tarefas agendadas e URLs de saúde.
  async check(projectId: number): Promise<StoredMonitor | null> {
    const monitor = getMonitor(this.ctx.db, projectId)
    const project = getProject(this.ctx.db, projectId)
    if (!monitor || !project || !monitor.enabled) return monitor
    const now = this.ctx.now()
    const tz = monitor.timezone
    const coolify = this.options.coolify
    const items: WatchItem[] = []
    let reports: string[] = []
    let deployState = monitor.deployState
    let lastDeploy = monitor.lastDeploy

    if (!coolify || !monitor.coolifyAppUuid) {
      items.push({
        key: 'coolify',
        name: 'API do Coolify',
        problem: coolify ? 'escolha a aplicação do Coolify nos vigias do projeto' : 'o servidor não tem HARPIA_COOLIFY_URL e HARPIA_COOLIFY_TOKEN'
      })
    } else {
      try {
        const app = await coolify.getApplication(monitor.coolifyAppUuid)
        const deployments = (await coolify.listDeployments(monitor.coolifyAppUuid, 15)).filter((dep) => dep.pullRequestId === 0)
        const tasks = await coolify.listScheduledTasks(monitor.coolifyAppUuid)
        const executions = new Map<string, CoolifyExecution[]>()
        for (const task of tasks) executions.set(task.uuid, await coolify.listExecutions(monitor.coolifyAppUuid, task.uuid).catch(() => []))
        items.push({ key: 'coolify', name: 'API do Coolify', problem: null })

        const health = await this.health(monitor)
        const appProblem = /^running/.test(app.status) && !/unhealthy/.test(app.status) ? null : `estado "${app.status || 'desconhecido'}" no Coolify`
        const round = await deployRound({
          deployments,
          state: deployState,
          now,
          timezone: tz,
          siteLabel: this.liveLabel(app.name, monitor),
          checkLive: async () => [...(appProblem ? [`${app.name}: ${appProblem}`] : []), ...health.filter((item) => item.problem).map((item) => `${item.name}: ${item.problem}`)],
          failedTasksSince: async (since) => failedSince(tasks, executions, since),
          mainHead: () => this.mainHead(project, app.gitBranch)
        })
        deployState = round.state
        reports = round.reports
        const newest = deployments[0]
        if (newest) lastDeploy = { id: newest.id, status: newest.status, commit: newest.commit, at: newest.updatedAt }

        items.push({ key: 'app', name: `Aplicação ${app.name}`, problem: appProblem })
        for (const task of tasks) {
          items.push({
            key: `task:${task.uuid}`,
            name: `Tarefa agendada "${task.name}"`,
            problem: taskProblem({ task, executions: executions.get(task.uuid) ?? [], now, timezone: tz, watchingSince: monitor.watchingSince ?? now.toISOString() })
          })
        }
        items.push(...health)
      } catch (error) {
        // Falha do próprio vigia nunca passa calada: vira um problema (e avisa quando volta).
        items.push({ key: 'coolify', name: 'API do Coolify', problem: `não consegui verificar: ${(error as Error).message.slice(0, 250)}` })
        // O que não deu para olhar fica como estava (sem alarme de "voltou ao normal").
        for (const [key, problem] of Object.entries(monitor.watchState ?? {})) {
          if (key !== 'coolify' && !items.some((item) => item.key === key)) {
            items.push({ key, name: monitor.panorama.find((item) => item.key === key)?.name ?? key, problem })
          }
        }
      }
    }

    const change = transitions(monitor.watchState, items)
    const lines = [...reports, ...change.lines]
    const saved = saveMonitorState(
      this.ctx.db,
      projectId,
      {
        deployState,
        watchState: Object.fromEntries(items.map((item) => [item.key, item.problem])),
        panorama: { items, lastDeploy }
      },
      now
    )
    this.ctx.hub.broadcast({ type: 'monitor', monitor: publicMonitor(saved) })
    if (lines.length) {
      const title = change.first ? `**Vigias de ${project.name} — primeira verificação**` : `**Vigias de ${project.name}**`
      const text = `${title}\n\n${lines.join('\n\n')}`
      const event = insertMonitorEvent(this.ctx.db, projectId, text, now)
      this.ctx.hub.broadcast({ type: 'monitor_event', event })
      for (const userId of this.recipients(monitor)) await this.ctx.notifier.sendTo(userId, text)
    }
    return saved
  }

  private async health(monitor: StoredMonitor): Promise<WatchItem[]> {
    const items: WatchItem[] = []
    for (const check of monitor.healthChecks) {
      items.push({ key: `health:${check.url}`, name: check.url.replace(/^https?:\/\//, ''), problem: await healthProblem(this.options.probe, check) })
    }
    return items
  }

  private liveLabel(appName: string, monitor: StoredMonitor): string {
    const urls = monitor.healthChecks.map((check) => check.url.replace(/^https?:\/\//, ''))
    return `${appName} saudável na versão nova${urls.length ? `, ${urls.join(' e ')} respondendo 200` : ''}.`
  }

  private async mainHead(project: Project, branch: string | null) {
    const repo = parseGitHubRepo(project.repoUrl)
    if (!repo) return null
    return withGitHubReader(this.ctx, (client) => client.getCommit(repo, branch || project.defaultBranch || 'main'))
  }

  private recipients(monitor: StoredMonitor): number[] {
    const users = listUsers(this.ctx.db)
    const chosen = monitor.notifyUserIds.filter((id) => users.some((user) => user.id === id))
    return chosen.length ? chosen : users.filter((user) => user.role === 'admin').map((user) => user.id)
  }
}

function failedSince(tasks: CoolifyTask[], executions: Map<string, CoolifyExecution[]>, since: string) {
  const sinceTime = new Date(since).getTime()
  const failed: { name: string; status: string; message: string | null; at: string }[] = []
  for (const task of tasks) {
    for (const execution of executions.get(task.uuid) ?? []) {
      if (new Date(execution.createdAt).getTime() >= sinceTime && execution.status !== 'success' && execution.status !== 'running') {
        failed.push({ name: task.name, status: execution.status, message: execution.message, at: execution.createdAt })
      }
    }
  }
  return failed.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5)
}

