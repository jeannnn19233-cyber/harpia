import { useEffect, useMemo, useState } from 'react'
import { TASK_STATUS_LABELS, type ChatProvider } from '../../../../shared/types.ts'
import { api } from '../../lib/api.ts'
import { useHarpia } from '../../lib/store.ts'
import { ChatList } from './ChatList.tsx'
import { ChatView } from './ChatView.tsx'
import { TaskSidebar } from './TaskSidebar.tsx'
import { TerminalDock } from './TerminalDock.tsx'

// Tela de trabalho de uma task: conversas à esquerda, chat no centro com o terminal
// embaixo, e os dados da task com o histórico da equipe à direita.
export function TaskWorkspace({ taskId }: { taskId: number }) {
  const { me, agentsStatus, openTask, upsertTask, setEvents, upsertChats } = useHarpia()
  const task = useHarpia((state) => state.tasks[taskId])
  const allChats = useHarpia((state) => state.chats)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [creating, setCreating] = useState<ChatProvider | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('')

  const chats = useMemo(
    () => Object.values(allChats).filter((chat) => chat.taskId === taskId).sort((a, b) => a.id - b.id),
    [allChats, taskId]
  )

  useEffect(() => {
    api
      .task(taskId)
      .then((detail) => {
        upsertTask(detail.task)
        setEvents(taskId, detail.events)
      })
      .catch((err: Error) => setError(err.message))
    api
      .taskChats(taskId)
      .then(({ chats }) => {
        upsertChats(chats)
        // Abre a minha conversa mais recente; senão, a mais recente da equipe.
        const open = chats.filter((chat) => chat.status !== 'closed')
        const mine = open.filter((chat) => chat.userId === me?.id)
        const initial = mine.at(-1) ?? open.at(-1)
        if (initial) setSelectedId((current) => current ?? initial.id)
      })
      .catch(() => undefined)
  }, [taskId, me?.id, upsertTask, setEvents, upsertChats])

  useEffect(() => {
    if (task) setTitle(task.title)
  }, [task?.title])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !(event.target instanceof HTMLTextAreaElement) && !(event.target instanceof HTMLInputElement)) {
        openTask(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openTask])

  if (!task) return <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">Carregando task…</div>

  const disabledReason = agentsStatus && !agentsStatus.enabled ? agentsStatus.reason : null
  const taskDone = task.status === 'done'

  const create = async (provider: ChatProvider) => {
    setCreating(provider)
    try {
      const { chat } = await api.createChat(task.id, provider, 'ask')
      upsertChats([chat])
      setSelectedId(chat.id)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setCreating(null)
    }
  }

  const saveTitle = async () => {
    if (!title.trim() || title === task.title) return
    try {
      upsertTask((await api.updateTask(task.id, { title })).task)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
        <button className="btn-ghost px-2 py-1 text-sm" onClick={() => openTask(null)} title="Voltar ao quadro (Esc)">
          ← Quadro
        </button>
        <span className="font-mono text-sm text-zinc-500">T-{task.number}</span>
        <input
          className="min-w-0 flex-1 bg-transparent text-base font-semibold outline-none"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void saveTitle()}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <span className="rounded-full border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-300">
          {TASK_STATUS_LABELS[task.status]}
        </span>
      </div>
      {error && <div className="bg-rose-950 px-4 py-2 text-sm text-rose-300">{error}</div>}

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)_320px]">
        <ChatList
          chats={chats}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onCreate={(provider) => void create(provider)}
          creating={creating}
          disabledReason={taskDone ? 'A task está concluída. Reabra para trabalhar nela.' : disabledReason}
        />
        <main className="flex min-h-0 flex-col">
          {selectedId ? (
            <ChatView key={selectedId} chatId={selectedId} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-zinc-500">
              <p className="text-base text-zinc-300">Nenhuma conversa aberta nesta task.</p>
              <p>Comece uma conversa com o Claude ou o Codex ao lado. Cada pessoa usa o próprio agente e a própria cópia do código.</p>
            </div>
          )}
          <TerminalDock taskId={task.id} enabled={!disabledReason} />
        </main>
        <TaskSidebar taskId={task.id} />
      </div>
    </div>
  )
}
