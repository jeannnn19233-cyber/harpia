import { useEffect, useRef, useState } from 'react'
import type { AgentAccounts } from '../../../shared/types.ts'
import { api } from '../lib/api.ts'
import { Dialog } from './Dialogs.tsx'
import { TerminalView, type TerminalControls } from './TerminalView.tsx'

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
