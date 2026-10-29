import { useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../lib/api.ts'
import { useHarpia } from '../lib/store.ts'
import { Avatar } from './Avatar.tsx'

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/60 px-4 pt-24" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} className="btn-ghost px-2 py-1" aria-label="Fechar">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function ProjectForm({ onCreated }: { onCreated?: () => void }) {
  const selectProject = useHarpia((state) => state.selectProject)
  const upsertProject = useHarpia((state) => state.upsertProject)
  const [name, setName] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [defaultBranch, setDefaultBranch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      const { project } = await api.createProject({ name, repoUrl, defaultBranch: defaultBranch || undefined })
      upsertProject(project)
      selectProject(project.id)
      onCreated?.()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <input className="input" placeholder="Nome do projeto" value={name} onChange={(e) => setName(e.target.value)} required />
      <input
        className="input font-mono"
        placeholder="https://github.com/equipe/repositorio.git"
        value={repoUrl}
        onChange={(e) => setRepoUrl(e.target.value)}
        required
      />
      <input
        className="input font-mono"
        placeholder="Branch principal (opcional, ex.: main)"
        value={defaultBranch}
        onChange={(e) => setDefaultBranch(e.target.value)}
      />
      <p className="text-xs text-zinc-500">
        O servidor do Harpia clona o repositório. Para repositórios privados, o login do GitHub precisa estar
        configurado na VPS (veja docs/VPS.md).
      </p>
      {error && <p className="text-sm text-rose-400">{error}</p>}
      <button className="btn-primary w-full" disabled={busy}>
        {busy ? 'Criando…' : 'Criar projeto'}
      </button>
    </form>
  )
}

export function TeamDialog({ onClose }: { onClose: () => void }) {
  const { me, users, online } = useHarpia()
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const invite = async (role: 'admin' | 'member') => {
    try {
      const { invite } = await api.createInvite(role)
      setLink(`${location.origin}/convite/${invite.token}`)
      setCopied(false)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const copy = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Dialog title="Equipe" onClose={onClose}>
      <ul className="mb-5 space-y-2">
        {Object.values(users)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((user) => (
            <li key={user.id} className="flex items-center gap-3">
              <Avatar user={user} online={online.includes(user.id)} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{user.name}</p>
                <p className="truncate text-xs text-zinc-500">{user.email}</p>
              </div>
              {user.role === 'admin' && <span className="text-xs text-brand-400">admin</span>}
            </li>
          ))}
      </ul>

      {me?.role === 'admin' ? (
        <div className="space-y-3 border-t border-zinc-800 pt-4">
          <p className="text-sm text-zinc-400">Gere um link de convite. Ele vale por 7 dias e serve para uma pessoa.</p>
          <div className="flex gap-2">
            <button className="btn-primary flex-1" onClick={() => void invite('member')}>
              Convidar membro
            </button>
            <button className="btn-outline" onClick={() => void invite('admin')}>
              Convidar admin
            </button>
          </div>
          {link && (
            <div className="flex gap-2">
              <input className="input font-mono text-xs" value={link} readOnly onFocus={(e) => e.target.select()} />
              <button className="btn-outline shrink-0" onClick={() => void copy()}>
                {copied ? 'Copiado' : 'Copiar'}
              </button>
            </div>
          )}
          {error && <p className="text-sm text-rose-400">{error}</p>}
        </div>
      ) : (
        <p className="border-t border-zinc-800 pt-4 text-sm text-zinc-500">Convites são criados por administradores.</p>
      )}
    </Dialog>
  )
}
