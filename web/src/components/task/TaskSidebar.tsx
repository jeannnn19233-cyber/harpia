import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  AGENT_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  PR_QUEUE_LABELS,
  VERDICT_LABELS,
  type AgentSession,
  type PrQueue,
  type PrReviewVerdict,
  type TaskEvent,
  type TaskStatus,
  type User
} from '../../../../shared/types.ts'
import { CHAT_PROVIDER_LABELS, type ChatProvider } from '../../../../shared/types.ts'
import { api } from '../../lib/api.ts'
import { fullDate, timeAgo } from '../../lib/format.ts'
import { useHarpia } from '../../lib/store.ts'
import { Avatar } from '../Avatar.tsx'
import { DeliverySection } from './Delivery.tsx'
import { SummarySection } from '../insights/Insights.tsx'
import { FindingCard, useOpenFindings } from '../Watcher.tsx'

function describe(event: TaskEvent, users: Record<number, User>): string {
  const name = (id: unknown) => (typeof id === 'number' ? (users[id]?.name ?? 'alguém') : 'ninguém')
  const status = (value: unknown) => TASK_STATUS_LABELS[value as TaskStatus] ?? String(value)
  switch (event.type) {
    case 'created':
      return event.data.importedFrom ? `importou a task do quadro de origem (${event.data.importedFrom})` : 'criou a task'
    case 'edited': {
      const fields = (event.data.fields as string[] | undefined) ?? []
      const labels = fields.map((field) => (field === 'title' ? 'o título' : 'a descrição'))
      return `editou ${labels.join(' e ')}`
    }
    case 'watcher_notice':
      return `avisou: ${String(event.data.message)}`
    case 'pr_opened':
      return `abriu o PR #${event.data.number}`
    case 'pr_updated':
      return `enviou novas alterações para o PR #${event.data.number}`
    case 'pr_merged':
      return `o PR #${event.data.number} de ${name(event.data.userId)} teve merge`
    case 'pr_reviewed': {
      const counts = event.data.counts as { critical: number; warning: number } | null
      const verdict = VERDICT_LABELS[event.data.verdict as PrReviewVerdict] ?? 'comentários'
      const parts = counts
        ? [counts.critical && `${counts.critical} bloqueio(s)`, counts.warning && `${counts.warning} ponto(s) que não bloqueiam`].filter(Boolean)
        : []
      const queue = PR_QUEUE_LABELS[event.data.queue as PrQueue] ?? 'revisão'
      return `${queue} do PR #${event.data.number} pelo revisor de ${name(event.data.reviewerId)}: ${verdict}${parts.length ? ` (${parts.join(', ')})` : ''}`
    }
    case 'summarized': {
      const learnings = Number(event.data.learnings ?? 0)
      return `escreveu o resumo da task com o Claude de ${name(event.data.userId)}${learnings ? ` e sugeriu ${learnings} aprendizado(s)` : ''}`
    }
    case 'learning_applied':
      return event.data.prUrl
        ? `aprovou um aprendizado para o AGENTS.md (PR aberto): ${String(event.data.text)}`
        : `aprovou um aprendizado para a memória do projeto: ${String(event.data.text)}`
    case 'learning_dismissed':
      return `descartou o aprendizado: ${String(event.data.text)}`
    case 'pr_closed':
      return `o PR #${event.data.number} de ${name(event.data.userId)} foi fechado sem merge`
    case 'status_changed':
      if (event.data.reason === 'merged') return 'concluiu a task: todos os PRs tiveram merge'
      if (event.data.reason === 'pr_opened')
        return `moveu para ${status(event.data.to)} ao abrir o PR #${event.data.number}`
      if (event.data.reason === 'agent') return `começou a trabalhar: moveu para ${status(event.data.to)}`
      if (event.data.reason === 'import') return `moveu para ${status(event.data.to)} pela importação do quadro`
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
    case 'chat_started':
      return `abriu uma conversa com o ${CHAT_PROVIDER_LABELS[event.data.provider as ChatProvider] ?? 'agente'}`
    case 'agent_started':
      return `abriu ${AGENT_LABELS[event.data.kind as AgentSession['kind']] ?? 'um agente'}`
    case 'agent_stopped': {
      const label = AGENT_LABELS[event.data.kind as AgentSession['kind']] ?? 'agente'
      if (event.data.reason === 'ended') return `a sessão de ${label} de ${name(event.data.ownerId)} terminou`
      return event.data.ownerId === event.actorId
        ? `encerrou o ${label}`
        : `encerrou o ${label} de ${name(event.data.ownerId)}`
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
              {actor ? (
                <Avatar user={actor} size="sm" />
              ) : (
                <span
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-500 text-[10px] font-bold text-zinc-950"
                  title="Ação automática do Harpia"
                >
                  H
                </span>
              )}
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

// Coluna da direita: dados da task, equipe e histórico (com os comentários da equipe).
export function TaskSidebar({ taskId }: { taskId: number }) {
  const task = useHarpia((state) => state.tasks[taskId])
  const { me, users, online, upsertTask } = useHarpia()
  const [description, setDescription] = useState('')
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)
  const findings = useOpenFindings(task?.projectId ?? null, taskId)

  useEffect(() => {
    if (task) setDescription(task.description)
  }, [task?.description])

  // Um erro antigo (ex.: "a task tem PR aberto") perde o sentido quando o status muda.
  useEffect(() => setError(null), [task?.status])

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
    <aside className="studio-task-details flex min-h-0 flex-col border-l border-zinc-800 bg-zinc-950">
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <div className="grid grid-cols-1 gap-2">
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">Status</span>
            <select
              className="input py-1.5"
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
              className="input py-1.5"
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
            <ul className="space-y-1.5">
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

        {findings.length > 0 && (
          <section>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-amber-400 uppercase">Avisos do vigia</h3>
            <div className="space-y-2">
              {findings.map((finding) => (
                <FindingCard key={finding.id} finding={finding} compact />
              ))}
            </div>
          </section>
        )}

        <SummarySection task={task} />

        <DeliverySection task={task} />

        <section>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase">Descrição</h3>
          <textarea
            className="input min-h-24 resize-y"
            placeholder="Contexto, critérios de pronto, links…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => description !== task.description && run(() => api.updateTask(task.id, { description }))}
          />
        </section>

        <section>
          <h3 className="mb-3 text-xs font-semibold tracking-wide text-zinc-400 uppercase">Histórico da equipe</h3>
          <Timeline taskId={task.id} />
        </section>
      </div>

      {error && <div className="border-t border-rose-900 bg-rose-950 px-4 py-2 text-sm text-rose-300">{error}</div>}
      <form onSubmit={sendComment} className="flex gap-2 border-t border-zinc-800 px-4 py-3">
        <textarea
          className="input max-h-32 min-h-10 flex-1 resize-none"
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
        <button className="btn-outline" disabled={!comment.trim()}>
          Enviar
        </button>
      </form>
    </aside>
  )
}
