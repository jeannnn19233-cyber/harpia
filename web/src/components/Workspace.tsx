import { useEffect, useMemo, useRef, useState } from 'react'
import { TASK_STATUSES, TASK_STATUS_LABELS, type Task } from '../../../shared/types.ts'
import { api } from '../lib/api.ts'
import { startRealtime } from '../lib/realtime.ts'
import { useHarpia } from '../lib/store.ts'
import { AccountsDialog } from './AccountsDialog.tsx'
import { AgentDialog } from './AgentDialog.tsx'
import { Avatar } from './Avatar.tsx'
import { Board } from './Board.tsx'
import { Conversations } from './chat/Conversations.tsx'
import { Dialog, ProjectForm, TeamDialog } from './Dialogs.tsx'
import { Icon } from './Icon.tsx'
import { usePendingLearnings } from './insights/Insights.tsx'
import { MonitorDialog } from './monitors/MonitorDialog.tsx'
import { NewTaskDialog } from './NewTaskDialog.tsx'
import { ResizeHandle, savedSize, rememberSize } from './ResizeHandle.tsx'
import { ReviewsDialog } from './reviews/ReviewsDialog.tsx'
import { Routines } from './routines/Routines.tsx'
import { MemoryDialog, useOpenFindings, WatcherDialog } from './Watcher.tsx'
import { TaskWorkspace } from './task/TaskWorkspace.tsx'

function lastTask(projectId: number): number | null {
  try {
    return Number(localStorage.getItem(`harpia.studio.task.${projectId}`)) || null
  } catch {
    return null
  }
}

export function Workspace({ onLogout }: { onLogout: () => void }) {
  const {
    me,
    users,
    online,
    connected,
    projects,
    projectId,
    openTaskId,
    selectProject,
    setTasks,
    agentsStatus,
    openTask,
    tasks,
    chats,
    view,
    setView
  } = useHarpia()
  const [dialog, setDialog] = useState<
    'project' | 'team' | 'accounts' | 'watcher' | 'memory' | 'newTask' | 'search' | 'reviews' | 'monitor' | 'agent' | null
  >(null)
  const [query, setQuery] = useState(''),
    [explorerOpen, setExplorerOpen] = useState(true),
    [mobileExplorer, setMobileExplorer] = useState(false)
  const [explorerWidth, setExplorerWidth] = useState(() => savedSize('harpia.studio.explorer', 250, 210, 360))
  const [tabs, setTabs] = useState<number[]>([]),
    [loadError, setLoadError] = useState<string | null>(null)
  const initialized = useRef<number | null>(null)
  const findings = useOpenFindings(projectId)
  const pendingLearnings = usePendingLearnings(projectId)
  const monitor = useHarpia((state) => (projectId ? state.monitors[projectId] : undefined))
  const monitorProblem = monitor?.enabled && monitor.panorama.some((item) => item.problem)
  const project = projects.find((project) => project.id === projectId)
  const taskList = useMemo(
    () =>
      Object.values(tasks)
        .filter((task) => task.projectId === projectId)
        .sort((a, b) => b.number - a.number),
    [tasks, projectId]
  )
  const visible = taskList.filter((task) =>
    `${task.title} T-${task.number}`.toLocaleLowerCase('pt-BR').includes(query.toLocaleLowerCase('pt-BR'))
  )
  const activeChats = Object.values(chats).filter(
    (chat) => chat.taskId && tasks[chat.taskId] && chat.status !== 'closed'
  )
  const working = activeChats.filter((chat) => chat.status === 'working').length
  const waiting = activeChats.filter((chat) => chat.status === 'waiting').length
  const choose = (id: number) => {
    setView('board')
    openTask(id)
    setMobileExplorer(false)
  }
  const showBoard = () => {
    setView('board')
    openTask(null)
  }
  useEffect(() => startRealtime(), [])
  useEffect(() => {
    if (!projectId) return
    let current = true
    setLoadError(null)
    // Os vigias do Coolify são opcionais: se falharem, o resto do projeto carrega igual.
    api
      .monitor(projectId)
      .then((result) => current && useHarpia.getState().setMonitor(result.monitor, result.events))
      .catch(() => undefined)
    Promise.all([api.tasks(projectId), api.projectPulls(projectId), api.findings(projectId)])
      .then(([taskResult, pulls, findings]) => {
        if (!current) return
        setTasks(taskResult.tasks)
        useHarpia.getState().upsertPulls(pulls.pullRequests)
        useHarpia.getState().upsertFindings(findings.findings)
        if (initialized.current !== projectId) {
          initialized.current = projectId
          setTabs([])
          const remembered = lastTask(projectId)
          const next =
            taskResult.tasks.find((task) => task.id === remembered) ??
            taskResult.tasks.find((task) => task.ownerId === me?.id && task.status === 'in_progress') ??
            taskResult.tasks.find((task) => task.status === 'in_progress') ??
            taskResult.tasks.find((task) => task.status !== 'done')
          if (next) openTask(next.id)
        }
      })
      .catch((err: Error) => current && setLoadError(err.message))
    return () => {
      current = false
    }
  }, [projectId, setTasks, openTask, me?.id])
  useEffect(() => {
    if (!openTaskId || !tasks[openTaskId]) return
    setTabs((current) => (current.includes(openTaskId) ? current : [...current, openTaskId]))
    if (projectId)
      try {
        localStorage.setItem(`harpia.studio.task.${projectId}`, String(openTaskId))
      } catch {
        /* A sessão continua. */
      }
  }, [openTaskId, tasks, projectId])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setDialog((current) => (current === 'search' ? null : 'search'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const closeTab = (id: number) => {
    const next = tabs.filter((tab) => tab !== id)
    setTabs(next)
    if (openTaskId === id) openTask(next.at(-1) ?? null)
  }
  const changeProject = (id: number) => {
    initialized.current = null
    setTabs([])
    setQuery('')
    selectProject(id)
  }
  const addTask = (task: Task) => choose(task.id)
  return (
    <div className="studio-shell">
      <header className="studio-titlebar">
        <div className="studio-product">
          <img src="/brand/harpia-amazonia.png" alt="" />
          <strong>Harpia</strong>
          <span className="product-divider" /> <span>Workspace de agentes</span>
        </div>
        <button className="command-trigger" onClick={() => setDialog('search')}>
          <Icon name="search" size={14} />
          <span>Buscar tarefa ou projeto</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="titlebar-presence">
          <span className={`connection-led ${connected ? 'connected' : ''}`} />
          <span>{connected ? 'Conectado' : 'Reconectando'}</span>
          <div className="presence-stack">
            {online.slice(0, 3).map((id) => (
              <Avatar key={id} user={users[id]} size="sm" />
            ))}
          </div>
        </div>
      </header>
      <div className="studio-body">
        <nav className="activity-rail" aria-label="Ferramentas do workspace">
          <button
            aria-label="Mostrar explorador"
            title="Explorador de tarefas"
            className={explorerOpen ? 'active' : ''}
            onClick={() => {
              setExplorerOpen(!explorerOpen)
              setMobileExplorer(!mobileExplorer)
            }}
          >
            <Icon name="folder" size={21} />
          </button>
          <button
            aria-label="Abrir quadro de tarefas"
            title="Quadro de tarefas"
            className={view === 'board' && !openTaskId ? 'active' : ''}
            onClick={showBoard}
          >
            <Icon name="board" size={21} />
          </button>
          <button
            aria-label="Abrir conversas"
            title="Conversas fora das tarefas"
            className={view === 'chats' ? 'active' : ''}
            onClick={() => setView('chats')}
          >
            <Icon name="chat" size={21} />
          </button>
          <button
            aria-label="Abrir rotinas"
            title="Rotinas agendadas"
            className={view === 'routines' ? 'active' : ''}
            onClick={() => setView('routines')}
          >
            <Icon name="clock" size={21} />
          </button>
          <button
            aria-label="Abrir Vigia"
            title="Vigia"
            disabled={!projectId}
            className={findings.length || pendingLearnings.length ? 'has-notice' : ''}
            onClick={() => setDialog('watcher')}
          >
            <Icon name="spark" size={21} />
            {findings.length + pendingLearnings.length > 0 && <i>{findings.length + pendingLearnings.length}</i>}
          </button>
          <button
            aria-label="Abrir revisão de PRs"
            title={project?.prReview ? 'Revisão de PRs (ligada)' : 'Revisão de PRs'}
            disabled={!projectId}
            onClick={() => setDialog('reviews')}
          >
            <Icon name="review" size={21} />
            {project?.prReview && <b className="rail-dot ok" />}
          </button>
          <button
            aria-label="Abrir vigias do deploy"
            title="Vigias do deploy e das tarefas agendadas no Coolify"
            disabled={!projectId}
            className={monitorProblem ? 'has-notice' : ''}
            onClick={() => setDialog('monitor')}
          >
            <Icon name="deploy" size={21} />
            {monitor?.enabled && <b className={`rail-dot ${monitorProblem ? 'problem' : 'ok'}`} />}
          </button>
          <button
            aria-label="Abrir memória do projeto"
            title="Memória do projeto"
            disabled={!projectId}
            onClick={() => setDialog('memory')}
          >
            <Icon name="leaf" size={21} />
          </button>
          <div className="rail-bottom">
            <button
              aria-label="Meu agente"
              title="Seu agente pessoal no Telegram, com o cofre do Obsidian"
              disabled={!agentsStatus?.enabled}
              onClick={() => setDialog('agent')}
            >
              <Icon name="send" size={19} />
            </button>
            <button
              aria-label="Minhas IAs"
              title="Contas de IA"
              disabled={!agentsStatus?.enabled}
              onClick={() => setDialog('accounts')}
            >
              <Icon name="terminal" size={20} />
            </button>
            <button aria-label="Equipe" title="Equipe" onClick={() => setDialog('team')}>
              <Icon name="team" size={20} />
            </button>
            <button aria-label="Sair da conta" title="Sair da conta" onClick={onLogout}>
              <Avatar user={me ?? undefined} size="sm" />
            </button>
          </div>
        </nav>
        {mobileExplorer && (
          <button className="explorer-scrim" aria-label="Fechar explorador" onClick={() => setMobileExplorer(false)} />
        )}
        <aside
          className={`project-explorer ${explorerOpen ? '' : 'collapsed'} ${mobileExplorer ? 'mobile-open' : ''}`}
          style={{ width: explorerWidth }}
          aria-label="Projetos e tarefas"
        >
          <div className="explorer-project">
            <span className="project-letter">{project?.name.charAt(0).toUpperCase() ?? 'H'}</span>
            <select
              aria-label="Projeto ativo"
              value={projectId ?? ''}
              onChange={(event) => changeProject(Number(event.target.value))}
            >
              {!projects.length && <option value="">Sem projeto</option>}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <button title="Novo projeto" aria-label="Novo projeto" onClick={() => setDialog('project')}>
              <Icon name="plus" size={15} />
            </button>
          </div>
          <div className="explorer-repo">
            <Icon name="branch" size={12} />
            <span>{project?.defaultBranch ?? 'main'}</span>
            <span className="repo-state">
              {project?.cloneStatus === 'ready'
                ? 'Sincronizado'
                : project?.cloneStatus === 'error'
                  ? 'Falha na conexão'
                  : project
                    ? 'Conectando…'
                    : 'Sem repositório'}
            </span>
          </div>
          <div className="explorer-heading">
            <span>TAREFAS</span>
            <span>{taskList.length}</span>
            <button
              aria-label="Nova tarefa"
              title="Nova tarefa"
              disabled={!projectId}
              onClick={() => setDialog('newTask')}
            >
              <Icon name="plus" size={15} />
            </button>
          </div>
          <label className="explorer-search">
            <Icon name="search" size={13} />
            <input
              aria-label="Filtrar tarefas"
              placeholder="Filtrar tarefas…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="explorer-tasks">
            {TASK_STATUSES.map((status) => {
              const group = visible.filter((task) => task.status === status)
              if (!group.length) return null
              return (
                <section key={status}>
                  <h2>
                    <i className={`task-status ${status}`} />
                    {TASK_STATUS_LABELS[status]}
                    <span>{group.length}</span>
                  </h2>
                  {group.map((task) => (
                    <button
                      key={task.id}
                      className={`explorer-task ${openTaskId === task.id ? 'selected' : ''}`}
                      onClick={() => choose(task.id)}
                      title={task.title}
                    >
                      <span className="task-reference">T-{task.number}</span>
                      <span className="explorer-task-title">{task.title}</span>
                      {Object.values(chats).some((chat) => chat.taskId === task.id && chat.status === 'waiting') ? (
                        <i className="mini-state waiting" />
                      ) : Object.values(chats).some((chat) => chat.taskId === task.id && chat.status === 'working') ? (
                        <i className="mini-state working" />
                      ) : null}
                    </button>
                  ))}
                </section>
              )
            })}
            {!visible.length && (
              <p className="explorer-empty">{query ? 'Nenhuma tarefa encontrada.' : 'Crie uma tarefa para começar.'}</p>
            )}
          </div>
          <div className="explorer-sessions">
            <div className="explorer-heading">
              <span>SESSÕES ATIVAS</span>
              <span>{activeChats.length}</span>
            </div>
            {activeChats.slice(0, 3).map((chat) => (
              <button key={chat.id} onClick={() => chat.taskId && choose(chat.taskId)}>
                <span className={`provider-symbol ${chat.provider}`}>{chat.provider === 'claude' ? '✳' : '⌘'}</span>
                <span>
                  {users[chat.userId]?.name.split(' ')[0] ?? 'Membro'}
                  <small>
                    {chat.provider === 'claude' ? 'Claude' : 'Codex'} ·{' '}
                    {chat.status === 'working'
                      ? 'executando'
                      : chat.status === 'waiting'
                        ? 'aguarda aprovação'
                        : 'pronto'}
                  </small>
                </span>
                <i className={`mini-state ${chat.status}`} />
              </button>
            ))}
            {!activeChats.length && <p>Nenhuma sessão iniciada.</p>}
          </div>
          <button className="explorer-account" onClick={() => setDialog('accounts')} disabled={!agentsStatus?.enabled}>
            <Icon name="terminal" size={15} />
            <span>Conectar minhas IAs</span>
            <Icon name="chevron" size={12} />
          </button>
        </aside>
        {explorerOpen && (
          <ResizeHandle
            label="Largura do explorador"
            value={explorerWidth}
            min={210}
            max={360}
            onResize={(value) => {
              setExplorerWidth(value)
              rememberSize('harpia.studio.explorer', value)
            }}
          />
        )}
        <div className="studio-workbench">
          <div className="work-tabs" role="tablist" aria-label="Tarefas abertas">
            <button
              role="tab"
              aria-selected={view === 'board' && !openTaskId}
              className={view === 'board' && !openTaskId ? 'selected' : ''}
              onClick={showBoard}
            >
              <Icon name="board" size={13} />
              <span>Quadro</span>
            </button>
            {tabs
              .filter((id) => tasks[id]?.projectId === projectId)
              .map((id) => (
                <div className={`work-tab ${view === 'board' && openTaskId === id ? 'selected' : ''}`} key={id}>
                  <button role="tab" aria-selected={view === 'board' && openTaskId === id} onClick={() => choose(id)}>
                    <i className={`task-status ${tasks[id].status}`} />
                    <span>T-{tasks[id].number}</span>
                    <strong>{tasks[id].title}</strong>
                  </button>
                  <button
                    className="close-tab"
                    aria-label={`Fechar aba T-${tasks[id].number}`}
                    onClick={() => closeTab(id)}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              ))}
            <button
              className="add-work-tab"
              aria-label="Criar tarefa"
              disabled={!projectId}
              onClick={() => setDialog('newTask')}
            >
              <Icon name="plus" size={15} />
            </button>
          </div>
          {loadError && (
            <p className="studio-error" role="alert">
              {loadError}
              <button onClick={() => location.reload()}>Recarregar</button>
            </p>
          )}
          {project?.cloneStatus === 'error' && (
            <div className="studio-error">
              O repositório não foi conectado.
              <button
                onClick={() =>
                  void api.recloneProject(project.id).then(({ project }) => useHarpia.getState().upsertProject(project))
                }
              >
                Tentar novamente
              </button>
            </div>
          )}
          {view === 'chats' ? (
            <Conversations />
          ) : view === 'routines' ? (
            <Routines />
          ) : projectId && openTaskId ? (
            <TaskWorkspace key={openTaskId} taskId={openTaskId} />
          ) : projectId ? (
            <div className="studio-board">
              <header>
                <div>
                  <Icon name="board" size={18} />
                  <h1>Quadro de tarefas</h1>
                  <span>{project?.name}</span>
                </div>
                <button className="btn-primary" onClick={() => setDialog('newTask')}>
                  <Icon name="plus" size={14} />
                  Nova tarefa
                </button>
              </header>
              <Board projectId={projectId} />
            </div>
          ) : (
            <main className="studio-empty">
              <Icon name="folder" size={30} />
              <h1>Conecte seu projeto</h1>
              <p>Abra um repositório para trabalhar com sua equipe e seus agentes.</p>
              <button className="btn-primary" onClick={() => setDialog('project')}>
                Adicionar projeto
              </button>
            </main>
          )}
        </div>
      </div>
      <footer className="studio-statusbar">
        <span>
          <i className={`connection-led ${connected ? 'connected' : ''}`} />
          {connected ? 'Servidor conectado' : 'Reconectando'}
        </span>
        <span>
          <Icon name="branch" size={12} />
          {project?.defaultBranch ?? 'Sem projeto'}
        </span>
        <span className="statusbar-agents">
          {working} em execução
          {waiting > 0 && (
            <>
              {' '}
              · <strong>{waiting} aguardando aprovação</strong>
            </>
          )}
        </span>
        <button onClick={() => setDialog('watcher')} disabled={!projectId}>
          <Icon name="spark" size={12} />
          {findings.length ? `${findings.length} avisos do Vigia` : 'Vigia'}
          {pendingLearnings.length > 0 && ` · ${pendingLearnings.length} aprendizados`}
        </button>
        <span className="statusbar-user">{me?.name}</span>
      </footer>
      {dialog === 'project' && (
        <Dialog title="Novo projeto" onClose={() => setDialog(null)}>
          <ProjectForm onCreated={() => setDialog(null)} />
        </Dialog>
      )}
      {dialog === 'newTask' && projectId && (
        <NewTaskDialog projectId={projectId} onClose={() => setDialog(null)} onCreated={addTask} />
      )}
      {dialog === 'team' && <TeamDialog onClose={() => setDialog(null)} />}{' '}
      {dialog === 'accounts' && <AccountsDialog onClose={() => setDialog(null)} />}{' '}
      {dialog === 'watcher' && projectId && <WatcherDialog projectId={projectId} onClose={() => setDialog(null)} />}{' '}
      {dialog === 'memory' && projectId && <MemoryDialog projectId={projectId} onClose={() => setDialog(null)} />}
      {dialog === 'agent' && <AgentDialog onClose={() => setDialog(null)} />}
      {dialog === 'monitor' && projectId && <MonitorDialog projectId={projectId} onClose={() => setDialog(null)} />}
      {dialog === 'reviews' && projectId && <ReviewsDialog projectId={projectId} onClose={() => setDialog(null)} />}
      {dialog === 'search' && (
        <Dialog title="Ir para…" onClose={() => setDialog(null)}>
          <input
            className="input command-input"
            placeholder="Buscar tarefa ou projeto…"
            aria-label="Buscar tarefa ou projeto"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
          <div className="command-results">
            {projects
              .filter((project) => project.name.toLowerCase().includes(query.toLowerCase()))
              .map((project) => (
                <button
                  key={`p${project.id}`}
                  onClick={() => {
                    changeProject(project.id)
                    setDialog(null)
                  }}
                >
                  <Icon name="folder" size={15} />
                  <span>{project.name}</span>
                  <small>Projeto</small>
                </button>
              ))}
            {visible.map((task) => (
              <button
                key={task.id}
                onClick={() => {
                  choose(task.id)
                  setDialog(null)
                  setQuery('')
                }}
              >
                <span>T-{task.number}</span>
                <strong>{task.title}</strong>
                <Icon name="arrow" size={13} />
              </button>
            ))}
            {!visible.length &&
              !projects.some((project) => project.name.toLowerCase().includes(query.toLowerCase())) && (
                <p>Nenhum resultado.</p>
              )}
          </div>
        </Dialog>
      )}
    </div>
  )
}
