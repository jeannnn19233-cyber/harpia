import type { Chat } from '../../../shared/types.ts'

// Regras dos avisos do app de computador, sem React nem store (testadas em desktop/test).

// Conversas da própria pessoa, abertas por ela (rotinas e revisões avisam pelo Telegram).
function mine(chat: Chat, userId: number | undefined): boolean {
  return chat.userId === userId && chat.origin === 'user'
}

// O que merece aviso do sistema: o agente da pessoa parou para pedir aprovação, ou terminou.
export function noticesFor(before: Record<number, Chat>, after: Record<number, Chat>, userId: number | undefined, taskTitle: (taskId: number | null) => string | null) {
  const notices: { title: string; body: string; taskId: number | null }[] = []
  for (const chat of Object.values(after)) {
    const previous = before[chat.id]
    if (!previous || !mine(chat, userId) || previous.status === chat.status || previous.status !== 'working') continue
    const where = taskTitle(chat.taskId) ?? chat.title
    const agent = chat.provider === 'claude' ? 'Claude' : 'Codex'
    if (chat.status === 'waiting') notices.push({ title: `${agent} pede aprovação`, body: where, taskId: chat.taskId })
    if (chat.status === 'idle') notices.push({ title: `${agent} terminou`, body: where, taskId: chat.taskId })
  }
  return notices
}

export function waitingCount(chats: Record<number, Chat>, userId: number | undefined): number {
  return Object.values(chats).filter((chat) => mine(chat, userId) && chat.status === 'waiting').length
}
