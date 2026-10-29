// Tipos compartilhados entre o servidor e a interface web.

export const TASK_STATUSES = ['backlog', 'in_progress', 'review', 'done'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  in_progress: 'Em andamento',
  review: 'Revisão',
  done: 'Feito'
}

export type UserRole = 'admin' | 'member'

export interface User {
  id: number
  name: string
  email: string
  role: UserRole
  createdAt: string
}

export type CloneStatus = 'pending' | 'cloning' | 'ready' | 'error'

export interface Project {
  id: number
  name: string
  slug: string
  repoUrl: string
  defaultBranch: string
  cloneStatus: CloneStatus
  cloneError: string | null
  createdBy: number
  createdAt: string
}

export interface Task {
  id: number
  projectId: number
  number: number
  title: string
  description: string
  status: TaskStatus
  ownerId: number | null
  participantIds: number[]
  position: number
  createdBy: number
  createdAt: string
  updatedAt: string
  lastActivityAt: string
  closedAt: string | null
}

export type TaskEventType =
  | 'watcher_notice'
  | 'pr_opened'
  | 'pr_updated'
  | 'pr_merged'
  | 'pr_closed'
  | 'chat_started'
  | 'agent_started'
  | 'agent_stopped'
  | 'created'
  | 'edited'
  | 'status_changed'
  | 'owner_changed'
  | 'participant_joined'
  | 'participant_left'
  | 'comment'

export interface TaskEvent {
  id: number
  taskId: number
  actorId: number | null
  type: TaskEventType
  data: Record<string, unknown>
  createdAt: string
}

export interface TaskDetail {
  task: Task
  events: TaskEvent[]
}

export interface Invite {
  token: string
  role: UserRole
  expiresAt: string
}

// Agentes de IA e terminais (fase 3).
export const AGENT_KINDS = ['claude', 'codex', 'shell'] as const
export type AgentKind = (typeof AGENT_KINDS)[number]

export const AGENT_LABELS: Record<AgentKind | 'account', string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  shell: 'Terminal',
  account: 'Terminal pessoal'
}

export interface AgentSession {
  id: number
  // null no terminal pessoal (usado para conectar as contas de IA).
  taskId: number | null
  userId: number
  kind: AgentKind | 'account'
  branch: string | null
  status: 'running' | 'exited'
  createdAt: string
  endedAt: string | null
}

export interface AgentsStatus {
  enabled: boolean
  // Por que os terminais estão desligados, quando estão.
  reason: string | null
}

// Se a pessoa já conectou cada ferramenta de IA no servidor.
export interface AgentAccounts {
  claude: boolean
  codex: boolean
}

// Conversas com os agentes de IA (chat), a forma principal de trabalhar numa task.
export const CHAT_PROVIDERS = ['claude', 'codex'] as const
export type ChatProvider = (typeof CHAT_PROVIDERS)[number]

export const CHAT_PROVIDER_LABELS: Record<ChatProvider, string> = {
  claude: 'Claude',
  codex: 'Codex'
}

// O quanto o agente pode fazer sem pedir aprovação.
export const PERMISSION_MODES = ['ask', 'edits', 'auto'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  ask: 'Pedir aprovação',
  edits: 'Aceitar edições',
  auto: 'Autônomo'
}

// idle: esperando mensagem; working: trabalhando; waiting: esperando aprovação.
export type ChatStatus = 'idle' | 'working' | 'waiting' | 'closed'

export interface Chat {
  id: number
  taskId: number | null
  userId: number
  provider: ChatProvider
  title: string
  status: ChatStatus
  permissionMode: PermissionMode
  branch: string | null
  // Próxima mensagem sugerida pelo agente (só o Claude oferece).
  suggestion: string | null
  // Modelo escolhido pela pessoa; null usa o padrão da conta dela.
  model: string | null
  // Conversas fora das tasks são privadas; com shared, a equipe acompanha (só leitura).
  // Conversas de task são sempre visíveis para a equipe.
  shared: boolean
  createdAt: string
  updatedAt: string
}

// Modelo que a conta da pessoa oferece, como o Claude Code ou o Codex informam.
export interface ChatModel {
  id: string
  label: string
  description: string
}

interface ChatItemBase {
  id: number
  chatId: number
  createdAt: string
  updatedAt: string
}

export type ChatItem = ChatItemBase &
  (
    // steer: mensagem enviada enquanto o agente trabalhava; entra no meio da vez dele.
    | { kind: 'user'; text: string; authorId: number; steer?: boolean }
    | { kind: 'assistant'; text: string; streaming: boolean }
    | { kind: 'tool'; name: string; summary: string; status: 'running' | 'done' | 'failed'; output: string | null }
    | {
        kind: 'approval'
        title: string
        detail: string
        status: 'pending' | 'allowed' | 'denied' | 'expired'
        decidedBy: number | null
      }
    | { kind: 'error'; text: string }
    // Aviso passageiro do agente, como "sem conexão, tentando de novo".
    | { kind: 'notice'; text: string }
  )

export type ChatItemKind = ChatItem['kind']

// Entrega pelo GitHub (fase 5).
export type PullRequestState = 'open' | 'merged' | 'closed'

export interface PullRequest {
  id: number
  taskId: number
  userId: number
  number: number
  url: string
  branch: string
  base: string
  state: PullRequestState
  createdAt: string
  updatedAt: string
}

// Arquivo alterado na cópia de trabalho da pessoa, em relação à branch principal.
export interface ChangedFile {
  path: string
  // A: novo, M: alterado, D: apagado, ?: ainda não versionado
  status: 'A' | 'M' | 'D' | '?'
  additions: number | null
  deletions: number | null
}

// Vigia (fase 4): avisos sobre o andamento das tasks.
export type FindingKind = 'stale' | 'review_without_pr' | 'file_overlap' | 'duplicate'

export const FINDING_LABELS: Record<FindingKind, string> = {
  stale: 'Task parada',
  review_without_pr: 'Revisão sem PR',
  file_overlap: 'Mesmos arquivos',
  duplicate: 'Tasks parecidas'
}

export interface Finding {
  id: number
  projectId: number
  kind: FindingKind
  taskIds: number[]
  userIds: number[]
  message: string
  details: Record<string, unknown>
  // resolved: o vigia viu que o problema acabou; dismissed: alguém dispensou o aviso.
  status: 'open' | 'dismissed' | 'resolved'
  dismissedBy: number | null
  createdAt: string
  updatedAt: string
}

export interface SimilarTask {
  id: number
  number: number
  title: string
  status: TaskStatus
}

// Memória do projeto: o que a equipe quer que todo agente saiba ao começar uma conversa.
export const PROJECT_MEMORY_LIMIT = 3000

export interface ProjectMemory {
  projectId: number
  body: string
  updatedBy: number | null
  updatedAt: string | null
}

export interface NotificationSettings {
  telegram: {
    // O servidor tem um bot do Telegram configurado.
    available: boolean
    botUsername: string | null
    linked: boolean
  }
}

// Mensagens enviadas pelo servidor em tempo real (WebSocket).
export type RealtimeMessage =
  | { type: 'presence'; userIds: number[] }
  | { type: 'project'; project: Project }
  | { type: 'task'; task: Task }
  | { type: 'task_event'; event: TaskEvent }
  | { type: 'user'; user: User }
  | { type: 'session'; session: AgentSession }
  | { type: 'chat'; chat: Chat }
  | { type: 'chat_item'; item: ChatItem }
  // A conversa deixou de estar visível para quem recebe (foi excluída ou deixou de ser compartilhada).
  | { type: 'chat_removed'; chatId: number }
  | { type: 'pull_request'; pullRequest: PullRequest }
  | { type: 'finding'; finding: Finding }
  | { type: 'memory'; memory: ProjectMemory }
