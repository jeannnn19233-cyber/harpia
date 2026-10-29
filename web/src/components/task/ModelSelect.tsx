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

export function ModelSelect({ chat, onChange }: { chat: Chat; onChange: (model: string | null) => void }) {
  const [models, setModels] = useState<ChatModel[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void loadModels(chat.provider).then((result) => {
      if (!current) return
      setModels(result.models)
      setError(result.error)
    })
    return () => {
      current = false
    }
  }, [chat.provider])

  const list = models ?? []
  // O modelo escolhido continua na lista mesmo que a conta não o anuncie mais.
  const options = chat.model && !list.some((model) => model.id === chat.model) ? [{ id: chat.model, label: chat.model, description: '' }, ...list] : list

  return (
    <select
      className="input w-auto max-w-44 py-1 text-xs"
      value={chat.model ?? ''}
      title={error ?? 'Modelo usado nesta conversa. A troca vale a partir da próxima mensagem.'}
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
