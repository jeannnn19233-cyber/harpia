import { useEffect, useState } from 'react'
import type { Project } from '../../../shared/types.ts'
import { api } from '../lib/api.ts'
import { startRealtime } from '../lib/realtime.ts'
import { useHarpia } from '../lib/store.ts'
import { AccountsDialog } from './AccountsDialog.tsx'
import { Avatar } from './Avatar.tsx'
import { Board } from './Board.tsx'
import { Dialog, ProjectForm, TeamDialog } from './Dialogs.tsx'
import { TaskWorkspace } from './task/TaskWorkspace.tsx'

function CloneBadge({ project }: { project: Project }) {
  const upsertProject = useHarpia((state) => state.upsertProject)
  if (project.cloneStatus === 'ready') return null
  if (project.cloneStatus === 'error') {
    return (
      <span className="flex items-center gap-2 text-xs text-rose-400" title={project.cloneError ?? ''}>
        Falha ao clonar o repositório
        <button
          className="btn-outline px-2 py-0.5 text-xs"
          onClick={() => void api.recloneProject(project.id).then(({ project }) => upsertProject(project))}
        >
          Tentar de novo
        </button>
      </span>
    )
  }
  return <span className="text-xs text-zinc-400">Clonando repositório…</span>
}

export function Workspace({ onLogout }: { onLogout: () => void }) {
  const { me, users, online, connected, projects, projectId, openTaskId, selectProject, setTasks, agentsStatus } = useHarpia()
  const [dialog, setDialog] = useState<'project' | 'team' | 'accounts' | null>(null)

  useEffect(() => startRealtime(), [])

  useEffect(() => {
    if (!projectId) return
    let current = true
    api
      .tasks(projectId)
      .then(({ tasks }) => current && setTasks(tasks))
      .then(() => api.projectPulls(projectId))
      .then((result) => current && result && useHarpia.getState().upsertPulls(result.pullRequests))
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [projectId, setTasks])

  const project = projects.find((item) => item.id === projectId) ?? null
  const onlineUsers = online.map((id) => users[id]).filter(Boolean)

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-4 py-2.5">
        <span className="text-lg font-bold tracking-tight text-brand-400">Harpia</span>
        {projects.length > 0 && (
          <select
            className="input w-auto py-1.5"
            value={projectId ?? ''}
            onChange={(e) => selectProject(Number(e.target.value))}
          >
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        )}
        <button className="btn-ghost py-1.5" onClick={() => setDialog('project')}>
          + Projeto
        </button>
        {project && <CloneBadge project={project} />}

        <div className="ml-auto flex items-center gap-3">
          {!connected && <span className="text-xs text-amber-400">Reconectando…</span>}
          <div className="flex -space-x-1.5" title="Online agora">
            {onlineUsers.map((user) => (
              <Avatar key={user.id} user={user} size="sm" online />
            ))}
          </div>
          {agentsStatus?.enabled && (
            <button className="btn-ghost py-1.5" onClick={() => setDialog('accounts')}>
              Minhas IAs
            </button>
          )}
          <button className="btn-ghost py-1.5" onClick={() => setDialog('team')}>
            Equipe
          </button>
          <span className="hidden text-sm text-zinc-400 sm:inline">{me?.name}</span>
          <button className="btn-ghost py-1.5" onClick={onLogout}>
            Sair
          </button>
        </div>
      </header>

      {project && openTaskId ? (
        <TaskWorkspace key={openTaskId} taskId={openTaskId} />
      ) : project ? (
        <Board projectId={project.id} />
      ) : (
        <div className="flex flex-1 items-start justify-center px-4 pt-20">
          <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900/60 p-6">
            <h2 className="mb-1 font-semibold">Crie o primeiro projeto</h2>
            <p className="mb-4 text-sm text-zinc-400">Um projeto é um repositório git em que a equipe trabalha junta.</p>
            <ProjectForm />
          </div>
        </div>
      )}

      {dialog === 'project' && (
        <Dialog title="Novo projeto" onClose={() => setDialog(null)}>
          <ProjectForm onCreated={() => setDialog(null)} />
        </Dialog>
      )}
      {dialog === 'team' && <TeamDialog onClose={() => setDialog(null)} />}
      {dialog === 'accounts' && <AccountsDialog onClose={() => setDialog(null)} />}

    </div>
  )
}
