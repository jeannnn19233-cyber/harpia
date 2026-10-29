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

// Mensagens enviadas pelo servidor em tempo real (WebSocket).
export type RealtimeMessage =
  | { type: 'presence'; userIds: number[] }
  | { type: 'project'; project: Project }
  | { type: 'task'; task: Task }
  | { type: 'task_event'; event: TaskEvent }
  | { type: 'user'; user: User }
