import { create } from 'zustand'
import type { Project, RealtimeMessage, Task, TaskEvent, User } from '../../../shared/types.ts'

interface HarpiaState {
  me: User | null
  users: Record<number, User>
  online: number[]
  connected: boolean
  projects: Project[]
  projectId: number | null
  tasks: Record<number, Task>
  openTaskId: number | null
  events: Record<number, TaskEvent[]>

  setMe(me: User | null): void
  setUsers(users: User[]): void
  setConnected(connected: boolean): void
  setProjects(projects: Project[]): void
  upsertProject(project: Project): void
  selectProject(projectId: number | null): void
  setTasks(tasks: Task[]): void
  upsertTask(task: Task): void
  openTask(taskId: number | null): void
  setEvents(taskId: number, events: TaskEvent[]): void
  apply(message: RealtimeMessage): void
}

const PROJECT_KEY = 'harpia.projectId'

function savedProjectId(): number | null {
  try {
    const value = Number(localStorage.getItem(PROJECT_KEY))
    return Number.isInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function addEvent(list: TaskEvent[] | undefined, event: TaskEvent): TaskEvent[] | undefined {
  if (!list) return list
  if (list.some((item) => item.id === event.id)) return list
  return [...list, event]
}

export const useHarpia = create<HarpiaState>((set, get) => ({
  me: null,
  users: {},
  online: [],
  connected: false,
  projects: [],
  projectId: savedProjectId(),
  tasks: {},
  openTaskId: null,
  events: {},

  setMe: (me) => set({ me }),
  setUsers: (users) => set({ users: Object.fromEntries(users.map((user) => [user.id, user])) }),
  setConnected: (connected) => set({ connected }),
  setProjects: (projects) => {
    const current = get().projectId
    const projectId = projects.some((project) => project.id === current) ? current : (projects[0]?.id ?? null)
    set({ projects, projectId })
  },
  upsertProject: (project) =>
    set((state) => {
      const exists = state.projects.some((item) => item.id === project.id)
      const projects = exists
        ? state.projects.map((item) => (item.id === project.id ? project : item))
        : [...state.projects, project].sort((a, b) => a.name.localeCompare(b.name))
      return { projects, projectId: state.projectId ?? project.id }
    }),
  selectProject: (projectId) => {
    try {
      if (projectId) localStorage.setItem(PROJECT_KEY, String(projectId))
    } catch {
      // Sem armazenamento local: só não lembra o último projeto.
    }
    set({ projectId, tasks: {}, openTaskId: null })
  },
  setTasks: (tasks) => set({ tasks: Object.fromEntries(tasks.map((task) => [task.id, task])) }),
  upsertTask: (task) =>
    set((state) => (task.projectId === state.projectId ? { tasks: { ...state.tasks, [task.id]: task } } : {})),
  openTask: (openTaskId) => set({ openTaskId }),
  setEvents: (taskId, events) => set((state) => ({ events: { ...state.events, [taskId]: events } })),

  apply: (message) => {
    const state = get()
    switch (message.type) {
      case 'presence':
        set({ online: message.userIds })
        break
      case 'user':
        set({ users: { ...state.users, [message.user.id]: message.user } })
        break
      case 'project':
        state.upsertProject(message.project)
        break
      case 'task':
        state.upsertTask(message.task)
        break
      case 'task_event': {
        const list = addEvent(state.events[message.event.taskId], message.event)
        if (list) set({ events: { ...state.events, [message.event.taskId]: list } })
        break
      }
    }
  }
}))
