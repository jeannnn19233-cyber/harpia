import { useEffect, useRef, useState } from 'react'
import type { AgentAccounts } from '../../../shared/types.ts'
import { api } from '../lib/api.ts'
import { useHarpia } from '../lib/store.ts'
import { Dialog } from './Dialogs.tsx'
import { TerminalView, type TerminalControls } from './TerminalView.tsx'

// "Minhas IAs": cada pessoa conecta a própria conta do Claude Code e do Codex no servidor.
// Usuário do GitHub: os PRs da pessoa são revisados no Claude dela.
function GitHubLogin() {
  const { me, setMe } = useHarpia()
  const [value, setValue] = useState(me?.githubLogin ?? '')
  const [state, setState] = useState<{ error: string | null; saved: boolean }>({ error: null, saved: false })
  const save = async () => {
    try {
      const { user } = await api.updateMe({ githubLogin: value.trim() || null })
      setMe(user)
      setState({ error: null, saved: true })
    } catch (err) {
      setState({ error: (err as Error).message, saved: false })
    }
  }
  return (
    <div className="mb-4 rounded-lg border border-zinc-800 px-4 py-3">
      <p className="text-sm font-medium">Seu usuário do GitHub</p>
      <p className="mb-2 text-xs text-zinc-400">Os seus PRs são revisados automaticamente no seu Claude (veja "Revisões" no quadro).</p>
      <div className="flex gap-2">
        <input
          className="input max-w-60"
          value={value}
          placeholder="ex.: ana-souza"
          onChange={(e) => {
            setValue(e.target.value)
            setState({ error: null, saved: false })
          }}
        />
        <button className="btn-outline py-1.5" onClick={() => void save()} disabled={(me?.githubLogin ?? '') === value.trim()}>
          Salvar
        </button>
        {state.saved && <span className="self-center text-xs text-emerald-400">Salvo</span>}
      </div>
      {state.error && <p className="mt-1 text-xs text-rose-400">{state.error}</p>}
    </div>
  )
}

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
      <GitHubLogin />
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
