import { useEffect, useState } from 'react'
import { api } from '../../lib/api.ts'
import { Icon } from '../Icon.tsx'

export function ChangesPanel({ taskId }: { taskId: number }) {
  const [changes, setChanges] = useState<Awaited<ReturnType<typeof api.taskChanges>> | null>(null),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(false)
  const refresh = () => {
    setLoading(true)
    setError(null)
    api
      .taskChanges(taskId)
      .then(setChanges)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    let current = true
    api
      .taskChanges(taskId)
      .then((value) => current && setChanges(value))
      .catch((err: Error) => current && setError(err.message))
    return () => {
      current = false
    }
  }, [taskId])
  const additions = changes?.files.reduce((sum, file) => sum + (file.additions ?? 0), 0) ?? 0
  const deletions = changes?.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0) ?? 0
  return (
    <div className="changes-panel">
      <header>
        <span>SUAS ALTERAÇÕES</span>
        <button className="btn-ghost" disabled={loading} onClick={refresh}>
          {loading ? 'Lendo…' : 'Atualizar'}
        </button>
      </header>
      {error ? (
        <p className="text-rose-400" role="alert">
          {error}
        </p>
      ) : !changes ? (
        <p>Lendo alterações…</p>
      ) : !changes.hasWorktree ? (
        <div className="changes-empty">
          <Icon name="branch" size={24} />
          <p>Abra uma sessão para criar sua cópia do código.</p>
        </div>
      ) : (
        <>
          <div className="changes-branch">
            <Icon name="branch" size={13} />
            <code>{changes.branch}</code>
          </div>
          <div className="changes-summary">
            <span>{changes.files.length} arquivos</span>
            <strong>+{additions}</strong>
            <em>−{deletions}</em>
          </div>
          <ul>
            {changes.files.map((file) => (
              <li key={file.path}>
                <span className={`change-kind ${file.status === 'D' ? 'deleted' : ''}`}>
                  {file.status === '?' ? 'A' : file.status}
                </span>
                <code title={file.path}>{file.path}</code>
                <small>
                  <b>+{file.additions ?? '—'}</b>
                  <i>−{file.deletions ?? '—'}</i>
                </small>
              </li>
            ))}
          </ul>
          {!changes.files.length && <p>Nenhuma alteração em relação à branch principal.</p>}
          <p className="changes-note">
            {changes.uncommitted ? 'Há alterações sem commit.' : 'As alterações estão versionadas.'} Revise e envie pelo
            painel de contexto, na seção Entrega.
          </p>
        </>
      )}
    </div>
  )
}
