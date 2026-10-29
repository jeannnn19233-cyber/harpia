import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  CHAT_PROVIDER_LABELS,
  PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  type ChatItem,
  type PermissionMode
} from '../../../../shared/types.ts'
import { api } from '../../lib/api.ts'
import { useHarpia } from '../../lib/store.ts'
import { Avatar } from '../Avatar.tsx'
import { RichText } from './RichText.tsx'

function ToolCard({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const icon = item.status === 'running' ? '⋯' : item.status === 'failed' ? '✕' : '✓'
  const color = item.status === 'running' ? 'text-sky-400' : item.status === 'failed' ? 'text-rose-400' : 'text-emerald-400'
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 text-xs">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setOpen(!open)}
        disabled={!item.output}
      >
        <span className={`w-3 shrink-0 text-center ${color} ${item.status === 'running' ? 'animate-pulse' : ''}`}>{icon}</span>
        <span className="font-medium text-zinc-300">{item.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-zinc-500">{item.summary}</span>
        {item.output && <span className="text-zinc-500">{open ? 'ocultar' : 'ver saída'}</span>}
      </button>
      {open && item.output && (
        <pre className="max-h-72 overflow-auto border-t border-zinc-800 px-3 py-2 font-mono whitespace-pre-wrap text-zinc-400">
          {item.output}
        </pre>
      )}
    </div>
  )
}

function ApprovalCard({
  item,
  canDecide,
  onDecide
}: {
  item: Extract<ChatItem, { kind: 'approval' }>
  canDecide: boolean
  onDecide: (decision: 'allow' | 'deny') => void
}) {
  const users = useHarpia((state) => state.users)
  const status = {
    pending: 'Esperando aprovação',
    allowed: `Permitido${item.decidedBy ? ` por ${users[item.decidedBy]?.name ?? 'alguém'}` : ''}`,
    denied: `Recusado${item.decidedBy ? ` por ${users[item.decidedBy]?.name ?? 'alguém'}` : ''}`,
    expired: 'Expirou'
  }[item.status]
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 text-sm ${
        item.status === 'pending' ? 'border-amber-500/50 bg-amber-950/30' : 'border-zinc-800 bg-zinc-900/60'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="font-medium">{item.title}</span>
        <span className="ml-auto text-xs text-zinc-400">{status}</span>
      </div>
      <pre className="mt-1.5 font-mono text-xs whitespace-pre-wrap text-zinc-300">{item.detail}</pre>
      {item.status === 'pending' && canDecide && (
        <div className="mt-2.5 flex gap-2">
          <button className="btn-primary py-1 text-xs" onClick={() => onDecide('allow')}>
            Permitir
          </button>
          <button className="btn-outline py-1 text-xs" onClick={() => onDecide('deny')}>
            Recusar
          </button>
        </div>
      )}
    </div>
  )
}

export function ChatView({ chatId }: { chatId: number }) {
  const { me, users } = useHarpia()
  const chat = useHarpia((state) => state.chats[chatId])
  const items = useHarpia((state) => state.chatItems[chatId])
  const upsertChats = useHarpia((state) => state.upsertChats)
  const setChatItems = useHarpia((state) => state.setChatItems)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  useEffect(() => {
    api
      .chat(chatId)
      .then(({ chat, items }) => {
        upsertChats([chat])
        setChatItems(chatId, items)
      })
      .catch((err: Error) => setError(err.message))
  }, [chatId, upsertChats, setChatItems])

  // Acompanha a resposta enquanto ela chega, a menos que a pessoa tenha rolado para cima.
  useEffect(() => {
    const element = scroller.current
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight
  }, [items])

  if (!chat || !me) return null
  const mine = chat.userId === me.id
  const busy = chat.status === 'working' || chat.status === 'waiting'
  const owner = users[chat.userId]

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action()
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const send = async (event?: FormEvent) => {
    event?.preventDefault()
    const message = text.trim()
    if (!message || busy) return
    setText('')
    stickToBottom.current = true
    await run(() => api.sendMessage(chat.id, message))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
        <Avatar user={owner} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{chat.title}</p>
          <p className="truncate text-xs text-zinc-500">
            {owner?.name} · {CHAT_PROVIDER_LABELS[chat.provider]} · <span className="font-mono">{chat.branch}</span>
          </p>
        </div>
        {mine && chat.status !== 'closed' ? (
          <select
            className="input w-auto py-1 text-xs"
            value={chat.permissionMode}
            title="O quanto o agente pode fazer sem pedir aprovação"
            onChange={(e) => run(() => api.setPermissionMode(chat.id, e.target.value as PermissionMode))}
          >
            {PERMISSION_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {PERMISSION_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        ) : (
          !mine && <span className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300">Acompanhando · só leitura</span>
        )}
        {mine && chat.status !== 'closed' && (
          <button
            className="btn-ghost px-2 py-1 text-xs"
            onClick={() => confirm('Encerrar esta conversa?') && run(() => api.closeChat(chat.id))}
          >
            Encerrar
          </button>
        )}
      </header>

      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        onScroll={(event) => {
          const element = event.currentTarget
          stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
        }}
      >
        <div className="mx-auto max-w-3xl space-y-4">
          {!items && <p className="text-sm text-zinc-500">Carregando conversa…</p>}
          {items?.length === 0 && (
            <div className="py-10 text-center text-sm text-zinc-500">
              {mine
                ? `Escreva o que o ${CHAT_PROVIDER_LABELS[chat.provider]} deve fazer nesta task. Ele trabalha na sua cópia do código, na branch ${chat.branch}.`
                : 'Nenhuma mensagem ainda.'}
            </div>
          )}
          {items?.map((item) => {
            switch (item.kind) {
              case 'user':
                return (
                  <div key={item.id} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl bg-zinc-800 px-4 py-2.5 text-sm whitespace-pre-wrap">{item.text}</div>
                  </div>
                )
              case 'assistant':
                return (
                  <div key={item.id} className="text-zinc-200">
                    <RichText text={item.text} />
                    {item.streaming && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-brand-400 align-middle" />}
                  </div>
                )
              case 'tool':
                return <ToolCard key={item.id} item={item} />
              case 'approval':
                return (
                  <ApprovalCard
                    key={item.id}
                    item={item}
                    canDecide={mine}
                    onDecide={(decision) => void run(() => api.decide(chat.id, item.id, decision))}
                  />
                )
              case 'notice':
                return (
                  <p key={item.id} className="flex items-center gap-2 text-xs text-amber-300/80">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                    {item.text}
                  </p>
                )
              case 'error':
                return (
                  <div key={item.id} className="rounded-lg border border-rose-900 bg-rose-950/40 px-3 py-2 text-sm text-rose-300">
                    {item.text}
                  </div>
                )
            }
          })}
          {chat.status === 'working' && (
            <p className="flex items-center gap-2 text-xs text-zinc-500">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" /> trabalhando…
            </p>
          )}
        </div>
      </div>

      {error && <div className="border-t border-rose-900 bg-rose-950 px-4 py-2 text-sm text-rose-300">{error}</div>}
      {mine && chat.status !== 'closed' && (
        <form onSubmit={send} className="border-t border-zinc-800 px-4 py-3">
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <textarea
              className="input max-h-48 min-h-11 flex-1 resize-none"
              rows={2}
              placeholder={
                busy
                  ? 'O agente está trabalhando…'
                  : `Mensagem para o ${CHAT_PROVIDER_LABELS[chat.provider]} (Enter envia, Shift+Enter quebra linha)`
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            {busy ? (
              <button type="button" className="btn-outline" onClick={() => run(() => api.interruptChat(chat.id))}>
                Parar
              </button>
            ) : (
              <button className="btn-primary" disabled={!text.trim()}>
                Enviar
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  )
}
