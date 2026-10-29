import { useMemo, useState, type DragEvent, type FormEvent } from 'react'
import { TASK_STATUSES, TASK_STATUS_LABELS, type Task, type TaskStatus } from '../../../shared/types.ts'
import { api } from '../lib/api.ts'
import { timeAgo } from '../lib/format.ts'
import { useHarpia } from '../lib/store.ts'
import { Avatar } from './Avatar.tsx'

const COLUMN_ACCENT: Record<TaskStatus, string> = {
  backlog: 'bg-zinc-500',
  in_progress: 'bg-sky-400',
  review: 'bg-violet-400',
  done: 'bg-emerald-400'
}

// Posição entre os vizinhos, para reordenar sem renumerar a coluna inteira.
function positionBefore(column: Task[], targetId: number | null, movingId: number): number {
  const others = column.filter((task) => task.id !== movingId)
  if (targetId === null) return (others.at(-1)?.position ?? 0) + 1000
  const index = others.findIndex((task) => task.id === targetId)
  if (index === -1) return (others.at(-1)?.position ?? 0) + 1000
  const next = others[index].position
  const previous = index > 0 ? others[index - 1].position : next - 2000
  return (previous + next) / 2
}

function TaskCard({ task, onDragStart }: { task: Task; onDragStart: (event: DragEvent, task: Task) => void }) {
  const { users, online, openTask, chats, pulls } = useHarpia()
  const taskPulls = Object.values(pulls).filter((pull) => pull.taskId === task.id && pull.state !== 'closed')
  // Conversas com agentes nesta task: quem está trabalhando ou esperando aprovação.
  const busyChats = Object.values(chats).filter(
    (chat) => chat.taskId === task.id && (chat.status === 'working' || chat.status === 'waiting')
  )
  const waiting = busyChats.some((chat) => chat.status === 'waiting')
  const owner = task.ownerId ? users[task.ownerId] : undefined
  const helpers = task.participantIds.filter((id) => id !== task.ownerId)

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(event) => onDragStart(event, task)}
      onClick={() => openTask(task.id)}
      onKeyDown={(event) => event.key === 'Enter' && openTask(task.id)}
      data-task-id={task.id}
      className="w-full cursor-grab rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-left transition hover:border-zinc-600 active:cursor-grabbing"
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 font-mono text-xs text-zinc-500">T-{task.number}</span>
        <span className="text-sm leading-snug font-medium">{task.title}</span>
      </div>
      {taskPulls.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {taskPulls.map((pull) => (
            <span
              key={pull.id}
              className={`rounded-full border px-1.5 py-0.5 font-mono text-[10px] ${
                pull.state === 'merged' ? 'border-violet-700 text-violet-300' : 'border-sky-700 text-sky-300'
              }`}
            >
              PR #{pull.number}
            </span>
          ))}
        </div>
      )}
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {owner && <Avatar user={owner} size="sm" online={online.includes(owner.id)} />}
          {owner && helpers.length > 0 && <span className="text-xs text-zinc-400">+{helpers.length}</span>}
          {!owner &&
            (helpers.length > 0 ? (
              helpers.map((id) => <Avatar key={id} user={users[id]} size="sm" online={online.includes(id)} />)
            ) : (
              <span className="text-xs text-zinc-500">Sem responsável</span>
            ))}
          {busyChats.length > 0 && (
            <span
              className={`ml-2 flex items-center gap-1 text-xs ${waiting ? 'text-amber-400' : 'text-sky-400'}`}
              title={busyChats.map((chat) => `${users[chat.userId]?.name ?? '?'}: ${chat.status === 'waiting' ? 'esperando aprovação' : 'trabalhando'}`).join('\n')}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${waiting ? 'bg-amber-400' : 'animate-pulse bg-sky-400'}`} />
              {waiting ? 'esperando aprovação' : `${busyChats.length} ${busyChats.length === 1 ? 'agente trabalhando' : 'agentes trabalhando'}`}
            </span>
          )}
        </div>
        <span className="text-xs text-zinc-500" title="Última atividade">
          {timeAgo(task.lastActivityAt)}
        </span>
      </div>
    </div>
  )
}

function NewTaskForm({ projectId }: { projectId: number }) {
  const [title, setTitle] = useState('')
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim()) return
    try {
      await api.createTask(projectId, { title })
      setTitle('')
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn-ghost w-full justify-start text-zinc-400">
        + Nova task
      </button>
    )
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <input
        className="input"
        placeholder="O que precisa ser feito?"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        autoFocus
      />
      {error && <p className="text-xs text-rose-400">{error}</p>}
      <div className="flex gap-2">
        <button className="btn-primary flex-1 py-1.5">Criar</button>
        <button type="button" onClick={() => setOpen(false)} className="btn-ghost py-1.5">
          Cancelar
        </button>
      </div>
    </form>
  )
}

export function Board({ projectId }: { projectId: number }) {
  const tasks = useHarpia((state) => state.tasks)
  const upsertTask = useHarpia((state) => state.upsertTask)
  const [dragging, setDragging] = useState<Task | null>(null)
  const [overColumn, setOverColumn] = useState<TaskStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const columns = useMemo(() => {
    const grouped = Object.fromEntries(TASK_STATUSES.map((status) => [status, [] as Task[]])) as Record<TaskStatus, Task[]>
    for (const task of Object.values(tasks)) grouped[task.status].push(task)
    for (const list of Object.values(grouped)) list.sort((a, b) => a.position - b.position || a.id - b.id)
    return grouped
  }, [tasks])

  const onDragStart = (event: DragEvent, task: Task) => {
    setDragging(task)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(task.id))
  }

  const onDrop = async (event: DragEvent, status: TaskStatus) => {
    event.preventDefault()
    setOverColumn(null)
    const task = dragging
    setDragging(null)
    if (!task) return
    const targetCard = (event.target as HTMLElement).closest('[data-task-id]')
    const targetId = targetCard ? Number(targetCard.getAttribute('data-task-id')) : null
    if (targetId === task.id) return
    const position = positionBefore(columns[status], targetId, task.id)

    upsertTask({ ...task, status, position })
    try {
      const { task: saved } = await api.updateTask(task.id, status === task.status ? { position } : { status, position })
      upsertTask(saved)
      setError(null)
    } catch (err) {
      upsertTask(task)
      setError((err as Error).message)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error && <div className="mx-4 mt-3 rounded-md bg-rose-950 px-3 py-2 text-sm text-rose-300">{error}</div>}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto p-4 md:grid-cols-2 xl:grid-cols-4">
        {TASK_STATUSES.map((status) => (
          <section
            key={status}
            onDragOver={(event) => {
              event.preventDefault()
              setOverColumn(status)
            }}
            onDragLeave={() => setOverColumn((current) => (current === status ? null : current))}
            onDrop={(event) => void onDrop(event, status)}
            className={`flex min-h-48 flex-col rounded-xl border bg-zinc-900/40 p-3 transition ${
              overColumn === status ? 'border-brand-500/60' : 'border-zinc-800'
            }`}
          >
            <header className="mb-3 flex items-center gap-2 px-1">
              <span className={`h-2 w-2 rounded-full ${COLUMN_ACCENT[status]}`} />
              <h2 className="text-sm font-semibold">{TASK_STATUS_LABELS[status]}</h2>
              <span className="text-xs text-zinc-500">{columns[status].length}</span>
            </header>
            <div className="flex flex-1 flex-col gap-2">
              {columns[status].map((task) => (
                <TaskCard key={task.id} task={task} onDragStart={onDragStart} />
              ))}
              {status === 'backlog' && <NewTaskForm projectId={projectId} />}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
