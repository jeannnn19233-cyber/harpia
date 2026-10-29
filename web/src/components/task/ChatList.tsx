import { useState } from 'react'
import { CHAT_PROVIDERS, CHAT_PROVIDER_LABELS, type Chat, type ChatProvider } from '../../../../shared/types.ts'
import { useHarpia } from '../../lib/store.ts'
import { Avatar } from '../Avatar.tsx'

export const CHAT_STATUS_STYLE: Record<Chat['status'], { dot: string; label: string }> = {
  working: { dot: 'bg-sky-400 animate-pulse', label: 'trabalhando' },
  waiting: { dot: 'bg-amber-400', label: 'esperando aprovação' },
  idle: { dot: 'bg-zinc-500', label: 'parado' },
  closed: { dot: 'bg-zinc-700', label: 'encerrada' }
}

function ChatRow({ chat, selected, onSelect }: { chat: Chat; selected: boolean; onSelect: () => void }) {
  const users = useHarpia((state) => state.users)
  const style = CHAT_STATUS_STYLE[chat.status]
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left ${selected ? 'bg-zinc-800' : 'hover:bg-zinc-900'}`}
    >
      <Avatar user={users[chat.userId]} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{chat.title}</p>
        <p className="flex items-center gap-1.5 text-xs text-zinc-500">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
          {CHAT_PROVIDER_LABELS[chat.provider]} · {style.label}
        </p>
      </div>
    </button>
  )
}

export function ChatList({
  chats,
  selectedId,
  onSelect,
  onCreate,
  creating,
  disabledReason
}: {
  chats: Chat[]
  selectedId: number | null
  onSelect: (chatId: number) => void
  onCreate: (provider: ChatProvider) => void
  creating: ChatProvider | null
  disabledReason: string | null
}) {
  const me = useHarpia((state) => state.me)
  const [showClosed, setShowClosed] = useState(false)
  const visible = chats.filter((chat) => showClosed || chat.status !== 'closed' || chat.id === selectedId)
  const mine = visible.filter((chat) => chat.userId === me?.id)
  const team = visible.filter((chat) => chat.userId !== me?.id)
  const closedCount = chats.filter((chat) => chat.status === 'closed').length

  return (
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
                onClick={() => onCreate(provider)}
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
            <ChatRow key={chat.id} chat={chat} selected={chat.id === selectedId} onSelect={() => onSelect(chat.id)} />
          ))}
        </section>
        <section>
          <p className="px-2 pb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Da equipe</p>
          {team.length === 0 && <p className="px-2 text-xs text-zinc-600">Ninguém mais conversando aqui.</p>}
          {team.map((chat) => (
            <ChatRow key={chat.id} chat={chat} selected={chat.id === selectedId} onSelect={() => onSelect(chat.id)} />
          ))}
        </section>
        {closedCount > 0 && (
          <button className="px-2 text-xs text-zinc-500 hover:text-zinc-300" onClick={() => setShowClosed(!showClosed)}>
            {showClosed ? 'Ocultar' : 'Mostrar'} {closedCount} encerradas
          </button>
        )}
      </div>
    </nav>
  )
}
