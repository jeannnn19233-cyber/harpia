import { useEffect, useState } from 'react'
import type { Chat, ChatModel, ChatProvider } from '../../../../shared/types.ts'
import { api } from '../../lib/api.ts'

// A lista vem da conta de cada pessoa (perguntada ao Claude Code ou ao Codex) e muda pouco.
const cache = new Map<ChatProvider, Promise<{ models: ChatModel[]; error: string | null }>>()

function loadModels(provider: ChatProvider) {
  let pending = cache.get(provider)
  if (!pending) {
    pending = api.models(provider).catch((err: Error) => ({ models: [], error: err.message }))
    cache.set(provider, pending)
  }
  return pending
}

export function ModelPicker({
  provider,
  value,
  onChange,
  className = 'input w-auto max-w-44 py-1 text-xs'
}: {
  provider: ChatProvider
  value: string | null
  onChange: (model: string | null) => void
  className?: string
}) {
  const [models, setModels] = useState<ChatModel[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void loadModels(provider).then((result) => {
      if (!current) return
      setModels(result.models)
      setError(result.error)
    })
    return () => {
      current = false
    }
  }, [provider])

  const list = models ?? []
  // O modelo escolhido continua na lista mesmo que a conta não o anuncie mais.
  const options = value && !list.some((model) => model.id === value) ? [{ id: value, label: value, description: '' }, ...list] : list

  return (
    <select
      className={className}
      value={value ?? ''}
      title={error ?? 'Modelo usado. A troca vale a partir da próxima mensagem.'}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">{models === null ? 'Carregando modelos…' : 'Modelo padrão'}</option>
      {options.map((model) => (
        <option key={model.id} value={model.id} title={model.description}>
          {model.label}
        </option>
      ))}
    </select>
  )
}

export function ModelSelect({ chat, onChange }: { chat: Chat; onChange: (model: string | null) => void }) {
  return <ModelPicker provider={chat.provider} value={chat.model} onChange={onChange} />
}
