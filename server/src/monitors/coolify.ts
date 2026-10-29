// Cliente da API do Coolify, só leitura (port dos vigias do Hermes, que liam o banco do Coolify por
// SSH como root). O token fica só no servidor (HARPIA_COOLIFY_TOKEN) e nunca chega aos agentes.

export interface CoolifyDeployment {
  id: number
  uuid: string
  // queued | in_progress | finished | failed | cancelled-by-user
  status: string
  commit: string | null
  commitMessage: string | null
  pullRequestId: number
  createdAt: string
  updatedAt: string
  // Linhas do log (sem as ocultas); null quando o token não pode ler o log.
  logs: string[] | null
}

export interface CoolifyApplication {
  uuid: string
  name: string
  // Ex.: "running:healthy", "running:unhealthy", "exited:unhealthy".
  status: string
  gitBranch: string | null
}

export interface CoolifyTask {
  uuid: string
  name: string
  enabled: boolean
  frequency: string
  createdAt: string
}

export interface CoolifyExecution {
  // success | failed | running
  status: string
  message: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export interface CoolifyClient {
  listApplications(): Promise<{ uuid: string; name: string }[]>
  getApplication(uuid: string): Promise<CoolifyApplication>
  listDeployments(appUuid: string, take: number): Promise<CoolifyDeployment[]>
  listScheduledTasks(appUuid: string): Promise<CoolifyTask[]>
  listExecutions(appUuid: string, taskUuid: string): Promise<CoolifyExecution[]>
}

type Raw = Record<string, unknown>

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

function parseLogs(value: unknown): string[] | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const items = JSON.parse(value) as { output?: string; hidden?: boolean }[]
    return items.filter((item) => !item.hidden && item.output).map((item) => String(item.output))
  } catch {
    return null
  }
}

export function toDeployment(raw: Raw): CoolifyDeployment {
  return {
    id: Number(raw.id),
    uuid: String(raw.deployment_uuid ?? raw.uuid ?? ''),
    status: String(raw.status ?? ''),
    commit: text(raw.commit),
    commitMessage: text(raw.commit_message),
    pullRequestId: Number(raw.pull_request_id ?? 0),
    createdAt: String(raw.created_at ?? ''),
    updatedAt: String(raw.updated_at ?? raw.created_at ?? ''),
    logs: parseLogs(raw.logs)
  }
}

export function createCoolifyClient(options: { url: string; token: string }): CoolifyClient {
  const base = `${options.url.replace(/\/+$/, '')}/api/v1`

  async function call<T>(path: string): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${options.token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20000)
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Coolify respondeu ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
    }
    return (await response.json()) as T
  }

  return {
    async listApplications() {
      const list = await call<Raw[]>('/applications')
      return list.map((app) => ({ uuid: String(app.uuid), name: String(app.name ?? app.uuid) }))
    },
    async getApplication(uuid) {
      const app = await call<Raw>(`/applications/${encodeURIComponent(uuid)}`)
      return { uuid: String(app.uuid), name: String(app.name ?? uuid), status: String(app.status ?? ''), gitBranch: text(app.git_branch) }
    },
    async listDeployments(appUuid, take) {
      // A API devolve { count, deployments } (algumas versões devolvem a lista direto).
      const result = await call<Raw[] | { deployments?: Raw[] }>(`/deployments/applications/${encodeURIComponent(appUuid)}?skip=0&take=${take}`)
      const list = Array.isArray(result) ? result : (result.deployments ?? [])
      return list.map(toDeployment)
    },
    async listScheduledTasks(appUuid) {
      const list = await call<Raw[]>(`/applications/${encodeURIComponent(appUuid)}/scheduled-tasks`)
      return list.map((task) => ({
        uuid: String(task.uuid),
        name: String(task.name ?? task.uuid),
        enabled: task.enabled === true || task.enabled === 1 || task.enabled === 't',
        frequency: String(task.frequency ?? ''),
        createdAt: String(task.created_at ?? '')
      }))
    },
    async listExecutions(appUuid, taskUuid) {
      const list = await call<Raw[]>(`/applications/${encodeURIComponent(appUuid)}/scheduled-tasks/${encodeURIComponent(taskUuid)}/executions`)
      return list.map((execution) => ({
        status: String(execution.status ?? ''),
        message: text(execution.message),
        startedAt: text(execution.started_at),
        finishedAt: text(execution.finished_at),
        createdAt: String(execution.created_at ?? '')
      }))
    }
  }
}

// GET de saúde: código e começo do corpo (nunca guarda nem mostra o corpo inteiro).
export type HttpProbe = (url: string) => Promise<{ status: number; body: string }>

export const fetchProbe: HttpProbe = async (url) => {
  const response = await fetch(url, { headers: { 'user-agent': 'harpia-vigia' }, signal: AbortSignal.timeout(15000), redirect: 'follow' })
  const body = (await response.text().catch(() => '')).slice(0, 4000)
  return { status: response.status, body }
}
