import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { User } from '../../../shared/types.ts'
import { api } from '../lib/api.ts'

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-3xl font-bold tracking-tight text-brand-400">Harpia</div>
          <h1 className="mt-4 text-lg font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-zinc-400">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-400">{label}</span>
      {children}
    </label>
  )
}

function AccountForm({
  submitLabel,
  onSubmit
}: {
  submitLabel: string
  onSubmit: (input: { name: string; email: string; password: string }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSubmit({ name, email, password })
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-6">
      <Field label="Nome">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      </Field>
      <Field label="E-mail">
        <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </Field>
      <Field label="Senha (mínimo 8 caracteres)">
        <input
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          required
        />
      </Field>
      {error && <p className="text-sm text-rose-400">{error}</p>}
      <button className="btn-primary w-full" disabled={busy}>
        {busy ? 'Aguarde…' : submitLabel}
      </button>
    </form>
  )
}

export function SetupScreen({ onDone }: { onDone: (user: User) => void }) {
  return (
    <Shell title="Configuração inicial" subtitle="Crie a conta de administrador. Depois você convida a equipe.">
      <AccountForm submitLabel="Criar conta" onSubmit={async (input) => onDone((await api.setup(input)).user)} />
    </Shell>
  )
}

export function LoginScreen({ onDone }: { onDone: (user: User) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onDone((await api.login({ email, password })).user)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Shell title="Entrar" subtitle="Workspace da equipe">
      <form onSubmit={submit} className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-6">
        <Field label="E-mail">
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </Field>
        <Field label="Senha">
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {error && <p className="text-sm text-rose-400">{error}</p>}
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
      <p className="mt-4 text-center text-xs text-zinc-500">Sem conta? Peça um convite a um administrador.</p>
    </Shell>
  )
}

export function InviteScreen({ token, onDone }: { token: string; onDone: (user: User) => void }) {
  const [state, setState] = useState<'checking' | 'valid' | 'invalid'>('checking')

  useEffect(() => {
    api
      .checkInvite(token)
      .then(() => setState('valid'))
      .catch(() => setState('invalid'))
  }, [token])

  if (state === 'checking') return <Shell title="Convite" subtitle="Verificando o convite…">{null}</Shell>
  if (state === 'invalid') {
    return (
      <Shell title="Convite inválido" subtitle="Este convite expirou ou já foi usado. Peça um novo ao administrador.">
        <a href="/" className="btn-outline w-full">
          Ir para o login
        </a>
      </Shell>
    )
  }
  return (
    <Shell title="Você foi convidado" subtitle="Crie sua conta para entrar no workspace.">
      <AccountForm
        submitLabel="Criar conta e entrar"
        onSubmit={async (input) => {
          const { user } = await api.acceptInvite(token, input)
          history.replaceState(null, '', '/')
          onDone(user)
        }}
      />
    </Shell>
  )
}
