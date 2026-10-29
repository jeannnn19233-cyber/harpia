import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { ChangedFile, PullRequest, Task } from '../../../../shared/types.ts'
import { api } from '../../lib/api.ts'
import { timeAgo } from '../../lib/format.ts'
import { useHarpia } from '../../lib/store.ts'
import { Avatar } from '../Avatar.tsx'
import { Dialog } from '../Dialogs.tsx'

export const PULL_STATE_STYLE: Record<PullRequest['state'], { label: string; className: string }> = {
  open: { label: 'Aberto', className: 'border-sky-700 text-sky-300' },
  merged: { label: 'Merge feito', className: 'border-violet-700 text-violet-300' },
  closed: { label: 'Fechado', className: 'border-zinc-700 text-zinc-400' }
}

const FILE_STATUS: Record<ChangedFile['status'], { label: string; className: string }> = {
  A: { label: 'novo', className: 'text-emerald-400' },
  M: { label: 'alterado', className: 'text-sky-400' },
  D: { label: 'apagado', className: 'text-rose-400' },
  '?': { label: 'novo', className: 'text-emerald-400' }
}

// Confere as alterações e abre (ou atualiza) o PR da pessoa.
function DeliverDialog({ task, existing, onClose }: { task: Task; existing: PullRequest | null; onClose: () => void }) {
  const upsertPulls = useHarpia((state) => state.upsertPulls)
  const [changes, setChanges] = useState<Awaited<ReturnType<typeof api.taskChanges>> | null>(null)
  const [title, setTitle] = useState(`T-${task.number}: ${task.title}`)
  const [body, setBody] = useState(task.description)
  const [commitMessage, setCommitMessage] = useState(`T-${task.number}: ${task.title}`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .taskChanges(task.id)
      .then(setChanges)
      .catch((err: Error) => setError(err.message))
  }, [task.id])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { pullRequest } = await api.openPull(task.id, { title, body, commitMessage })
      upsertPulls([pullRequest])
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Dialog title={existing ? `Enviar alterações para o PR #${existing.number}` : 'Abrir pull request'} onClose={onClose} wide>
      {!changes && !error && <p className="text-sm text-zinc-500">Lendo suas alterações…</p>}
      {changes && !changes.hasWorktree && (
        <p className="text-sm text-zinc-400">
          Você ainda não tem uma cópia do código nesta task. Abra uma conversa com o agente ou o terminal primeiro.
        </p>
      )}
      {changes?.hasWorktree && (
        <form onSubmit={submit} className="space-y-4">
          <div>
            <p className="mb-2 text-sm text-zinc-400">
              Branch <span className="font-mono text-zinc-300">{changes.branch}</span> ·{' '}
              {changes.files.length === 0
                ? 'nenhuma alteração em relação à branch principal'
                : `${changes.files.length} ${changes.files.length === 1 ? 'arquivo alterado' : 'arquivos alterados'}`}
            </p>
            {changes.files.length > 0 && (
              <ul className="max-h-48 overflow-y-auto rounded-lg border border-zinc-800 font-mono text-xs">
                {changes.files.map((file) => (
                  <li key={file.path} className="flex items-center gap-3 border-b border-zinc-900 px-3 py-1.5 last:border-0">
                    <span className={`w-14 shrink-0 ${FILE_STATUS[file.status].className}`}>{FILE_STATUS[file.status].label}</span>
                    <span className="min-w-0 flex-1 truncate text-zinc-300">{file.path}</span>
                    {file.additions !== null && <span className="text-emerald-400">+{file.additions}</span>}
                    {file.deletions !== null && <span className="text-rose-400">−{file.deletions}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {changes.uncommitted && (
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-400">Há alterações sem commit. Mensagem do commit:</span>
              <input className="input font-mono" value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} required />
            </label>
          )}
          {!existing && (
            <>
              <label className="block">
                <span className="mb-1 block text-xs text-zinc-400">Título do PR</span>
                <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-zinc-400">Descrição</span>
                <textarea className="input min-h-28" value={body} onChange={(e) => setBody(e.target.value)} />
              </label>
            </>
          )}
          {error && <p className="text-sm text-rose-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancelar
            </button>
            <button className="btn-primary" disabled={busy || changes.files.length === 0}>
              {busy ? 'Enviando…' : existing ? 'Enviar alterações' : 'Abrir PR no GitHub'}
            </button>
          </div>
        </form>
      )}
      {error && !changes?.hasWorktree && <p className="mt-3 text-sm text-rose-400">{error}</p>}
    </Dialog>
  )
}

// Seção "Entrega" no painel da task: os PRs de cada pessoa e o botão para abrir o seu.
export function DeliverySection({ task }: { task: Task }) {
  const { me, users, agentsStatus, upsertPulls } = useHarpia()
  const allPulls = useHarpia((state) => state.pulls)
  const [dialog, setDialog] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const pulls = useMemo(
    () => Object.values(allPulls).filter((pull) => pull.taskId === task.id).sort((a, b) => a.id - b.id),
    [allPulls, task.id]
  )
  const mine = pulls.find((pull) => pull.userId === me?.id && pull.state === 'open') ?? null

  useEffect(() => {
    api
      .taskPulls(task.id)
      .then(({ pullRequests }) => upsertPulls(pullRequests))
      .catch(() => undefined)
  }, [task.id, upsertPulls])

  const refresh = async () => {
    setChecking(true)
    try {
      upsertPulls((await api.refreshPulls(task.id)).pullRequests)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setChecking(false)
    }
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">Entrega</h3>
        {pulls.some((pull) => pull.state === 'open') && (
          <button className="btn-ghost px-2 py-1 text-xs" disabled={checking} onClick={() => void refresh()}>
            {checking ? 'Verificando…' : 'Verificar merge'}
          </button>
        )}
      </div>
      {pulls.length === 0 && <p className="mb-2 text-sm text-zinc-500">Nenhum pull request ainda.</p>}
      <ul className="mb-2 space-y-1.5">
        {pulls.map((pull) => (
          <li key={pull.id} className="flex items-center gap-2 text-sm">
            <Avatar user={users[pull.userId]} size="sm" />
            <a href={pull.url} target="_blank" rel="noreferrer" className="font-mono text-brand-400 hover:underline">
              #{pull.number}
            </a>
            <span className={`rounded-full border px-2 py-0.5 text-xs ${PULL_STATE_STYLE[pull.state].className}`}>
              {PULL_STATE_STYLE[pull.state].label}
            </span>
            <span className="ml-auto text-xs text-zinc-500">{timeAgo(pull.updatedAt)}</span>
          </li>
        ))}
      </ul>
      {agentsStatus?.enabled && task.status !== 'done' && (
        <button className="btn-outline w-full py-1.5 text-sm" onClick={() => setDialog(true)}>
          {mine ? `Enviar alterações para o PR #${mine.number}` : 'Abrir PR com minhas alterações'}
        </button>
      )}
      {pulls.some((pull) => pull.state === 'open') && (
        <p className="mt-2 text-xs text-zinc-500">A task vai para "Feito" sozinha quando todos os PRs tiverem merge.</p>
      )}
      {error && <p className="mt-2 text-sm text-rose-400">{error}</p>}
      {dialog && <DeliverDialog task={task} existing={mine} onClose={() => setDialog(false)} />}
    </section>
  )
}
