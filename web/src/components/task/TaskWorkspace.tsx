import { useEffect, useMemo, useState } from 'react'
import { CHAT_PROVIDER_LABELS, TASK_STATUS_LABELS, type ChatProvider } from '../../../../shared/types.ts'
import { api } from '../../lib/api.ts'
import { useHarpia } from '../../lib/store.ts'
import { Icon } from '../Icon.tsx'
import { ResizeHandle, savedSize, rememberSize } from '../ResizeHandle.tsx'
import { ChatList } from './ChatList.tsx'
import { ChatView } from './ChatView.tsx'
import { ChangesPanel } from './ChangesPanel.tsx'
import { TaskSidebar } from './TaskSidebar.tsx'
import { TerminalDock } from './TerminalDock.tsx'

function storedChat(taskId: number) {
  try {
    return Number(localStorage.getItem(`harpia.studio.chat.${taskId}`)) || null
  } catch {
    return null
  }
}
export function TaskWorkspace({ taskId }: { taskId: number }) {
  const { me, users, agentsStatus, upsertTask, setEvents, upsertChats } = useHarpia()
  const task = useHarpia((state) => state.tasks[taskId]),
    allChats = useHarpia((state) => state.chats)
  const [selectedId, setSelectedId] = useState<number | null>(null),
    [creating, setCreating] = useState<ChatProvider | null>(null),
    [error, setError] = useState<string | null>(null),
    [title, setTitle] = useState('')
  const [sessionPicker, setSessionPicker] = useState(false),
    [inspector, setInspector] = useState(() => window.innerWidth >= 980),
    [inspectorTab, setInspectorTab] = useState<'context' | 'changes'>('context')
  const [inspectorWidth, setInspectorWidth] = useState(() => savedSize('harpia.studio.inspector', 300, 250, 440))
  const chats = useMemo(
    () =>
      Object.values(allChats)
        .filter((chat) => chat.taskId === taskId)
        .sort((a, b) => a.id - b.id),
    [allChats, taskId]
  )
  useEffect(() => {
    let current = true
    api
      .task(taskId)
      .then((detail) => {
        if (!current) return
        upsertTask(detail.task)
        setEvents(taskId, detail.events)
      })
      .catch((err: Error) => current && setError(err.message))
    api
      .taskChats(taskId)
      .then(({ chats }) => {
        if (!current) return
        upsertChats(chats)
        const remembered = storedChat(taskId)
        const active = chats.filter((chat) => chat.status !== 'closed')
        const initial =
          chats.find((chat) => chat.id === remembered) ??
          active.filter((chat) => chat.userId === me?.id).at(-1) ??
          active.at(-1)
        if (initial) setSelectedId((current) => current ?? initial.id)
      })
      .catch((err: Error) => current && setError(err.message))
    return () => {
      current = false
    }
  }, [taskId, me?.id, upsertTask, setEvents, upsertChats])
  useEffect(() => {
    if (task) setTitle(task.title)
  }, [task?.title])
  const selectChat = (id: number) => {
    setSelectedId(id)
    setSessionPicker(false)
    try {
      localStorage.setItem(`harpia.studio.chat.${taskId}`, String(id))
    } catch {
      /* Continua sem persistência. */
    }
  }
  if (!task) return <div className="studio-empty">Carregando tarefa…</div>
  const disabledReason =
    task.status === 'done'
      ? 'Reabra a tarefa para iniciar outra sessão.'
      : agentsStatus && !agentsStatus.enabled
        ? agentsStatus.reason
        : null
  const create = async (provider: ChatProvider) => {
    setCreating(provider)
    try {
      const { chat } = await api.createChat(task.id, provider, 'ask')
      upsertChats([chat])
      selectChat(chat.id)
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
  const visibleChats = chats.filter((chat) => chat.status !== 'closed' || chat.id === selectedId)
  return (
    <section className="task-studio">
      <header className="task-pathbar">
        <span className="task-number">T-{task.number}</span>
        <input
          aria-label="Título da tarefa"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void saveTitle()}
          onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
        />
        <span className={`studio-status ${task.status}`}>
          <i className={`task-status ${task.status}`} />
          {TASK_STATUS_LABELS[task.status]}
        </span>
        <button
          className={sessionPicker ? 'selected' : ''}
          title="Conversas da equipe"
          aria-label="Gerenciar conversas"
          aria-expanded={sessionPicker}
          onClick={() => setSessionPicker(!sessionPicker)}
        >
          <Icon name="team" size={15} />
        </button>
        <button
          className={inspector ? 'selected' : ''}
          title="Mostrar contexto e alterações"
          aria-label="Alternar painel de contexto"
          aria-expanded={inspector}
          onClick={() => setInspector(!inspector)}
        >
          <Icon name="list" size={16} />
        </button>
      </header>
      {error && (
        <p className="studio-error" role="alert">
          {error}
        </p>
      )}
      <div
        className={`task-studio-layout ${inspector ? '' : 'inspector-hidden'}`}
        style={inspector ? { gridTemplateColumns: `minmax(0,1fr) 4px ${inspectorWidth}px` } : undefined}
      >
        <main className="agent-workspace">
          <div className="session-tabs" role="tablist" aria-label="Sessões de agentes">
            {visibleChats.map((chat) => (
              <button
                role="tab"
                aria-selected={chat.id === selectedId}
                key={chat.id}
                className={chat.id === selectedId ? 'selected' : ''}
                onClick={() => selectChat(chat.id)}
                title={`${chat.title} · ${users[chat.userId]?.name}`}
              >
                <span className={`provider-symbol ${chat.provider}`}>{chat.provider === 'claude' ? '✳' : '⌘'}</span>
                <span>{CHAT_PROVIDER_LABELS[chat.provider]}</span>
                <small>{users[chat.userId]?.name.split(' ')[0]}</small>
                <i className={`mini-state ${chat.status}`} />
              </button>
            ))}
            <button aria-label="Nova conversa" title="Nova conversa" onClick={() => setSessionPicker(!sessionPicker)}>
              <Icon name="plus" size={14} />
              {!visibleChats.length && <span>Nova sessão</span>}
            </button>
          </div>
          {sessionPicker && (
            <div className="session-popover">
              <ChatList
                chats={chats}
                selectedId={selectedId}
                onSelect={selectChat}
                onCreate={(provider) => void create(provider)}
                creating={creating}
                disabledReason={disabledReason}
              />
              <button className="session-popover-close" onClick={() => setSessionPicker(false)}>
                Fechar
              </button>
            </div>
          )}
          {selectedId ? (
            <ChatView key={selectedId} chatId={selectedId} />
          ) : (
            <div className="session-empty">
              <span className="session-empty-icon">
                <Icon name="terminal" size={26} />
              </span>
              <h1>Uma tarefa. Seus agentes.</h1>
              <p>
                Inicie uma sessão para trabalhar nesta tarefa.
                <br />
                Sua equipe acompanha a execução em tempo real.
              </p>
              <div className="provider-choices">
                <button disabled={!!disabledReason || creating !== null} onClick={() => void create('claude')}>
                  <span className="provider-symbol claude">✳</span>
                  <strong>{creating === 'claude' ? 'Abrindo…' : 'Claude'}</strong>
                  <small>Nova sessão</small>
                  <Icon name="plus" size={15} />
                </button>
                <button disabled={!!disabledReason || creating !== null} onClick={() => void create('codex')}>
                  <span className="provider-symbol codex">⌘</span>
                  <strong>{creating === 'codex' ? 'Abrindo…' : 'Codex'}</strong>
                  <small>Nova sessão</small>
                  <Icon name="plus" size={15} />
                </button>
              </div>
              {disabledReason && <p className="session-disabled">{disabledReason}</p>}
              <span className="session-footnote">
                <Icon name="branch" size={12} />
                Cada pessoa trabalha na própria branch.
              </span>
            </div>
          )}
          <TerminalDock taskId={task.id} enabled={!!agentsStatus?.enabled} />
        </main>
        {inspector && (
          <>
            <ResizeHandle
              label="Largura do painel de contexto"
              value={inspectorWidth}
              min={250}
              max={440}
              direction={-1}
              onResize={(value) => {
                setInspectorWidth(value)
                rememberSize('harpia.studio.inspector', value)
              }}
            />
            <aside className="studio-inspector" aria-label="Inspector da tarefa">
              <div className="inspector-tabs" role="tablist" aria-label="Conteúdo do inspector">
                <button
                  role="tab"
                  aria-selected={inspectorTab === 'context'}
                  className={inspectorTab === 'context' ? 'selected' : ''}
                  onClick={() => setInspectorTab('context')}
                >
                  Contexto
                </button>
                <button
                  role="tab"
                  aria-selected={inspectorTab === 'changes'}
                  className={inspectorTab === 'changes' ? 'selected' : ''}
                  onClick={() => setInspectorTab('changes')}
                >
                  Alterações
                </button>
                <button aria-label="Fechar inspector" onClick={() => setInspector(false)}>
                  <Icon name="close" size={12} />
                </button>
              </div>
              {inspectorTab === 'context' ? (
                <TaskSidebar taskId={task.id} />
              ) : (
                <ChangesPanel key={task.id} taskId={task.id} />
              )}
            </aside>
          </>
        )}
      </div>
    </section>
  )
}
