import { useEffect, useRef, useState } from 'react'
import { REVIEW_MODE_LABELS, REVIEW_MODES, type AgentAccounts, type ReviewMode, type User } from '../../../shared/types.ts'
import { api } from '../lib/api.ts'
import { useHarpia } from '../lib/store.ts'
import { Dialog } from './Dialogs.tsx'
import { TerminalView, type TerminalControls } from './TerminalView.tsx'

// "Minhas IAs": cada pessoa conecta a própria conta do Claude Code e do Codex no servidor.
// GitHub de cada pessoa: o revisor de PRs dela publica, corrige e aprova com este token, em nome dela.
function GitHubAccount() {
  const { me, setMe, users } = useHarpia()
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!me) return null
  const run = async (action: () => Promise<{ user: User }>) => {
    setBusy(true)
    try {
      setMe((await action()).user)
      setError(null)
      setToken('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const colleagues = Object.values(users).filter((user) => user.id !== me.id)
  return (
    <div className="mb-4 space-y-3 rounded-lg border border-zinc-800 px-4 py-3">
      <div>
        <p className="text-sm font-medium">Seu GitHub (revisor de PRs)</p>
        <p className="text-xs text-zinc-400">
          O seu revisor revisa os PRs dos colegas no seu Claude e publica no GitHub com o seu token, na primeira pessoa, como se fosse você.
          O token fica cifrado no servidor e nunca é mostrado de novo nem entregue à IA.
        </p>
      </div>
      {me.githubConnected ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-emerald-400">Conectado como @{me.githubLogin}</span>
          <button className="btn-ghost py-1 text-xs" disabled={busy} onClick={() => void run(() => api.disconnectGitHub())}>
            Desconectar
          </button>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="flex gap-2">
            <input
              className="input max-w-80"
              type="password"
              autoComplete="off"
              value={token}
              placeholder="github_pat_…"
              onChange={(e) => setToken(e.target.value)}
            />
            <button className="btn-primary py-1.5" disabled={busy || token.trim().length < 20} onClick={() => void run(() => api.connectGitHub(token.trim()))}>
              Conectar
            </button>
          </div>
          <p className="text-xs text-zinc-500">
            Crie em GitHub → Settings → Developer settings → Fine-grained tokens, só para os repositórios da equipe, com permissão de
            leitura e escrita em <b>Contents</b> e <b>Pull requests</b> (e leitura em <b>Checks</b>).
          </p>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-zinc-400">
          O que o meu revisor pode fazer
          <select
            className="input mt-1"
            value={me.reviewMode}
            onChange={(e) => void run(() => api.updateMe({ reviewMode: e.target.value as ReviewMode }))}
          >
            {REVIEW_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {REVIEW_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-zinc-400">
          Quem revisa os meus PRs
          <select
            className="input mt-1"
            value={me.preferredReviewerId ?? ''}
            onChange={(e) => void run(() => api.updateMe({ preferredReviewerId: e.target.value ? Number(e.target.value) : null }))}
          >
            <option value="">O padrão do projeto</option>
            {colleagues.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
                {user.githubConnected ? '' : ' (sem GitHub conectado)'}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="text-xs text-rose-400">{error}</p>}
    </div>
  )
}

// Sugestão de próxima mensagem nas conversas com o Codex, escrita pelo Claude (Haiku) da pessoa.
function CodexSuggestions() {
  const { me, setMe } = useHarpia()
  if (!me) return null
  return (
    <label className="mb-4 flex items-start gap-3 rounded-lg border border-zinc-800 px-4 py-3 text-sm">
      <input
        type="checkbox"
        className="mt-1"
        checked={me.codexSuggestions}
        onChange={(e) => void api.updateMe({ codexSuggestions: e.target.checked }).then(({ user }) => setMe(user))}
      />
      <span>
        <span className="font-medium">Sugerir a próxima mensagem nas conversas com o Codex</span>
        <span className="block text-xs text-zinc-400">
          O Claude já faz isso sozinho. Para o Codex, o seu Claude (modelo Haiku, o mais barato) lê o último pedido e a resposta e sugere o
          próximo passo. Gasta um pouco da sua cota a cada resposta.
        </span>
      </span>
    </label>
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
      <GitHubAccount />
      <CodexSuggestions />
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
