import { create } from 'zustand'
import type {
  AgentSession,
  AgentsStatus,
  Chat,
  ChatItem,
  Finding,
  Learning,
  MonitorEvent,
  PrReview,
  ProjectMonitor,
  Project,
  PullRequest,
  RealtimeMessage,
  Routine,
  RoutineRun,
  Task,
  TaskEvent,
  TaskSummary,
  User
} from '../../../shared/types.ts'

export type View = 'board' | 'chats' | 'routines'

interface HarpiaState {
  // Quadro de tasks ou conversas fora das tasks.
  view: View
  me: User | null
  users: Record<number, User>
  online: number[]
  connected: boolean
  projects: Project[]
  projectId: number | null
  tasks: Record<number, Task>
  openTaskId: number | null
  events: Record<number, TaskEvent[]>
  agentsStatus: AgentsStatus | null
  sessions: Record<number, AgentSession>
  chats: Record<number, Chat>
  // Itens de cada conversa já carregada (as outras ainda não foram abertas).
  chatItems: Record<number, ChatItem[]>
  pulls: Record<number, PullRequest>
  findings: Record<number, Finding>
  routines: Record<number, Routine>
  reviews: Record<number, PrReview>
  // Vigias do Coolify por projeto e os últimos avisos.
  monitors: Record<number, ProjectMonitor>
  monitorEvents: Record<number, MonitorEvent[]>
  // Fase 4b: resumo de cada task concluída e aprendizados sugeridos.
  summaries: Record<number, TaskSummary>
  learnings: Record<number, Learning>
  // Execuções de cada rotina já carregada (mais recentes primeiro).
  routineRuns: Record<number, RoutineRun[]>

  setView(view: View): void
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
  setAgentsStatus(status: AgentsStatus): void
  upsertSessions(sessions: AgentSession[]): void
  upsertChats(chats: Chat[]): void
  setChatItems(chatId: number, items: ChatItem[]): void
  upsertPulls(pulls: PullRequest[]): void
  upsertFindings(findings: Finding[]): void
  upsertReviews(reviews: PrReview[]): void
  setMonitor(monitor: ProjectMonitor, events?: MonitorEvent[]): void
  setSummary(summary: TaskSummary): void
  upsertLearnings(learnings: Learning[]): void
  setRoutines(routines: Routine[]): void
  upsertRoutine(routine: Routine): void
  setRoutineRuns(routineId: number, runs: RoutineRun[]): void
  apply(message: RealtimeMessage): void
}

const PROJECT_KEY = 'harpia.projectId'
const VIEW_KEY = 'harpia.view'

function savedView(): View {
  try {
    const saved = localStorage.getItem(VIEW_KEY)
    return saved === 'chats' || saved === 'routines' ? saved : 'board'
  } catch {
    return 'board'
  }
}

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
  view: savedView(),
  me: null,
  users: {},
  online: [],
  connected: false,
  projects: [],
  projectId: savedProjectId(),
  tasks: {},
  openTaskId: null,
  events: {},
  agentsStatus: null,
  sessions: {},
  chats: {},
  chatItems: {},
  pulls: {},
  findings: {},
  routines: {},
  reviews: {},
  monitors: {},
  monitorEvents: {},
  summaries: {},
  learnings: {},
  routineRuns: {},

  setView: (view) => {
    try {
      localStorage.setItem(VIEW_KEY, view)
    } catch {
      // Sem armazenamento local: só não lembra a última tela.
    }
    set({ view })
  },
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
  setAgentsStatus: (agentsStatus) => set({ agentsStatus }),
  upsertSessions: (sessions) =>
    set((state) => ({ sessions: { ...state.sessions, ...Object.fromEntries(sessions.map((s) => [s.id, s])) } })),
  upsertChats: (chats) =>
    set((state) => ({ chats: { ...state.chats, ...Object.fromEntries(chats.map((chat) => [chat.id, chat])) } })),
  setChatItems: (chatId, items) => set((state) => ({ chatItems: { ...state.chatItems, [chatId]: items } })),
  setSummary: (summary) => set((state) => ({ summaries: { ...state.summaries, [summary.taskId]: summary } })),
  upsertLearnings: (learnings) =>
    set((state) => ({ learnings: { ...state.learnings, ...Object.fromEntries(learnings.map((learning) => [learning.id, learning])) } })),
  setMonitor: (monitor, events) =>
    set((state) => ({
      monitors: { ...state.monitors, [monitor.projectId]: monitor },
      monitorEvents: events ? { ...state.monitorEvents, [monitor.projectId]: events } : state.monitorEvents
    })),
  upsertReviews: (reviews) =>
    set((state) => ({ reviews: { ...state.reviews, ...Object.fromEntries(reviews.map((review) => [review.id, review])) } })),
  setRoutines: (routines) => set({ routines: Object.fromEntries(routines.map((routine) => [routine.id, routine])) }),
  upsertRoutine: (routine) => set((state) => ({ routines: { ...state.routines, [routine.id]: routine } })),
  setRoutineRuns: (routineId, runs) => set((state) => ({ routineRuns: { ...state.routineRuns, [routineId]: runs } })),
  upsertFindings: (findings) =>
    set((state) => ({ findings: { ...state.findings, ...Object.fromEntries(findings.map((finding) => [finding.id, finding])) } })),
  upsertPulls: (pulls) =>
    set((state) => ({ pulls: { ...state.pulls, ...Object.fromEntries(pulls.map((pull) => [pull.id, pull])) } })),

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
      case 'session':
        state.upsertSessions([message.session])
        break
      case 'finding':
        state.upsertFindings([message.finding])
        break
      case 'pull_request':
        state.upsertPulls([message.pullRequest])
        break
      case 'chat':
        state.upsertChats([message.chat])
        break
      case 'routine':
        state.upsertRoutine(message.routine)
        break
      case 'pr_review':
        state.upsertReviews([message.review])
        break
      case 'task_summary':
        state.setSummary(message.summary)
        break
      case 'learning':
        state.upsertLearnings([message.learning])
        break
      case 'routine_removed': {
        const { [message.routineId]: _routine, ...routines } = state.routines
        set({ routines })
        break
      }
      case 'routine_run': {
        const list = state.routineRuns[message.run.routineId]
        if (!list) break
        const index = list.findIndex((run) => run.id === message.run.id)
        const next = index === -1 ? [message.run, ...list] : list.map((run, i) => (i === index ? message.run : run))
        set({ routineRuns: { ...state.routineRuns, [message.run.routineId]: next } })
        break
      }
      case 'chat_removed': {
        const { [message.chatId]: _chat, ...chats } = state.chats
        const { [message.chatId]: _items, ...chatItems } = state.chatItems
        set({ chats, chatItems })
        break
      }
      case 'chat_item': {
        const list = state.chatItems[message.item.chatId]
        if (!list) break
        const index = list.findIndex((item) => item.id === message.item.id)
        const next = index === -1 ? [...list, message.item] : list.map((item, i) => (i === index ? message.item : item))
        set({ chatItems: { ...state.chatItems, [message.item.chatId]: next } })
        break
      }
      case 'monitor':
        state.setMonitor(message.monitor)
        break
      case 'monitor_event': {
        const list = state.monitorEvents[message.event.projectId] ?? []
        if (!list.some((item) => item.id === message.event.id)) {
          set({ monitorEvents: { ...state.monitorEvents, [message.event.projectId]: [message.event, ...list].slice(0, 30) } })
        }
        break
      }
      case 'task_event': {
        const list = addEvent(state.events[message.event.taskId], message.event)
        if (list) set({ events: { ...state.events, [message.event.taskId]: list } })
        break
      }
    }
  }
}))
