import { useEffect, useMemo, useState } from 'react'
import { LEARNING_TARGET_LABELS, type Learning, type Task } from '../../../../shared/types.ts'
import { api } from '../../lib/api.ts'
import { useHarpia } from '../../lib/store.ts'
import { RichText } from '../task/RichText.tsx'

export function usePendingLearnings(projectId: number | null, taskId?: number): Learning[] {
  const learnings = useHarpia((state) => state.learnings)
  return useMemo(
    () =>
      Object.values(learnings)
        .filter((learning) => learning.status === 'pending' && learning.projectId === projectId && (taskId === undefined || learning.taskId === taskId))
        .sort((a, b) => a.id - b.id),
    [learnings, projectId, taskId]
  )
}

// Aprendizado sugerido pela IA: qualquer pessoa da equipe ajusta o texto e aprova, ou descarta.
export function LearningCard({ learning, showTask = false }: { learning: Learning; showTask?: boolean }) {
  const { users, tasks, upsertLearnings, openTask } = useHarpia()
  const [text, setText] = useState(learning.text)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const task = tasks[learning.taskId]

  const run = async (action: () => Promise<{ learning: Learning }>) => {
    setBusy(true)
    try {
      upsertLearnings([(await action()).learning])
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (learning.status !== 'pending') {
    return (
      <div className="rounded-lg border border-zinc-800 px-3 py-2 text-xs text-zinc-400">
        <span className={learning.status === 'applied' ? 'text-emerald-400' : 'text-zinc-500'}>
          {learning.status === 'applied' ? 'Aprovado' : 'Descartado'}
        </span>
        {learning.decidedBy && ` por ${users[learning.decidedBy]?.name.split(' ')[0] ?? 'alguém'}`}: {learning.text}
        {learning.prUrl && (
          <a href={learning.prUrl} target="_blank" rel="noreferrer" className="ml-1 text-brand-400 underline">
            ver PR
          </a>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-2 rounded-lg border border-sky-500/30 bg-sky-950/20 px-3 py-2.5 text-sm">
      <p className="text-xs text-sky-300">
        💡 Para o {LEARNING_TARGET_LABELS[learning.target]}
        {showTask && task && (
          <button className="ml-1 text-zinc-400 hover:underline" onClick={() => openTask(task.id)}>
            · T-{task.number} {task.title}
          </button>
        )}
      </p>
      {editing ? (
        <textarea className="input min-h-20 resize-y text-sm" value={text} onChange={(e) => setText(e.target.value)} />
      ) : (
        <p className="text-zinc-200">{text}</p>
      )}
      <p className="text-xs text-zinc-500">Por quê: {learning.reason}</p>
      {error && <p className="text-xs text-rose-300">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          className="btn-primary px-2 py-1 text-xs"
          disabled={busy || text.trim().length < 5}
          onClick={() => void run(() => api.applyLearning(learning.id, text.trim() !== learning.text ? text.trim() : undefined))}
          title={learning.target === 'agents_md' ? 'Abre um PR que acrescenta a regra ao AGENTS.md' : 'Acrescenta a regra à memória do projeto'}
        >
          {busy ? 'Aplicando…' : learning.target === 'agents_md' ? 'Aprovar e abrir PR' : 'Aprovar na memória'}
        </button>
        <button className="btn-ghost px-2 py-1 text-xs" disabled={busy} onClick={() => setEditing(!editing)}>
          {editing ? 'Pronto' : 'Editar'}
        </button>
        <button className="btn-ghost px-2 py-1 text-xs text-zinc-400" disabled={busy} onClick={() => void run(() => api.dismissLearning(learning.id))}>
          Descartar
        </button>
      </div>
    </div>
  )
}

// Na task concluída: o resumo escrito pela IA e os aprendizados sugeridos.
export function SummarySection({ task }: { task: Task }) {
  const { users, setSummary, upsertLearnings } = useHarpia()
  const summary = useHarpia((state) => state.summaries[task.id])
  const all = useHarpia((state) => state.learnings)
  const learnings = useMemo(() => Object.values(all).filter((learning) => learning.taskId === task.id).sort((a, b) => a.id - b.id), [all, task.id])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .taskInsights(task.id)
      .then((result) => {
        if (result.summary) setSummary(result.summary)
        upsertLearnings(result.learnings)
      })
      .catch(() => undefined)
  }, [task.id, task.status, setSummary, upsertLearnings])

  if (task.status !== 'done' && !summary) return null

  const request = async () => {
    try {
      const result = await api.summarizeTask(task.id)
      if (result.summary) setSummary(result.summary)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const author = summary?.userId ? users[summary.userId]?.name.split(' ')[0] : null
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">Resumo da task</h3>
        {task.status === 'done' && summary?.status !== 'running' && (
          <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => void request()} title="Escreve de novo, com o seu Claude">
            {summary ? 'Refazer' : 'Escrever resumo'}
          </button>
        )}
      </div>
      {!summary ? (
        <p className="text-xs text-zinc-500">O vigia escreve o resumo em alguns minutos, com o Claude de quem estava na task.</p>
      ) : summary.status === 'running' ? (
        <p className="flex items-center gap-2 text-xs text-zinc-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" /> O Claude de {author ?? 'alguém'} está escrevendo o resumo…
        </p>
      ) : summary.status === 'failed' ? (
        <p className="text-xs text-rose-300">Não deu para escrever o resumo: {summary.error}</p>
      ) : (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-zinc-200">
          <RichText text={summary.summary ?? ''} />
          <p className="mt-1 text-[11px] text-zinc-500">Escrito pelo Claude de {author ?? 'alguém'}</p>
        </div>
      )}
      {learnings.map((learning) => (
        <LearningCard key={learning.id} learning={learning} />
      ))}
      {error && <p className="text-xs text-rose-300">{error}</p>}
    </section>
  )
}
