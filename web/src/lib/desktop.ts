import { noticesFor, waitingCount } from './desktop-notices.ts'
import { useHarpia } from './store.ts'

// Ponte com o app de computador (pasta desktop/). No navegador, `window.harpiaDesktop` não existe
// e nada aqui roda.
interface HarpiaDesktop {
  platform: string
  version: string
  setBadge(count: number): void
  notify(notice: { title: string; body: string; taskId?: number | null }): void
  onOpenTask(callback: (payload: { taskId: number }) => void): () => void
}

declare global {
  interface Window {
    harpiaDesktop?: HarpiaDesktop
  }
}

export function desktopApp(): HarpiaDesktop | null {
  return typeof window === 'undefined' ? null : (window.harpiaDesktop ?? null)
}

// Marca a página como app de computador (a barra do topo muda no Mac), já na tela de login.
export function markDesktop(): void {
  const desktop = desktopApp()
  if (desktop) document.documentElement.classList.add('desktop', `desktop-${desktop.platform}`)
}

export function startDesktopBridge(): () => void {
  const desktop = desktopApp()
  if (!desktop) return () => undefined

  const unsubscribe = useHarpia.subscribe((state, previous) => {
    if (state.chats === previous.chats) return
    const userId = state.me?.id
    desktop.setBadge(waitingCount(state.chats, userId))
    // Com a janela em foco a pessoa já está vendo; o aviso é para quando ela saiu.
    if (document.hasFocus()) return
    const title = (taskId: number | null) => {
      const task = taskId ? state.tasks[taskId] : null
      return task ? `T-${task.number} · ${task.title}` : null
    }
    for (const notice of noticesFor(previous.chats, state.chats, userId, title)) desktop.notify(notice)
  })

  const stopOpen = desktop.onOpenTask(({ taskId }) => {
    const state = useHarpia.getState()
    const task = state.tasks[taskId]
    if (task && task.projectId !== state.projectId) {
      // Ao trocar de projeto, o Workspace abre a última task lembrada dele: lembra esta.
      try {
        localStorage.setItem(`harpia.studio.task.${task.projectId}`, String(taskId))
      } catch {
        // Sem armazenamento local, abre a task logo abaixo do mesmo jeito.
      }
      state.selectProject(task.projectId)
    }
    state.setView('board')
    state.openTask(taskId)
  })

  return () => {
    unsubscribe()
    stopOpen()
    desktop.setBadge(0)
  }
}
