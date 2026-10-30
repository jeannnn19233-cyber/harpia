import { useEffect, useState } from 'react'
import { EFFORT_LABELS, EFFORT_LEVELS, type Chat, type ChatModel, type ChatProvider } from '../../../../shared/types.ts'
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

// Níveis de esforço do modelo escolhido; com o modelo padrão, os que algum modelo da conta aceita.
export function effortsFor(models: ChatModel[], model: string | null): { levels: string[]; fallback: string | null } {
  const chosen = model ? models.find((item) => item.id === model) : undefined
  const source = chosen ? [chosen] : models
  const levels = new Set(source.flatMap((item) => item.efforts ?? []))
  return {
    levels: EFFORT_LEVELS.filter((level) => levels.has(level)),
    fallback: chosen?.defaultEffort ?? null
  }
}

// Quanto o modelo pensa antes de responder. Some quando o modelo não tem essa escolha.
export function EffortSelect({ chat, onChange }: { chat: Chat; onChange: (effort: string | null) => void }) {
  const [models, setModels] = useState<ChatModel[]>([])
  useEffect(() => {
    let current = true
    void loadModels(chat.provider).then((result) => current && setModels(result.models))
    return () => {
      current = false
    }
  }, [chat.provider])
  const { levels, fallback } = effortsFor(models, chat.model)
  if (levels.length === 0 && !chat.effort) return null
  const options = chat.effort && !levels.includes(chat.effort as (typeof levels)[number]) ? [chat.effort, ...levels] : levels
  return (
    <select
      className="input w-auto max-w-36 py-1 text-xs"
      value={chat.effort ?? ''}
      title="Esforço: quanto o modelo pensa antes de responder. Mais esforço, respostas mais cuidadosas e mais lentas. Vale a partir da próxima mensagem."
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">{fallback ? `Esforço padrão (${EFFORT_LABELS[fallback] ?? fallback})` : 'Esforço padrão'}</option>
      {options.map((level) => (
        <option key={level} value={level}>
          {EFFORT_LABELS[level] ?? level}
        </option>
      ))}
    </select>
  )
}
