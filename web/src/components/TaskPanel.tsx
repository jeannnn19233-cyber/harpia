import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  AGENT_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type AgentSession,
  type TaskEvent,
  type TaskStatus,
  type User
} from '../../../shared/types.ts'
import { api } from '../lib/api.ts'
import { fullDate, timeAgo } from '../lib/format.ts'
import { useHarpia } from '../lib/store.ts'
import { AgentsSection } from './Agents.tsx'
import { Avatar } from './Avatar.tsx'

function describe(event: TaskEvent, users: Record<number, User>): string {
  const name = (id: unknown) => (typeof id === 'number' ? (users[id]?.name ?? 'alguém') : 'ninguém')
  const status = (value: unknown) => TASK_STATUS_LABELS[value as TaskStatus] ?? String(value)
  switch (event.type) {
    case 'created':
      return 'criou a task'
    case 'edited': {
      const fields = (event.data.fields as string[] | undefined) ?? []
      const labels = fields.map((field) => (field === 'title' ? 'o título' : 'a descrição'))
      return `editou ${labels.join(' e ')}`
    }
    case 'status_changed':
      if (event.data.reason === 'agent') return `começou a trabalhar: moveu para ${status(event.data.to)}`
      return `moveu de ${status(event.data.from)} para ${status(event.data.to)}`
    case 'owner_changed':
      if (event.data.to === null) return 'removeu o responsável'
      if (event.data.to === event.actorId) return 'assumiu a task como responsável'
      return `passou a responsabilidade para ${name(event.data.to)}`
    case 'participant_joined':
      return 'entrou na task'
    case 'participant_left':
      return 'saiu da task'
    case 'comment':
      return 'comentou'
    case 'agent_started':
      return `abriu ${AGENT_LABELS[event.data.kind as AgentSession['kind']] ?? 'um agente'}`
    case 'agent_stopped': {
      const label = AGENT_LABELS[event.data.kind as AgentSession['kind']] ?? 'agente'
      if (event.data.reason === 'ended') return `a sessão de ${label} de ${name(event.data.ownerId)} terminou`
      return event.data.ownerId === event.actorId ? `encerrou o ${label}` : `encerrou o ${label} de ${name(event.data.ownerId)}`
    }
  }
}

function Timeline({ taskId }: { taskId: number }) {
  const events = useHarpia((state) => state.events[taskId])
  const users = useHarpia((state) => state.users)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [events?.length])

  if (!events) return <p className="text-sm text-zinc-500">Carregando histórico…</p>
  return (
    <ol className="space-y-3">
      {events
        // Quem vira responsável entra na task automaticamente; o evento de troca já diz isso.
        .filter((event) => !(event.type === 'participant_joined' && event.data.reason === 'owner'))
        .map((event) => {
        const actor = event.actorId ? users[event.actorId] : undefined
        return (
          <li key={event.id} className="flex gap-3">
            <Avatar user={actor} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="text-sm">
                <span className="font-medium">{actor?.name ?? 'Harpia'}</span>{' '}
                <span className="text-zinc-400">{describe(event, users)}</span>{' '}
                <span className="text-xs text-zinc-500" title={fullDate(event.createdAt)}>
                  · {timeAgo(event.createdAt)}
                </span>
              </p>
              {event.type === 'comment' && (
                <p className="mt-1 rounded-lg bg-zinc-800/70 px-3 py-2 text-sm whitespace-pre-wrap">
                  {String(event.data.body)}
                </p>
              )}
            </div>
          </li>
        )
      })}
      <div ref={bottom} />
    </ol>
  )
}

export function TaskPanel({ taskId }: { taskId: number }) {
  const task = useHarpia((state) => state.tasks[taskId])
  const { me, users, online, openTask, upsertTask, setEvents } = useHarpia()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .task(taskId)
      .then((detail) => {
        upsertTask(detail.task)
        setEvents(taskId, detail.events)
      })
      .catch((err: Error) => setError(err.message))
  }, [taskId, upsertTask, setEvents])

  useEffect(() => {
    if (!task) return
    setTitle(task.title)
    setDescription(task.description)
  }, [task?.title, task?.description])

  if (!task || !me) return null

  const run = async (action: () => Promise<{ task?: typeof task }>) => {
    try {
      const result = await action()
      if (result.task) upsertTask(result.task)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const sendComment = async (event: FormEvent) => {
    event.preventDefault()
    if (!comment.trim()) return
    await run(async () => {
      await api.comment(task.id, comment)
      setComment('')
      return {}
    })
  }

  const participating = task.participantIds.includes(me.id)
  const teamList = Object.values(users).sort((a, b) => a.name.localeCompare(b.name))

  return (
    <aside className="fixed inset-y-0 right-0 z-20 flex w-full max-w-xl flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-5 py-3">
        <span className="font-mono text-sm text-zinc-500">T-{task.number}</span>
        <span className="text-xs text-zinc-500">criada {timeAgo(task.createdAt)}</span>
        <button onClick={() => openTask(null)} className="btn-ghost ml-auto px-2 py-1" aria-label="Fechar">
          ✕
        </button>
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4">
        <input
          className="w-full bg-transparent text-xl font-semibold outline-none"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== task.title && run(() => api.updateTask(task.id, { title }))}
        />

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">Status</span>
            <select
              className="input"
              value={task.status}
              onChange={(e) => run(() => api.updateTask(task.id, { status: e.target.value as TaskStatus }))}
            >
              {TASK_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {TASK_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">Responsável</span>
            <select
              className="input"
              value={task.ownerId ?? ''}
              onChange={(e) =>
                run(() => api.updateTask(task.id, { ownerId: e.target.value ? Number(e.target.value) : null }))
              }
            >
              <option value="">Ninguém</option>
              {teamList.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">Quem está na task</h3>
            {participating ? (
              task.ownerId !== me.id && (
                <button className="btn-ghost px-2 py-1 text-xs" onClick={() => run(() => api.leaveTask(task.id))}>
                  Sair
                </button>
              )
            ) : (
              <button className="btn-outline px-2 py-1 text-xs" onClick={() => run(() => api.joinTask(task.id))}>
                Entrar para ajudar
              </button>
            )}
          </div>
          {task.participantIds.length === 0 ? (
            <p className="text-sm text-zinc-500">Ninguém ainda.</p>
          ) : (
            <ul className="flex flex-wrap gap-3">
              {task.participantIds.map((id) => (
                <li key={id} className="flex items-center gap-2 text-sm">
                  <Avatar user={users[id]} size="sm" online={online.includes(id)} />
                  <span>{users[id]?.name ?? 'Usuário'}</span>
                  {id === task.ownerId && <span className="text-xs text-brand-400">responsável</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <AgentsSection taskId={task.id} taskDone={task.status === 'done'} />

        <section>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase">Descrição</h3>
          <textarea
            className="input min-h-28 resize-y"
            placeholder="Contexto, critérios de pronto, links…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => description !== task.description && run(() => api.updateTask(task.id, { description }))}
          />
        </section>

        <section>
          <h3 className="mb-3 text-xs font-semibold tracking-wide text-zinc-400 uppercase">Histórico</h3>
          <Timeline taskId={task.id} />
        </section>
      </div>

      {error && <div className="border-t border-rose-900 bg-rose-950 px-5 py-2 text-sm text-rose-300">{error}</div>}
      <form onSubmit={sendComment} className="flex gap-2 border-t border-zinc-800 px-5 py-3">
        <textarea
          className="input max-h-40 min-h-10 flex-1 resize-none"
          rows={1}
          placeholder="Escreva para a equipe…"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void sendComment(e)
            }
          }}
        />
        <button className="btn-primary" disabled={!comment.trim()}>
          Enviar
        </button>
      </form>
    </aside>
  )
}
