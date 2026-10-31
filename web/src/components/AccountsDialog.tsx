import { useEffect, useRef, useState } from 'react'
import {
  CHAT_PROVIDER_LABELS,
  REVIEW_MODE_LABELS,
  REVIEW_MODES,
  type AgentAccounts,
  type AgentLoginState,
  type ChatProvider,
  type ReviewMode,
  type User
} from '../../../shared/types.ts'
import { api } from '../lib/api.ts'
import { useHarpia } from '../lib/store.ts'
import { Dialog } from './Dialogs.tsx'
import { TerminalView, type TerminalControls } from './TerminalView.tsx'

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

const STEP_LABELS: Record<string, string> = {
  server: 'Servidor',
  user: 'Seu usuário no servidor',
  login: 'Login',
  program: 'Programa',
  reply: 'Resposta de verdade'
}

// Testa a corrente inteira de cada agente e diz em qual etapa ela quebra.
function AgentDiagnosis() {
  const [live, setLive] = useState(false)
  const [running, setRunning] = useState<ChatProvider | null>(null)
  const [results, setResults] = useState<Partial<Record<ChatProvider, { key: string; ok: boolean; detail: string }[] | string>>>({})
  const run = async (provider: ChatProvider) => {
    setRunning(provider)
    try {
      const { steps } = await api.diagnoseAgent(provider, live)
      setResults((current) => ({ ...current, [provider]: steps }))
    } catch (err) {
      setResults((current) => ({ ...current, [provider]: (err as Error).message }))
    } finally {
      setRunning(null)
    }
  }
  return (
    <div className="mb-4 space-y-3 rounded-lg border border-zinc-800 px-4 py-3">
      <div>
        <p className="text-sm font-medium">Diagnóstico dos agentes</p>
        <p className="text-xs text-zinc-400">Se o agente não responde, teste aqui: o Harpia confere cada etapa e mostra onde parou.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {(['claude', 'codex'] as const).map((provider) => (
          <button key={provider} className="btn-outline py-1.5" disabled={running !== null} onClick={() => void run(provider)}>
            {running === provider ? 'Testando…' : `Testar ${CHAT_PROVIDER_LABELS[provider]}`}
          </button>
        ))}
        <label className="flex items-center gap-1.5 text-xs text-zinc-400">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
          Teste completo (manda uma mensagem curta e gasta um pouco da cota)
        </label>
      </div>
      {(['claude', 'codex'] as const).map((provider) => {
        const result = results[provider]
        if (!result) return null
        return (
          <div key={provider} className="rounded border border-zinc-800 px-3 py-2 text-xs">
            <p className="mb-1 font-medium text-zinc-300">{CHAT_PROVIDER_LABELS[provider]}</p>
            {typeof result === 'string' ? (
              <p className="text-rose-300">{result}</p>
            ) : (
              <ul className="space-y-1">
                {result.map((step) => (
                  <li key={step.key} className={step.ok ? 'text-zinc-300' : 'text-rose-300'}>
                    {step.ok ? '✅' : '❌'} <b>{STEP_LABELS[step.key] ?? step.key}:</b> {step.detail}
                  </li>
                ))}
                {result.every((step) => step.ok) && !live && (
                  <li className="text-zinc-500">Para conferir a resposta de verdade, marque "Teste completo" e teste de novo.</li>
                )}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}

const PROVIDER_NAMES: Record<ChatProvider, string> = { claude: 'Claude Code', codex: 'Codex' }

const PROVIDER_ABOUT: Record<ChatProvider, string> = {
  claude: 'Com a sua assinatura do Claude (Pro ou Max).',
  codex: 'Com a sua conta do ChatGPT (Plus, Pro, Business…).'
}

// Um cartão por agente: conectar em dois passos, sem terminal.
function AgentConnect({
  provider,
  connected,
  login,
  onChange
}: {
  provider: ChatProvider
  connected: boolean
  login: AgentLoginState | null
  onChange: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const name = PROVIDER_NAMES[provider]
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
      await onChange()
    }
  }
  const active = login && (login.stage === 'open_link' || login.stage === 'checking') ? login : null
  const failed = login?.stage === 'failed' ? login.error : null

  return (
    <div className="space-y-3 rounded-lg border border-zinc-800 px-4 py-3" data-testid={`connect-${provider}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{name}</p>
          <p className="text-xs text-zinc-500">{PROVIDER_ABOUT[provider]}</p>
        </div>
        {connected && !active ? <span className="whitespace-nowrap text-sm text-emerald-400">✅ Conectado</span> : !active && <span className="whitespace-nowrap text-sm text-zinc-500">Não conectado</span>}
      </div>

      {!active &&
        (connected ? (
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost py-1 text-xs" disabled={busy} onClick={() => void run(() => api.startAgentLogin(provider))}>
              Conectar outra conta
            </button>
            <button
              className="btn-ghost py-1 text-xs text-rose-300"
              disabled={busy}
              onClick={() => confirm(`Desconectar o ${name}? Seus agentes param de funcionar até você conectar de novo.`) && void run(() => api.agentLogout(provider))}
            >
              Desconectar
            </button>
          </div>
        ) : (
          <button className="btn-primary" disabled={busy} onClick={() => void run(() => api.startAgentLogin(provider))}>
            {busy ? 'Abrindo…' : `Conectar ${name}`}
          </button>
        ))}

      {active && (
        <ol className="space-y-3 text-sm">
          <li>
            <p className="mb-1.5">
              <b>1.</b> {provider === 'claude' ? 'Abra a página do Claude e clique em "Autorizar".' : 'Abra a página da OpenAI e entre com a sua conta do ChatGPT.'}
            </p>
            <a className="btn-primary inline-block" href={active.url ?? '#'} target="_blank" rel="noreferrer">
              {provider === 'claude' ? 'Abrir a página do Claude' : 'Abrir a página da OpenAI'}
            </a>
          </li>
          {provider === 'claude' ? (
            <li>
              <p className="mb-1.5">
                <b>2.</b> A página mostra um código. Copie e cole aqui:
              </p>
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void run(async () => {
                    await api.sendClaudeCode(code)
                    setCode('')
                  })
                }}
              >
                <input
                  className="input min-w-0 flex-1 font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Cole o código aqui"
                  value={code}
                  disabled={active.stage === 'checking' || busy}
                  onChange={(e) => setCode(e.target.value)}
                />
                <button className="btn-primary" disabled={busy || code.trim().length < 10}>
                  {busy ? 'Conferindo…' : 'Conectar'}
                </button>
              </form>
            </li>
          ) : (
            <li>
              <p className="mb-1.5">
                <b>2.</b> Digite este código na página:
              </p>
              <div className="flex items-center gap-2">
                <code className="rounded-md bg-zinc-900 px-3 py-1.5 font-mono text-lg tracking-widest text-emerald-300">{active.deviceCode}</code>
                <button
                  className="btn-ghost py-1 text-xs"
                  onClick={() =>
                    void navigator.clipboard.writeText(active.deviceCode ?? '').then(() => {
                      setCopied(true)
                      setTimeout(() => setCopied(false), 2000)
                    })
                  }
                >
                  {copied ? 'Copiado' : 'Copiar'}
                </button>
              </div>
              <p className="mt-2 text-xs text-zinc-400">Esperando você autorizar… esta tela atualiza sozinha. O código vale 15 minutos.</p>
              <p className="mt-1 text-xs text-zinc-500">
                Se a página recusar o código, ative o login por código de dispositivo nas configurações de segurança do ChatGPT e tente de novo.
              </p>
            </li>
          )}
          <li>
            <button className="btn-ghost py-1 text-xs" disabled={busy} onClick={() => void run(() => api.cancelAgentLogin(provider))}>
              Cancelar
            </button>
          </li>
        </ol>
      )}
      {(error ?? failed) && <p className="text-xs text-rose-400">{error ?? failed}</p>}
    </div>
  )
}

// Caminho antigo, para quem prefere: o terminal pessoal com os comandos de login.
function TerminalFallback() {
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const terminal = useRef<TerminalControls>(null)
  const openTerminal = async () => {
    try {
      setSessionId((await api.openPersonalTerminal()).session.id)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }
  return (
    <details className="mb-4 rounded-lg border border-zinc-800 px-4 py-3 text-sm">
      <summary className="cursor-pointer text-zinc-400">Prefere conectar pelo terminal?</summary>
      <div className="mt-3 space-y-3">
        {sessionId === null ? (
          <button className="btn-outline py-1.5" onClick={() => void openTerminal()}>
            Abrir meu terminal
          </button>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <button className="btn-outline py-1.5" onClick={() => terminal.current?.type('claude auth login\r')}>
                Login do Claude Code
              </button>
              <button className="btn-outline py-1.5" onClick={() => terminal.current?.type('codex login --device-auth\r')}>
                Login do Codex
              </button>
            </div>
            <div className="h-72 overflow-hidden rounded-lg border border-zinc-800">
              <TerminalView sessionId={sessionId} readOnly={false} controls={terminal} />
            </div>
          </>
        )}
        {error && <p className="text-sm text-rose-400">{error}</p>}
      </div>
    </details>
  )
}

export function AccountsDialog({ onClose }: { onClose: () => void }) {
  const [accounts, setAccounts] = useState<AgentAccounts | null>(null)
  const [logins, setLogins] = useState<Record<ChatProvider, AgentLoginState | null>>({ claude: null, codex: null })
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    try {
      const result = await api.agentLogins()
      setAccounts(result.accounts)
      setLogins(result.logins)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  // Enquanto a pessoa autoriza na outra aba, confere de tempos em tempos se já conectou.
  const waiting = Object.values(logins).some((login) => login?.stage === 'open_link')
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => void refresh(), 2000)
    return () => clearInterval(timer)
  }, [waiting])

  return (
    <Dialog title="Minhas IAs" onClose={onClose} wide>
      <p className="mb-3 text-sm text-zinc-400">
        Cada pessoa usa a própria assinatura. O login fica guardado na sua pasta no servidor, que só os seus agentes enxergam.
      </p>
      {error ? (
        <p className="mb-4 rounded-lg border border-rose-900 px-4 py-3 text-sm text-rose-300">{error}</p>
      ) : (
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          {(['claude', 'codex'] as const).map((provider) => (
            <AgentConnect key={provider} provider={provider} connected={!!accounts?.[provider]} login={logins[provider]} onChange={refresh} />
          ))}
        </div>
      )}
      <AgentDiagnosis />
      <GitHubAccount />
      <CodexSuggestions />
      <TerminalFallback />
    </Dialog>
  )
}
