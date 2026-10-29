import { useEffect, useMemo, useState } from 'react'
import { CHAT_PROVIDERS, CHAT_PROVIDER_LABELS, type Chat, type ChatProvider } from '../../../../shared/types.ts'
import { api } from '../../lib/api.ts'
import { timeAgo } from '../../lib/format.ts'
import { useHarpia } from '../../lib/store.ts'
import { Avatar } from '../Avatar.tsx'
import { CHAT_STATUS_STYLE } from '../task/ChatList.tsx'
import { ChatView } from '../task/ChatView.tsx'

const SELECTED_KEY = 'harpia.conversation'

function savedSelection(): number | null {
  try {
    const value = Number(localStorage.getItem(SELECTED_KEY))
    return Number.isInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function Row({ chat, selected, onSelect, showOwner }: { chat: Chat; selected: boolean; onSelect: () => void; showOwner: boolean }) {
  const users = useHarpia((state) => state.users)
  const style = CHAT_STATUS_STYLE[chat.status]
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left ${selected ? 'bg-zinc-800' : 'hover:bg-zinc-900'}`}
    >
      {showOwner && <Avatar user={users[chat.userId]} size="sm" />}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{chat.title}</p>
        <p className="flex items-center gap-1.5 text-xs text-zinc-500">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
          <span className="truncate">
            {CHAT_PROVIDER_LABELS[chat.provider]}
            {chat.status === 'idle' ? ` · ${timeAgo(chat.updatedAt)}` : ` · ${style.label}`}
            {!showOwner && chat.shared && ' · compartilhada'}
          </span>
        </p>
      </div>
    </button>
  )
}

// Fase 2: conversas com o Claude ou o Codex fora das tasks, cada pessoa com a própria conta.
export function Conversations() {
  const { me, agentsStatus, upsertChats } = useHarpia()
  const allChats = useHarpia((state) => state.chats)
  const [selectedId, setSelectedId] = useState<number | null>(savedSelection)
  const [creating, setCreating] = useState<ChatProvider | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .generalChats()
      .then(({ chats }) => upsertChats(chats))
      .catch((err: Error) => setError(err.message))
  }, [upsertChats])

  const chats = useMemo(
    () =>
      Object.values(allChats)
        .filter((chat) => chat.taskId === null)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id),
    [allChats]
  )
  const mine = chats.filter((chat) => chat.userId === me?.id)
  const team = chats.filter((chat) => chat.userId !== me?.id)
  const current = selectedId !== null && chats.some((chat) => chat.id === selectedId) ? selectedId : null

  const select = (chatId: number | null) => {
    setSelectedId(chatId)
    try {
      if (chatId) localStorage.setItem(SELECTED_KEY, String(chatId))
      else localStorage.removeItem(SELECTED_KEY)
    } catch {
      // Sem armazenamento local: só não lembra a última conversa.
    }
  }

  const create = async (provider: ChatProvider) => {
    setCreating(provider)
    try {
      const { chat } = await api.createGeneralChat(provider)
      upsertChats([chat])
      select(chat.id)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setCreating(null)
    }
  }

  const disabledReason = agentsStatus && !agentsStatus.enabled ? agentsStatus.reason : null

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)]">
      <nav className="flex min-h-0 flex-col border-r border-zinc-800 bg-zinc-950">
        <div className="space-y-2 border-b border-zinc-800 p-3">
          <p className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">Nova conversa</p>
          {disabledReason ? (
            <p className="text-xs text-zinc-500">{disabledReason}</p>
          ) : (
            <div className="flex gap-2">
              {CHAT_PROVIDERS.map((provider) => (
                <button
                  key={provider}
                  className="btn-outline flex-1 px-2 py-1.5 text-xs"
                  disabled={creating !== null}
                  onClick={() => void create(provider)}
                >
                  {creating === provider ? 'Abrindo…' : `+ ${CHAT_PROVIDER_LABELS[provider]}`}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-2">
          <section>
            <p className="px-2 pb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Minhas</p>
            {mine.length === 0 && <p className="px-2 text-xs text-zinc-600">Nenhuma ainda.</p>}
            {mine.map((chat) => (
              <Row key={chat.id} chat={chat} showOwner={false} selected={chat.id === current} onSelect={() => select(chat.id)} />
            ))}
          </section>
          <section>
            <p className="px-2 pb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Compartilhadas pela equipe</p>
            {team.length === 0 && <p className="px-2 text-xs text-zinc-600">Nenhuma conversa compartilhada.</p>}
            {team.map((chat) => (
              <Row key={chat.id} chat={chat} showOwner selected={chat.id === current} onSelect={() => select(chat.id)} />
            ))}
          </section>
        </div>
      </nav>
      <main className="flex min-h-0 flex-col">
        {error && <div className="bg-rose-950 px-4 py-2 text-sm text-rose-300">{error}</div>}
        {current ? (
          <ChatView key={current} chatId={current} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-zinc-500">
            <p className="text-base text-zinc-300">Converse com o Claude ou o Codex, fora das tasks.</p>
            <p className="max-w-md">
              Cada pessoa usa a própria conta e escolhe o modelo. As conversas são privadas; se quiser mostrar uma para a
              equipe, use "Compartilhar".
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
