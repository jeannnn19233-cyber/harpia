import { useEffect, useState } from 'react'
import { Menu, type MenuOption } from '../Menu.tsx'
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

// Modelo e esforço num menu só, em cascata: o modelo na lista e, ao lado, o esforço dele.
export function ModelEffortMenu({ chat, onChange }: { chat: Chat; onChange: (choice: { model: string | null; effort: string | null }) => void }) {
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
  // O modelo escolhido continua no menu mesmo que a conta não o anuncie mais.
  const all = chat.model && !list.some((model) => model.id === chat.model) ? [{ id: chat.model, label: chat.model, description: '' }, ...list] : list
  const effortsOf = (model: string | null) => effortsFor(list, model)
  const submenu = (model: string | null): MenuOption[] | undefined => {
    const { levels, fallback } = effortsOf(model)
    if (levels.length === 0) return undefined
    return [
      {
        key: 'default',
        label: 'Esforço padrão',
        hint: fallback ? EFFORT_LABELS[fallback] ?? fallback : undefined,
        checked: chat.model === model && !chat.effort,
        onSelect: () => onChange({ model, effort: null })
      },
      ...levels.map((level) => ({
        key: level,
        label: EFFORT_LABELS[level] ?? level,
        checked: chat.model === model && chat.effort === level,
        onSelect: () => onChange({ model, effort: level })
      }))
    ]
  }
  const option = (id: string | null, label: string, hint?: string): MenuOption => {
    const children = submenu(id)
    return {
      key: id ?? 'default',
      label,
      hint,
      checked: children ? undefined : chat.model === id,
      children,
      onSelect: children ? undefined : () => onChange({ model: id, effort: null })
    }
  }
  const options: MenuOption[] = [
    option(null, 'Modelo padrão', 'o padrão da sua conta'),
    ...all.map((model) => option(model.id, model.label, model.description || undefined))
  ]
  if (models === null) options.push({ key: 'loading', label: 'Carregando modelos…' })
  const current = chat.model ? (all.find((model) => model.id === chat.model)?.label ?? chat.model) : 'Modelo padrão'
  return (
    <Menu
      title={error ?? 'Modelo e esforço (quanto o modelo pensa antes de responder). A troca vale a partir da próxima mensagem.'}
      label={chat.effort ? `${current} · ${EFFORT_LABELS[chat.effort] ?? chat.effort}` : current}
      options={options}
    />
  )
}
