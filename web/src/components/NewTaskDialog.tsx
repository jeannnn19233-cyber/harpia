import { useEffect, useState, type FormEvent } from 'react'
import type { SimilarTask, Task } from '../../../shared/types.ts'
import { api } from '../lib/api.ts'
import { useHarpia } from '../lib/store.ts'
import { Dialog } from './Dialogs.tsx'

export function NewTaskDialog({
  projectId,
  onClose,
  onCreated
}: {
  projectId: number
  onClose: () => void
  onCreated: (task: Task) => void
}) {
  const [title, setTitle] = useState(''),
    [description, setDescription] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [similar, setSimilar] = useState<SimilarTask[]>([])
  useEffect(() => {
    let current = true
    const timer = setTimeout(() => {
      if (title.trim().length < 4) {
        setSimilar([])
        return
      }
      api
        .similarTasks(projectId, title)
        .then((r) => current && setSimilar(r.tasks))
        .catch(() => current && setSimilar([]))
    }, 300)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [projectId, title])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    try {
      const { task } = await api.createTask(projectId, { title, description })
      useHarpia.getState().upsertTask(task)
      onCreated(task)
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return (
    <Dialog title="Nova tarefa" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <label className="studio-field">
          Título
          <input
            className="input"
            placeholder="O que vamos construir?"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label className="studio-field">
          Contexto
          <textarea
            className="input min-h-28"
            placeholder="Objetivo, requisitos e critérios de entrega…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {similar.length > 0 && (
          <div className="similar-tasks">
            <p>Já existe trabalho parecido:</p>
            {similar.map((task) => (
              <button
                type="button"
                key={task.id}
                onClick={() => {
                  useHarpia.getState().openTask(task.id)
                  onClose()
                }}
              >
                T-{task.number} · {task.title}
              </button>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-rose-400">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn-primary" disabled={!title.trim() || busy}>
            {busy ? 'Criando…' : 'Criar e abrir tarefa'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
