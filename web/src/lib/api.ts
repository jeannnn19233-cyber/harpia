import type {
  AgentAccounts,
  AgentKind,
  AgentSession,
  AgentsStatus,
  Chat,
  ChatItem,
  ChatProvider,
  Invite,
  PermissionMode,
  Project,
  Task,
  TaskDetail,
  TaskEvent,
  TaskStatus,
  User
} from '../../../shared/types.ts'

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const data = (await response.json().catch(() => ({}))) as { error?: string }
  if (!response.ok) throw new ApiError(response.status, data.error ?? `Erro ${response.status}`)
  return data as T
}

export const api = {
  status: () => request<{ needsSetup: boolean; setupCodeRequired: boolean }>('GET', '/api/status'),
  me: () => request<{ user: User }>('GET', '/api/me'),
  setup: (input: { name: string; email: string; password: string; setupCode?: string }) =>
    request<{ user: User }>('POST', '/api/setup', input),
  login: (input: { email: string; password: string }) => request<{ user: User }>('POST', '/api/login', input),
  logout: () => request<{ ok: true }>('POST', '/api/logout', {}),

  users: () => request<{ users: User[] }>('GET', '/api/users'),
  createInvite: (role: 'admin' | 'member') => request<{ invite: Invite }>('POST', '/api/invites', { role }),
  checkInvite: (token: string) => request<{ invite: { role: string; expiresAt: string } }>('GET', `/api/invites/${token}`),
  acceptInvite: (token: string, input: { name: string; email: string; password: string }) =>
    request<{ user: User }>('POST', `/api/invites/${token}/accept`, input),

  projects: () => request<{ projects: Project[] }>('GET', '/api/projects'),
  createProject: (input: { name: string; repoUrl: string; defaultBranch?: string }) =>
    request<{ project: Project }>('POST', '/api/projects', input),
  recloneProject: (id: number) => request<{ project: Project }>('POST', `/api/projects/${id}/clone`, {}),

  tasks: (projectId: number) => request<{ tasks: Task[] }>('GET', `/api/projects/${projectId}/tasks`),
  createTask: (projectId: number, input: { title: string; description?: string; ownerId?: number | null }) =>
    request<{ task: Task }>('POST', `/api/projects/${projectId}/tasks`, input),
  task: (id: number) => request<TaskDetail>('GET', `/api/tasks/${id}`),
  updateTask: (
    id: number,
    input: Partial<{ title: string; description: string; status: TaskStatus; ownerId: number | null; position: number }>
  ) => request<{ task: Task; events: TaskEvent[] }>('PATCH', `/api/tasks/${id}`, input),
  joinTask: (id: number) => request<{ task: Task }>('POST', `/api/tasks/${id}/join`, {}),
  leaveTask: (id: number) => request<{ task: Task }>('POST', `/api/tasks/${id}/leave`, {}),
  comment: (id: number, body: string) => request<{ event: TaskEvent }>('POST', `/api/tasks/${id}/comments`, { body }),

  agentsStatus: () => request<AgentsStatus>('GET', '/api/agents/status'),
  accounts: () => request<{ accounts: AgentAccounts }>('GET', '/api/me/accounts'),
  openPersonalTerminal: () => request<{ session: AgentSession }>('POST', '/api/me/terminal', {}),
  runningSessions: () => request<{ sessions: AgentSession[] }>('GET', '/api/sessions/running'),
  taskSessions: (taskId: number) => request<{ sessions: AgentSession[] }>('GET', `/api/tasks/${taskId}/sessions`),
  startSession: (taskId: number, kind: AgentKind) =>
    request<{ session: AgentSession }>('POST', `/api/tasks/${taskId}/sessions`, { kind }),
  stopSession: (id: number) => request<{ session: AgentSession }>('POST', `/api/sessions/${id}/stop`, {}),
  openTaskTerminal: (taskId: number) => request<{ session: AgentSession }>('POST', `/api/tasks/${taskId}/terminal`, {}),

  activeChats: () => request<{ chats: Chat[] }>('GET', '/api/chats/active'),
  taskChats: (taskId: number) => request<{ chats: Chat[] }>('GET', `/api/tasks/${taskId}/chats`),
  createChat: (taskId: number, provider: ChatProvider, permissionMode: PermissionMode) =>
    request<{ chat: Chat }>('POST', `/api/tasks/${taskId}/chats`, { provider, permissionMode }),
  chat: (id: number) => request<{ chat: Chat; items: ChatItem[] }>('GET', `/api/chats/${id}`),
  sendMessage: (id: number, text: string) => request<{ ok: true }>('POST', `/api/chats/${id}/messages`, { text }),
  interruptChat: (id: number) => request<{ ok: true }>('POST', `/api/chats/${id}/interrupt`, {}),
  decide: (id: number, itemId: number, decision: 'allow' | 'deny') =>
    request<{ item: ChatItem }>('POST', `/api/chats/${id}/approvals/${itemId}`, { decision }),
  setPermissionMode: (id: number, permissionMode: PermissionMode) =>
    request<{ chat: Chat }>('PATCH', `/api/chats/${id}`, { permissionMode }),
  closeChat: (id: number) => request<{ chat: Chat }>('POST', `/api/chats/${id}/close`, {})
}
