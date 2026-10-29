import { useEffect, useMemo, useRef, useState } from 'react'
import { AGENT_LABELS, type AgentAccounts, type AgentKind, type AgentSession } from '../../../shared/types.ts'
import { api } from '../lib/api.ts'
import { timeAgo } from '../lib/format.ts'
import { useHarpia } from '../lib/store.ts'
import { Avatar } from './Avatar.tsx'
import { Dialog } from './Dialogs.tsx'
import { TerminalView, type TerminalControls } from './TerminalView.tsx'

function useTaskSessions(taskId: number): AgentSession[] {
  const sessions = useHarpia((state) => state.sessions)
  return useMemo(
    () => Object.values(sessions).filter((session) => session.taskId === taskId).sort((a, b) => a.id - b.id),
    [sessions, taskId]
  )
}

// Seção "Agentes" no painel da task: abrir o próprio agente e ver os da equipe.
export function AgentsSection({ taskId, taskDone }: { taskId: number; taskDone: boolean }) {
  const { agentsStatus, users, upsertSessions, watchSession } = useHarpia()
  const sessions = useTaskSessions(taskId)
  const [busy, setBusy] = useState<AgentKind | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showEnded, setShowEnded] = useState(false)

  useEffect(() => {
    if (!agentsStatus?.enabled) return
    api
      .taskSessions(taskId)
      .then(({ sessions }) => upsertSessions(sessions))
      .catch(() => undefined)
  }, [taskId, agentsStatus?.enabled, upsertSessions])

  if (!agentsStatus) return null
  if (!agentsStatus.enabled) {
    return (
      <section>
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase">Agentes</h3>
        <p className="text-sm text-zinc-500">{agentsStatus.reason}</p>
      </section>
    )
  }

  const start = async (kind: AgentKind) => {
    setBusy(kind)
    setError(null)
    try {
      const { session } = await api.startSession(taskId, kind)
      upsertSessions([session])
      watchSession(session.id)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const running = sessions.filter((session) => session.status === 'running')
  const ended = sessions.filter((session) => session.status === 'exited')

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase">Agentes</h3>
      {!taskDone && (
        <div className="mb-3 flex flex-wrap gap-2">
          {(['claude', 'codex', 'shell'] as const).map((kind) => (
            <button
              key={kind}
              className={kind === 'shell' ? 'btn-ghost py-1.5' : 'btn-outline py-1.5'}
              disabled={busy !== null}
              onClick={() => void start(kind)}
            >
              {busy === kind ? 'Abrindo…' : `Abrir ${AGENT_LABELS[kind]}`}
            </button>
          ))}
        </div>
      )}
      {error && <p className="mb-2 text-sm text-rose-400">{error}</p>}
      {running.length === 0 ? (
        <p className="text-sm text-zinc-500">Nenhum agente rodando nesta task.</p>
      ) : (
        <ul className="space-y-2">
          {running.map((session) => (
            <li key={session.id} className="flex items-center gap-3 rounded-lg border border-zinc-800 px-3 py-2">
              <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-400" />
              <Avatar user={users[session.userId]} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">
                  {users[session.userId]?.name ?? 'Alguém'} · {AGENT_LABELS[session.kind]}
                </p>
                <p className="truncate font-mono text-xs text-zinc-500">{session.branch}</p>
              </div>
              <button className="btn-ghost px-2 py-1 text-xs" onClick={() => watchSession(session.id)}>
                Ver ao vivo
              </button>
            </li>
          ))}
        </ul>
      )}
      {ended.length > 0 && (
        <button className="mt-2 text-xs text-zinc-500 hover:text-zinc-300" onClick={() => setShowEnded(!showEnded)}>
          {showEnded ? 'Ocultar' : 'Mostrar'} {ended.length} sessões encerradas
        </button>
      )}
      {showEnded && (
        <ul className="mt-2 space-y-1">
          {ended.map((session) => (
            <li key={session.id} className="text-xs text-zinc-500">
              {users[session.userId]?.name} · {AGENT_LABELS[session.kind]} · encerrada{' '}
              {session.endedAt ? timeAgo(session.endedAt) : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// Tela grande com os terminais de uma task, em abas.
export function SessionsOverlay({ sessionId }: { sessionId: number }) {
  const { me, users, sessions, tasks, watchSession } = useHarpia()
  const current = sessions[sessionId]
  const taskSessions = useTaskSessions(current?.taskId ?? -1).filter(
    (session) => session.status === 'running' || session.id === sessionId
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && event.shiftKey) watchSession(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [watchSession])

  if (!current || !me) return null
  const task = current.taskId ? tasks[current.taskId] : undefined
  const mine = current.userId === me.id
  const canStop = current.status === 'running' && (mine || me.role === 'admin')

  const stop = async () => {
    if (!confirm('Encerrar esta sessão? O que estiver rodando nela será interrompido.')) return
    try {
      await api.stopSession(current.id)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-zinc-950/95 p-3 sm:p-6">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950">
        <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
          {task && <span className="mr-2 text-sm text-zinc-400">T-{task.number} · {task.title}</span>}
          <nav className="flex flex-wrap gap-1">
            {taskSessions.map((session) => (
              <button
                key={session.id}
                onClick={() => watchSession(session.id)}
                className={`flex items-center gap-2 rounded-md px-2.5 py-1 text-sm ${
                  session.id === sessionId ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${session.status === 'running' ? 'bg-emerald-400' : 'bg-zinc-600'}`}
                />
                {users[session.userId]?.name.split(' ')[0] ?? '?'} · {AGENT_LABELS[session.kind]}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {!mine && <span className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300">Assistindo · só leitura</span>}
            {canStop && (
              <button className="btn-ghost px-2 py-1 text-xs text-rose-300" onClick={() => void stop()}>
                Encerrar sessão
              </button>
            )}
            <button className="btn-outline px-2 py-1 text-xs" onClick={() => watchSession(null)}>
              Fechar
            </button>
          </div>
        </header>
        {error && <div className="bg-rose-950 px-4 py-2 text-sm text-rose-300">{error}</div>}
        <div className="min-h-0 flex-1">
          {current.status === 'running' ? (
            <TerminalView key={current.id} sessionId={current.id} readOnly={!mine} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-zinc-500">Esta sessão foi encerrada.</div>
          )}
        </div>
        <footer className="border-t border-zinc-800 px-3 py-1.5 text-xs text-zinc-500">
          Fechar esta tela não encerra o agente: ele continua rodando no servidor.
        </footer>
      </div>
    </div>
  )
}

// "Minhas IAs": cada pessoa conecta a própria conta do Claude Code e do Codex no servidor.
export function AccountsDialog({ onClose }: { onClose: () => void }) {
  const [accounts, setAccounts] = useState<AgentAccounts | null>(null)
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const terminal = useRef<TerminalControls>(null)

  const refresh = () =>
    api
      .accounts()
      .then(({ accounts }) => setAccounts(accounts))
      .catch((err: Error) => setError(err.message))

  useEffect(() => {
    void refresh()
  }, [])

  const openTerminal = async () => {
    try {
      setSessionId((await api.openPersonalTerminal()).session.id)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const status = (connected: boolean | undefined) =>
    connected ? <span className="text-emerald-400">Conectado</span> : <span className="text-zinc-500">Não conectado</span>

  return (
    <Dialog title="Minhas IAs" onClose={onClose} wide>
      <div className="mb-4 grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-zinc-800 px-4 py-3">
          <p className="text-sm font-medium">Claude Code</p>
          <p className="text-sm">{status(accounts?.claude)}</p>
        </div>
        <div className="rounded-lg border border-zinc-800 px-4 py-3">
          <p className="text-sm font-medium">Codex</p>
          <p className="text-sm">{status(accounts?.codex)}</p>
        </div>
      </div>
      <p className="mb-3 text-sm text-zinc-400">
        Cada pessoa usa a própria assinatura. O login fica guardado na sua pasta no servidor, que só os seus agentes
        enxergam.
      </p>

      {sessionId === null ? (
        <button className="btn-primary" onClick={() => void openTerminal()}>
          Abrir meu terminal para conectar
        </button>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <button className="btn-outline py-1.5" onClick={() => terminal.current?.type('claude\r')}>
              Conectar Claude Code
            </button>
            <button className="btn-outline py-1.5" onClick={() => terminal.current?.type('codex login --device-auth\r')}>
              Conectar Codex
            </button>
            <button className="btn-ghost py-1.5" onClick={() => void refresh()}>
              Verificar conexão
            </button>
          </div>
          <ul className="list-disc space-y-1 pl-5 text-xs text-zinc-400">
            <li>
              <b>Claude Code:</b> escolha entrar com a sua assinatura, abra o link que aparecer, autorize e cole o código
              de volta aqui. Depois digite <code>/exit</code>.
            </li>
            <li>
              <b>Codex:</b> abra o link mostrado, digite o código que aparece aqui e autorize com a sua conta.
            </li>
          </ul>
          <div className="h-80 overflow-hidden rounded-lg border border-zinc-800">
            <TerminalView sessionId={sessionId} readOnly={false} controls={terminal} />
          </div>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}
    </Dialog>
  )
}
