import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api.ts'
import { useHarpia } from '../../lib/store.ts'
import { TerminalView } from '../TerminalView.tsx'

const HEIGHT_KEY = 'harpia.terminalHeight'
const OPEN_KEY = 'harpia.terminalOpen'

function readNumber(key: string, fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key))
    return Number.isFinite(value) && value > 0 ? value : fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Sem armazenamento local: só não lembra a preferência.
  }
}

// Terminal no centro, embaixo do chat. Abas: o meu terminal na task e os da equipe (só leitura).
export function TerminalDock({ taskId, enabled }: { taskId: number; enabled: boolean }) {
  const { me, users, sessions, upsertSessions } = useHarpia()
  const [open, setOpen] = useState(() => readNumber(OPEN_KEY, 1) === 1)
  const [height, setHeight] = useState(() => readNumber(HEIGHT_KEY, 190))
  const [selected, setSelected] = useState<number | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dragging = useRef<{ startY: number; startHeight: number } | null>(null)

  const terminals = useMemo(
    () =>
      Object.values(sessions)
        .filter((session) => session.taskId === taskId && session.kind === 'shell' && session.status === 'running')
        .sort((a, b) => (a.userId === me?.id ? -1 : b.userId === me?.id ? 1 : a.id - b.id)),
    [sessions, taskId, me?.id]
  )

  const mine = terminals.find((session) => session.userId === me?.id)

  // Abre (ou reaproveita) o meu terminal na minha cópia do código. Só quando a pessoa pede:
  // olhar uma task não deve criar cópia de trabalho para ninguém.
  const openMine = async () => {
    setStarting(true)
    try {
      const { session } = await api.openTaskTerminal(taskId)
      upsertSessions([session])
      setSelected(session.id)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setStarting(false)
    }
  }

  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!dragging.current) return
      const next = dragging.current.startHeight + (dragging.current.startY - event.clientY)
      setHeight(Math.min(Math.max(next, 120), window.innerHeight * 0.75))
    }
    const up = () => {
      if (!dragging.current) return
      dragging.current = null
      document.body.style.userSelect = ''
      setHeight((value) => {
        save(HEIGHT_KEY, String(Math.round(value)))
        return value
      })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [])

  const toggle = () => {
    save(OPEN_KEY, open ? '2' : '1')
    setOpen(!open)
  }

  const current = terminals.find((session) => session.id === selected) ?? terminals[0]

  return (
    <section
      className="studio-terminal flex shrink-0 flex-col border-t border-zinc-800 bg-zinc-950"
      style={open ? { height } : undefined}
    >
      {open && (
        <div
          className="h-1 shrink-0 cursor-row-resize bg-zinc-900 hover:bg-brand-500/50"
          onMouseDown={(event) => {
            dragging.current = { startY: event.clientY, startHeight: height }
            document.body.style.userSelect = 'none'
          }}
          title="Arraste para mudar a altura"
          role="separator"
          aria-label="Altura do terminal"
          aria-orientation="horizontal"
          aria-valuemin={120}
          aria-valuemax={Math.round(window.innerHeight * 0.75)}
          aria-valuenow={height}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault()
              setHeight((current) => {
                const next = Math.min(
                  window.innerHeight * 0.75,
                  Math.max(120, current + (event.key === 'ArrowUp' ? 20 : -20))
                )
                save(HEIGHT_KEY, String(next))
                return next
              })
            }
          }}
        />
      )}
      <header className="flex items-center gap-1 px-2 py-1">
        <button className="btn-ghost px-2 py-1 text-xs font-semibold tracking-wide uppercase" onClick={toggle}>
          {open ? '▾' : '▸'} Terminal
        </button>
        {open &&
          terminals.map((session) => (
            <button
              key={session.id}
              onClick={() => setSelected(session.id)}
              className={`rounded-md px-2.5 py-1 text-xs ${
                session.id === current?.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900'
              }`}
            >
              {session.userId === me?.id
                ? 'Meu terminal'
                : `${users[session.userId]?.name.split(' ')[0] ?? '?'} (só leitura)`}
            </button>
          ))}
        {open && enabled && !mine && (
          <button
            className="btn-ghost px-2 py-1 text-xs text-brand-400"
            disabled={starting}
            onClick={() => void openMine()}
          >
            {starting ? 'Abrindo…' : '+ Abrir meu terminal'}
          </button>
        )}
      </header>
      {open && (
        <div className="min-h-0 flex-1">
          {!enabled ? (
            <p className="px-4 py-3 text-sm text-zinc-500">Os terminais estão desligados no servidor.</p>
          ) : error ? (
            <p className="px-4 py-3 text-sm text-rose-400">{error}</p>
          ) : current ? (
            <TerminalView key={current.id} sessionId={current.id} readOnly={current.userId !== me?.id} />
          ) : (
            <p className="px-4 py-3 text-sm text-zinc-500">
              Nenhum terminal aberto nesta task. Abra o seu para rodar comandos na sua cópia do código.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
