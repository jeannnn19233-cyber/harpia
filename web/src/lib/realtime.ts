import type { RealtimeMessage } from '../../../shared/types.ts'
import { api } from './api.ts'
import { useHarpia } from './store.ts'

// Recarrega o que pode ter mudado enquanto a conexão estava fora.
export async function resync(): Promise<void> {
  const store = useHarpia.getState()
  const [{ users }, { projects }] = await Promise.all([api.users(), api.projects()])
  store.setUsers(users)
  store.setProjects(projects)
  const { projectId, openTaskId } = useHarpia.getState()
  if (projectId) {
    store.setTasks((await api.tasks(projectId)).tasks)
    store.upsertPulls((await api.projectPulls(projectId)).pullRequests)
  }
  const status = await api.agentsStatus()
  store.setAgentsStatus(status)
  if (status.enabled) {
    store.upsertSessions((await api.runningSessions()).sessions)
    store.upsertChats((await api.activeChats()).chats)
  }
  // Conversas abertas na tela podem ter recebido mensagens enquanto a conexão estava fora.
  for (const chatId of Object.keys(useHarpia.getState().chatItems).map(Number)) {
    const { chat, items } = await api.chat(chatId)
    store.upsertChats([chat])
    store.setChatItems(chatId, items)
  }
  if (openTaskId) {
    const detail = await api.task(openTaskId)
    store.setEvents(openTaskId, detail.events)
  }
}

// Mantém uma conexão em tempo real com o servidor e reconecta sozinha.
export function startRealtime(): () => void {
  let socket: WebSocket | null = null
  let stopped = false
  let retryDelay = 1000
  let timer: ReturnType<typeof setTimeout> | undefined

  const connect = () => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    socket = new WebSocket(`${protocol}://${location.host}/api/ws`)
    socket.onopen = () => {
      retryDelay = 1000
      useHarpia.getState().setConnected(true)
      void resync().catch(() => undefined)
    }
    socket.onmessage = (event) => {
      useHarpia.getState().apply(JSON.parse(String(event.data)) as RealtimeMessage)
    }
    socket.onclose = () => {
      useHarpia.getState().setConnected(false)
      if (stopped) return
      timer = setTimeout(connect, retryDelay)
      retryDelay = Math.min(retryDelay * 2, 15000)
    }
  }

  connect()
  return () => {
    stopped = true
    clearTimeout(timer)
    socket?.close()
  }
}
