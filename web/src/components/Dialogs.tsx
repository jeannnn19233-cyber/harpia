import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../lib/api.ts'
import { useHarpia } from '../lib/store.ts'
import { Avatar } from './Avatar.tsx'

export function Dialog({
  title,
  onClose,
  wide = false,
  children
}: {
  title: string
  onClose: () => void
  wide?: boolean
  children: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const getFocusable = () =>
      Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input, textarea, select, a[href], [tabindex="0"]'
        ) ?? []
      )
    getFocusable()[0]?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const elements = getFocusable()
      const first = elements[0],
        last = elements.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      previous?.focus()
    }
  }, [])
  return (
    <div
      className={`dialog-overlay fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/60 px-4 ${wide ? 'pt-10 pb-10' : 'pt-24'}`}
      onClick={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`dialog-panel w-full ${wide ? 'max-w-4xl' : 'max-w-md'} rounded-xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl`}
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
      // O aviso em tempo real pode chegar antes desta resposta e já trazer o estado mais novo.
      if (!useHarpia.getState().projects.some((item) => item.id === project.id)) upsertProject(project)
      selectProject(project.id)
      onCreated?.()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="field-label">
        Nome do projeto
        <input
          className="input"
          placeholder="Ex.: Meu aplicativo"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </label>
      <input
        className="input font-mono"
        aria-label="URL do repositório"
        placeholder="https://github.com/equipe/repositorio.git"
        value={repoUrl}
        onChange={(e) => setRepoUrl(e.target.value)}
        required
      />
      <input
        className="input font-mono"
        aria-label="Branch principal"
        placeholder="Branch principal (opcional, ex.: main)"
        value={defaultBranch}
        onChange={(e) => setDefaultBranch(e.target.value)}
      />
      <p className="text-xs text-zinc-500">
        O repositório será conectado ao workspace. Para repositórios privados, peça ao administrador para configurar o
        acesso do GitHub.
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
